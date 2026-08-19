// The balancing proxy.
//
// Claude Code is pointed at this server with ANTHROPIC_BASE_URL. For each
// request we look up (or create) the session's account lease, replace the
// `Authorization` header with that account's OAuth access token, and forward
// everything else byte-for-byte.
//
// The body is NEVER rewritten. Anthropic's prompt cache is a prefix match over
// tools -> system -> messages, and the invalidation hierarchy means touching
// `tools` or `system` at all would invalidate the entire cached prefix. We only
// change a header.
//
// Verified end-to-end (2026-08-13): Claude Code sent account 2's token, the
// proxy substituted account 1's, and the response came back from account 1's
// organization id. The CLI was unaware.

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

import { AffinityStore, DEFAULT_LEASE_TTL_MS } from './affinity.js';
import { DEFAULT_RAW_RETENTION_DAYS, MetricsStore } from './metrics.js';
import { UsageCollector, usageFromJsonBody } from './usage.js';
import type { Usage } from './usage.js';
import { hasClaims, parseClaims } from './claims.js';
import { discoverAccounts, loadAccountStates, readOAuth, readSlotObservation, recordObservation, resolveAuthswapRoot, resolveStateRoot, tokenFingerprint } from './accounts.js';
import type { Account } from './accounts.js';
import { selectAccount } from './policy.js';
import { REFRESH_SWEEP_INTERVAL_MS, TokenRefresher } from './refresh.js';
import { UsageProbe } from './usage-probe.js';

export const SESSION_HEADER = 'x-claude-code-session-id';
export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
export const DEFAULT_PORT = 8789;

/** Bounds connect/TLS/wait-for-headers; response streams are deliberately unbounded. */
export const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 90 * 1000;

/**
 * A 429 whose `retry-after` is at or below this is cheaper to wait out than to
 * rotate away from: rotating pays a guaranteed cache re-create (20x on the next
 * request) to avoid a delay measured in seconds.
 */
export const RETRY_AFTER_WAIT_CEILING_MS = 15_000;

/**
 * Transport failures that killed the connection before any response byte
 * arrived, and are therefore safe to re-send on the same account.
 *
 * `pre-header` is the hard precondition — no status line reached the client, so
 * a retry cannot duplicate streamed content. Within that, only errors meaning
 * "the connection broke" qualify. A header TIMEOUT is deliberately excluded:
 * the server is plausibly still working on that inference, and re-sending would
 * bill a second one.
 *
 * Measured provenance: 34 transport failures over two days on this deployment,
 * 33 of them `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC` and one `ECONNRESET`, every
 * one at `pre-header`. Each surfaced to Claude Code as a hard 502.
 */
export const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
]);

/** Attempts added after the first, on a retryable pre-header transport failure. */
export const TRANSPORT_RETRY_LIMIT = 2;

/** Backoff before each transport retry. Short: the connection died instantly. */
export const TRANSPORT_RETRY_BACKOFF_MS = [150, 600];

/**
 * A pre-header transport failure re-sends only when the connection itself
 * broke. Anything else — a header timeout above all — is terminal, because the
 * request may already be running upstream.
 */
export function isRetryableTransportError(error: {
  phase?: string;
  code?: string;
}): boolean {
  if (error.phase !== 'pre-header') return false;
  if (error.code === 'UPSTREAM_HEADERS_TIMEOUT') return false;
  return error.code !== undefined && RETRYABLE_TRANSPORT_CODES.has(error.code);
}

/** Raw metric rows are pruned on this cadence, not only at startup. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** True hop-by-hop headers (RFC 7230 §6.1). Forwarding them corrupts framing. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Additionally dropped from the REQUEST. `host` and `content-length` are not
 * hop-by-hop — they are dropped because we re-target and re-frame the request.
 *
 * `x-api-key` and `anthropic-auth-token` are dropped for a different and more
 * important reason: a developer box with `ANTHROPIC_API_KEY` exported makes
 * Claude Code send a console API key, which would arrive alongside the
 * subscription bearer we substitute. The upstream would then either bill the
 * API key at full list price — defeating the entire point of this proxy, and
 * invisibly, since our metrics would still record it against the chosen slot —
 * or reject the conflicting pair.
 */
const REQUEST_STRIP = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'authorization',
  'x-api-key',
  'anthropic-auth-token',
]);

/**
 * Dropped from the RESPONSE. Only genuine hop-by-hop headers: the body is
 * relayed byte-for-byte, so upstream's `content-length` stays correct and is
 * forwarded rather than forcing every response into chunked framing.
 */
const RESPONSE_STRIP = HOP_BY_HOP;

export type ProxyLogEvent = {
  kind: 'route' | 'retry' | 'error' | 'exhausted' | 'refresh';
  method: string;
  path: string;
  model?: string;
  session?: string;
  slot?: string;
  decision?: string;
  reason?: string;
  status?: number;
  message?: string;
};

export type ProxyOptions = {
  port?: number;
  host?: string;
  upstream?: string;
  stateRoot?: string;
  authswapRoot?: string;
  allowOverage?: boolean;
  leaseTtlMs?: number;
  /** Retry a 429 once on a different account. Safe: 429 arrives before any body. */
  retryOnRateLimit?: boolean;
  /** Record per-request usage metrics to SQLite. Default true. */
  metrics?: boolean;
  /** Raw-row retention window; the daily rollup is kept forever. */
  metricsRetentionDays?: number;
  /** Maximum connect/TLS/header wait. Streaming after headers is not limited. */
  upstreamHeaderTimeoutMs?: number;
  /** Package-test seam; production defaults to probing enabled. */
  usageProbe?: boolean;
  now?: () => number;
  log?: (event: ProxyLogEvent) => void;
};

type Resolved = Required<Omit<ProxyOptions, 'log' | 'now'>> & {
  now: () => number;
  log: (event: ProxyLogEvent) => void;
};

function resolveOptions(options: ProxyOptions): Resolved {
  return {
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? '127.0.0.1',
    upstream: options.upstream ?? DEFAULT_UPSTREAM,
    stateRoot: options.stateRoot ?? resolveStateRoot(),
    authswapRoot: options.authswapRoot ?? resolveAuthswapRoot(),
    allowOverage: options.allowOverage ?? false,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    retryOnRateLimit: options.retryOnRateLimit ?? true,
    metrics: options.metrics ?? true,
    metricsRetentionDays: options.metricsRetentionDays ?? DEFAULT_RAW_RETENTION_DAYS,
    upstreamHeaderTimeoutMs: options.upstreamHeaderTimeoutMs ?? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS,
    usageProbe: options.usageProbe ?? true,
    now: options.now ?? Date.now,
    log: options.log ?? (() => {}),
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function modelFromBody(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

type UpstreamResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
  /** Retained so a client abort can cancel the upstream generation. */
  request: http.ClientRequest;
};

/**
 * Reject anything that is not an origin-form request target.
 *
 * Node hands `req.url` through verbatim, so an absolute-form target
 * (`POST http://evil.example/steal HTTP/1.1`) would override the configured
 * upstream origin in `new URL(req.url, base)` — and this proxy attaches a live
 * OAuth bearer token to whatever it connects to. Any local process could then
 * exfiltrate an account token. Protocol-relative targets (`//evil.example/x`)
 * resolve the same way and are rejected for the same reason.
 */
export function isOriginFormTarget(target: string | undefined): boolean {
  if (!target) return false;
  if (!target.startsWith('/')) return false;
  if (target.startsWith('//')) return false;
  // Backslashes are normalized to '/' by some parsers; refuse the ambiguity.
  if (target.includes('\\')) return false;
  return true;
}

function forward(
  upstreamBase: string,
  req: http.IncomingMessage,
  body: Buffer,
  token: string,
  headerTimeoutMs: number,
  upstreamHttpsAgent: https.Agent,
): Promise<UpstreamResult> {
  const base = new URL(upstreamBase);
  const rawTarget = req.url ?? '/';
  if (!isOriginFormTarget(rawTarget)) {
    return Promise.reject(new Error('refusing non-origin-form request target'));
  }
  const target = new URL(rawTarget, base);
  // Defence in depth: even if the parse above were coaxed off-origin, never
  // send a credential anywhere but the configured upstream.
  if (target.origin !== base.origin) {
    return Promise.reject(new Error(`refusing cross-origin forward to ${target.origin}`));
  }
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (REQUEST_STRIP.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  headers['authorization'] = `Bearer ${token}`;
  if (body.length > 0) headers['content-length'] = String(body.length);

  const agent = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timer: NodeJS.Timeout;
    const upstreamReq = agent.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        // Only inference HTTPS uses this proxy-owned transport. HTTP test/dev
        // upstreams and other network clients retain their existing behavior.
        agent: target.protocol === 'https:' ? upstreamHttpsAgent : undefined,
      },
      res => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 502, headers: res.headers, stream: res, request: upstreamReq });
      },
    );
    upstreamReq.on('error', error => {
      clearTimeout(timer);
      const detail = error as NodeJS.ErrnoException & { phase?: string; durationMs?: number; reusedSocket?: boolean };
      detail.phase = 'pre-header';
      detail.durationMs = Date.now() - started;
      detail.reusedSocket = upstreamReq.reusedSocket;
      reject(detail);
    });
    timer = setTimeout(() => {
      const error = new Error(`upstream headers timed out after ${headerTimeoutMs}ms`) as NodeJS.ErrnoException;
      error.code = 'UPSTREAM_HEADERS_TIMEOUT';
      upstreamReq.destroy(error);
    }, headerTimeoutMs);
    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
}

/** Decompressor matching the upstream's Content-Encoding, or null for identity. */
function decompressorFor(encoding: string | undefined): zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | null {
  switch ((encoding ?? '').toLowerCase().trim()) {
    case 'gzip':
      return zlib.createGunzip();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'deflate':
      return zlib.createInflate();
    default:
      return null;
  }
}

/** Cap on the plaintext copy kept for the non-streaming JSON fallback. */
const JSON_FALLBACK_LIMIT = 1_000_000;

/**
 * Pipe the upstream response to the client byte-for-byte while observing a
 * decompressed copy for usage accounting.
 *
 * The client stream is the primary: the observer never sits between upstream
 * and client, so a failure in usage parsing cannot corrupt or stall a response.
 */
function relayAndObserve(
  res: http.ServerResponse,
  result: UpstreamResult,
  onUsage: (usage: Usage, model: string | undefined) => void,
): void {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(result.headers)) {
    if (value === undefined) continue;
    if (RESPONSE_STRIP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  res.writeHead(result.status, out);

  const encoding = Array.isArray(result.headers['content-encoding'])
    ? result.headers['content-encoding'][0]
    : result.headers['content-encoding'];
  const contentType = Array.isArray(result.headers['content-type'])
    ? result.headers['content-type'][0]
    : result.headers['content-type'];
  // The JSON fallback exists only for non-streaming bodies. On an SSE stream
  // the collector always produces usage, so accumulating up to 1 MB of
  // plaintext per in-flight stream would be pure waste.
  const wantFallback = !(contentType ?? '').includes('text/event-stream');
  const decompressor = decompressorFor(encoding);
  const collector = new UsageCollector();
  let fallback = '';
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    let usage = collector.end();
    if (
      usage.inputTokens === undefined &&
      usage.outputTokens === undefined &&
      usage.cacheReadInputTokens === undefined
    ) {
      const fromJson = usageFromJsonBody(fallback);
      if (Object.values(fromJson).some(v => v !== undefined)) usage = fromJson;
    }
    onUsage(usage, collector.model);
  };

  const observe = (text: string) => {
    collector.push(text);
    if (wantFallback && fallback.length < JSON_FALLBACK_LIMIT) fallback += text;
  };

  // A cancelled turn (Esc, or the user typing during generation) destroys
  // `res`. Without this the upstream generation runs to completion against a
  // dead socket, burning full output tokens against the 5h/7d claims — a silent
  // quota leak in a proxy whose whole purpose is conserving quota.
  res.on('close', () => {
    if (!res.writableEnded) {
      finish();
      result.request.destroy();
      result.stream.destroy();
    }
  });

  // `Readable.pipe()` does NOT close the destination when the source errors.
  // An upstream that sends 200 plus a partial SSE body and then drops its
  // socket would otherwise leave the client waiting forever, because headers
  // are already sent and no terminal chunk ever arrives. Destroy explicitly.
  const abortDownstream = (error: Error) => {
    finish();
    if (!res.writableEnded) res.destroy(error);
  };

  if (decompressor) {
    decompressor.on('data', (chunk: Buffer) => observe(chunk.toString('utf8')));
    decompressor.on('end', finish);
    // Observation must never take the process down or break the relay.
    decompressor.on('error', finish);
    result.stream.on('data', (chunk: Buffer) => {
      try {
        decompressor.write(chunk);
      } catch {
        /* observation only */
      }
    });
    result.stream.on('end', () => {
      try {
        decompressor.end();
      } catch {
        finish();
      }
    });
    result.stream.on('error', abortDownstream);
  } else {
    result.stream.on('data', (chunk: Buffer) => observe(chunk.toString('utf8')));
    result.stream.on('end', finish);
    result.stream.on('error', abortDownstream);
  }

  result.stream.pipe(res);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Returns milliseconds,
 * or undefined when absent or unparseable.
 */
export function retryAfterMs(
  headers: http.IncomingHttpHeaders,
  nowMs: number = Date.now(),
): number | undefined {
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function drain(stream: http.IncomingMessage): Promise<void> {
  return new Promise(resolve => {
    stream.on('data', () => {});
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
}

export function createProxy(options: ProxyOptions = {}): http.Server {
  const opts = resolveOptions(options);
  const server_close_hooks: (() => void)[] = [];
  // A proxy instance owns exactly one inference HTTPS agent. Disabling both
  // socket keep-alive and the TLS session cache ensures every attempt gets a
  // fresh TCP connection and a full TLS handshake.
  const upstreamHttpsAgent = new https.Agent({
    keepAlive: false,
    maxCachedSessions: 0,
  });
  server_close_hooks.push(() => upstreamHttpsAgent.destroy());
  const affinity = new AffinityStore({
    stateRoot: opts.stateRoot,
    ttlMs: opts.leaseTtlMs,
    now: opts.now,
  });

  const refresher = new TokenRefresher({
    now: opts.now,
    stateRoot: opts.stateRoot,
    log: e =>
      opts.log({
        kind: e.outcome === 'failed' ? 'error' : 'refresh',
        method: 'OAUTH',
        path: '/v1/oauth/token',
        slot: e.slot,
        reason: e.outcome,
        message:
          e.message ??
          (e.outcome === 'refreshed'
            ? `valid for ${Math.round((e.expiresInMs ?? 0) / 60000)}m${e.rotated ? ', refresh token rotated' : ''}`
            : undefined),
      }),
  });

  const usageProbe = new UsageProbe({
    upstream: opts.upstream,
    stateRoot: opts.stateRoot,
    now: opts.now,
    prepare: async account => {
      const outcome = await refresher.ensureFresh(account);
      if (outcome.status === 'failed' || outcome.status === 'skipped') {
        throw new Error('slot token could not be prepared for usage probe');
      }
    },
  });

  // Idle slots are the whole point. Reactive refresh only ever touches accounts
  // that are being selected, and an account is not selected precisely when it
  // has gone stale — so without this sweep the balancer degenerates to whichever
  // account Claude Code happens to keep warm.
  const runRefreshSweep = () => {
    void refresher
      .sweep(discoverAccounts(opts.authswapRoot))
      .catch(() => {}); // a sweep failure must never take the proxy down
  };
  runRefreshSweep();
  {
    const timer = setInterval(runRefreshSweep, REFRESH_SWEEP_INTERVAL_MS);
    timer.unref();
    server_close_hooks.push(() => clearInterval(timer));
  }

  const metrics = opts.metrics ? new MetricsStore(opts.stateRoot) : undefined;
  const runPrune = () => {
    try {
      metrics?.prune(opts.now(), opts.metricsRetentionDays);
    } catch {
      /* pruning must never take the proxy down */
    }
  };
  if (metrics) {
    runPrune();
    // Pruning only at startup means a daemon left running for weeks never
    // enforces retention at all — exactly the Codex-balancer failure this
    // store was written to avoid. `unref` keeps it from holding the process up.
    const timer = setInterval(runPrune, PRUNE_INTERVAL_MS);
    timer.unref();
    server_close_hooks.push(() => clearInterval(timer));
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const reqPath = (req.url ?? '/').split('?')[0]!;
    const startedAt = opts.now();

    // Refuse before any account is selected, so a hostile target never even
    // reaches the credential store.
    if (!isOriginFormTarget(req.url)) {
      opts.log({
        kind: 'error',
        method,
        path: reqPath,
        message: 'rejected non-origin-form request target',
      });
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'claude-auth-balancer: bad request target' },
        }),
      );
      req.resume();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const model = modelFromBody(body);
    const sessionHeader = req.headers[SESSION_HEADER];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    const tried = new Set<string>();
    let waitedOnRateLimit = false;

    const attempt = async (excluded: Set<string>): Promise<boolean> => {
      const now = opts.now();
      let loaded = loadAccountStates({
        stateRoot: opts.stateRoot,
        authswapRoot: opts.authswapRoot,
        nowMs: now,
      });
      let candidates = loaded.states.filter(s => !excluded.has(s.slot));
      const affinitySlot = sessionId ? affinity.lookup(sessionId, model) : undefined;
      const select = () => selectAccount({
        accounts: candidates,
        model,
        affinitySlot: affinitySlot && !excluded.has(affinitySlot) ? affinitySlot : undefined,
        nowMs: opts.now(),
        allowOverage: opts.allowOverage,
      });
      let selection = select();

      // A warm, serviceable affinity is the expensive thing this proxy exists
      // to preserve, so it never waits on bookkeeping. Fresh selection and a
      // move/exhaustion decision do wait briefly for due usage readings, then
      // run the exact same policy once more before the lease is pinned.
      const preservingAffinity = affinitySlot !== undefined && selection.slot === affinitySlot;
      if (opts.usageProbe && !preservingAffinity) {
        const due = candidates.filter(state =>
          usageProbe.isDue(readSlotObservation(opts.stateRoot, state.slot)),
        );
        if (due.length > 0) {
          await Promise.all(due.map(state => {
            const account = loaded.accounts.get(state.slot);
            return account ? usageProbe.probe(account) : Promise.resolve('failed' as const);
          }));
          loaded = loadAccountStates({
            stateRoot: opts.stateRoot,
            authswapRoot: opts.authswapRoot,
            nowMs: opts.now(),
          });
          candidates = loaded.states.filter(s => !excluded.has(s.slot));
          selection = select();
        }
      }

      if (!selection.slot) {
        opts.log({
          kind: 'exhausted',
          method,
          path: reqPath,
          model,
          session: sessionId,
          reason: selection.reason,
        });
        if (!res.headersSent) {
          res.writeHead(429, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: `claude-auth-balancer: ${selection.reason}`,
              },
            }),
          );
        }
        return true;
      }

      const account = loaded.accounts.get(selection.slot) as Account | undefined;
      if (!account) {
        excluded.add(selection.slot);
        return false;
      }

      // Refresh before use, not after a 401. The token has to be valid for the
      // whole generation, and a 401 mid-stream is unrecoverable — the client
      // has already received a 200 and part of the body.
      const refreshed = await refresher.ensureFresh(account);
      if (refreshed.status === 'failed' || refreshed.status === 'skipped') {
        opts.log({
          kind: 'error',
          method,
          path: reqPath,
          slot: selection.slot,
          message: `refresh ${refreshed.status}: ${
            refreshed.status === 'failed' ? refreshed.message : refreshed.reason
          }`,
        });
      }
      const oauth = readOAuth(account.credentialPath);
      if (!oauth || (oauth.expiresAt !== undefined && oauth.expiresAt <= opts.now())) {
        // Still unusable after the refresh attempt. Exclude and let the loop
        // try another account rather than sending a dead token to the wire.
        excluded.add(selection.slot);
        return false;
      }

      opts.log({
        kind: tried.size === 0 ? 'route' : 'retry',
        method,
        path: reqPath,
        model,
        session: sessionId,
        slot: selection.slot,
        decision: selection.decision,
        reason: selection.reason,
      });
      tried.add(selection.slot);

      // Pin the lease at SELECTION time, not after a successful response.
      // Node is single-threaded up to the next await, so this makes
      // select-then-pin atomic within the process. Deferring it until the
      // response arrived let a session's concurrent opening requests — Claude
      // Code fires `/v1/messages` and `/v1/messages/count_tokens` about 20ms
      // apart — both observe "no lease" and split across two accounts, which is
      // the one case where both pay a full cache write.
      if (sessionId) affinity.touch(sessionId, selection.slot, model);

      // Retry a broken connection on the SAME account. Rotating would be wrong
      // twice over: the account is not at fault, and moving the session pays a
      // full cache re-create for a socket-level fault.
      let result: UpstreamResult | undefined;
      for (let transportAttempt = 0; ; transportAttempt += 1) {
        try {
          result = await forward(
            opts.upstream,
            req,
            body,
            oauth.accessToken,
            opts.upstreamHeaderTimeoutMs,
            upstreamHttpsAgent,
          );
          break;
        } catch (error) {
          const detail = error as NodeJS.ErrnoException & { phase?: string; durationMs?: number; reusedSocket?: boolean };
          const willRetry =
            transportAttempt < TRANSPORT_RETRY_LIMIT && isRetryableTransportError(detail);
          opts.log({
            kind: willRetry ? 'retry' : 'error',
            method,
            path: reqPath,
            slot: selection.slot,
            message: [
              detail.message,
              detail.phase ? `phase=${detail.phase}` : '',
              detail.code ? `code=${detail.code}` : '',
              detail.syscall ? `syscall=${detail.syscall}` : '',
              detail.durationMs !== undefined ? `duration=${detail.durationMs}ms` : '',
              detail.reusedSocket !== undefined ? `reused=${detail.reusedSocket}` : '',
              `attempt=${transportAttempt + 1}`,
              willRetry ? 'retrying on the same account' : 'terminal',
            ].filter(Boolean).join(' '),
          });
          if (willRetry) {
            const backoff =
              TRANSPORT_RETRY_BACKOFF_MS[transportAttempt] ??
              TRANSPORT_RETRY_BACKOFF_MS[TRANSPORT_RETRY_BACKOFF_MS.length - 1]!;
            await sleep(backoff);
            continue;
          }
          try {
            metrics?.record({
              ts: startedAt,
              slot: selection.slot,
              email: account.email,
              sessionHash: sessionId ? AffinityStore.hashSession(sessionId, model) : undefined,
              model,
              endpoint: reqPath,
              status: 502,
              decision: selection.decision,
              durationMs: opts.now() - startedAt,
              usage: {},
            });
          } catch { /* transport failure reporting must not mask the response */ }
          if (!res.headersSent) res.writeHead(502).end();
          return true;
        }
      }

      const claims = parseClaims(result.headers as Record<string, string | string[] | undefined>);
      if (hasClaims(claims)) {
        recordObservation(opts.stateRoot, selection.slot, claims, opts.now(), account.email);
      }

      // A 429 arrives before any response body, so rotating here cannot
      // duplicate streamed content. Anything else is terminal.
      if (result.status === 429 && opts.retryOnRateLimit) {
        // Prefer waiting over rotating when the window reopens shortly: this
        // session's warm prefix lives on THIS account, and abandoning it costs
        // 20x on the next request plus a full prefill.
        const waitMs = retryAfterMs(result.headers);
        if (
          waitMs !== undefined &&
          waitMs <= RETRY_AFTER_WAIT_CEILING_MS &&
          !waitedOnRateLimit &&
          sessionId !== undefined
        ) {
          waitedOnRateLimit = true;
          await drain(result.stream);
          opts.log({
            kind: 'retry',
            method,
            path: reqPath,
            slot: selection.slot,
            status: 429,
            reason: `retry-after ${Math.round(waitMs / 1000)}s; waiting rather than paying a cache re-create`,
          });
          await sleep(waitMs);
          return false;
        }
        excluded.add(selection.slot);
        await drain(result.stream);
        opts.log({
          kind: 'retry',
          method,
          path: reqPath,
          slot: selection.slot,
          status: 429,
          reason: 'rate limited; rotating account',
        });
        return false;
      }

      relayAndObserve(res, result, (usage, streamedModel) => {
        if (!metrics) return;
        try {
          metrics.record({
            ts: startedAt,
            slot: selection.slot!,
            email: account.email,
            sessionHash: sessionId ? AffinityStore.hashSession(sessionId, model) : undefined,
            model: streamedModel ?? model,
            endpoint: reqPath,
            status: result.status,
            decision: selection.decision,
            durationMs: opts.now() - startedAt,
            usage,
            claims,
          });
        } catch (error) {
          opts.log({
            kind: 'error',
            method,
            path: reqPath,
            slot: selection.slot,
            message: `metrics: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
      return true;
    };

    // Bound by the number of accounts that exist, not a fixed constant: with a
    // fixed 4 and five slots, four 429s would exit reporting exhaustion without
    // ever trying the fifth. Every attempt adds a slot to `excluded`, so the
    // loop is strictly decreasing and cannot spin.
    const excluded = new Set<string>();
    const slotCount = discoverAccounts(opts.authswapRoot).length;
    const maxRounds = Math.max(1, slotCount) + 1;
    for (let round = 0; round < maxRounds; round += 1) {
      let done: boolean;
      try {
        done = await attempt(excluded);
      } catch (error) {
        opts.log({
          kind: 'error',
          method,
          path: reqPath,
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(502).end();
        return;
      }
      if (done) return;
    }
    if (!res.headersSent) res.writeHead(429, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'claude-auth-balancer: all accounts rate limited' },
      }),
    );
  });

  server.on('close', () => {
    for (const hook of server_close_hooks) hook();
    metrics?.close();
  });

  return server;
}

export async function startProxy(options: ProxyOptions = {}): Promise<{ server: http.Server; port: number; url: string }> {
  const opts = resolveOptions(options);
  const server = createProxy(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://${opts.host}:${port}` };
}

export { tokenFingerprint };

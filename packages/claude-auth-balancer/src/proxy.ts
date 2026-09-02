// The balancing proxy.
//
// Claude Code is pointed at this server with ANTHROPIC_BASE_URL. For each
// request we look up (or create) the session's account lease, replace the
// `Authorization` header with that account's OAuth access token, and forward
// request/response bodies byte-for-byte. Headers are semantically forwarded
// under explicit strip/rewrite rules; raw HTTP-message fidelity is not claimed.
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
import type { TLSSocket } from 'node:tls';
import zlib from 'node:zlib';

import { AffinityStore, DEFAULT_LEASE_TTL_MS } from './affinity.js';
import { DEFAULT_RAW_RETENTION_DAYS, MetricsStore } from './metrics.js';
import { UsageCollector, usageFromJsonBody } from './usage.js';
import type { Usage } from './usage.js';
import { hasClaims, parseClaims } from './claims.js';
import { discoverAccounts, loadAccountStates, readOAuth, readSlotObservation, recordObservation, resolveAuthswapRoot, resolveStateRoot, tokenFingerprint } from './accounts.js';
import type { Account } from './accounts.js';
import { selectAccount, DEFAULT_EXPIRING_WEEKLY_HORIZON_MS } from './policy.js';
import { REFRESH_SWEEP_INTERVAL_MS, TokenRefresher } from './refresh.js';
import { UsageProbe } from './usage-probe.js';
import { ClientCredentialStore, RUNTIME_CREDENTIAL_HEADER, ensureRuntimeCredential, timingSafeNonceEqual } from './admission.js';
import { AttemptStore, newAttemptId, newRequestId, scopedAttemptHash } from './attempts.js';
import type { EvidenceCode } from '@bravo/auth-balancer-contract';

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
 * Transport failures that killed the connection before application request
 * bytes may have been written, and are therefore safe to re-send on the same
 * account.
 *
 * `pre-wire` is the hard precondition. "No response headers reached the client"
 * is not proof that upstream did no work, so after-wire generation failures are
 * terminal by default. Within pre-wire, only errors meaning "the connection
 * broke" qualify. A header TIMEOUT is deliberately excluded: the server is
 * plausibly still working on that inference, and re-sending would bill a second
 * one.
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

/** Attempts added after the first, on a retryable pre-wire transport failure. */
export const TRANSPORT_RETRY_LIMIT = 2;

/** Backoff before each transport retry. Short: the connection died instantly. */
export const TRANSPORT_RETRY_BACKOFF_MS = [150, 600];
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_CONFIGURABLE_REQUEST_BODY_BYTES = 512 * 1024 * 1024;
export const REPORT_ONLY_MEMORY_CEILING_BYTES = DEFAULT_MAX_REQUEST_BODY_BYTES;
export const CONTROL_BODY_DRAIN_TIMEOUT_MS = 1000;
export const CONTROL_BODY_DRAIN_LIMIT_BYTES = 64 * 1024;

export type BodyLimitMode = 'report-only' | 'enforce';
export type ClaudeTlsPolicy = 'fresh_tls_quarantine' | 'keepalive_no_tls_cache' | 'keepalive_with_tls_cache';
export const TLS_POLICY_VERSION = 'claude-tls-policy-v1';

/**
 * A pre-wire transport failure re-sends only when the connection itself
 * broke. Anything else — a header timeout above all — is terminal, because the
 * request may already be running upstream.
 */
export function isRetryableTransportError(error: {
  phase?: string;
  code?: string;
}): boolean {
  if (error.phase !== 'pre-wire' && error.phase !== 'pre-header') return false;
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
  /** Window before a 7d reset inside which unspent quota pulls sessions. 0 disables. */
  expiringHorizonMs?: number;
  leaseTtlMs?: number;
  /** Retry a 429 once on a different account. Safe: 429 arrives before any body. */
  retryOnRateLimit?: boolean;
  /** Record per-request usage metrics to SQLite. Default true. */
  metrics?: boolean;
  /** Raw-row retention window; the daily rollup is kept forever. */
  metricsRetentionDays?: number;
  /** Maximum connect/TLS/header wait. Streaming after headers is not limited. */
  upstreamHeaderTimeoutMs?: number;
  /** Runtime local nonce check. Defaults on; tests may disable explicitly. */
  requireGatewayAuth?: boolean;
  /** Request body cap for report-only or enforcement. */
  maxRequestBodyBytes?: number;
  /** Report body size only, or enforce with a local 413. */
  bodyLimitMode?: BodyLimitMode;
  /** Disable hidden generation retries and 429 rotation. */
  strictGenerationRetry?: boolean;
  /** Inference HTTPS transport policy. */
  tlsPolicy?: ClaudeTlsPolicy;
  /** Attempt telemetry. Default true. */
  attempts?: boolean;
  /** Package-test seam; production defaults to probing enabled. */
  usageProbe?: boolean;
  now?: () => number;
  log?: (event: ProxyLogEvent) => void;
};

type Resolved = Required<Omit<ProxyOptions, 'log' | 'now'>> & {
  now: () => number;
  log: (event: ProxyLogEvent) => void;
};

export function validateMaxRequestBodyBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`maxRequestBodyBytes must be a finite positive integer at or below ${MAX_CONFIGURABLE_REQUEST_BODY_BYTES}`);
  }
  if (value > MAX_CONFIGURABLE_REQUEST_BODY_BYTES) {
    throw new RangeError(`maxRequestBodyBytes must be at or below ${MAX_CONFIGURABLE_REQUEST_BODY_BYTES}`);
  }
  return value;
}

function resolveOptions(options: ProxyOptions): Resolved {
  return {
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? '127.0.0.1',
    upstream: options.upstream ?? DEFAULT_UPSTREAM,
    stateRoot: options.stateRoot ?? resolveStateRoot(),
    authswapRoot: options.authswapRoot ?? resolveAuthswapRoot(),
    allowOverage: options.allowOverage ?? false,
    expiringHorizonMs: options.expiringHorizonMs ?? DEFAULT_EXPIRING_WEEKLY_HORIZON_MS,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    retryOnRateLimit: options.retryOnRateLimit ?? true,
    metrics: options.metrics ?? true,
    metricsRetentionDays: options.metricsRetentionDays ?? DEFAULT_RAW_RETENTION_DAYS,
    upstreamHeaderTimeoutMs: options.upstreamHeaderTimeoutMs ?? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS,
    requireGatewayAuth: options.requireGatewayAuth ?? true,
    maxRequestBodyBytes: validateMaxRequestBodyBytes(options.maxRequestBodyBytes),
    bodyLimitMode: options.bodyLimitMode ?? 'report-only',
    strictGenerationRetry: options.strictGenerationRetry ?? false,
    tlsPolicy: options.tlsPolicy ?? 'fresh_tls_quarantine',
    attempts: options.attempts ?? true,
    usageProbe: options.usageProbe ?? true,
    now: options.now ?? Date.now,
    log: options.log ?? (() => {}),
  };
}

class BodyLimitError extends Error {
  readonly bytesRead: number;
  readonly limit: number;
  readonly reasonCode: 'request_body_too_large' | 'request_body_memory_ceiling';
  constructor(bytesRead: number, limit: number, reasonCode: 'request_body_too_large' | 'request_body_memory_ceiling' = 'request_body_too_large') {
    super(`request body exceeded ${limit} bytes`);
    this.name = 'BodyLimitError';
    this.bytesRead = bytesRead;
    this.limit = limit;
    this.reasonCode = reasonCode;
  }
}

function readBody(req: http.IncomingMessage, limitBytes: number, mode: BodyLimitMode): Promise<{ body: Buffer; bytesRead: number; overLimit: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let overLimit = false;
    let settled = false;
    req.on('data', c => {
      const chunk = c as Buffer;
      bytesRead += chunk.length;
      if (bytesRead > limitBytes) {
        overLimit = true;
        if (mode === 'enforce' && !settled) {
          settled = true;
          chunks.length = 0;
          req.resume();
          reject(new BodyLimitError(bytesRead, limitBytes));
          return;
        }
      }
      if (mode === 'report-only' && bytesRead > REPORT_ONLY_MEMORY_CEILING_BYTES && !settled) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new BodyLimitError(bytesRead, REPORT_ONLY_MEMORY_CEILING_BYTES, 'request_body_memory_ceiling'));
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ body: Buffer.concat(chunks), bytesRead, overLimit });
    });
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
  evidence: ForwardEvidence;
};

type ForwardEvidence = {
  wireStarted: boolean;
  requestBytesWritten: number;
  responseHeadersReceived: boolean;
  connectionPhase: string;
  socketReused?: boolean;
  tlsSessionReused?: boolean;
  handshakeDurationMs?: number;
};

type ForwardError = NodeJS.ErrnoException & {
  phase?: string;
  durationMs?: number;
  reusedSocket?: boolean;
  evidence?: ForwardEvidence;
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
    const evidence: ForwardEvidence = {
      wireStarted: false,
      requestBytesWritten: 0,
      responseHeadersReceived: false,
      connectionPhase: 'connect',
    };
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
        evidence.responseHeadersReceived = true;
        evidence.connectionPhase = 'headers';
        evidence.socketReused = upstreamReq.reusedSocket;
        resolve({ status: res.statusCode ?? 502, headers: res.headers, stream: res, request: upstreamReq, evidence });
      },
    );
    upstreamReq.on('socket', socket => {
      const assignedAt = Date.now();
      evidence.connectionPhase = 'socket';
      socket.once('connect', () => {
        evidence.connectionPhase = 'connect';
        evidence.socketReused = upstreamReq.reusedSocket;
      });
      socket.once('secureConnect', () => {
        evidence.connectionPhase = 'tls';
        evidence.socketReused = upstreamReq.reusedSocket;
        evidence.handshakeDurationMs = Date.now() - assignedAt;
        if ('isSessionReused' in socket) {
          evidence.tlsSessionReused = (socket as TLSSocket).isSessionReused();
        }
      });
    });
    upstreamReq.on('error', error => {
      clearTimeout(timer);
      const detail = error as ForwardError;
      detail.phase = evidence.wireStarted ? 'after-wire' : 'pre-wire';
      detail.durationMs = Date.now() - started;
      detail.reusedSocket = upstreamReq.reusedSocket;
      detail.evidence = { ...evidence, socketReused: upstreamReq.reusedSocket };
      reject(detail);
    });
    timer = setTimeout(() => {
      const error = new Error(`upstream headers timed out after ${headerTimeoutMs}ms`) as NodeJS.ErrnoException;
      error.code = 'UPSTREAM_HEADERS_TIMEOUT';
      upstreamReq.destroy(error);
    }, headerTimeoutMs);
    if (body.length > 0) {
      evidence.wireStarted = true;
      evidence.requestBytesWritten = body.length;
      evidence.connectionPhase = 'request';
      upstreamReq.write(body);
    }
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
  onComplete: (observation: { usage?: Usage; model?: string; observationFailed: boolean }) => void,
  onContentStart?: () => void,
  onStreamError?: (error: Error, contentStarted: boolean) => void,
  onAbort?: (contentStarted: boolean) => void,
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
  let observationSettled = false;
  let terminalSettled = false;
  let contentStarted = false;
  let observationFailed = false;
  let upstreamEnded = false;
  let observedUsage: { usage: Usage; model: string | undefined } | undefined;

  const collectUsage = (): { usage: Usage; model: string | undefined } => {
    if (observedUsage) return observedUsage;
    if (observationSettled) {
      observedUsage = { usage: {}, model: collector.model };
      return observedUsage;
    }
    observationSettled = true;
    let usage = collector.end();
    if (
      usage.inputTokens === undefined &&
      usage.outputTokens === undefined &&
      usage.cacheReadInputTokens === undefined
    ) {
      const fromJson = usageFromJsonBody(fallback);
      if (Object.values(fromJson).some(v => v !== undefined)) usage = fromJson;
    }
    observedUsage = { usage, model: collector.model };
    return observedUsage;
  };

  const failObservation = () => {
    observationFailed = true;
    observationSettled = true;
    if (upstreamEnded) completeSuccessfully();
  };

  const completeSuccessfully = () => {
    if (terminalSettled) return;
    terminalSettled = true;
    const observed = observationFailed ? undefined : collectUsage();
    onComplete({
      usage: observed?.usage,
      model: observed?.model,
      observationFailed,
    });
  };

  const observe = (text: string) => {
    if (!contentStarted && text.length > 0) {
      contentStarted = true;
      onContentStart?.();
    }
    collector.push(text);
    if (wantFallback && fallback.length < JSON_FALLBACK_LIMIT) fallback += text;
  };

  // A cancelled turn (Esc, or the user typing during generation) destroys
  // `res`. Without this the upstream generation runs to completion against a
  // dead socket, burning full output tokens against the 5h/7d claims — a silent
  // quota leak in a proxy whose whole purpose is conserving quota.
  res.on('close', () => {
    if (!res.writableEnded) {
      if (!observationFailed) collectUsage();
      if (!terminalSettled) {
        terminalSettled = true;
        onAbort?.(contentStarted);
      }
      result.request.destroy();
      result.stream.destroy();
    }
  });

  // `Readable.pipe()` does NOT close the destination when the source errors.
  // An upstream that sends 200 plus a partial SSE body and then drops its
  // socket would otherwise leave the client waiting forever, because headers
  // are already sent and no terminal chunk ever arrives. Destroy explicitly.
  const abortDownstream = (error: Error) => {
    if (!observationFailed) collectUsage();
    if (!terminalSettled) {
      terminalSettled = true;
      onStreamError?.(error, contentStarted);
    }
    if (!res.writableEnded) res.destroy(error);
  };

  if (decompressor) {
    decompressor.on('data', (chunk: Buffer) => observe(chunk.toString('utf8')));
    decompressor.on('end', completeSuccessfully);
    // Observation must never take the process down or break the relay.
    decompressor.on('error', failObservation);
    result.stream.on('data', (chunk: Buffer) => {
      try {
        decompressor.write(chunk);
      } catch {
        failObservation();
      }
    });
    result.stream.on('end', () => {
      upstreamEnded = true;
      try {
        decompressor.end();
      } catch {
        failObservation();
        completeSuccessfully();
      }
      if (observationFailed) completeSuccessfully();
    });
    result.stream.on('error', abortDownstream);
  } else {
    result.stream.on('data', (chunk: Buffer) => observe(chunk.toString('utf8')));
    result.stream.on('end', completeSuccessfully);
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

function drainControlBody(stream: http.IncomingMessage, timeoutMs = CONTROL_BODY_DRAIN_TIMEOUT_MS, limitBytes = CONTROL_BODY_DRAIN_LIMIT_BYTES): Promise<EvidenceCode[]> {
  return new Promise(resolve => {
    const evidence: EvidenceCode[] = ['control_body_bounded'];
    let bytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(evidence);
    };
    const timer = setTimeout(() => {
      evidence.push('control_body_deadline_reached');
      stream.destroy();
      finish();
    }, timeoutMs);
    timer.unref();
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        evidence.push('control_body_byte_limit_reached');
        stream.destroy();
        finish();
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.resume();
  });
}

function makeHttpsAgent(policy: ClaudeTlsPolicy): https.Agent {
  switch (policy) {
    case 'keepalive_no_tls_cache':
      return new https.Agent({ keepAlive: true, maxCachedSessions: 0 });
    case 'keepalive_with_tls_cache':
      return new https.Agent({ keepAlive: true });
    case 'fresh_tls_quarantine':
    default:
      return new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
  }
}

function endpointClass(pathname: string): string {
  if (pathname === '/v1/messages') return 'generation';
  if (pathname.endsWith('/count_tokens')) return 'count_tokens';
  return 'other';
}

function isGenerationEndpoint(className: string): boolean {
  return className === 'generation';
}

export function createProxy(options: ProxyOptions = {}): http.Server {
  const opts = resolveOptions(options);
  const server_close_hooks: (() => void)[] = [];
  // The nonce persists across restarts, so it is never removed on shutdown:
  // unlinking it would regenerate it on the next start and 401 every client
  // that read the old value.
  const runtimeCredential = opts.requireGatewayAuth ? ensureRuntimeCredential(opts.stateRoot) : undefined;
  // Per-client nonces live on disk and survive daemon restarts, so clients
  // launched against a previous daemon instance keep authenticating. The
  // gateway nonce above remains for manual and apiKeyHelper clients.
  const clientCredentials = opts.requireGatewayAuth ? new ClientCredentialStore(opts.stateRoot) : undefined;
  // A proxy instance owns exactly one inference HTTPS agent. Disabling both
  // socket keep-alive and the TLS session cache ensures every attempt gets a
  // fresh TCP connection and a full TLS handshake.
  const upstreamHttpsAgent = makeHttpsAgent(opts.tlsPolicy);
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
  const attempts = opts.attempts ? new AttemptStore(opts.stateRoot) : undefined;
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

  const opening = new Map<string, Promise<void>>();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const reqPath = (req.url ?? '/').split('?')[0]!;
    const requestId = newRequestId();
    const className = endpointClass(reqPath);
    const startedAt = opts.now();
    const recordAttempt = (input: Omit<Parameters<AttemptStore['record']>[0], 'request_id' | 'public_model_id' | 'endpoint_class' | 'duration_ms'> & {
      public_model_id?: string;
      duration_ms?: number;
    }) => {
      try {
        attempts?.record({
          request_id: requestId,
          public_model_id: input.public_model_id ?? 'unknown',
          endpoint_class: className,
          duration_ms: input.duration_ms ?? opts.now() - startedAt,
          ...input,
        });
      } catch {
        /* attempt telemetry must never mask the proxied response */
      }
    };

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
      recordAttempt({
        phase: 'admission',
        outcome: 'security_rejected',
        reason_code: 'bad_request_target',
        evidence_codes: ['local_security_validated', 'no_application_bytes_written', 'global_auth_fallback_blocked'],
        wire_started: false,
        content_started: false,
        retry_eligible: false,
        rotation_eligible: false,
      });
      req.resume();
      return;
    }

    const presentedCredential = req.headers[RUNTIME_CREDENTIAL_HEADER];
    const presentedNonce = Array.isArray(presentedCredential) ? presentedCredential[0] : presentedCredential;
    const instanceNonceOk = runtimeCredential ? timingSafeNonceEqual(presentedNonce, runtimeCredential.nonce) : true;
    if (runtimeCredential && !instanceNonceOk && !clientCredentials!.verify(presentedNonce)) {
      opts.log({
        kind: 'error',
        method,
        path: reqPath,
        message: 'rejected invalid local gateway credential',
      });
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'claude-auth-balancer: invalid local gateway credential' },
        }),
      );
      recordAttempt({
        phase: 'admission',
        outcome: 'security_rejected',
        reason_code: 'invalid_local_nonce',
        evidence_codes: ['local_security_validated', 'no_application_bytes_written', 'global_auth_fallback_blocked'],
        wire_started: false,
        content_started: false,
        retry_eligible: false,
        rotation_eligible: false,
      });
      req.resume();
      return;
    }

    let body: Buffer;
    let bodyBytesRead = 0;
    let bodyOverLimit = false;
    try {
      const read = await readBody(req, opts.maxRequestBodyBytes, opts.bodyLimitMode);
      body = read.body;
      bodyBytesRead = read.bytesRead;
      bodyOverLimit = read.overLimit;
    } catch (error) {
      if (error instanceof BodyLimitError) {
        recordAttempt({
          phase: 'admission',
          outcome: 'body_limit_rejected',
          reason_code: error.reasonCode,
          evidence_codes: [
            'local_security_validated',
            'no_application_bytes_written',
            ...(error.reasonCode === 'request_body_memory_ceiling' ? ['body_size_observed'] as const : []),
            'body_limit_enforced',
          ],
          request_bytes_written: 0,
          wire_started: false,
          content_started: false,
          retry_eligible: false,
          rotation_eligible: false,
        });
        res.writeHead(413, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: `claude-auth-balancer: request body exceeds ${error.limit} bytes` },
          }),
        );
        return;
      }
      res.writeHead(400).end();
      return;
    }

    const model = modelFromBody(body);
    const sessionHeader = req.headers[SESSION_HEADER];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const sessionHash = scopedAttemptHash(opts.stateRoot, 'session', sessionId ? AffinityStore.hashSession(sessionId, model) : undefined);
    if (bodyOverLimit) {
      recordAttempt({
        phase: 'admission',
        outcome: 'completed',
        public_model_id: model ?? 'unknown',
        reason_code: 'request_body_limit_report_only',
        evidence_codes: ['local_security_validated', 'body_size_observed'],
        request_bytes_written: 0,
        session_hash: sessionHash,
        wire_started: false,
        content_started: false,
        retry_eligible: false,
        rotation_eligible: false,
      });
    }

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
        expiringHorizonMs: opts.expiringHorizonMs,
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
        recordAttempt({
          phase: 'selection',
          outcome: 'exhausted',
          public_model_id: model ?? 'unknown',
          session_hash: sessionHash,
          reason_code: selection.reason,
          evidence_codes: ['attempt_record_durable', sessionId ? 'affinity_read_before_selection' : 'sessionless_request'],
          wire_started: false,
          content_started: false,
          retry_eligible: false,
          rotation_eligible: false,
        });
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
        recordAttempt({
          phase: 'credential',
          outcome: 'credential_unavailable',
          public_model_id: model ?? 'unknown',
          session_hash: sessionHash,
          slot_id: selection.slot,
          reason_code: refreshed.status === 'failed' ? refreshed.kind : refreshed.reason,
          evidence_codes: [
            'credential_refresh_attempted',
            refreshed.status === 'failed' && refreshed.kind === 'terminal' ? 'credential_refresh_terminal' : 'credential_refresh_transient',
            'credential_unusable_before_wire',
            'no_application_bytes_written',
            'attempt_record_durable',
          ],
          wire_started: false,
          content_started: false,
          retry_eligible: false,
          rotation_eligible: true,
        });
      }
      const oauth = readOAuth(account.credentialPath);
      if (!oauth || (oauth.expiresAt !== undefined && oauth.expiresAt <= opts.now())) {
        // Still unusable after the refresh attempt. Exclude and let the loop
        // try another account rather than sending a dead token to the wire.
        excluded.add(selection.slot);
        recordAttempt({
          phase: 'credential',
          outcome: 'auth_unusable',
          public_model_id: model ?? 'unknown',
          session_hash: sessionHash,
          slot_id: selection.slot,
          reason_code: 'token_unusable_after_refresh',
          evidence_codes: ['credential_unusable_before_wire', 'no_application_bytes_written', 'attempt_record_durable'],
          wire_started: false,
          content_started: false,
          retry_eligible: false,
          rotation_eligible: true,
        });
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
      recordAttempt({
        phase: 'selection',
        outcome: selection.decision === 'fresh'
          ? 'fresh_placed'
          : selection.decision === 'affinity-hold' || selection.decision === 'evacuating-fallback'
            ? 'affinity_preserved'
            : selection.decision === 'affinity-broken'
              ? 'affinity_replaced'
              : selection.decision === 'overage-fallback'
                ? 'affinity_preserved'
                : 'fresh_placed',
        public_model_id: model ?? 'unknown',
        session_hash: sessionHash,
        slot_id: selection.slot,
        account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
        reason_code: selection.decision,
        evidence_codes: [
          'local_security_validated',
          'selected_slot_credential_used',
          'account_connection_attributed',
          sessionId ? 'affinity_published_before_async_work' : 'sessionless_request',
          'attempt_record_durable',
        ],
        wire_started: false,
        content_started: false,
        retry_eligible: false,
        rotation_eligible: false,
      });

      // Retry a broken connection on the SAME account. Rotating would be wrong
      // twice over: the account is not at fault, and moving the session pays a
      // full cache re-create for a socket-level fault.
      let result: UpstreamResult | undefined;
      let finalAttemptId: string | undefined;
      for (let transportAttempt = 0; ; transportAttempt += 1) {
        const upstreamAttemptId = newAttemptId();
        finalAttemptId = upstreamAttemptId;
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
          const detail = error as ForwardError;
          const wireStarted = detail.evidence?.wireStarted === true;
          const retryableByWire =
            isRetryableTransportError(detail) &&
            (!isGenerationEndpoint(className) || !wireStarted) &&
            !(opts.strictGenerationRetry && isGenerationEndpoint(className));
          const willRetry =
            transportAttempt < TRANSPORT_RETRY_LIMIT && retryableByWire;
          recordAttempt({
            attempt_id: upstreamAttemptId,
            phase: wireStarted ? 'request' : 'connect',
            outcome: wireStarted ? 'transport_failed_after_wire' : 'transport_failed_before_wire',
            public_model_id: model ?? 'unknown',
            session_hash: sessionHash,
            slot_id: selection.slot,
            account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
            reason_code: willRetry ? 'retryable_transport_failure' : 'terminal_transport_failure',
            transport_mode: opts.tlsPolicy,
            transport_policy_version: TLS_POLICY_VERSION,
            connection_phase: detail.evidence?.connectionPhase ?? detail.phase,
            socket_reused: detail.evidence?.socketReused ?? detail.reusedSocket,
            tls_session_reused: detail.evidence?.tlsSessionReused,
            handshake_duration_ms: detail.evidence?.handshakeDurationMs,
            request_bytes_written: detail.evidence?.requestBytesWritten ?? 0,
            response_headers_received: false,
            error_code: detail.code,
            evidence_codes: [
              wireStarted ? 'request_bytes_written' : 'no_application_bytes_written',
              wireStarted ? 'transport_failure_after_wire' : 'transport_failure_pre_wire',
              'transport_policy_recorded',
              'socket_reuse_recorded',
              'tls_session_reuse_recorded',
              'attempt_record_durable',
            ],
            wire_started: wireStarted,
            content_started: false,
            retry_eligible: willRetry,
            rotation_eligible: false,
          });
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
            recordAttempt({
              phase: 'terminal',
              outcome: 'retried_same_slot',
              public_model_id: model ?? 'unknown',
              parent_attempt_id: upstreamAttemptId,
              session_hash: sessionHash,
              slot_id: selection.slot,
              account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
              reason_code: 'pre_wire_transport_retry',
              transport_mode: opts.tlsPolicy,
              transport_policy_version: TLS_POLICY_VERSION,
              evidence_codes: ['same_slot_retry_recorded', 'no_application_bytes_written', 'attempt_record_durable'],
              wire_started: false,
              content_started: false,
              retry_eligible: false,
              rotation_eligible: false,
            });
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
      if (result.status === 429 && opts.retryOnRateLimit && !(opts.strictGenerationRetry && isGenerationEndpoint(className))) {
        // Prefer waiting over rotating when the window reopens shortly: this
        // session's warm prefix lives on THIS account, and abandoning it costs
        // 20x on the next request plus a full prefill.
        const waitMs = retryAfterMs(result.headers);
        const controlEvidence = await drainControlBody(result.stream);
        recordAttempt({
          attempt_id: finalAttemptId,
          phase: 'headers',
          outcome: 'rate_limited_pre_content',
          public_model_id: model ?? 'unknown',
          session_hash: sessionHash,
          slot_id: selection.slot,
          account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
          reason_code: waitMs !== undefined && waitMs <= RETRY_AFTER_WAIT_CEILING_MS ? 'short_retry_after' : 'rotate_on_429',
          transport_mode: opts.tlsPolicy,
          transport_policy_version: TLS_POLICY_VERSION,
          connection_phase: result.evidence.connectionPhase,
          socket_reused: result.evidence.socketReused,
          tls_session_reused: result.evidence.tlsSessionReused,
          handshake_duration_ms: result.evidence.handshakeDurationMs,
          request_bytes_written: result.evidence.requestBytesWritten,
          response_headers_received: true,
          upstream_status: 429,
          evidence_codes: [
            'explicit_429_rejection',
            'content_not_started',
            'request_bytes_written',
            'response_headers_received',
            'transport_policy_recorded',
            'attempt_record_durable',
            ...controlEvidence,
          ],
          wire_started: result.evidence.wireStarted,
          content_started: false,
          retry_eligible: false,
          rotation_eligible: waitMs === undefined || waitMs > RETRY_AFTER_WAIT_CEILING_MS,
        });
        if (
          waitMs !== undefined &&
          waitMs <= RETRY_AFTER_WAIT_CEILING_MS &&
          !waitedOnRateLimit &&
          sessionId !== undefined
        ) {
          waitedOnRateLimit = true;
          opts.log({
            kind: 'retry',
            method,
            path: reqPath,
            slot: selection.slot,
            status: 429,
            reason: `retry-after ${Math.round(waitMs / 1000)}s; waiting rather than paying a cache re-create`,
          });
          recordAttempt({
            phase: 'terminal',
            outcome: 'waited_same_slot',
            public_model_id: model ?? 'unknown',
            parent_attempt_id: finalAttemptId,
            session_hash: sessionHash,
            slot_id: selection.slot,
            account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
            reason_code: 'short_retry_after',
            wait_ms: Math.round(waitMs),
            evidence_codes: ['wait_recorded', 'retry_after_short_wait', 'attempt_record_durable'],
            wire_started: false,
            content_started: false,
            retry_eligible: false,
            rotation_eligible: false,
          });
          await sleep(waitMs);
          return false;
        }
        excluded.add(selection.slot);
        opts.log({
          kind: 'retry',
          method,
          path: reqPath,
          slot: selection.slot,
          status: 429,
          reason: 'rate limited; rotating account',
        });
        recordAttempt({
          phase: 'terminal',
          outcome: 'rotated_pre_content',
          public_model_id: model ?? 'unknown',
          parent_attempt_id: finalAttemptId,
          session_hash: sessionHash,
          slot_id: selection.slot,
          account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
          reason_code: 'rate_limited_pre_content',
          evidence_codes: ['rotation_recorded', 'explicit_429_rejection', 'content_not_started', 'attempt_record_durable'],
          wire_started: false,
          content_started: false,
          retry_eligible: false,
          rotation_eligible: false,
        });
        return false;
      }

      let contentStartRecorded = false;
      relayAndObserve(res, result, ({ usage, model: streamedModel, observationFailed }) => {
        recordAttempt({
          attempt_id: finalAttemptId,
          phase: 'terminal',
          outcome: 'completed',
          public_model_id: streamedModel ?? model ?? 'unknown',
          session_hash: sessionHash,
          slot_id: selection.slot,
          account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
          reason_code: observationFailed ? 'upstream_completed_observation_failed' : 'upstream_completed',
          transport_mode: opts.tlsPolicy,
          transport_policy_version: TLS_POLICY_VERSION,
          connection_phase: result.evidence.connectionPhase,
          socket_reused: result.evidence.socketReused,
          tls_session_reused: result.evidence.tlsSessionReused,
          handshake_duration_ms: result.evidence.handshakeDurationMs,
          request_bytes_written: result.evidence.requestBytesWritten,
          response_headers_received: true,
          upstream_status: result.status,
          evidence_codes: [
            'selected_slot_credential_used',
            'account_connection_attributed',
            'response_headers_received',
            'transport_policy_recorded',
            'socket_reuse_recorded',
            'tls_session_reuse_recorded',
            'terminal_outcome_recorded',
            'attempt_record_durable',
          ],
          wire_started: result.evidence.wireStarted,
          content_started: contentStartRecorded,
          retry_eligible: false,
          rotation_eligible: false,
        });
        if (!metrics || !usage) return;
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
      }, () => {
        if (contentStartRecorded) return;
        contentStartRecorded = true;
        recordAttempt({
          phase: 'content',
          outcome: 'content_started',
          public_model_id: model ?? 'unknown',
          parent_attempt_id: finalAttemptId,
          session_hash: sessionHash,
          slot_id: selection.slot,
          account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
          transport_mode: opts.tlsPolicy,
          transport_policy_version: TLS_POLICY_VERSION,
          evidence_codes: ['content_started_observed', 'attempt_record_durable'],
          wire_started: result.evidence.wireStarted,
          content_started: true,
          retry_eligible: false,
          rotation_eligible: false,
        });
      }, error => {
        recordAttempt({
          phase: 'terminal',
          outcome: 'terminal_failure',
          public_model_id: model ?? 'unknown',
          parent_attempt_id: finalAttemptId,
          session_hash: sessionHash,
          slot_id: selection.slot,
          account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
          reason_code: 'stream_error_after_headers',
          transport_mode: opts.tlsPolicy,
          transport_policy_version: TLS_POLICY_VERSION,
          error_code: (error as NodeJS.ErrnoException).code,
          evidence_codes: [
            contentStartRecorded ? 'content_started_observed' : 'content_not_started',
            'terminal_outcome_recorded',
            'attempt_record_durable',
          ],
          wire_started: result.evidence.wireStarted,
          content_started: contentStartRecorded,
          retry_eligible: false,
          rotation_eligible: false,
        });
      }, contentStarted => {
        recordAttempt({
          phase: 'terminal',
          outcome: 'aborted',
          public_model_id: model ?? 'unknown',
          parent_attempt_id: finalAttemptId,
          session_hash: sessionHash,
          slot_id: selection.slot,
          account_hash: scopedAttemptHash(opts.stateRoot, 'account', account.email ?? account.slot),
          reason_code: 'client_aborted',
          transport_mode: opts.tlsPolicy,
          transport_policy_version: TLS_POLICY_VERSION,
          evidence_codes: [
            contentStarted ? 'content_started_observed' : 'content_not_started',
            'terminal_outcome_recorded',
            'attempt_record_durable',
          ],
          wire_started: result.evidence.wireStarted,
          content_started: contentStarted,
          retry_eligible: false,
          rotation_eligible: false,
        });
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
        if (sessionId && excluded.size === 0 && affinity.lookup(sessionId, model) === undefined) {
          const key = AffinityStore.hashSession(sessionId, model);
          const active = opening.get(key);
          if (active) {
            await active.catch(() => {});
            continue;
          }
          let release!: () => void;
          const gate = new Promise<void>(resolve => { release = resolve; });
          opening.set(key, gate);
          try {
            done = await attempt(excluded);
          } finally {
            if (opening.get(key) === gate) opening.delete(key);
            release();
          }
        } else {
          done = await attempt(excluded);
        }
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

  let closed = false;
  const closeOwnedResources = () => {
    if (closed) return;
    closed = true;
    for (const hook of server_close_hooks) hook();
    metrics?.close();
    attempts?.close();
  };
  server.on('close', closeOwnedResources);
  server.once('error', closeOwnedResources);
  server.once('listening', () => server.off('error', closeOwnedResources));

  return server;
}

export async function startProxy(options: ProxyOptions = {}): Promise<{ server: http.Server; port: number; url: string }> {
  const opts = resolveOptions(options);
  const server = createProxy(options);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, opts.host, () => resolve());
    });
  } catch (error) {
    server.close(() => {});
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://${opts.host}:${port}` };
}

export { tokenFingerprint };

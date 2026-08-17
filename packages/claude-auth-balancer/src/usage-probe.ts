import http from 'node:http';
import https from 'node:https';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Account, PersistedAccount } from './accounts.js';
import { readOAuth, readSlotObservation, recordObservation } from './accounts.js';
import type { Claim, Claims } from './claims.js';

export const USAGE_PROBE_PATH = '/api/oauth/usage';
export const USAGE_PROBE_BETA = 'oauth-2025-04-20';
export const USAGE_PROBE_STALE_MS = 2 * 60 * 1000;
export const USAGE_PROBE_TIMEOUT_MS = 750;
export const USAGE_PROBE_BODY_LIMIT = 64 * 1024;
const FAILURE_BACKOFF_MS = 15 * 1000;
const RATE_LIMIT_BACKOFF_MS = 60 * 1000;

export type UsageProbeResult = 'updated' | 'backoff' | 'failed' | 'empty';

type LegacyWindow = { utilization?: unknown; resets_at?: unknown; reset?: unknown };

function positiveIsoEpochSeconds(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : undefined;
}

function windowClaim(id: string, value: unknown): Claim | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const window = value as LegacyWindow;
  const utilization =
    typeof window.utilization === 'number' &&
    Number.isFinite(window.utilization) &&
    window.utilization >= 0 &&
    window.utilization <= 100
      ? window.utilization / 100
      : undefined;
  // A fresh usage response without a trustworthy utilization is not useful on
  // its own. Emitting a reset-only claim would replace the prior whole claim in
  // mergeClaims(), silently erasing its utilization and rejected status.
  if (utilization === undefined) return undefined;

  const rawReset = window.resets_at ?? window.reset;
  let reset: number | undefined;
  if (typeof rawReset === 'number' && Number.isFinite(rawReset) && rawReset > 0) {
    const seconds = rawReset > 1e12 ? rawReset / 1000 : rawReset;
    if (Number.isFinite(seconds) && seconds > 0) reset = seconds;
  }
  if (typeof rawReset === 'string') reset = positiveIsoEpochSeconds(rawReset);
  if (reset === undefined) return undefined;
  return { id, utilization, reset, status: utilization >= 1 ? 'rejected' : 'allowed' };
}

/** Map only the legacy windows whose meaning is already represented locally. */
export function claimsFromUsageBody(body: unknown): Claims | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as Record<string, unknown>;
  const mappings: [string, string][] = [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ];
  const byId: Record<string, Claim> = {};
  for (const [field, id] of mappings) {
    const claim = windowClaim(id, value[field]);
    if (claim) byId[id] = claim;
  }
  if (Object.keys(byId).length === 0) return undefined;
  return { byId };
}

function retryAfter(headers: http.IncomingHttpHeaders, nowMs: number): number | undefined {
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

export class UsageProbe {
  private readonly inflight = new Map<string, Promise<UsageProbeResult>>();

  constructor(private readonly options: {
    upstream: string;
    stateRoot: string;
    now: () => number;
    timeoutMs?: number;
    /** Refresh/validate the slot before its canonical credential is reread. */
    prepare?: (account: Account) => Promise<unknown>;
  }) {}

  isDue(observation: PersistedAccount | undefined): boolean {
    const now = this.options.now();
    if (observation?.observedAt === undefined || now - observation.observedAt >= USAGE_PROBE_STALE_MS) {
      return true;
    }
    // Read the persisted (unprojected) reset. Projected policy state advances
    // this timestamp and would otherwise hide the exact rollover that requires
    // a fresh server reading before a new lease is selected.
    return ['5h', '7d'].some(id => {
      const reset = observation.claims?.byId[id]?.reset;
      return reset !== undefined && reset * 1000 <= now;
    });
  }

  probe(account: Account): Promise<UsageProbeResult> {
    const existing = this.inflight.get(account.slot);
    if (existing) return existing;
    const pending = this.run(account).finally(() => this.inflight.delete(account.slot));
    this.inflight.set(account.slot, pending);
    return pending;
  }

  private backoffPath(slot: string): string {
    return path.join(this.options.stateRoot, 'state', 'usage-probe', `${encodeURIComponent(slot)}.json`);
  }

  private readBackoff(slot: string): number {
    try {
      const parsed = JSON.parse(readFileSync(this.backoffPath(slot), 'utf8')) as { retryAt?: unknown };
      return typeof parsed.retryAt === 'number' ? parsed.retryAt : 0;
    } catch { return 0; }
  }

  private writeBackoff(slot: string, retryAt: number): void {
    const target = this.backoffPath(slot);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ retryAt }), { mode: 0o600 });
    renameSync(tmp, target);
  }

  private async run(account: Account): Promise<UsageProbeResult> {
    const startedAt = this.options.now();
    const initialObservation = JSON.stringify(readSlotObservation(this.options.stateRoot, account.slot));
    if (this.readBackoff(account.slot) > startedAt) return 'backoff';
    try {
      await this.options.prepare?.(account);
    } catch {
      this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
      return 'failed';
    }
    // Preparation may rotate the access token, so never retain a credential
    // read from before it completed.
    const oauth = readOAuth(account.credentialPath);
    if (!oauth || (oauth.expiresAt !== undefined && oauth.expiresAt <= this.options.now())) return 'failed';
    const base = new URL(this.options.upstream);
    const target = new URL(USAGE_PROBE_PATH, base);
    if (target.origin !== base.origin) return 'failed';
    const agent = target.protocol === 'http:' ? http : https;

    return new Promise(resolve => {
      let settled = false;
      let response: http.IncomingMessage | undefined;
      let req: http.ClientRequest;
      const deadline = setTimeout(() => {
        this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
        finish('failed');
        response?.destroy();
        req.destroy(new Error('usage probe wall-clock deadline exceeded'));
      }, this.options.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS);
      const finish = (result: UsageProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      req = agent.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: USAGE_PROBE_PATH,
        method: 'GET',
        headers: {
          authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': USAGE_PROBE_BETA,
          accept: 'application/json',
        },
      }, res => {
        response = res;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= USAGE_PROBE_BODY_LIMIT) {
            chunks.push(chunk);
            return;
          }
          this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
          finish('failed');
          res.destroy();
        });
        res.on('end', () => {
          if (res.statusCode === 429) {
            this.writeBackoff(account.slot, this.options.now() + (retryAfter(res.headers, this.options.now()) ?? RATE_LIMIT_BACKOFF_MS));
            finish('backoff');
            return;
          }
          if (res.statusCode !== 200) {
            this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
            finish('failed');
            return;
          }
          try {
            const claims = claimsFromUsageBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (!claims) { finish('empty'); return; }
            // Inference headers that landed while this slower read was in
            // flight are authoritative, even when an injected clock gives both
            // observations the same timestamp.
            if (JSON.stringify(readSlotObservation(this.options.stateRoot, account.slot)) === initialObservation) {
              recordObservation(this.options.stateRoot, account.slot, claims, startedAt, account.email);
            }
            finish('updated');
          } catch {
            this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
            finish('failed');
          }
        });
      });
      req.on('error', () => {
        this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
        finish('failed');
      });
      req.end();
    });
  }
}

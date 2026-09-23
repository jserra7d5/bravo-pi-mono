import http from 'node:http';
import https from 'node:https';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Account, PersistedAccount } from './accounts.js';
import { readOAuth, readSlotObservation, readSlotPlan, recordObservation, writeSlotPlan } from './accounts.js';
import type { Claim, Claims } from './claims.js';

export const USAGE_PROBE_PATH = '/api/oauth/usage';
export const USAGE_PROBE_BETA = 'oauth-2025-04-20';
export const USAGE_PROBE_STALE_MS = 2 * 60 * 1000;
export const USAGE_PROBE_TIMEOUT_MS = 750;
export const USAGE_PROBE_BODY_LIMIT = 64 * 1024;
export const PROFILE_PROBE_PATH = '/api/oauth/profile';
/** A plan changes only on an upgrade or downgrade, so a daily read is plenty. */
export const PLAN_PROBE_STALE_MS = 24 * 60 * 60 * 1000;
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

  // A window that has rolled over and not been reopened comes back as
  // `{utilization: 0.0, resets_at: null}`. That is a real reading of an idle
  // account, not missing data, and it is the ONLY reading an untouched account
  // ever produces: the server opens a window on first use, so no amount of
  // waiting will make a reset appear. Dropping it freezes `observedAt` at the
  // account's last request, and the statusline reads "stale" until real traffic
  // happens to land there.
  //
  // Only a zero utilization qualifies. A nonzero utilization with no window is
  // a shape the server has never sent, and admitting it would let a malformed
  // response replace a real claim through mergeClaims().
  if (rawReset === null || rawReset === undefined) {
    return utilization === 0 ? { id, utilization: 0, status: 'allowed' } : undefined;
  }

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

/** `organization.rate_limit_tier` from a profile response, e.g. `default_claude_max_5x`. */
export function tierFromProfileBody(body: unknown): string | undefined {
  const org = (body as { organization?: { rate_limit_tier?: unknown } } | null)?.organization;
  const tier = org?.rate_limit_tier;
  return typeof tier === 'string' && tier.length > 0 ? tier : undefined;
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
    const token = await this.prepareToken(account);
    if (token === 'prepare-failed') this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
    if (typeof token !== 'object') return 'failed';
    const res = await this.get(USAGE_PROBE_PATH, token.accessToken);
    if (res === undefined || res.status !== 200 && res.status !== 429) {
      this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
      return 'failed';
    }
    if (res.status === 429) {
      this.writeBackoff(account.slot, this.options.now() + (retryAfter(res.headers, this.options.now()) ?? RATE_LIMIT_BACKOFF_MS));
      return 'backoff';
    }
    try {
      const claims = claimsFromUsageBody(JSON.parse(res.body));
      if (!claims) return 'empty';
      // Inference headers that landed while this slower read was in
      // flight are authoritative, even when an injected clock gives both
      // observations the same timestamp.
      if (JSON.stringify(readSlotObservation(this.options.stateRoot, account.slot)) === initialObservation) {
        recordObservation(this.options.stateRoot, account.slot, claims, startedAt, account.email);
      }
      return 'updated';
    } catch {
      this.writeBackoff(account.slot, this.options.now() + FAILURE_BACKOFF_MS);
      return 'failed';
    }
  }

  /** True when the slot's plan has never been read, or was read over a day ago. */
  isPlanDue(slot: string): boolean {
    const plan = readSlotPlan(this.options.stateRoot, slot);
    return plan === undefined || this.options.now() - plan.observedAt >= PLAN_PROBE_STALE_MS;
  }

  /**
   * Read the account's plan tier. Sweep-only: nothing on the request path
   * waits for it, and a failure keeps the prior plan until the next sweep.
   */
  async probePlan(account: Account): Promise<'updated' | 'failed'> {
    const token = await this.prepareToken(account);
    if (typeof token !== 'object') return 'failed';
    const res = await this.get(PROFILE_PROBE_PATH, token.accessToken);
    if (res?.status !== 200) return 'failed';
    let tier: string | undefined;
    try { tier = tierFromProfileBody(JSON.parse(res.body)); } catch { /* invalid below */ }
    if (tier === undefined) return 'failed';
    writeSlotPlan(this.options.stateRoot, account.slot, { tier, observedAt: this.options.now() });
    return 'updated';
  }

  /** The slot's canonical token after `prepare`. */
  private async prepareToken(account: Account): Promise<{ accessToken: string } | 'prepare-failed' | 'unusable'> {
    try {
      await this.options.prepare?.(account);
    } catch {
      return 'prepare-failed';
    }
    // Preparation may rotate the access token, so never retain a credential
    // read from before it completed.
    const oauth = readOAuth(account.credentialPath);
    if (!oauth || (oauth.expiresAt !== undefined && oauth.expiresAt <= this.options.now())) return 'unusable';
    return { accessToken: oauth.accessToken };
  }

  /**
   * One OAuth GET under an absolute wall-clock deadline covering headers and
   * the whole body, with a body-size limit. Undefined on any transport failure.
   */
  private get(
    requestPath: string,
    token: string,
  ): Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: string } | undefined> {
    const base = new URL(this.options.upstream);
    const target = new URL(requestPath, base);
    if (target.origin !== base.origin) return Promise.resolve(undefined);
    const agent = target.protocol === 'http:' ? http : https;

    return new Promise(resolve => {
      let settled = false;
      let response: http.IncomingMessage | undefined;
      let req: http.ClientRequest;
      const deadline = setTimeout(() => {
        finish(undefined);
        response?.destroy();
        req.destroy(new Error('usage probe wall-clock deadline exceeded'));
      }, this.options.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS);
      const finish = (result: { status?: number; headers: http.IncomingHttpHeaders; body: string } | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      req = agent.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: requestPath,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
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
          finish(undefined);
          res.destroy();
        });
        res.on('end', () => {
          finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', () => finish(undefined));
      req.end();
    });
  }
}

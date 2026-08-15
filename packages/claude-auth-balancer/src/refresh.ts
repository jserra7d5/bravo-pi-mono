// Proactive token refresh.
//
// This is the piece that makes the balancer unattended. Without it, only the
// account Claude Code happens to have made active in authswap stays fresh, and
// every other slot expires within ~12h — which is not a balancer, it is one
// account with extra steps. When this package was first written both stashed
// slots were 92h and 188h past expiry.
//
// Refreshing means writing credential files that authswap and Claude Code also
// write. That is a deliberate reversal of the original "never become a second
// owner of Claude OAuth material" rule: nobody else refreshes the INACTIVE
// slots, so declining to write meant the material simply rotted. Three things
// keep the shared ownership honest:
//
//   - Every write is read-modify-write under a lock, preserving unknown fields,
//     via a temp file and rename so a reader never sees a partial file.
//   - The credential is re-read under the lock right before the exchange, so a
//     refresh Claude Code performed while we waited is adopted instead of being
//     overwritten with our now-stale view.
//   - A `transient` failure never touches the file. The stored refresh token
//     stays exactly as it was and the next attempt retries the same one.

import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

import type { Account, ClaudeOAuth } from './accounts.js';
import { readOAuth } from './accounts.js';
import { OAuthRefreshError, refreshClaudeToken } from './oauth.js';
import type { ClaudeTokenSet } from './oauth.js';
import { setRefreshWarning } from './health.js';

/**
 * Refresh this long before the access token actually expires.
 *
 * Wide enough that a slot is never selected with a token that dies during a
 * long generation; the transport's 90-second deadline ends once headers arrive.
 */
export const REFRESH_SKEW_MS = 30 * 60 * 1000;

/** How often the background sweeper looks for slots approaching expiry. */
export const REFRESH_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * After a terminal failure, stop retrying that slot for this long.
 *
 * A dead grant only comes back through human re-auth, and hammering a revoked
 * token is how an account attracts attention it does not want.
 */
export const TERMINAL_BACKOFF_MS = 60 * 60 * 1000;

/** After a transient failure, wait this long before trying that slot again. */
export const TRANSIENT_BACKOFF_MS = 60 * 1000;

/**
 * A lock older than this is assumed abandoned (crashed process) and broken.
 * Must exceed the refresh timeout, or a slow-but-live refresh gets its lock
 * stolen and two exchanges race the same refresh token.
 */
export const LOCK_STALE_MS = 90_000;

export type RefreshOutcome =
  | { status: 'fresh'; oauth: ClaudeOAuth }
  | { status: 'refreshed'; oauth: ClaudeOAuth; rotated: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; kind: 'transient' | 'terminal'; message: string };

export type RefreshLogEvent = {
  slot: string;
  email?: string;
  outcome: RefreshOutcome['status'];
  kind?: 'transient' | 'terminal';
  message?: string;
  rotated?: boolean;
  expiresInMs?: number;
};

type Deps = {
  now: () => number;
  refresh: typeof refreshClaudeToken;
  log?: (event: RefreshLogEvent) => void;
  stateRoot?: string;
};

// ---------------------------------------------------------------------------
// Credential file I/O
// ---------------------------------------------------------------------------

/**
 * Merge a refreshed token set into the credential file without disturbing
 * anything else in it.
 *
 * Claude Code's file has other top-level keys and other fields inside
 * `claudeAiOauth` (subscriptionType, rateLimitTier, ...). A whole-file rewrite
 * would drop whichever ones this package does not model, so the parsed object
 * is mutated in place and re-serialized.
 */
export function mergeCredentialFile(raw: string, tokens: ClaudeTokenSet): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const oauth = (parsed['claudeAiOauth'] ?? {}) as Record<string, unknown>;
  oauth['accessToken'] = tokens.accessToken;
  oauth['refreshToken'] = tokens.refreshToken;
  oauth['expiresAt'] = tokens.expiresAt;
  if (tokens.refreshTokenExpiresAt !== undefined) {
    oauth['refreshTokenExpiresAt'] = tokens.refreshTokenExpiresAt;
  }
  if (tokens.scopes?.length) oauth['scopes'] = tokens.scopes;
  parsed['claudeAiOauth'] = oauth;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function writeCredentialFile(credentialPath: string, contents: string): void {
  const tmp = `${credentialPath}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, credentialPath);
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

function lockPath(credentialPath: string): string {
  return `${credentialPath}.refresh.lock`;
}

/** Take the lock, or return false if someone else holds a live one. */
function acquireLock(credentialPath: string, nowMs: number): boolean {
  const file = lockPath(credentialPath);
  try {
    closeSync(openSync(file, 'wx', 0o600));
    return true;
  } catch {
    /* held — fall through to the staleness check */
  }
  try {
    const age = nowMs - statSync(file).mtimeMs;
    if (age < LOCK_STALE_MS) return false;
    unlinkSync(file);
    closeSync(openSync(file, 'wx', 0o600));
    return true;
  } catch {
    // Lost the race to break it, or it vanished under us. Either way someone
    // else is handling this slot; declining is always safe.
    return false;
  }
}

function releaseLock(credentialPath: string): void {
  try {
    unlinkSync(lockPath(credentialPath));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// The refresher
// ---------------------------------------------------------------------------

export class TokenRefresher {
  private readonly deps: Deps;
  /** In-process dedup: concurrent requests for one slot await one exchange. */
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>();
  /** Slot -> epoch-ms before which we will not try again. */
  private readonly backoffUntil = new Map<string, number>();

  constructor(deps: Partial<Deps> = {}) {
    this.deps = {
      now: deps.now ?? Date.now,
      refresh: deps.refresh ?? refreshClaudeToken,
      log: deps.log,
      stateRoot: deps.stateRoot,
    };
  }

  /**
   * True when this token is expired or close enough that we should act.
   *
   * Purely a question about the clock. Whether we *can* do anything about it is
   * a separate question, answered later — folding "has a refresh token" in here
   * makes an expired credential with no refresh token report as not needing
   * refresh, which callers then read as healthy.
   */
  needsRefresh(oauth: ClaudeOAuth | undefined, nowMs: number): boolean {
    if (oauth?.expiresAt === undefined) return false;
    return oauth.expiresAt - nowMs <= REFRESH_SKEW_MS;
  }

  /**
   * Ensure this account has a usable access token, refreshing if needed.
   *
   * Concurrent callers for the same slot share one exchange rather than each
   * issuing their own — which, with rotation, would invalidate each other.
   */
  async ensureFresh(account: Account): Promise<RefreshOutcome> {
    const existing = this.inflight.get(account.slot);
    if (existing) return existing;

    const run = this.refreshSlot(account).then(outcome => {
      if (outcome.status === 'fresh' && this.deps.stateRoot) {
        setRefreshWarning(this.deps.stateRoot, account.slot);
      }
      return outcome;
    }).finally(() => {
      this.inflight.delete(account.slot);
    });
    this.inflight.set(account.slot, run);
    return run;
  }

  private emit(account: Account, outcome: RefreshOutcome, nowMs: number): RefreshOutcome {
    const event: RefreshLogEvent = { slot: account.slot, email: account.email, outcome: outcome.status };
    if (outcome.status === 'failed') {
      event.kind = outcome.kind;
      event.message = outcome.message;
      if (this.deps.stateRoot) setRefreshWarning(this.deps.stateRoot, account.slot, {
        code: outcome.kind === 'terminal' ? 'refresh-terminal' : 'refresh-backoff',
        slot: account.slot,
        message: outcome.message,
        at: nowMs,
      });
    } else if (outcome.status === 'refreshed') {
      if (this.deps.stateRoot) setRefreshWarning(this.deps.stateRoot, account.slot);
      event.rotated = outcome.rotated;
      event.expiresInMs = (outcome.oauth.expiresAt ?? nowMs) - nowMs;
    } else if (outcome.status === 'skipped') {
      event.message = outcome.reason;
    }
    this.deps.log?.(event);
    return outcome;
  }

  private async refreshSlot(account: Account): Promise<RefreshOutcome> {
    const nowMs = this.deps.now();

    const blockedUntil = this.backoffUntil.get(account.slot);
    if (blockedUntil !== undefined && nowMs < blockedUntil) {
      const current = readOAuth(account.credentialPath);
      // A backoff is not a reason to reject a token that is still valid.
      if (current && !this.needsRefresh(current, nowMs)) return { status: 'fresh', oauth: current };
      return this.emit(
        account,
        { status: 'skipped', reason: `backing off for ${Math.round((blockedUntil - nowMs) / 1000)}s` },
        nowMs,
      );
    }

    const before = readOAuth(account.credentialPath);
    if (!before) return this.emit(account, { status: 'skipped', reason: 'no credential' }, nowMs);
    if (!this.needsRefresh(before, nowMs)) return { status: 'fresh', oauth: before };
    if (!before.refreshToken) {
      return this.emit(account, { status: 'skipped', reason: 'no refresh token' }, nowMs);
    }

    if (!acquireLock(account.credentialPath, nowMs)) {
      // Someone else is refreshing this slot right now. Re-read rather than
      // wait: if they already finished we get their result for free.
      const current = readOAuth(account.credentialPath);
      if (current && !this.needsRefresh(current, this.deps.now())) {
        return { status: 'fresh', oauth: current };
      }
      return this.emit(account, { status: 'skipped', reason: 'locked by another refresher' }, nowMs);
    }

    try {
      // Re-read UNDER the lock. Claude Code or another process may have
      // refreshed while we were queued, and replaying our stale refresh token
      // against a rotated family is exactly what invites reuse detection.
      const raw = readFileSync(account.credentialPath, 'utf8');
      const current = readOAuth(account.credentialPath);
      if (!current?.refreshToken) {
        return this.emit(account, { status: 'skipped', reason: 'credential vanished' }, nowMs);
      }
      const checkedAt = this.deps.now();
      if (!this.needsRefresh(current, checkedAt)) {
        return { status: 'fresh', oauth: current };
      }

      let tokens: ClaudeTokenSet;
      try {
        tokens = await this.deps.refresh(current.refreshToken, {
          nowMs: checkedAt,
          scopes: current.scopes,
        });
      } catch (error) {
        const kind = error instanceof OAuthRefreshError ? error.kind : 'transient';
        // Upstream error bodies are not safe persistence/log material: an OAuth
        // server may echo credential input. Classification is all operators need.
        const message = kind === 'terminal'
          ? 'OAuth grant rejected; re-authentication required'
          : 'OAuth refresh temporarily unavailable';
        this.backoffUntil.set(
          account.slot,
          this.deps.now() + (kind === 'terminal' ? TERMINAL_BACKOFF_MS : TRANSIENT_BACKOFF_MS),
        );
        // The credential file is untouched on every failure path, so a
        // transient blip can never cost us the refresh token.
        return this.emit(account, { status: 'failed', kind, message }, nowMs);
      }

      writeCredentialFile(account.credentialPath, mergeCredentialFile(raw, tokens));
      this.backoffUntil.delete(account.slot);
      const oauth = readOAuth(account.credentialPath);
      return this.emit(
        account,
        { status: 'refreshed', oauth: oauth ?? (current as ClaudeOAuth), rotated: tokens.rotated },
        nowMs,
      );
    } finally {
      releaseLock(account.credentialPath);
    }
  }

  /**
   * Refresh every account that is near expiry.
   *
   * This is what keeps IDLE slots alive. Reactive refresh alone would only ever
   * touch accounts that are already being selected — and an expired account is
   * excluded from selection, so it would never be reached.
   */
  async sweep(accounts: Account[]): Promise<RefreshOutcome[]> {
    const out: RefreshOutcome[] = [];
    for (const account of accounts) {
      const oauth = readOAuth(account.credentialPath);
      if (!this.needsRefresh(oauth, this.deps.now())) continue;
      out.push(await this.ensureFresh(account));
    }
    return out;
  }
}

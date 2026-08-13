// Credential discovery and persisted account state.
//
// Source of truth for credentials is the existing authswap layout, so this
// package does not become a second place that owns Claude OAuth material:
//
//   ~/.authswap/state.json
//   ~/.authswap/providers/anthropic/credentials/.credentials-<n>-<email>.json
//
// Each credential file is Claude Code's own shape:
//   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, ... } }
//
// Refresh lives in ./refresh.ts, which writes these files. authswap has no
// refresh logic of its own — it relies on Claude Code refreshing whichever
// account it made active — so without that module every inactive slot expires
// within ~12h.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AccountState } from './policy.js';
import type { Claims } from './claims.js';

export type ClaudeOAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  scopes?: string[];
};

export type Account = {
  slot: string;
  email?: string;
  credentialPath: string;
};

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.CLAUDE_AUTH_BALANCER_HOME || path.join(os.homedir(), '.bravo', 'claude-auth-balancer'),
  );
}

export function resolveAuthswapRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.AUTHSWAP_DIR || path.join(os.homedir(), '.authswap'));
}

const CRED_RE = /^\.credentials-(\d+)-(.+)\.json$/;

/**
 * Enumerate Anthropic accounts from the authswap credential directory.
 * Slot ids are the authswap account numbers, so `slot` matches what
 * `authswap --list` and `state.json` call an account.
 */
export function discoverAccounts(authswapRoot = resolveAuthswapRoot()): Account[] {
  const dir = path.join(authswapRoot, 'providers', 'anthropic', 'credentials');
  if (!existsSync(dir)) return [];
  const out: Account[] = [];
  for (const name of readdirSync(dir)) {
    const m = CRED_RE.exec(name);
    if (!m) continue;
    out.push({ slot: m[1]!, email: m[2], credentialPath: path.join(dir, name) });
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

export function readOAuth(credentialPath: string): ClaudeOAuth | undefined {
  try {
    const parsed = JSON.parse(readFileSync(credentialPath, 'utf8')) as Record<string, unknown>;
    const oauth = parsed['claudeAiOauth'];
    if (!oauth || typeof oauth !== 'object') return undefined;
    const o = oauth as Record<string, unknown>;
    if (typeof o['accessToken'] !== 'string') return undefined;
    return o as unknown as ClaudeOAuth;
  } catch {
    return undefined;
  }
}

/** Stable, non-reversible id for logging a token without ever printing it. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Persisted observations
// ---------------------------------------------------------------------------

export type PersistedAccount = {
  slot: string;
  email?: string;
  claims?: Claims;
  observedAt?: number;
};

/**
 * One file per slot, not one file for all of them.
 *
 * A single `accounts.json` would need a read-modify-write cycle, so two proxy
 * processes recording different slots concurrently would silently drop one
 * another's observation despite the atomic rename. Per-slot files make each
 * write independent, and the only racers for a given file are writers of the
 * same slot — where last-write-wins is the correct outcome anyway.
 */
function slotDir(stateRoot: string): string {
  return path.join(stateRoot, 'state', 'accounts');
}

function slotPath(stateRoot: string, slot: string): string {
  return path.join(slotDir(stateRoot), `${encodeURIComponent(slot)}.json`);
}

export function readSlotObservation(stateRoot: string, slot: string): PersistedAccount | undefined {
  try {
    const parsed = JSON.parse(readFileSync(slotPath(stateRoot, slot), 'utf8')) as PersistedAccount;
    if (parsed && typeof parsed.slot === 'string') return parsed;
  } catch {
    /* absent or unreadable */
  }
  return undefined;
}

export function writeSlotObservation(stateRoot: string, account: PersistedAccount): void {
  const target = slotPath(stateRoot, account.slot);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(account, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * True when a credential can be revived without a human.
 *
 * An expired access token is only fatal if the refresh token is missing or
 * itself expired. Conflating the two would drop every slot the refresher is
 * about to rescue — and since an excluded slot is never selected, nothing
 * would ever trigger its refresh. That is the deadlock this predicate avoids.
 */
export function isRefreshable(oauth: ClaudeOAuth | undefined, nowMs: number): boolean {
  if (!oauth?.refreshToken) return false;
  const expiry = oauth.refreshTokenExpiresAt;
  return expiry === undefined || expiry > nowMs;
}

/**
 * Join credential files with persisted observations into the shape the policy
 * consumes. `needs-reauth` means a human must act: no credential, or an expired
 * access token with no live refresh token behind it.
 */
export function loadAccountStates(options: {
  stateRoot: string;
  authswapRoot?: string;
  nowMs: number;
}): { states: AccountState[]; accounts: Map<string, Account> } {
  const accounts = discoverAccounts(options.authswapRoot ?? resolveAuthswapRoot());
  const bySlot = new Map<string, Account>();
  const states: AccountState[] = [];

  for (const account of accounts) {
    bySlot.set(account.slot, account);
    const oauth = readOAuth(account.credentialPath);
    const prior = readSlotObservation(options.stateRoot, account.slot);
    const expiresAt = oauth?.expiresAt;
    const expired = expiresAt !== undefined && expiresAt <= options.nowMs;
    const dead = !oauth || (expired && !isRefreshable(oauth, options.nowMs));
    states.push({
      slot: account.slot,
      email: account.email,
      health: dead ? 'needs-reauth' : 'ok',
      claims: prior?.claims,
      observedAt: prior?.observedAt,
      tokenExpiresAt: expiresAt,
    });
  }

  return { states, accounts: bySlot };
}

/**
 * Merge a fresh observation over the prior one, preserving claims the new
 * response did not mention.
 *
 * This matters for `7d_oi`, which only appears on Fable responses. Replacing
 * the snapshot wholesale would mean one Opus request erases a 96%-utilized
 * Fable budget, and the next Fable request would treat it as unknown — silently
 * defeating the evacuation rule for exactly the model it guards.
 */
export function mergeClaims(prior: Claims | undefined, next: Claims): Claims {
  if (!prior) return next;
  return {
    ...prior,
    ...next,
    byId: { ...prior.byId, ...next.byId },
  };
}

/** Record a fresh claims observation for one slot. */
export function recordObservation(
  stateRoot: string,
  slot: string,
  claims: Claims,
  nowMs: number,
  email?: string,
): void {
  const prior = readSlotObservation(stateRoot, slot);
  writeSlotObservation(stateRoot, {
    slot,
    email: email ?? prior?.email,
    claims: mergeClaims(prior?.claims, claims),
    observedAt: nowMs,
  });
}

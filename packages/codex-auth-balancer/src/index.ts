import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { refreshCodexToken, type CodexTokenSet } from './codex-oauth.js';
import { classifyOAuthRefreshError, redactSecretsInText, type OAuthErrorKind } from './oauth-error.js';

export type UsageWindow = {
  label: 'primary' | 'secondary' | string;
  remainingPercent?: number;
  windowMinutes?: number;
  resetAt?: number;
  resetInSeconds?: number;
  stale?: boolean;
};
export type CodexAccountStatus = 'ok' | 'limited' | 'broken' | 'unknown';
export type CodexAccountSlot = {
  slot: string;
  label?: string;
  email?: string;
  accountIdHash?: string;
  activePi: boolean;
  activeCodex: boolean;
  status: CodexAccountStatus;
  usage?: { primary?: UsageWindow; secondary?: UsageWindow; updatedAt?: number; source?: 'cache' | 'probe' | 'live' | 'broken' | 'manual' | 'unknown' };
  problem?: { code: string; message: string };
  /**
   * Absolute expiry (epoch ms) of the access token this slot would actually
   * lease, read from the same file the lease path reads. Undefined when the
   * credential is missing or carries no derivable expiry.
   */
  tokenExpiresAt?: number;
  /** False when the credential cannot be refreshed at all — re-auth required. */
  refreshable?: boolean;
};
export type CodexUsage = { accounts: CodexAccountSlot[]; generatedAt: number; staleAfterMs: number; unavailable?: boolean; error?: string };
export type UsageEntry = {
  slot: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  updatedAt?: number;
  source?: 'cache' | 'probe' | 'live' | 'broken' | 'manual' | 'unknown';
  status?: CodexAccountStatus;
  problem?: { code: string; message: string };
};
export type Account = { slot: string; authPath: string; piAuthPath?: string; idHash: string; usage?: UsageEntry };
type InternalAccount = Account & { authHash: string; accountIdHash?: string; activePi: boolean; activeCodex: boolean; tokenExpiresAt?: number; hasRefreshToken: boolean; claimBearing: boolean };
type SelectionMetadata = {
  reservation_id: string;
  launch_id: string;
  policy_version: number;
  score: number;
  active_reservations: number;
  reservation_expires_at: number;
  generated_at?: number;
  stale: boolean;
  tie_break: string;
  candidates_considered: number;
  penalties: string[];
};
type ReservedAccount = InternalAccount & { reservationId: string; launchId: string; selection: SelectionMetadata };
type LaunchMetadata = {
  slot: string;
  generation: string;
  authHash: string;
  stateRoot: string;
  metadata_path?: string;
  expected_generation?: string;
  reservation_id?: string;
  launch_id?: string;
  policy_version?: number;
  run_id?: string;
  root_run_id?: string;
  reservation_expires_at?: number;
  pi_auth_hash?: string;
};
export type PrepareLaunchResult = {
  schema_version: 1;
  selected_slot: string;
  slot: string;
  label?: string;
  reason: string;
  status: 'ok' | 'limited' | 'unknown';
  isolated_dir: string;
  pi_agent_dir: string;
  codex_home: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  selection?: SelectionMetadata;
  primary_remaining_percent?: number;
  secondary_remaining_percent?: number;
};

export type TokenLeasePurpose = 'pi-provider-request' | 'async-child-preflight' | 'manual' | 'command-backed-token';
export type TokenLeaseFinishStatus = 'completed' | 'failed' | 'aborted' | 'preflight_failed' | 'expired';
export type StartTokenLeaseInput = {
  provider: 'bravo-codex-balanced';
  model: string;
  purpose: TokenLeasePurpose;
  expected_runtime_ms: number;
  ttl_safety_buffer_ms: number;
  stateRoot?: string;
  lease_key?: string;
  preferred_slot?: string;
  session_affinity_key?: string;
  abort_signal?: AbortSignal;
};
export type TokenLease = {
  schema_version: 1;
  provider: 'bravo-codex-balanced';
  model: string;
  purpose: TokenLeasePurpose;
  lease_id: string;
  access_token: string;
  slot: string;
  label?: string;
  expires_at: number;
  account_id_hash?: string;
  reservation_id: string;
  launch_id: string;
  session_affinity_key?: string;
};
export type FinishTokenLeaseInput = {
  lease_id: string;
  reservation_id: string;
  launch_id: string;
  status: TokenLeaseFinishStatus;
  stateRoot?: string;
  error_kind?: string;
};
export type FinishTokenLeaseResult = { schema_version: 1; ok: true; lease_id: string; reservation_id: string; status: TokenLeaseFinishStatus; already_final: boolean; previous_status?: string };

type LegacyUsageEntry = UsageEntry & { windows?: { primary?: UsageWindow; secondary?: UsageWindow } };
type UsageCache = { schema_version: 2; generated_at: number; accounts: Record<string, LegacyUsageEntry> };
type ProbeRateLimits = {
  primary?: { used_percent?: number; remaining_percent?: number; remainingPercent?: number; window_minutes?: number; windowMinutes?: number; resets_at?: number; resetsAt?: number; reset_at?: number; resetAt?: number; reset_in_seconds?: number; resetInSeconds?: number };
  secondary?: { used_percent?: number; remaining_percent?: number; remainingPercent?: number; window_minutes?: number; windowMinutes?: number; resets_at?: number; resetsAt?: number; reset_at?: number; resetAt?: number; reset_in_seconds?: number; resetInSeconds?: number };
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
};
export type LiveUsageIngestInput = {
  stateRoot?: string;
  slot?: string;
  reservation_id?: string;
  launch_id?: string;
  headers?: Record<string, unknown>;
  rateLimits?: unknown;
  rate_limits?: unknown;
  generated_at?: number;
  updated_at?: number;
};
export type LiveUsageIngestResult = { ok: boolean; ingested: boolean; slot?: string; skipped?: string; error?: string };

export function selectSingleActivePiSlot(usage: CodexUsage): string | undefined {
  const slots = usage.accounts.filter(account => account.activePi).map(account => account.slot);
  return slots.length === 1 ? slots[0] : undefined;
}

type SqlRow = Record<string, string | number | bigint | Buffer | null>;
type ReservationState = 'pending' | 'prepared' | 'completed' | 'released' | 'failed' | 'conflict' | 'expired';

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const PROBE_MODEL = process.env.CODEX_AUTH_BALANCER_PROBE_MODEL || 'gpt-5.3-codex-spark';
const PROBE_TIMEOUT_MS = Number(process.env.CODEX_AUTH_BALANCER_PROBE_TIMEOUT_MS || 60_000);
const PROBE_PROMPT = 'Reply exactly: OK';
const DB_SCHEMA_VERSION = 1;
const DEFAULT_RESERVATION_TTL_MS = 2 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const POLICY = {
  version: 2,
  hardFloorPrimaryPercent: 1,
  hardFloorSecondaryPercent: 1,
  // In-flight reservations are a *preference* signal, never a quota deduction: a
  // busy slot is deprioritized, but it is never excluded for being busy. The
  // penalty stays small enough that a real quota gap outranks transient
  // concurrency (a 12-point remaining gap is worth 7.2 score; 1-2 in-flight
  // requests must not flip that). Genuine exhaustion is caught by the hard
  // floors below and, at runtime, by 429 rotation.
  stalePenalty: 15,
  unknownPenalty: 25,
  activeReservationPenalty: 2,
  limitedPenalty: 30,
  weeklyConservationPenalty: 0.5,
  selectionStaleAfterMs: DEFAULT_STALE_AFTER_MS,
};

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
async function exists(p: string) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson<T>(p: string, fallback: T): Promise<T> { try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return fallback; } }
async function writeJson(p: string, v: unknown) { await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 }); await fs.writeFile(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); }
// Crash-safe credential write-back: write to a unique temp sibling then atomically rename
// into place, so a concurrent reader never observes a half-written file (matches syncBack's
// temp+rename pattern). Used on the lease refresh path where torn writes would brick a slot.
async function atomicWriteJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  // Durability: flush the temp file's contents to disk before the rename so a crash can never
  // leave a successfully-refreshed credential only partially persisted.
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, p);
  // Flush the directory entry so the rename itself survives a crash.
  const dir = await fs.open(path.dirname(p), 'r').catch(() => undefined);
  if (dir) { try { await dir.sync(); } catch { /* some platforms disallow directory fsync */ } finally { await dir.close(); } }
}
async function salt(root: string) { const p = path.join(root, 'account-id-hash-salt'); if (!(await exists(p))) { await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.writeFile(p, randomBytes(32).toString('hex') + '\n', { mode: 0o600 }); } return (await fs.readFile(p, 'utf8')).trim(); }
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string { return path.resolve(env.CODEX_AUTH_BALANCER_HOME || path.join(os.homedir(), '.bravo', 'codex-auth-balancer')); }

function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function asNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function rowNumber(value: unknown): number | undefined { return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : undefined; }
function rowString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function clampPct(value: number): number { return Math.max(0, Math.min(100, value)); }
function normalizeWindowMinutes(value: unknown): number | undefined {
  const minutes = asNumberish(value);
  return minutes != null && Number.isInteger(minutes) && minutes > 0 ? minutes : undefined;
}
function epochSecondsOrMs(value: number): number {
  // Codex/OpenAI-style reset fields may arrive as epoch seconds or millis.
  return value < 10_000_000_000 ? value * 1000 : value;
}
function persistedResetAtMs(value: number): number {
  // DB writes may receive already-normalized UsageWindow objects. Only repair
  // plausible epoch-second values to avoid double-normalizing small synthetic
  // timestamps or old test fixtures that already passed through reset parsing.
  return value >= 1_000_000_000 && value < 10_000_000_000 ? value * 1000 : value;
}
function normalizeWindow(label: string, value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const remaining = asNumber(value.remainingPercent) ?? asNumber(value.remaining_percent);
  const windowMinutes = normalizeWindowMinutes(value.windowMinutes) ?? normalizeWindowMinutes(value.window_minutes);
  const resetAt = asNumber(value.resetAt) ?? asNumber(value.reset_at);
  const resetInSeconds = asNumber(value.resetInSeconds) ?? asNumber(value.reset_in_seconds);
  return {
    label: typeof value.label === 'string' ? value.label : label,
    remainingPercent: remaining == null ? undefined : clampPct(remaining),
    windowMinutes,
    resetAt: resetAt == null ? undefined : persistedResetAtMs(resetAt),
    resetInSeconds,
    stale: value.stale === true,
  };
}
function asNumberish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
function windowFromRateLimit(label: string, value: ProbeRateLimits['primary']): UsageWindow | undefined {
  if (!value) return undefined;
  const remaining = asNumberish(value.remaining_percent) ?? asNumberish(value.remainingPercent);
  const used = asNumberish(value.used_percent);
  const windowMinutes = normalizeWindowMinutes(value.window_minutes) ?? normalizeWindowMinutes((value as Record<string, unknown>).windowMinutes);
  const resetAt = asNumberish(value.reset_at) ?? asNumberish(value.resetAt);
  const resetsAt = asNumberish(value.resets_at) ?? asNumberish(value.resetsAt);
  const resetInSeconds = asNumberish(value.reset_in_seconds) ?? asNumberish(value.resetInSeconds);
  return {
    label,
    remainingPercent: remaining != null ? clampPct(remaining) : used == null ? undefined : clampPct(100 - used),
    windowMinutes,
    resetAt: resetAt != null ? epochSecondsOrMs(resetAt) : resetsAt != null ? epochSecondsOrMs(resetsAt) : undefined,
    resetInSeconds,
  };
}
function hasWindowSignal(window: UsageWindow | undefined): boolean {
  return window?.remainingPercent != null || window?.windowMinutes != null || window?.resetAt != null || window?.resetInSeconds != null;
}
function normalizeLiveRateLimits(metadata: unknown): { primary?: UsageWindow; secondary?: UsageWindow; status: CodexAccountStatus } | undefined {
  const rateLimits = findRateLimits(metadata);
  if (!rateLimits) return undefined;
  const primary = windowFromRateLimit('primary', rateLimits.primary);
  const secondary = windowFromRateLimit('secondary', rateLimits.secondary);
  if (!hasWindowSignal(primary) && !hasWindowSignal(secondary)) return undefined;
  return { primary, secondary, status: rateLimits.rate_limit_reached_type ? 'limited' : 'ok' };
}
function parseHeaderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed) as unknown; } catch { return value; }
  }
  return value;
}
function liveRateLimitsFromHeaders(headers: Record<string, unknown> | undefined): ProbeRateLimits | undefined {
  if (!headers) return undefined;
  const byName: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const value = parseHeaderValue(rawValue);
    if ((key.includes('rate') || key.includes('limit')) && isRecord(value)) {
      const found = findRateLimits(value);
      if (found) return found;
    }
    byName[key.replace(/^x-/, '').replace(/-/g, '_')] = value;
  }
  const windowFor = (prefix: 'primary' | 'secondary') => {
    const window: NonNullable<ProbeRateLimits['primary']> = {};
    const copy = (target: keyof NonNullable<ProbeRateLimits['primary']>, ...names: string[]) => {
      for (const name of names) {
        const value = asNumberish(byName[name]);
        if (value != null) { (window as Record<string, number>)[target] = value; return; }
      }
    };
    copy('used_percent', `${prefix}_used_percent`, `codex_${prefix}_used_percent`, `ratelimit_${prefix}_used_percent`, `rate_limit_${prefix}_used_percent`);
    copy('remaining_percent', `${prefix}_remaining_percent`, `codex_${prefix}_remaining_percent`, `ratelimit_${prefix}_remaining_percent`, `rate_limit_${prefix}_remaining_percent`);
    copy('window_minutes', `${prefix}_window_minutes`, `${prefix}_windowminutes`, `codex_${prefix}_window_minutes`, `codex_${prefix}_windowminutes`, `ratelimit_${prefix}_window_minutes`, `rate_limit_${prefix}_window_minutes`);
    copy('resets_at', `${prefix}_resets_at`, `codex_${prefix}_resets_at`, `ratelimit_${prefix}_resets_at`, `rate_limit_${prefix}_resets_at`);
    copy('reset_at', `${prefix}_reset_at`, `codex_${prefix}_reset_at`, `ratelimit_${prefix}_reset_at`, `rate_limit_${prefix}_reset_at`);
    copy('reset_in_seconds', `${prefix}_reset_in_seconds`, `codex_${prefix}_reset_in_seconds`, `ratelimit_${prefix}_reset_in_seconds`, `rate_limit_${prefix}_reset_in_seconds`);
    return Object.keys(window).length > 0 ? window : undefined;
  };
  const out: ProbeRateLimits = { primary: windowFor('primary'), secondary: windowFor('secondary') };
  return out.primary || out.secondary ? out : undefined;
}
function liveRateLimitCandidates(input: LiveUsageIngestInput): unknown[] {
  const candidates: unknown[] = [];
  if (input.rateLimits != null) candidates.push(input.rateLimits);
  if (input.rate_limits != null) candidates.push(input.rate_limits);
  const fromHeaders = liveRateLimitsFromHeaders(input.headers);
  if (fromHeaders) candidates.push(fromHeaders);
  return candidates;
}
function accountIdFromPiAuth(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.accountId === 'string' ? value.accountId : typeof value.account_id === 'string' ? value.account_id : undefined;
}
function jwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) return undefined;
    const exp = asNumber(payload.exp);
    return exp == null ? undefined : exp * 1000;
  } catch {
    return undefined;
  }
}
const JWT_ACCOUNT_CLAIM_PATH = 'https://api.openai.com/auth';
function accessTokenAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload[JWT_ACCOUNT_CLAIM_PATH];
    const id = isRecord(auth) ? auth.chatgpt_account_id : undefined;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}
function tokenFromAuth(value: unknown): { accessToken?: string; refreshToken?: string; expiresAt?: number; accountId?: string; nestedProvider?: boolean; codexCliShape?: boolean } {
  if (!isRecord(value)) return {};
  const nested = value['openai-codex'];
  if (isRecord(nested)) return { ...tokenFromAuth(nested), nestedProvider: true };
  if (isRecord(value.tokens)) {
    const parsed = tokenFromAuth(value.tokens);
    return { ...parsed, accountId: parsed.accountId ?? accountIdFromPiAuth(value.tokens), codexCliShape: true };
  }
  const accessToken = typeof value.access_token === 'string' ? value.access_token : typeof value.access === 'string' ? value.access : undefined;
  const refreshToken = typeof value.refresh_token === 'string' ? value.refresh_token : typeof value.refresh === 'string' ? value.refresh : undefined;
  const expiresAt = asNumber(value.expiry_date) ?? asNumber(value.expires_at) ?? asNumber(value.expires) ?? jwtExpiryMs(accessToken);
  const accountId = accountIdFromPiAuth(value);
  return { accessToken, refreshToken, expiresAt, accountId, codexCliShape: typeof value.access_token === 'string' || typeof value.refresh_token === 'string' || Object.hasOwn(value, 'expiry_date') };
}

function withRefreshedTokenShape(original: unknown, refreshed: CodexTokenSet): unknown {
  if (isRecord(original) && isRecord(original['openai-codex'])) {
    return { ...original, 'openai-codex': withRefreshedTokenShape(original['openai-codex'], refreshed) };
  }
  if (isRecord(original) && isRecord(original.tokens)) {
    return { ...original, tokens: withRefreshedTokenShape(original.tokens, refreshed) };
  }
  const base = isRecord(original) ? { ...original } : {};
  const parsed = tokenFromAuth(original);
  if (parsed.codexCliShape) {
    return { ...base, access_token: refreshed.access, refresh_token: refreshed.refresh, expiry_date: refreshed.expires, accountId: refreshed.accountId };
  }
  return { ...base, access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires, accountId: refreshed.accountId };
}
async function readAccountIdHash(piAuthPath: string | undefined): Promise<string | undefined> {
  if (!piAuthPath) return undefined;
  const accountId = accountIdFromPiAuth(await readJson<unknown>(piAuthPath, undefined));
  return accountId ? sha(accountId) : undefined;
}
async function readActivePiAccountIdHash(): Promise<string | undefined> {
  const auth = await readJson<Record<string, unknown> | null>(path.join(os.homedir(), '.pi', 'agent', 'auth.json'), null);
  return auth ? (accountIdFromPiAuth(auth['openai-codex']) ? sha(accountIdFromPiAuth(auth['openai-codex'])!) : undefined) : undefined;
}
async function readActiveCodexAccountIdHash(): Promise<string | undefined> {
  const auth = await readJson<unknown>(path.join(os.homedir(), '.codex', 'auth.json'), undefined);
  return accountIdFromPiAuth(auth) ? sha(accountIdFromPiAuth(auth)!) : undefined;
}

function normalizeUsageAccounts(accounts: Record<string, unknown>): Record<string, LegacyUsageEntry> {
  const out: Record<string, LegacyUsageEntry> = {};
  for (const [slot, entry] of Object.entries(accounts)) {
    if (!isRecord(entry)) continue;
    out[slot] = { ...(entry as LegacyUsageEntry), slot: typeof entry.slot === 'string' ? entry.slot : slot };
  }
  return out;
}
function parseUsageCache(parsed: unknown, fallbackGeneratedAt: number): UsageCache | undefined {
  if (!isRecord(parsed)) return undefined;
  if (parsed.schema_version === 2) {
    if (!isRecord(parsed.accounts) || typeof parsed.generated_at !== 'number') return undefined;
    return { schema_version: 2, generated_at: parsed.generated_at, accounts: normalizeUsageAccounts(parsed.accounts) };
  }
  const accounts = normalizeUsageAccounts(parsed);
  if (Object.keys(accounts).length === 0 && Object.keys(parsed).length > 0) return undefined;
  return { schema_version: 2, generated_at: fallbackGeneratedAt, accounts };
}
async function readUsageCache(stateRoot: string): Promise<UsageCache | undefined> {
  const cachePath = path.join(stateRoot, 'cache', 'usage.json');
  try {
    const [content, stat] = await Promise.all([fs.readFile(cachePath, 'utf8'), fs.stat(cachePath).catch(() => undefined)]);
    return parseUsageCache(JSON.parse(content) as unknown, stat?.mtimeMs ?? Date.now());
  } catch { return undefined; }
}
function readUsageCacheSync(stateRoot: string): UsageCache | undefined {
  const cachePath = path.join(stateRoot, 'cache', 'usage.json');
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
    let generatedAt = Date.now();
    try { generatedAt = statSync(cachePath).mtimeMs; } catch { /* use current time fallback */ }
    return parseUsageCache(parsed, generatedAt);
  } catch { return undefined; }
}

function readJsonFileSync<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function piAuthStorageForCredential(credentialPath: string): Record<string, unknown> {
  return { 'openai-codex': readJsonFileSync<unknown>(credentialPath) };
}

function piCredentialFromAuthStorage(authStoragePath: string): unknown | undefined {
  const parsed = readJsonFileSync<unknown>(authStoragePath);
  return isRecord(parsed) && Object.hasOwn(parsed, 'openai-codex') ? parsed['openai-codex'] : parsed;
}

function openDb(stateRoot: string): DatabaseSync {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(stateRoot, 'balancer.sqlite3'));
  db.exec('PRAGMA busy_timeout = 5000');
  const preflightPragmaVersion = rowNumber(db.prepare('PRAGMA user_version').get()?.user_version) ?? 0;
  const hasMetadataTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'").get();
  const preflightMetadataRow = hasMetadataTable ? db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version') as SqlRow | undefined : undefined;
  const preflightMetadataVersion = preflightMetadataRow ? Number(preflightMetadataRow.value) : 0;
  if (preflightMetadataVersion > DB_SCHEMA_VERSION || preflightPragmaVersion > DB_SCHEMA_VERSION) {
    closeDb(db);
    throw new Error(`unsupported balancer sqlite schema version: ${Math.max(preflightMetadataVersion, preflightPragmaVersion)}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      slot TEXT PRIMARY KEY,
      id_hash TEXT,
      account_id_hash TEXT,
      auth_hash TEXT,
      auth_path TEXT,
      pi_auth_path TEXT,
      active_pi INTEGER NOT NULL DEFAULT 0,
      active_codex INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot TEXT NOT NULL REFERENCES accounts(slot) ON DELETE CASCADE,
      generated_at INTEGER NOT NULL,
      updated_at INTEGER,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      problem_code TEXT,
      problem_message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_snapshots_slot_id ON usage_snapshots(slot, id DESC);
    CREATE TABLE IF NOT EXISTS usage_windows (
      snapshot_id INTEGER NOT NULL REFERENCES usage_snapshots(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      label TEXT NOT NULL,
      remaining_percent REAL,
      reset_at INTEGER,
      reset_in_seconds INTEGER,
      window_minutes INTEGER,
      stale INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (snapshot_id, label)
    );
    CREATE TABLE IF NOT EXISTS policy (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      slot TEXT NOT NULL REFERENCES accounts(slot) ON DELETE CASCADE,
      launch_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      run_id TEXT,
      root_run_id TEXT,
      selected_score REAL,
      active_reservations INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_active ON reservations(state, expires_at, slot);
    CREATE TABLE IF NOT EXISTS launch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
      launch_id TEXT,
      slot TEXT,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      details_json TEXT
    );
  `);
  const row = db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version') as SqlRow | undefined;
  const metadataVersion = row ? Number(row.value) : 0;
  const pragmaVersion = rowNumber(db.prepare('PRAGMA user_version').get()?.user_version) ?? 0;
  if (metadataVersion !== pragmaVersion && metadataVersion !== 0 && pragmaVersion !== 0) {
    closeDb(db);
    throw new Error(`inconsistent balancer sqlite schema versions: metadata=${metadataVersion}, user_version=${pragmaVersion}`);
  }
  ensureAdditiveColumns(db);
  if (metadataVersion !== DB_SCHEMA_VERSION || pragmaVersion !== DB_SCHEMA_VERSION) {
    db.prepare('INSERT OR REPLACE INTO schema_metadata(key, value) VALUES (?, ?)').run('schema_version', String(DB_SCHEMA_VERSION));
    db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
  }
  initializePolicy(db);
  migrateUsageCacheSync(db, stateRoot);
  return db;
}
// Nullable columns older builds neither write nor read. Adding one is invisible to
// them, so it must NOT bump DB_SCHEMA_VERSION: a bump makes every already-running
// process that holds the previous build in memory reject the file it is sharing.
function ensureAdditiveColumns(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(usage_windows)').all() as SqlRow[];
    if (!columns.some(column => rowString(column.name) === 'window_minutes')) {
      db.exec('ALTER TABLE usage_windows ADD COLUMN window_minutes INTEGER');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function initializePolicy(db: DatabaseSync) {
  // Upsert, not INSERT OR IGNORE: these rows are the forensic record of which
  // selection policy is resident, so a stale row would misreport getDbStatus.
  db.prepare('INSERT INTO policy(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('version', String(POLICY.version));
  db.prepare('INSERT INTO policy(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('json', JSON.stringify(POLICY));
}
function closeDb(db: DatabaseSync) { try { db.close(); } catch { /* ignore close errors */ } }
function migrationCompleted(db: DatabaseSync): boolean {
  const key = db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('usage_cache_v2_migrated') as SqlRow | undefined;
  if (key) return true;
  const event = db.prepare('SELECT id FROM launch_events WHERE event_type = ? LIMIT 1').get('migrated_usage_cache_v2') as SqlRow | undefined;
  if (event) {
    db.prepare('INSERT OR IGNORE INTO schema_metadata(key, value) VALUES (?, ?)').run('usage_cache_v2_migrated', String(Date.now()));
    return true;
  }
  return false;
}
function migrateUsageCacheSync(db: DatabaseSync, stateRoot: string) {
  const cache = readUsageCacheSync(stateRoot);
  if (!cache || migrationCompleted(db)) return;
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (migrationCompleted(db)) {
      db.exec('COMMIT');
      return;
    }
    for (const [slot, entry] of Object.entries(cache.accounts)) {
      db.prepare('INSERT INTO accounts(slot, first_seen_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(slot) DO NOTHING').run(slot, now, now);
      writeUsageSnapshot(db, { ...entry, slot }, cache.generated_at);
    }
    db.prepare('INSERT INTO launch_events(event_type, created_at, details_json) VALUES (?, ?, ?)').run('migrated_usage_cache_v2', now, JSON.stringify({ generated_at: cache.generated_at, slots: Object.keys(cache.accounts).length }));
    db.prepare('INSERT OR REPLACE INTO schema_metadata(key, value) VALUES (?, ?)').run('usage_cache_v2_migrated', String(now));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function syncAccountInventory(db: DatabaseSync, accounts: InternalAccount[]) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO accounts(slot, id_hash, account_id_hash, auth_hash, auth_path, pi_auth_path, active_pi, active_codex, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET
      id_hash = excluded.id_hash,
      account_id_hash = excluded.account_id_hash,
      auth_hash = excluded.auth_hash,
      auth_path = excluded.auth_path,
      pi_auth_path = excluded.pi_auth_path,
      active_pi = excluded.active_pi,
      active_codex = excluded.active_codex,
      last_seen_at = excluded.last_seen_at
  `);
  for (const account of accounts) {
    stmt.run(account.slot, account.idHash, account.accountIdHash ?? null, account.authHash, account.authPath, account.piAuthPath ?? null, account.activePi ? 1 : 0, account.activeCodex ? 1 : 0, now, now);
  }
}
function writeWindow(db: DatabaseSync, snapshotId: number, slot: string, label: string, window: UsageWindow | undefined) {
  if (!window) return;
  db.prepare(`INSERT INTO usage_windows(snapshot_id, slot, label, remaining_percent, reset_at, reset_in_seconds, window_minutes, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    snapshotId,
    slot,
    window.label || label,
    window.remainingPercent ?? null,
    window.resetAt ?? null,
    window.resetInSeconds ?? null,
    window.windowMinutes ?? null,
    window.stale ? 1 : 0,
  );
}
function writeUsageSnapshot(db: DatabaseSync, entry: LegacyUsageEntry, generatedAt = Date.now()) {
  db.prepare('INSERT INTO accounts(slot, first_seen_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(slot) DO NOTHING').run(entry.slot, Date.now(), Date.now());
  const primary = entry.primary ?? entry.windows?.primary;
  const secondary = entry.secondary ?? entry.windows?.secondary;
  const status = entry.status || (primary || secondary ? 'ok' : 'unknown');
  const result = db.prepare(`
    INSERT INTO usage_snapshots(slot, generated_at, updated_at, source, status, problem_code, problem_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.slot, generatedAt, entry.updatedAt ?? generatedAt, entry.source || 'cache', status, entry.problem?.code ?? null, entry.problem?.message ?? null, Date.now());
  const snapshotId = Number(result.lastInsertRowid);
  writeWindow(db, snapshotId, entry.slot, 'primary', normalizeWindow('primary', primary));
  writeWindow(db, snapshotId, entry.slot, 'secondary', normalizeWindow('secondary', secondary));
}
function latestUsageEntries(db: DatabaseSync): Record<string, UsageEntry> {
  const snapshots = db.prepare(`
    SELECT s.* FROM usage_snapshots s
    JOIN (SELECT slot, MAX(id) AS id FROM usage_snapshots GROUP BY slot) latest ON latest.id = s.id
  `).all() as SqlRow[];
  const out: Record<string, UsageEntry> = {};
  for (const s of snapshots) {
    const slot = String(s.slot);
    const windows = db.prepare('SELECT * FROM usage_windows WHERE snapshot_id = ?').all(s.id as number) as SqlRow[];
    const entry: UsageEntry = {
      slot,
      updatedAt: rowNumber(s.updated_at),
      source: (rowString(s.source) as UsageEntry['source']) || 'cache',
      status: (rowString(s.status) as CodexAccountStatus) || 'unknown',
      problem: s.problem_code || s.problem_message ? { code: String(s.problem_code || 'unknown'), message: String(s.problem_message || '') } : undefined,
    };
    for (const w of windows) {
      const label = String(w.label);
      const window: UsageWindow = {
        label,
        remainingPercent: rowNumber(w.remaining_percent),
        windowMinutes: rowNumber(w.window_minutes),
        resetAt: (() => { const resetAt = rowNumber(w.reset_at); return resetAt == null ? undefined : persistedResetAtMs(resetAt); })(),
        resetInSeconds: rowNumber(w.reset_in_seconds),
        stale: Number(w.stale) === 1,
      };
      if (label === 'primary') entry.primary = window;
      else if (label === 'secondary') entry.secondary = window;
    }
    out[slot] = entry;
  }
  return out;
}
function latestGeneratedAt(db: DatabaseSync): number | undefined {
  const row = db.prepare('SELECT MAX(generated_at) AS generated_at FROM usage_snapshots').get() as SqlRow | undefined;
  return rowNumber(row?.generated_at);
}

export async function getUsage(options: { stateRoot?: string; staleAfterMs?: number } | string = {}): Promise<CodexUsage> {
  const stateRoot = typeof options === 'string' ? options : options.stateRoot || resolveStateRoot();
  const staleAfterMs = typeof options === 'string' ? DEFAULT_STALE_AFTER_MS : options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  try {
    const accounts = await loadInternalAccounts(stateRoot);
    const db = openDb(stateRoot);
    let generatedAt = Date.now();
    try { generatedAt = latestGeneratedAt(db) ?? generatedAt; } finally { closeDb(db); }
    const stale = Date.now() - generatedAt > staleAfterMs;
    return {
      generatedAt,
      staleAfterMs,
      error: stale ? 'stale' : undefined,
      accounts: accounts.map(a => {
        const primary = a.usage?.primary ? { ...a.usage.primary, stale: a.usage.primary.stale || stale } : undefined;
        const secondary = a.usage?.secondary ? { ...a.usage.secondary, stale: a.usage.secondary.stale || stale } : undefined;
        return {
          slot: a.slot,
          label: a.slot,
          accountIdHash: a.accountIdHash || a.idHash,
          activePi: a.activePi,
          activeCodex: a.activeCodex,
          status: a.usage?.status || (a.usage?.primary || a.usage?.secondary ? 'ok' : 'unknown'),
          usage: { primary, secondary, updatedAt: a.usage?.updatedAt, source: a.usage?.source || (a.usage ? 'cache' : 'unknown') },
          problem: a.usage?.problem,
          tokenExpiresAt: a.tokenExpiresAt,
          refreshable: a.hasRefreshToken,
        };
      }),
    };
  } catch (e) {
    return { accounts: [], generatedAt: Date.now(), staleAfterMs, unavailable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

async function scanInternalAccounts(stateRoot = resolveStateRoot()): Promise<InternalAccount[]> {
  const dir = path.join(stateRoot, 'accounts');
  const s = await salt(stateRoot);
  const activePiHash = await readActivePiAccountIdHash();
  const activeCodexHash = await readActiveCodexAccountIdHash();
  let slots: string[] = [];
  try { slots = await fs.readdir(dir); } catch { return []; }
  const out: InternalAccount[] = [];
  for (const slot of slots.sort()) {
    const authPath = path.join(dir, slot, 'auth.json');
    if (!(await exists(authPath))) continue;
    const piAuthPath = (await exists(path.join(dir, slot, 'pi-openai-codex.json'))) ? path.join(dir, slot, 'pi-openai-codex.json') : undefined;
    const accountIdHash = await readAccountIdHash(piAuthPath);
    const content = await fs.readFile(authPath);
    // Read expiry from the file startTokenLease actually leases from (same
    // piAuthPath-then-authPath precedence), so what the footer warns about is
    // what will really expire.
    const leased = tokenFromAuth(await readJson<unknown>(piAuthPath || authPath, undefined));
    out.push({
      slot,
      authPath,
      piAuthPath,
      authHash: sha(content),
      idHash: sha(s + ':' + slot),
      accountIdHash,
      activePi: !!accountIdHash && accountIdHash === activePiHash,
      activeCodex: !!accountIdHash && accountIdHash === activeCodexHash,
      tokenExpiresAt: leased.expiresAt,
      hasRefreshToken: !!leased.refreshToken,
      claimBearing: !!accessTokenAccountId(leased.accessToken),
    });
  }
  return out;
}
async function loadInternalAccounts(stateRoot = resolveStateRoot()): Promise<InternalAccount[]> {
  const accounts = await scanInternalAccounts(stateRoot);
  const db = openDb(stateRoot);
  try {
    syncAccountInventory(db, accounts);
    const usage = latestUsageEntries(db);
    return accounts.map(account => ({ ...account, usage: usage[account.slot] }));
  } finally {
    closeDb(db);
  }
}
export async function loadAccounts(stateRoot = resolveStateRoot()): Promise<Account[]> { return (await loadInternalAccounts(stateRoot)).map(({ authHash: _authHash, activePi: _activePi, activeCodex: _activeCodex, accountIdHash: _accountIdHash, tokenExpiresAt: _tokenExpiresAt, hasRefreshToken: _hasRefreshToken, claimBearing: _claimBearing, ...account }) => account); }

async function findLatestJsonl(dir: string): Promise<string | undefined> {
  const found: Array<{ path: string; mtime: number }> = [];
  async function walk(p: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push({ path: child, mtime: (await fs.stat(child)).mtimeMs });
    }
  }
  await walk(path.join(dir, 'sessions'));
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}
function findRateLimits(value: unknown): ProbeRateLimits | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value) && (value.primary || value.secondary)) return value as ProbeRateLimits;
  const direct = value.rate_limits;
  if (isRecord(direct) && (direct.primary || direct.secondary)) return direct as ProbeRateLimits;
  for (const child of Object.values(value)) {
    const found = findRateLimits(child);
    if (found) return found;
  }
  return undefined;
}
function extractRateLimitsFromLine(line: string): ProbeRateLimits | undefined {
  try {
    return findRateLimits(JSON.parse(line));
  } catch { }
  return undefined;
}
async function readLatestRateLimits(codexHome: string): Promise<ProbeRateLimits | undefined> {
  const session = await findLatestJsonl(codexHome);
  if (!session) return undefined;
  const lines = (await fs.readFile(session, 'utf8')).trim().split('\n').reverse();
  for (const line of lines) {
    const limits = extractRateLimitsFromLine(line);
    if (limits) return limits;
  }
  return undefined;
}
async function runCodexProbe(codexHome: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('codex', ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', PROBE_MODEL, PROBE_PROMPT], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`codex exited ${signal || code}: ${(stderr || stdout).trim().slice(-500)}`));
    });
  });
}
async function probeUsageForAccount(account: InternalAccount): Promise<UsageEntry> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `codex-usage-${account.slot}-`));
  try {
    await fs.chmod(tmp, 0o700);
    await fs.copyFile(account.authPath, path.join(tmp, 'auth.json'));
    await fs.chmod(path.join(tmp, 'auth.json'), 0o600);
    await runCodexProbe(tmp);
    const rateLimits = await readLatestRateLimits(tmp);
    if (!rateLimits) throw new Error('probe completed without rate_limits');
    return {
      slot: account.slot,
      primary: windowFromRateLimit('primary', rateLimits.primary),
      secondary: windowFromRateLimit('secondary', rateLimits.secondary),
      updatedAt: Date.now(),
      source: 'probe',
      status: rateLimits.rate_limit_reached_type ? 'limited' : 'ok',
    };
  } catch (e) {
    return {
      slot: account.slot,
      updatedAt: Date.now(),
      source: 'probe',
      status: 'broken',
      problem: { code: 'probe_failed', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function refreshUsage(options: { stateRoot?: string; all?: boolean; slot?: string } | string = {}, opts: { all?: boolean; slot?: string } = {}) {
  const stateRoot = typeof options === 'string' ? options : options.stateRoot || resolveStateRoot();
  const o = typeof options === 'string' ? opts : options;
  const accounts = await loadInternalAccounts(stateRoot);
  const wanted = new Set(o.slot ? [o.slot] : accounts.map(a => a.slot));
  const probed: UsageEntry[] = [];
  for (const account of accounts) {
    if (!wanted.has(account.slot)) continue;
    probed.push(await probeUsageForAccount(account));
  }
  const db = openDb(stateRoot);
  try {
    syncAccountInventory(db, accounts);
    const generatedAt = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of probed) writeUsageSnapshot(db, entry, generatedAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeDb(db);
  }
  return getUsage({ stateRoot });
}

function attributableSlot(db: DatabaseSync, input: LiveUsageIngestInput): string | undefined {
  if (input.slot) return input.slot;
  if (input.reservation_id) {
    const row = db.prepare('SELECT slot FROM reservations WHERE id = ? AND (? IS NULL OR launch_id = ?)').get(input.reservation_id, input.launch_id ?? null, input.launch_id ?? null) as SqlRow | undefined;
    return rowString(row?.slot);
  }
  if (input.launch_id) {
    const rows = db.prepare('SELECT DISTINCT slot FROM reservations WHERE launch_id = ?').all(input.launch_id) as SqlRow[];
    return rows.length === 1 ? rowString(rows[0].slot) : undefined;
  }
  return undefined;
}

export async function ingestLiveUsage(input: LiveUsageIngestInput): Promise<LiveUsageIngestResult> {
  try {
    const stateRoot = input.stateRoot || resolveStateRoot();
    const db = openDb(stateRoot);
    try {
      const slot = attributableSlot(db, input);
      if (!slot) return { ok: true, ingested: false, skipped: 'ambiguous_attribution' };
      let normalized: ReturnType<typeof normalizeLiveRateLimits>;
      for (const candidate of liveRateLimitCandidates(input)) {
        normalized = normalizeLiveRateLimits(candidate);
        if (normalized) break;
      }
      if (!normalized) return { ok: true, ingested: false, slot, skipped: 'no_rate_limits' };
      const generatedAt = input.generated_at && Number.isFinite(input.generated_at) ? input.generated_at : Date.now();
      const updatedAt = input.updated_at && Number.isFinite(input.updated_at) ? input.updated_at : generatedAt;
      db.exec('BEGIN IMMEDIATE');
      try {
        writeUsageSnapshot(db, { slot, primary: normalized.primary, secondary: normalized.secondary, updatedAt, source: 'live', status: normalized.status }, generatedAt);
        db.prepare('INSERT INTO launch_events(reservation_id, launch_id, slot, event_type, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)').run(input.reservation_id ?? null, input.launch_id ?? null, slot, 'live_usage_ingested', Date.now(), JSON.stringify({ source: 'live', has_primary: !!normalized.primary, has_secondary: !!normalized.secondary }));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { ok: true, ingested: true, slot };
    } finally {
      closeDb(db);
    }
  } catch (error) {
    return { ok: false, ingested: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function ingestDirectPiLiveUsage(input: Omit<LiveUsageIngestInput, 'slot'>): Promise<LiveUsageIngestResult> {
  const usage = await getUsage({ stateRoot: input.stateRoot });
  const slot = selectSingleActivePiSlot(usage);
  if (!slot) return { ok: true, ingested: false, skipped: 'ambiguous_attribution' };
  return ingestLiveUsage({ ...input, slot });
}

function releaseExpiredReservations(db: DatabaseSync, now = Date.now()) {
  db.prepare(`UPDATE reservations SET state = 'expired', updated_at = ? WHERE state IN ('pending', 'prepared') AND expires_at <= ?`).run(now, now);
}
function activeReservationCounts(db: DatabaseSync, now = Date.now()): Record<string, number> {
  const rows = db.prepare(`SELECT slot, COUNT(*) AS count FROM reservations WHERE state IN ('pending', 'prepared') AND expires_at > ? GROUP BY slot`).all(now) as SqlRow[];
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.slot)] = rowNumber(row.count) ?? 0;
  return out;
}
function statusOf(entry: UsageEntry | undefined): CodexAccountStatus {
  return entry?.status || (entry?.primary || entry?.secondary ? 'ok' : 'unknown');
}
/**
 * `requestedSlotMode`:
 *  - 'hard' (explicit `--slot`): only that slot is considered; an unusable slot is an error.
 *  - 'soft' (session affinity / rotation hint): that slot wins when it is selectable,
 *    otherwise selection falls back to the full account set. A preference must never
 *    turn a usable install into `slot unavailable by policy`.
 */
function selectAccount(accounts: InternalAccount[], usage: Record<string, UsageEntry>, activeCounts: Record<string, number>, stateRoot: string, requestedSlot: string | undefined, requestedSlotMode: 'hard' | 'soft', now: number): { account: InternalAccount; selection: SelectionMetadata } {
  const candidates: Array<{ account: InternalAccount; selection: SelectionMetadata }> = [];
  const hardSlot = requestedSlotMode === 'hard' ? requestedSlot : undefined;
  const considered = hardSlot ? accounts.filter(a => a.slot === hardSlot) : accounts;
  if (hardSlot && considered.length === 0) throw new Error(`slot not found: ${hardSlot}`);
  for (const account of considered) {
    const entry = usage[account.slot];
    const status = statusOf(entry);
    const active = activeCounts[account.slot] || 0;
    const primary = normalizeWindow('primary', entry?.primary);
    const secondary = normalizeWindow('secondary', entry?.secondary);
    const generatedAt = entry?.updatedAt;
    const stale = generatedAt != null ? now - generatedAt > POLICY.selectionStaleAfterMs : true;
    const usageStale = stale || primary?.stale === true || secondary?.stale === true;
    const remPrimary = primary?.remainingPercent;
    const remSecondary = secondary?.remainingPercent;
    const penalties: string[] = [];
    if (status === 'broken') { penalties.push('rejected:broken'); continue; }
    if (!usageStale && remPrimary != null && remPrimary < POLICY.hardFloorPrimaryPercent) { penalties.push('rejected:primary_hard_floor'); continue; }
    if (!usageStale && remSecondary != null && remSecondary < POLICY.hardFloorSecondaryPercent) { penalties.push('rejected:secondary_hard_floor'); continue; }
    let score = 50;
    if (remPrimary != null) score += remPrimary * 0.6;
    if (remSecondary != null) score += remSecondary * 0.4;
    if (entry?.updatedAt == null && !primary && !secondary) {
      score -= POLICY.unknownPenalty;
      penalties.push('unknown_usage');
    }
    if (status === 'limited') {
      score -= POLICY.limitedPenalty;
      penalties.push('limited');
    }
    if (usageStale) {
      score -= POLICY.stalePenalty;
      penalties.push('stale_usage');
    }
    if (active > 0) {
      score -= active * POLICY.activeReservationPenalty;
      penalties.push(`active_reservations:${active}`);
    }
    if (secondary?.resetAt && remSecondary != null && secondary.resetAt > now) {
      const curve = clampPct(((secondary.resetAt - now) / WEEK_MS) * 100);
      const deficit = Math.max(0, curve - remSecondary);
      if (deficit > 0) {
        score -= deficit * POLICY.weeklyConservationPenalty;
        penalties.push(`weekly_conservation_deficit:${deficit.toFixed(2)}`);
      }
    }
    const reservationId = `res_${randomBytes(12).toString('hex')}`;
    const launchId = `launch_${randomBytes(12).toString('hex')}`;
    const tieBreak = sha(`${POLICY.version}:${stateRoot}:${account.slot}`).slice(0, 16);
    candidates.push({
      account,
      selection: {
        reservation_id: reservationId,
        launch_id: launchId,
        policy_version: POLICY.version,
        score: Number(score.toFixed(4)),
        active_reservations: active,
        reservation_expires_at: now + DEFAULT_RESERVATION_TTL_MS,
        generated_at: generatedAt,
        stale: stale || primary?.stale === true || secondary?.stale === true,
        tie_break: tieBreak,
        candidates_considered: considered.length,
        penalties,
      },
    });
  }
  if (candidates.length === 0) throw new Error(hardSlot ? `slot unavailable by policy: ${hardSlot}` : 'no accounts available by policy');
  candidates.sort((a, b) => b.selection.score - a.selection.score || b.selection.tie_break.localeCompare(a.selection.tie_break) || a.account.slot.localeCompare(b.account.slot));
  if (requestedSlot && requestedSlotMode === 'soft') {
    const preferred = candidates.find(c => c.account.slot === requestedSlot);
    if (preferred) {
      preferred.selection.penalties.push('preferred_slot_honored');
      return preferred;
    }
    candidates[0].selection.penalties.push(`preferred_slot_unavailable:${requestedSlot}`);
  }
  return candidates[0];
}
export async function chooseSlot(stateRoot = resolveStateRoot(), slot?: string, opts: { runId?: string; rootRunId?: string; reservationTtlMs?: number; softSlot?: boolean } = {}): Promise<ReservedAccount> {
  const accounts = await scanInternalAccounts(stateRoot);
  if (accounts.length === 0) throw new Error('no accounts found');
  const db = openDb(stateRoot);
  try {
    syncAccountInventory(db, accounts);
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      releaseExpiredReservations(db, now);
      const usage = latestUsageEntries(db);
      const activeCounts = activeReservationCounts(db, now);
      const selected = selectAccount(accounts, usage, activeCounts, stateRoot, slot, opts.softSlot ? 'soft' : 'hard', now);
      const expiresAt = now + (opts.reservationTtlMs && opts.reservationTtlMs > 0 ? opts.reservationTtlMs : DEFAULT_RESERVATION_TTL_MS);
      selected.selection.reservation_expires_at = expiresAt;
      db.prepare(`
        INSERT INTO reservations(id, slot, launch_id, state, created_at, updated_at, expires_at, run_id, root_run_id, selected_score, active_reservations, metadata_json)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(selected.selection.reservation_id, selected.account.slot, selected.selection.launch_id, now, now, expiresAt, opts.runId ?? null, opts.rootRunId ?? null, selected.selection.score, selected.selection.active_reservations, JSON.stringify(selected.selection));
      db.prepare('INSERT INTO launch_events(reservation_id, launch_id, slot, event_type, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)').run(selected.selection.reservation_id, selected.selection.launch_id, selected.account.slot, 'reserved', now, JSON.stringify(selected.selection));
      db.exec('COMMIT');
      const withUsage = { ...selected.account, usage: usage[selected.account.slot] };
      return { ...withUsage, reservationId: selected.selection.reservation_id, launchId: selected.selection.launch_id, selection: selected.selection };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeDb(db);
  }
}
function insertReservationEvent(db: DatabaseSync, reservationId: string | undefined, launchId: string | undefined, eventType: string, now: number, details: Record<string, unknown> = {}) {
  const row = reservationId ? db.prepare('SELECT slot, launch_id, state FROM reservations WHERE id = ?').get(reservationId) as SqlRow | undefined : undefined;
  db.prepare('INSERT INTO launch_events(reservation_id, launch_id, slot, event_type, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)').run(reservationId ?? null, launchId ?? rowString(row?.launch_id) ?? null, rowString(row?.slot) ?? null, eventType, now, JSON.stringify(details));
  return row;
}
const TERMINAL_RESERVATION_STATES = new Set<ReservationState>(['completed', 'released', 'failed', 'conflict', 'expired']);
function isTerminalReservationState(state: unknown): state is ReservationState { return typeof state === 'string' && TERMINAL_RESERVATION_STATES.has(state as ReservationState); }
function markReservationInDb(db: DatabaseSync, reservationId: string | undefined, launchId: string | undefined, state: ReservationState, details: Record<string, unknown> = {}) {
  if (!reservationId) return;
  const now = Date.now();
  const row = db.prepare('SELECT state FROM reservations WHERE id = ?').get(reservationId) as SqlRow | undefined;
  const previousState = rowString(row?.state);
  let stateUpdated = false;
  if (!isTerminalReservationState(previousState)) {
    const result = db.prepare('UPDATE reservations SET state = ?, updated_at = ? WHERE id = ?').run(state, now, reservationId);
    stateUpdated = Number(result.changes) > 0;
  }
  insertReservationEvent(db, reservationId, launchId, stateUpdated ? state : `${state}_ignored`, now, { ...details, previous_state: previousState, state_updated: stateUpdated });
}
function markReservation(stateRoot: string, reservationId: string | undefined, launchId: string | undefined, state: ReservationState, details: Record<string, unknown> = {}) {
  if (!reservationId) return;
  const db = openDb(stateRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      markReservationInDb(db, reservationId, launchId, state, details);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeDb(db);
  }
}
export function writeBrokenSnapshot(stateRoot: string, slot: string, code: string, message: string) {
  const db = openDb(stateRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      writeUsageSnapshot(db, { slot, updatedAt: Date.now(), source: 'broken', status: 'broken', problem: { code, message } });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeDb(db);
  }
}
export function unbrickSlot(stateRoot: string, slot: string) {
  const db = openDb(stateRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      writeUsageSnapshot(db, { slot, updatedAt: Date.now(), source: 'manual', status: 'unknown' });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeDb(db);
  }
}
function assertSafeIsolatedDir(isolatedDir: string, stateRoot?: string) { const dir = path.resolve(isolatedDir); if (!path.isAbsolute(isolatedDir)) throw new Error('isolatedDir must be absolute'); if (dir === path.parse(dir).root || dir === os.homedir()) throw new Error('refusing unsafe isolatedDir'); if (stateRoot) { const root = path.resolve(stateRoot); if (dir === root || dir.startsWith(root + path.sep)) throw new Error('isolatedDir must not be inside stateRoot'); const marker = `${path.sep}auth${path.sep}codex-balancer`; if (!dir.endsWith(marker) && !dir.startsWith(os.tmpdir() + path.sep)) throw new Error('isolatedDir must be a run auth/codex-balancer dir or temp test dir'); } return dir; }
export async function prepareLaunch(isolatedDir: string, opts: { stateRoot?: string; slot?: string; runId?: string; rootRunId?: string; reservationTtlMs?: number } = {}): Promise<PrepareLaunchResult> {
  const stateRoot = opts.stateRoot || resolveStateRoot();
  isolatedDir = assertSafeIsolatedDir(isolatedDir, stateRoot);
  const acct = await chooseSlot(stateRoot, opts.slot, { runId: opts.runId, rootRunId: opts.rootRunId, reservationTtlMs: opts.reservationTtlMs });
  const piDir = path.join(isolatedDir, 'pi-agent');
  const codexDir = path.join(isolatedDir, 'codex');
  try {
    await fs.mkdir(piDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });
    await fs.copyFile(acct.authPath, path.join(codexDir, 'auth.json'));
    const piSourcePath = acct.piAuthPath || acct.authPath;
    await writeJson(path.join(piDir, 'auth.json'), piAuthStorageForCredential(piSourcePath));
    const metaPath = path.join(isolatedDir, 'balancer-metadata.json');
    const meta: LaunchMetadata = { slot: acct.slot, generation: acct.authHash, expected_generation: acct.authHash, authHash: acct.authHash, stateRoot, metadata_path: metaPath, reservation_id: acct.reservationId, launch_id: acct.launchId, policy_version: acct.selection.policy_version, run_id: opts.runId, root_run_id: opts.rootRunId, reservation_expires_at: acct.selection.reservation_expires_at, pi_auth_hash: sha(readFileSync(piSourcePath)) };
    await writeJson(metaPath, meta);
    markReservation(stateRoot, acct.reservationId, acct.launchId, 'prepared', { isolated_dir: isolatedDir, metadata_path: metaPath });
    const primary = normalizeWindow('primary', acct.usage?.primary);
    const secondary = normalizeWindow('secondary', acct.usage?.secondary);
    return { schema_version: 1, selected_slot: acct.slot, slot: acct.slot, label: acct.slot, reason: 'selected', status: acct.usage?.status === 'limited' ? 'limited' : acct.usage?.status === 'ok' ? 'ok' : 'unknown', isolated_dir: isolatedDir, pi_agent_dir: piDir, codex_home: codexDir, env: { PI_CODING_AGENT_DIR: piDir, CODEX_HOME: codexDir }, metadata: { metadata_path: metaPath, launch_id: acct.launchId, reservation_id: acct.reservationId }, selection: acct.selection, primary_remaining_percent: primary?.remainingPercent, secondary_remaining_percent: secondary?.remainingPercent };
  } catch (error) {
    try { markReservation(stateRoot, acct.reservationId, acct.launchId, 'failed', { stage: 'prepare', message: error instanceof Error ? error.message : String(error) }); } catch { /* preserve original prepare error */ }
    try { await fs.rm(isolatedDir, { recursive: true, force: true }); } catch { /* preserve original prepare error */ }
    throw error;
  }
}
export async function syncBack(isolatedDir: string, opts: { stateRoot?: string; slot?: string } = {}) {
  const meta = await readJson<LaunchMetadata | null>(path.join(isolatedDir, 'balancer-metadata.json'), null);
  if (!meta) throw new Error('missing balancer metadata');
  const stateRoot = opts.stateRoot || meta.stateRoot || resolveStateRoot();
  let tmpAuthPath: string | undefined;
  let tmpPiAuthPath: string | undefined;
  try {
    isolatedDir = assertSafeIsolatedDir(isolatedDir, stateRoot);
    if (path.resolve(isolatedDir) !== path.resolve(path.dirname(meta.metadata_path || path.join(isolatedDir, 'balancer-metadata.json')))) throw new Error('isolatedDir does not match metadata');
    const slot = opts.slot || meta.slot;
    if (slot !== meta.slot) throw new Error('slot does not match metadata');
    const authPath = path.join(stateRoot, 'accounts', slot, 'auth.json');
    const piAuthPath = path.join(stateRoot, 'accounts', slot, 'pi-openai-codex.json');
    const src = path.join(isolatedDir, 'codex', 'auth.json');
    const piSrc = path.join(isolatedDir, 'pi-agent', 'auth.json');
    const db = openDb(stateRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const reservation = meta.reservation_id ? db.prepare('SELECT state FROM reservations WHERE id = ?').get(meta.reservation_id) as SqlRow | undefined : undefined;
        const reservationState = rowString(reservation?.state);
        if (isTerminalReservationState(reservationState)) {
          insertReservationEvent(db, meta.reservation_id, meta.launch_id, 'sync_back_ignored', Date.now(), { isolated_dir: isolatedDir, previous_state: reservationState, state_updated: false });
          db.exec('COMMIT');
          return { ok: reservationState === 'completed', conflict: reservationState === 'conflict', retainedDir: reservationState === 'completed' ? null : isolatedDir };
        }
        const currentHash = sha(readFileSync(authPath));
        if (currentHash !== meta.generation) {
          // Intentionally NOT merging child creds here: access-token exp does not order the opaque
          // single-use refresh token, so a merge could roll the refresh token back and brick the
          // slot. Conflicts are retained for manual/opt-in handling.
          // KNOWN LIMITATION (opt-in legacy copied-credential path only): if the child rotated the
          // refresh token, canonical may keep a now-consumed token and brick on its next refresh.
          // That is handled at runtime by failover + quarantine (the slot self-excludes); the default
          // per-request lease path never copies a refresh token and so never hits this.
          markReservationInDb(db, meta.reservation_id, meta.launch_id, 'conflict', { isolated_dir: isolatedDir, reason: 'codex_auth_changed' });
          db.exec('COMMIT');
          return { ok: false, conflict: true, retainedDir: isolatedDir };
        }
        if (existsSync(piAuthPath) && meta.pi_auth_hash && sha(readFileSync(piAuthPath)) !== meta.pi_auth_hash) {
          // Intentionally NOT merging child creds here: access-token exp does not order the opaque
          // single-use refresh token, so a merge could roll the refresh token back and brick the
          // slot. Conflicts are retained for manual/opt-in handling.
          markReservationInDb(db, meta.reservation_id, meta.launch_id, 'conflict', { isolated_dir: isolatedDir, reason: 'pi_auth_changed' });
          db.exec('COMMIT');
          return { ok: false, conflict: true, retainedDir: isolatedDir };
        }
        tmpAuthPath = path.join(path.dirname(authPath), `.auth.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
        copyFileSync(src, tmpAuthPath);
        chmodSync(tmpAuthPath, 0o600);
        if (existsSync(piSrc)) {
          tmpPiAuthPath = path.join(path.dirname(piAuthPath), `.pi-openai-codex.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
          writeFileSync(tmpPiAuthPath, JSON.stringify(piCredentialFromAuthStorage(piSrc), null, 2) + '\n', { mode: 0o600 });
          chmodSync(tmpPiAuthPath, 0o600);
        }
        const nextHash = sha(readFileSync(tmpAuthPath));
        db.prepare(`
          INSERT INTO accounts(slot, auth_hash, auth_path, pi_auth_path, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(slot) DO UPDATE SET auth_hash = excluded.auth_hash, auth_path = excluded.auth_path, pi_auth_path = excluded.pi_auth_path, last_seen_at = excluded.last_seen_at
        `).run(slot, nextHash, authPath, tmpPiAuthPath ? piAuthPath : null, Date.now(), Date.now());
        markReservationInDb(db, meta.reservation_id, meta.launch_id, 'completed', { isolated_dir: isolatedDir });
        renameSync(tmpAuthPath, authPath);
        tmpAuthPath = undefined;
        if (tmpPiAuthPath) {
          renameSync(tmpPiAuthPath, piAuthPath);
          tmpPiAuthPath = undefined;
        }
        db.exec('COMMIT');
        return { ok: true, conflict: false, retainedDir: null };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      closeDb(db);
      if (tmpAuthPath) {
        try { rmSync(tmpAuthPath, { force: true }); } catch { /* ignore temp cleanup errors */ }
      }
      if (tmpPiAuthPath) {
        try { rmSync(tmpPiAuthPath, { force: true }); } catch { /* ignore temp cleanup errors */ }
      }
    }
  } catch (error) {
    try { markReservation(stateRoot, meta.reservation_id, meta.launch_id, 'failed', { stage: 'sync-back', message: error instanceof Error ? error.message : String(error) }); } catch { /* keep original sync error */ }
    throw error;
  }
}
export async function cleanupLaunch(isolatedDir: string) {
  const meta = await readJson<LaunchMetadata | null>(path.join(isolatedDir, 'balancer-metadata.json'), null);
  if (!meta) throw new Error('missing balancer metadata');
  isolatedDir = assertSafeIsolatedDir(isolatedDir, meta.stateRoot);
  if (path.resolve(isolatedDir) !== path.resolve(path.dirname(meta.metadata_path || path.join(isolatedDir, 'balancer-metadata.json')))) throw new Error('isolatedDir does not match metadata');
  if (meta.reservation_id) {
    const db = openDb(meta.stateRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const now = Date.now();
        const row = db.prepare('SELECT state FROM reservations WHERE id = ?').get(meta.reservation_id) as SqlRow | undefined;
        const previousState = rowString(row?.state);
        const result = db.prepare(`UPDATE reservations SET state = 'released', updated_at = ? WHERE id = ? AND state IN ('pending', 'prepared')`).run(now, meta.reservation_id);
        insertReservationEvent(db, meta.reservation_id, meta.launch_id, Number(result.changes) > 0 ? 'released' : 'cleanup', now, { isolated_dir: isolatedDir, cleanup: true, previous_state: previousState, state_updated: Number(result.changes) > 0 });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      closeDb(db);
    }
  }
  await fs.rm(isolatedDir, { recursive: true, force: true });
  return { ok: true };
}

function assertTokenLeaseInput(input: StartTokenLeaseInput) {
  if (input.provider !== 'bravo-codex-balanced') throw new Error('unsupported token lease provider');
  if (!input.model) throw new Error('model is required');
  if (!input.purpose) throw new Error('purpose is required');
  if (!Number.isFinite(input.expected_runtime_ms) || input.expected_runtime_ms <= 0) throw new Error('expected_runtime_ms must be positive');
  if (!Number.isFinite(input.ttl_safety_buffer_ms) || input.ttl_safety_buffer_ms < 0) throw new Error('ttl_safety_buffer_ms must be non-negative');
  if (input.abort_signal?.aborted) throw new Error('token lease aborted');
}
function affinityPath(stateRoot: string, key: string) { return path.join(stateRoot, 'leases', 'affinity', sha(key).slice(0, 32) + '.json'); }
async function readAffinitySlot(stateRoot: string, key: string | undefined): Promise<string | undefined> {
  if (!key) return undefined;
  const entry = await readJson<{ slot?: string; expires_at?: number } | null>(affinityPath(stateRoot, key), null);
  return entry?.slot && (!entry.expires_at || entry.expires_at > Date.now()) ? entry.slot : undefined;
}
async function writeAffinitySlot(stateRoot: string, key: string | undefined, slot: string, expiresAt: number) {
  if (!key) return;
  await writeJson(affinityPath(stateRoot, key), { schema_version: 1, slot, expires_at: expiresAt });
}
function refreshLockDir(stateRoot: string, slot: string) { return path.join(stateRoot, 'leases', 'refresh-locks', sha(slot).slice(0, 32)); }
async function wait(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_HEARTBEAT_MS = 10_000;
const REFRESH_LOCK_ACQUIRE_DEFAULT_MS = 60_000;
// process.kill(pid, 0) probes liveness without delivering a signal. EPERM means the process
// exists but we may not signal it (still alive); ESRCH means it is gone. This liveness check is
// only valid because the refresh lock lives under a SAME-MACHINE local stateRoot (~/.bravo): a
// pid from another host would be meaningless, but these locks are never shared across machines.
export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
// Pure steal decision, exported for test: only reclaim a lock that is BOTH stale (mtime older
// than staleMs, i.e. heartbeat stopped) AND whose owner process is dead. A slow-but-live refresh
// keeps its mtime fresh via the heartbeat, so it is never stolen out from under itself.
export function shouldStealRefreshLock(args: { ageMs: number; ownerAlive: boolean; staleMs: number }): boolean {
  return args.ageMs > args.staleMs && !args.ownerAlive;
}
function refreshLockAcquireMs(): number {
  const raw = process.env.CODEX_BALANCER_REFRESH_LOCK_ACQUIRE_MS;
  if (raw === undefined) return REFRESH_LOCK_ACQUIRE_DEFAULT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? REFRESH_LOCK_ACQUIRE_DEFAULT_MS : parsed;
}
async function withRefreshLock<T>(stateRoot: string, slot: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const lockDir = refreshLockDir(stateRoot, slot);
  const ownerPath = path.join(lockDir, 'owner.json');
  await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + refreshLockAcquireMs();
  // Unique per-acquisition token: in finally we only delete the lock if it still carries OUR
  // nonce, so a holder can never delete a lock that another process legitimately stole and re-took.
  const ownerNonce = randomBytes(12).toString('hex');
  while (true) {
    if (signal?.aborted) throw new Error('token lease aborted');
    try {
      await fs.mkdir(lockDir, { recursive: false, mode: 0o700 });
      await writeJson(ownerPath, { schema_version: 1, pid: process.pid, nonce: ownerNonce, created_at: Date.now() });
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockDir).catch(() => undefined);
      const owner = await readJson<{ pid?: number } | null>(ownerPath, null);
      const ageMs = stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
      const ownerAlive = isProcessAlive(owner?.pid);
      // Steal ONLY a lock that is both stale (heartbeat stopped) and owned by a dead process.
      // FIX A.2: the stat/owner read above is a moment-in-time snapshot, so a plain rm here is a
      // TOCTOU hazard — a concurrent process could re-acquire the lock between our read and the rm,
      // and that rm would then delete its FRESH lock. Make the steal atomic via rename: only one
      // stealer can win the rename of the stale dir, and the subsequent rm targets the private,
      // already-moved-aside dir (never a live lock). Losers fall through and retry acquisition.
      if (stat && shouldStealRefreshLock({ ageMs, ownerAlive, staleMs: REFRESH_LOCK_STALE_MS })) {
        const dead = `${lockDir}.dead.${ownerNonce}`;
        try {
          await fs.rename(lockDir, dead);            // atomic; only one stealer can win this
          await fs.rm(dead, { recursive: true, force: true }).catch(() => undefined);
        } catch { /* someone else moved/took it first; fall through and retry */ }
        continue; // retry acquisition; mkdir is the real atomic gate
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for token refresh lock for slot ${slot}`);
      await wait(100 + Math.floor(Math.random() * 150));
    }
  }
  // Heartbeat: touch the lockDir mtime while we hold it so a slow/hung refresh (the fetch has no
  // timeout) keeps the lock looking fresh and is never seen as stale by a concurrent acquirer.
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(lockDir, now, now).catch(() => undefined);
  }, REFRESH_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    if (signal?.aborted) throw new Error('token lease aborted');
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // FIX A.1: only remove the lock if it is STILL OURS (owner.json present and carrying our nonce).
    // Deleting on a MISSING owner.json was a bug: another process can be mid-acquisition — it has
    // created lockDir via mkdir but not yet written its owner.json — and our rm would delete that
    // freshly-created lock out from under it. Never delete on missing/different; only on a match.
    const current = await readJson<{ nonce?: string } | null>(ownerPath, null);
    if (current?.nonce === ownerNonce) await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Persist a freshly-exchanged credential. This is the one dangerous step both
 * the lease path and the proactive path share, so it lives in exactly one
 * place: the refreshed credential carries the rotated SINGLE-USE refresh token,
 * and failing to write it strands that token and bricks the slot with
 * invalid_grant on the next refresh. Callers must run this inside the slot's
 * refresh lock, and must not perform any fallible work between the exchange and
 * this call. Returns the new on-disk auth document.
 */
async function persistRefreshedCredential(authPath: string, auth: unknown, refreshed: CodexTokenSet): Promise<unknown> {
  const next = withRefreshedTokenShape(auth, refreshed);
  await atomicWriteJson(authPath, next);
  return next;
}

/**
 * How long before expiry a slot becomes eligible for proactive refresh.
 *
 * Codex access tokens live ~10 days. Refreshing with 4 days of headroom means a
 * refresh that has started failing gets ~4 days of retries before the token can
 * actually die — and, because the footer only warns under 3 days, a visible
 * expiry warning now means "proactive refresh is failing", not merely "time is
 * passing". That is the early signal; without it the first symptom is an outage.
 */
export const PROACTIVE_REFRESH_LEAD_MS = 4 * 24 * 60 * 60 * 1000;
/** Minimum spacing between proactive attempts per slot, so a persistently failing refresh cannot spin on every session start. */
const PROACTIVE_ATTEMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function readKv(db: DatabaseSync, key: string): string | undefined {
  return rowString((db.prepare('SELECT value FROM policy WHERE key = ?').get(key) as SqlRow | undefined)?.value);
}
function writeKv(stateRoot: string, key: string, value: string) {
  const db = openDb(stateRoot);
  try { db.prepare('INSERT INTO policy(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); } finally { closeDb(db); }
}
function readProactiveAttempt(stateRoot: string, slot: string): ProactiveAttempt | undefined {
  const db = openDb(stateRoot);
  try {
    const raw = readKv(db, `proactive_refresh:${slot}`);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.at === 'number' ? (parsed as ProactiveAttempt) : undefined;
  } catch { return undefined; } finally { closeDb(db); }
}

export type ProactiveAttempt = { at: number; ok: boolean; error?: string; errorKind?: OAuthErrorKind };
export type ProactiveRefreshOutcome = {
  slot: string;
  /** 'fresh': still far from expiry. 'cooldown': attempted too recently. 'adopted': another process had already refreshed it. */
  action: 'fresh' | 'cooldown' | 'adopted' | 'refreshed' | 'failed' | 'unrefreshable';
  expiresAt?: number;
  error?: string;
  errorKind?: OAuthErrorKind;
};

/**
 * Top up any slot whose access token expires within PROACTIVE_REFRESH_LEAD_MS.
 *
 * Deliberately NOT a second implementation of the lease refresh: it takes the
 * same per-slot refresh lock, re-reads under it, exchanges at most once, and
 * persists through the same shared write. It needs none of the lease path's
 * reservation telemetry or adopt-race retry loop — with no request waiting on
 * it, a token another process already refreshed is simply observed under the
 * lock and adopted, and a failure just gets recorded for the next attempt.
 *
 * Never throws: every outcome is reported per slot so callers can run it
 * fire-and-forget from a session hook.
 */
export async function ensureFreshTokens(options: { stateRoot?: string; leadMs?: number; signal?: AbortSignal; force?: boolean } = {}): Promise<ProactiveRefreshOutcome[]> {
  const stateRoot = options.stateRoot || resolveStateRoot();
  const leadMs = options.leadMs ?? PROACTIVE_REFRESH_LEAD_MS;
  const accounts = await scanInternalAccounts(stateRoot).catch(() => [] as InternalAccount[]);
  const out: ProactiveRefreshOutcome[] = [];
  for (const account of accounts) {
    const authPath = account.piAuthPath || account.authPath;
    const due = (expiresAt: number | undefined) => !expiresAt || expiresAt - Date.now() <= leadMs;
    if (!options.force && !due(account.tokenExpiresAt) && account.claimBearing) {
      out.push({ slot: account.slot, action: 'fresh', expiresAt: account.tokenExpiresAt });
      continue;
    }
    if (!account.hasRefreshToken) {
      out.push({ slot: account.slot, action: 'unrefreshable', expiresAt: account.tokenExpiresAt });
      continue;
    }
    const last = readProactiveAttempt(stateRoot, account.slot);
    if (!options.force && last && !last.ok && Date.now() - last.at < PROACTIVE_ATTEMPT_COOLDOWN_MS) {
      out.push({ slot: account.slot, action: 'cooldown', expiresAt: account.tokenExpiresAt, error: last.error, errorKind: last.errorKind });
      continue;
    }
    try {
      const outcome = await withRefreshLock(stateRoot, account.slot, options.signal, async (): Promise<ProactiveRefreshOutcome> => {
        const auth = await readJson<unknown>(authPath, undefined);
        const parsed = tokenFromAuth(auth);
        // Re-checked under the lock: a concurrent process may have refreshed
        // while we queued. Adopt its result rather than rotating again.
        if (!options.force && !due(parsed.expiresAt) && accessTokenAccountId(parsed.accessToken)) {
          return { slot: account.slot, action: 'adopted', expiresAt: parsed.expiresAt };
        }
        if (!parsed.refreshToken) return { slot: account.slot, action: 'unrefreshable', expiresAt: parsed.expiresAt };
        const exchanged = await refreshCodexToken(parsed.refreshToken, options.signal);
        const next = await persistRefreshedCredential(authPath, auth, { ...exchanged, accountId: parsed.accountId });
        return { slot: account.slot, action: 'refreshed', expiresAt: tokenFromAuth(next).expiresAt };
      });
      if (outcome.action === 'refreshed') {
        writeKv(stateRoot, `proactive_refresh:${account.slot}`, JSON.stringify({ at: Date.now(), ok: true } satisfies ProactiveAttempt));
      }
      out.push(outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorKind = classifyOAuthRefreshError(message);
      const redacted = redactSecretsInText(message);
      writeKv(stateRoot, `proactive_refresh:${account.slot}`, JSON.stringify({ at: Date.now(), ok: false, error: redacted, errorKind } satisfies ProactiveAttempt));
      // A revoked/exhausted refresh token is durable: surface it the same way
      // the lease path does so the slot reads as broken before it is needed.
      if (errorKind === 'invalid_grant') {
        try { writeBrokenSnapshot(stateRoot, account.slot, 'refresh_invalid_grant', redacted); } catch { /* best-effort */ }
      }
      out.push({ slot: account.slot, action: 'failed', expiresAt: account.tokenExpiresAt, error: redacted, errorKind });
    }
  }
  return out;
}

export type SlotTokenHealth = {
  slot: string;
  expiresAt?: number;
  expiresInMs?: number;
  hasRefreshToken: boolean;
  claimBearing: boolean;
  lastProactiveAttempt?: ProactiveAttempt;
  /** True when this slot cannot survive on its own: expired/expiring with no working refresh. */
  needsReauth: boolean;
};

/**
 * Read-only credential health per slot, for a loud check at session start.
 * Answers "can this slot still refresh itself, and how long has it got" without
 * touching the network or rotating anything.
 */
export async function getSlotTokenHealth(options: { stateRoot?: string } = {}): Promise<SlotTokenHealth[]> {
  const stateRoot = options.stateRoot || resolveStateRoot();
  const accounts = await scanInternalAccounts(stateRoot).catch(() => [] as InternalAccount[]);
  return accounts.map(account => {
    const lastProactiveAttempt = readProactiveAttempt(stateRoot, account.slot);
    const expiresInMs = account.tokenExpiresAt == null ? undefined : account.tokenExpiresAt - Date.now();
    return {
      slot: account.slot,
      expiresAt: account.tokenExpiresAt,
      expiresInMs,
      hasRefreshToken: account.hasRefreshToken,
      claimBearing: account.claimBearing,
      lastProactiveAttempt,
      needsReauth: !account.hasRefreshToken || lastProactiveAttempt?.errorKind === 'invalid_grant',
    };
  });
}

export async function startTokenLease(input: StartTokenLeaseInput): Promise<TokenLease> {
  assertTokenLeaseInput(input);
  const stateRoot = input.stateRoot || resolveStateRoot();
  const ttlMs = input.expected_runtime_ms + input.ttl_safety_buffer_ms;
  const preferred = input.preferred_slot || await readAffinitySlot(stateRoot, input.session_affinity_key);
  const account = await chooseSlot(stateRoot, preferred, { reservationTtlMs: ttlMs, softSlot: true });
  if (input.abort_signal?.aborted) {
    markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'aborted_after_reservation' });
    throw new Error('token lease aborted');
  }
  const authPath = account.piAuthPath || account.authPath;
  let auth = await readJson<unknown>(authPath, undefined);
  let parsed = tokenFromAuth(auth);
  const requiredUntil = Date.now() + ttlMs;
  if ((!parsed.accessToken || parsed.accessToken.trim().length < 8) && !parsed.refreshToken) {
    markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'empty_access_token' });
    throw new Error('selected slot has no usable access token');
  }
  if (!parsed.expiresAt || parsed.expiresAt <= requiredUntil || !accessTokenAccountId(parsed.accessToken)) {
    try {
      await withRefreshLock(stateRoot, account.slot, input.abort_signal, async () => {
        // Bounded refresh loop with advance-only recovery from a concurrent refresh-token
        // rotation. OpenAI single-uses each refresh token, so an isolated pi-balanced child
        // can rotate our token (R0->R1) and sync R1 to canonical between our read of R0 and
        // our refresh of R0 — making our refresh fail invalid_grant ("already used") even
        // though a valid R1 now sits on disk. SAFETY: OpenAI does reuse detection, so we
        // never replay a failed token and never step back to an older one; the only recovery
        // is to ADOPT a usable, claim-bearing access token that another process has already
        // written to disk. We deliberately do NOT retry the refresh with a *different* refresh
        // token: replaying a token that may already have been used elsewhere can trip OpenAI's
        // refresh-token reuse detection and invalidate the whole token family. Recovery is read-only.
        const MAX_REFRESH_ATTEMPTS = 3;
        let attempt = 0;
        while (attempt < MAX_REFRESH_ATTEMPTS) {
          attempt += 1;
          auth = await readJson<unknown>(authPath, undefined);
          parsed = tokenFromAuth(auth);
          // A concurrent process already produced a usable, claim-bearing token: done.
          if (parsed.expiresAt && parsed.expiresAt > requiredUntil && accessTokenAccountId(parsed.accessToken)) return;
          // An unexpired, ttl-sufficient token that merely lacks the account-id claim and
          // has no refresh token cannot be repaired here; fall through to the final claim
          // guard so it is recorded as 'claimless_access_token' rather than a bogus expiry error.
          if (parsed.expiresAt && parsed.expiresAt > requiredUntil && !parsed.refreshToken) return;
          if (!parsed.refreshToken) {
            // FIX E: a claimless access token with NO refresh token is an unrepairable poison pill.
            // Throwing the TTL/expiry error here (without bricking) would let it be reselected next
            // turn. Quarantine it instead: write a broken snapshot and fail with the account-id
            // error (which must NOT contain 'cannot refresh', so the outer catch records the failed
            // reservation rather than re-throwing verbatim and skipping the broken-state telemetry).
            if (!accessTokenAccountId(parsed.accessToken)) {
              writeBrokenSnapshot(stateRoot, account.slot, 'claimless_access_token', 'access token has no chatgpt_account_id claim and cannot be refreshed');
              markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'claimless_access_token' });
              throw new Error('selected slot access token has no accountId claim');
            }
            markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: parsed.expiresAt ? 'access_token_ttl_insufficient' : 'access_token_expiry_unknown' });
            throw new Error(parsed.expiresAt ? 'selected slot access token expires before requested lease ttl and cannot refresh' : 'selected slot access token expiry is unknown and cannot refresh');
          }
          let refreshed: CodexTokenSet;
          try {
            const exchanged = await refreshCodexToken(parsed.refreshToken, input.abort_signal);
            // The token endpoint does not echo the account id; carry forward the
            // one already on disk so withRefreshedTokenShape keeps writing it.
            refreshed = { ...exchanged, accountId: parsed.accountId };
          } catch (refreshError) {
            const upstream = refreshError instanceof Error ? refreshError.message : String(refreshError);
            const kind = classifyOAuthRefreshError(upstream);
            const redactedUpstream = redactSecretsInText(upstream);
            if (process.env.CODEX_BALANCER_LOG_REFRESH_ERRORS) {
              process.stderr.write(`[codex-balancer] refresh failed slot=${account.slot} kind=${kind} attempt=${attempt}: ${redactedUpstream}\n`);
            }
            // Race recovery (reuse-safe): an invalid_grant may mean a concurrent process already
            // rotated our token and completed its own refresh. Re-read disk; ONLY if a usable,
            // claim-bearing access token has now materialized do we loop and adopt it (the loop top
            // returns). We never retry the refresh with a different refresh token (reuse hazard).
            if (kind === 'invalid_grant' && attempt < MAX_REFRESH_ATTEMPTS) {
              await new Promise(r => setTimeout(r, 150));
              const fresh = tokenFromAuth(await readJson<unknown>(authPath, undefined));
              if (fresh.expiresAt && fresh.expiresAt > requiredUntil && accessTokenAccountId(fresh.accessToken)) {
                continue; // a concurrent refresh produced a usable token; adopt it on the next iteration
              }
            }
            // Not recoverable: token did not advance, not invalid_grant, or out of attempts.
            // Preserve the existing brick+throw behavior. Transient never bricks, just throws.
            if (kind === 'invalid_grant') {
              try { writeBrokenSnapshot(stateRoot, account.slot, 'refresh_invalid_grant', redactedUpstream); } catch { /* ignore */ }
            }
            const err = new Error('selected slot access token refresh failed');
            (err as any).errorKind = kind;
            (err as any).redactedUpstream = redactedUpstream;
            (err as any).cause = refreshError;
            throw err;
          }
          if (input.abort_signal?.aborted) {
            markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'aborted_after_refresh' });
            throw new Error('token lease aborted');
          }
          auth = await persistRefreshedCredential(authPath, auth, refreshed);
          parsed = tokenFromAuth(auth);
          if (!accessTokenAccountId(parsed.accessToken)) {
            writeBrokenSnapshot(stateRoot, account.slot, 'refresh_claimless_token', 'refreshed access token has no chatgpt_account_id claim');
            const err = new Error('selected slot access token refresh failed');
            (err as any).errorKind = 'invalid_grant';
            (err as any).redactedUpstream = 'refreshed access token has no chatgpt_account_id claim';
            throw err;
          }
          return; // refreshed successfully into a claim-bearing token
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.abort_signal?.aborted || message.includes('cannot refresh')) throw error;
      // FIX E: a claimless poison-pill thrown from inside the lock already wrote a broken snapshot
      // and recorded the failed reservation; surface its message verbatim (mirroring the existing
      // final-guard) instead of relabeling it as a generic refresh failure.
      if (message.includes('no accountId claim')) throw error;
      // A refresh-lock acquire timeout is contention, not a credential failure: the on-disk token
      // may be perfectly valid. Record it accurately and surface the lock message verbatim instead
      // of mislabeling it as a refresh failure (which would brick-adjacent the slot in telemetry).
      if (message.includes('timed out waiting for token refresh lock')) {
        markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'refresh_lock_acquire_timeout', slot: account.slot });
        throw error;
      }
      const error_kind = (error as any)?.errorKind ?? 'unknown';
      const redactedMessage = (error as any)?.redactedUpstream ?? redactSecretsInText(message);
      markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'access_token_refresh_failed', error_kind, message: redactedMessage });
      throw new Error('selected slot access token refresh failed');
    }
  }
  const { accessToken, expiresAt } = parsed;
  if (!accessToken || accessToken.trim().length < 8) {
    markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'empty_access_token' });
    throw new Error('selected slot has no usable access token');
  }
  if (!expiresAt || expiresAt <= requiredUntil) {
    markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'access_token_ttl_insufficient_after_refresh' });
    throw new Error('selected slot access token expires before requested lease ttl');
  }
  if (!accessTokenAccountId(accessToken)) {
    writeBrokenSnapshot(stateRoot, account.slot, 'claimless_access_token', 'access token has no chatgpt_account_id claim and cannot be refreshed');
    markReservation(stateRoot, account.reservationId, account.launchId, 'failed', { stage: 'token-lease', reason: 'claimless_access_token' });
    throw new Error('selected slot access token has no accountId claim');
  }
  const lease: TokenLease = {
    schema_version: 1,
    provider: 'bravo-codex-balanced',
    model: input.model,
    purpose: input.purpose,
    lease_id: account.reservationId,
    access_token: accessToken,
    slot: account.slot,
    label: account.slot,
    expires_at: account.selection.reservation_expires_at,
    account_id_hash: account.accountIdHash || account.idHash,
    reservation_id: account.reservationId,
    launch_id: account.launchId,
    session_affinity_key: input.session_affinity_key,
  };
  await writeAffinitySlot(stateRoot, input.session_affinity_key, account.slot, lease.expires_at + DEFAULT_RESERVATION_TTL_MS);
  return lease;
}

function reservationStateForFinish(status: TokenLeaseFinishStatus): ReservationState {
  if (status === 'completed') return 'completed';
  if (status === 'expired') return 'expired';
  return 'failed';
}
export async function finishTokenLease(input: FinishTokenLeaseInput): Promise<FinishTokenLeaseResult> {
  const stateRoot = input.stateRoot || resolveStateRoot();
  if (!input.lease_id || !input.reservation_id || !input.launch_id) throw new Error('lease_id, reservation_id, and launch_id are required');
  const db = openDb(stateRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const row = db.prepare('SELECT state FROM reservations WHERE id = ?').get(input.reservation_id) as SqlRow | undefined;
      const previous = rowString(row?.state);
      const alreadyFinal = isTerminalReservationState(previous);
      if (!alreadyFinal) db.prepare('UPDATE reservations SET state = ?, updated_at = ? WHERE id = ?').run(reservationStateForFinish(input.status), now, input.reservation_id);
      insertReservationEvent(db, input.reservation_id, input.launch_id, alreadyFinal ? 'token_lease_finish_ignored' : 'token_lease_finished', now, { status: input.status, error_kind: input.error_kind, previous_state: previous, state_updated: !alreadyFinal });
      db.exec('COMMIT');
      return { schema_version: 1, ok: true, lease_id: input.lease_id, reservation_id: input.reservation_id, status: input.status, already_final: alreadyFinal, previous_status: previous };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeDb(db);
  }
}

export async function getDbStatus(options: { stateRoot?: string } | string = {}) {
  const stateRoot = typeof options === 'string' ? options : options.stateRoot || resolveStateRoot();
  const db = openDb(stateRoot);
  try {
    const schema = db.prepare('SELECT value FROM schema_metadata WHERE key = ?').get('schema_version') as SqlRow | undefined;
    const journal = db.prepare('PRAGMA journal_mode').get() as SqlRow | undefined;
    const accountCount = rowNumber((db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as SqlRow | undefined)?.count) ?? 0;
    const reservationCount = rowNumber((db.prepare('SELECT COUNT(*) AS count FROM reservations').get() as SqlRow | undefined)?.count) ?? 0;
    const activeReservations = rowNumber((db.prepare(`SELECT COUNT(*) AS count FROM reservations WHERE state IN ('pending', 'prepared') AND expires_at > ?`).get(Date.now()) as SqlRow | undefined)?.count) ?? 0;
    return { stateRoot, dbPath: path.join(stateRoot, 'balancer.sqlite3'), schemaVersion: Number(schema?.value ?? DB_SCHEMA_VERSION), journalMode: String(Object.values(journal || { journal_mode: 'unknown' })[0]), generatedAt: latestGeneratedAt(db), accountCount, reservationCount, activeReservations };
  } finally {
    closeDb(db);
  }
}
export async function listReservations(options: { stateRoot?: string; includeInactive?: boolean } | string = {}) {
  const stateRoot = typeof options === 'string' ? options : options.stateRoot || resolveStateRoot();
  const includeInactive = typeof options === 'string' ? false : options.includeInactive ?? false;
  const db = openDb(stateRoot);
  try {
    releaseExpiredReservations(db);
    const rows = db.prepare(`${includeInactive ? 'SELECT * FROM reservations' : "SELECT * FROM reservations WHERE state IN ('pending', 'prepared') AND expires_at > ?"} ORDER BY created_at DESC`).all(...(includeInactive ? [] : [Date.now()])) as SqlRow[];
    return rows.map(row => ({ id: rowString(row.id), slot: rowString(row.slot), launchId: rowString(row.launch_id), state: rowString(row.state), createdAt: rowNumber(row.created_at), updatedAt: rowNumber(row.updated_at), expiresAt: rowNumber(row.expires_at), runId: rowString(row.run_id), rootRunId: rowString(row.root_run_id), selectedScore: rowNumber(row.selected_score), activeReservationsAtSelection: rowNumber(row.active_reservations) }));
  } finally {
    closeDb(db);
  }
}
export async function getPolicy(options: { stateRoot?: string } | string = {}) {
  const stateRoot = typeof options === 'string' ? options : options.stateRoot || resolveStateRoot();
  const db = openDb(stateRoot);
  try {
    const rows = db.prepare('SELECT key, value FROM policy ORDER BY key').all() as SqlRow[];
    const values = Object.fromEntries(rows.map(row => [String(row.key), String(row.value)]));
    return { version: POLICY.version, policy: POLICY, stored: values };
  } finally {
    closeDb(db);
  }
}
export function redactForJson<T>(v: T): T { return JSON.parse(JSON.stringify(v, (k, val) => /token|secret|refresh|key|auth_hash|expected_generation|generation|authHash/i.test(k) ? '[REDACTED]' : val)); }

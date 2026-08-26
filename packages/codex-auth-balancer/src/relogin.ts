import { CLUSTER_WINDOW_MS, DEVICE_AUTH_TIMEOUT_MS } from '@bravo/auth-balancer-contract';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { clearProactiveRefreshFailure, ensureFreshTokens, refreshUsage, unbrickSlot, withRefreshLock } from './index.js';

export type ReloginResult = { ok: boolean; slot: string; action: string; message: string; warning?: string };
export type CodexCheckSlot = {
  slot: string; account: string | null; deadline_at: null; deadline_in_ms: null; access_expires_at: number | null;
  last_login_at: number | null; level: 'ok' | 'fail'; reason: string | null; command: string;
};

type AuthIdentity = { identity?: string; account?: string; lastLogin?: number; refreshable: boolean; expiresAt?: number };
function jwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { return undefined; }
}
function inspectAuth(value: any): AuthIdentity {
  const tokens = value?.tokens;
  const claims = jwtPayload(tokens?.id_token);
  const profile = claims?.['https://api.openai.com/profile'] as { email?: unknown } | undefined;
  const email = (profile && typeof profile === 'object' ? profile.email : undefined)
    ?? claims?.['https://api.openai.com/profile.email'] ?? claims?.email;
  const authTime = claims?.auth_time;
  const identity = typeof tokens?.account_id === 'string' ? tokens.account_id
    : typeof tokens?.accountId === 'string' ? tokens.accountId
    : typeof email === 'string' ? email : undefined;
  const expiry = typeof tokens?.expiry_date === 'number' ? tokens.expiry_date
    : typeof tokens?.expiry_date === 'string' && Number.isFinite(Date.parse(tokens.expiry_date)) ? Date.parse(tokens.expiry_date) : undefined;
  return {
    identity, account: typeof email === 'string' ? email : identity,
    lastLogin: typeof authTime === 'number' ? authTime * 1000 : undefined,
    refreshable: typeof tokens?.refresh_token === 'string' && tokens.refresh_token.length > 0,
    expiresAt: expiry,
  };
}
function readAuth(file: string): any | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

export function recoverAbandonedRelogin(stateRoot: string, slot: string): 'restored' | 'stale' | 'none' {
  const authPath = path.join(stateRoot, 'accounts', slot, 'auth.json');
  const backup = `${authPath}.relogin-backup`;
  if (!existsSync(backup)) return 'none';
  if (!readAuth(authPath)) { renameSync(backup, authPath); return 'restored'; }
  unlinkSync(backup);
  return 'stale';
}

export function checkCodex(stateRoot: string, now = Date.now()): { accounts: CodexCheckSlot[]; clusters: Array<{ slots: [string, string]; apart_ms: number }> } {
  const root = path.join(stateRoot, 'accounts');
  let slots: string[] = [];
  try { slots = (awaitlessReaddir(root)); } catch { /* absent */ }
  const accounts = slots.map(slot => {
    recoverAbandonedRelogin(stateRoot, slot);
    const info = inspectAuth(readAuth(path.join(root, slot, 'auth.json')));
    const healthy = info.refreshable;
    return {
      slot, account: info.account ?? null, deadline_at: null, deadline_in_ms: null,
      access_expires_at: info.expiresAt ?? null, last_login_at: info.lastLogin ?? null,
      level: healthy ? 'ok' as const : 'fail' as const,
      reason: healthy ? null : 'no credential', command: `relogin codex ${slot}`,
    };
  });
  const clusters: Array<{ slots: [string, string]; apart_ms: number }> = [];
  for (let i = 0; i < accounts.length; i++) for (let j = i + 1; j < accounts.length; j++) {
    const a = accounts[i]!, b = accounts[j]!;
    if (a.access_expires_at !== null && b.access_expires_at !== null) {
      const apart = Math.abs(a.access_expires_at - b.access_expires_at);
      if (apart < CLUSTER_WINDOW_MS) clusters.push({ slots: [a.slot, b.slot], apart_ms: apart });
    }
  }
  void now;
  return { accounts, clusters };
}

function awaitlessReaddir(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function lastLoginLog(slotDir: string): string | undefined {
  try { return readFileSync(path.join(slotDir, 'log', 'codex-login.log'), 'utf8').trim().split(/\r?\n/).pop(); } catch { return undefined; }
}

export async function reloginCodexSlot(opts: { stateRoot: string; slot: string; ifNeeded?: boolean; tokenUrl?: string }): Promise<ReloginResult> {
  const slotDir = path.join(opts.stateRoot, 'accounts', opts.slot);
  const authPath = path.join(slotDir, 'auth.json');
  const backup = `${authPath}.relogin-backup`;
  if (!existsSync(slotDir) || !statSync(slotDir).isDirectory()) return { ok: false, slot: opts.slot, action: 'usage', message: `unknown slot ${opts.slot}` };
  recoverAbandonedRelogin(opts.stateRoot, opts.slot);
  if (opts.ifNeeded) {
    const outcome = (await ensureFreshTokens({ stateRoot: opts.stateRoot, slot: opts.slot, force: true, tokenUrl: opts.tokenUrl }))[0];
    if (outcome && ['refreshed', 'adopted', 'fresh'].includes(outcome.action)) {
      return { ok: true, slot: opts.slot, action: 'refreshed', message: `slot ${opts.slot} refreshed; not logging in` };
    }
  }

  let restoreArmed = false;
  const restore = () => {
    if (!restoreArmed || !existsSync(backup)) return;
    try { renameSync(backup, authPath); } catch { /* next run recovers */ }
  };
  const onExit = () => restore();
  process.on('exit', onExit);
  try {
    return await withRefreshLock(opts.stateRoot, opts.slot, undefined, async () => {
      if (existsSync(authPath)) {
        copyFileSync(authPath, backup);
        const fd = openSync(backup, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        chmodSync(backup, 0o600);
        restoreArmed = true;
      }
      const before = inspectAuth(readAuth(backup));
      const childResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; aborted: boolean; timeout: boolean }>((resolve, reject) => {
        const child = spawn('codex', ['login', '--device-auth'], { env: { ...process.env, CODEX_HOME: slotDir }, stdio: ['inherit', 'pipe', 'pipe'] });
        const mirror = (chunk: Buffer) => process.stderr.write(chunk);
        child.stdout.on('data', mirror); child.stderr.on('data', mirror);
        let aborted = false, timedOut = false;
        const interrupt = (signal: NodeJS.Signals) => { aborted = true; child.kill(signal); };
        const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
        process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, DEVICE_AUTH_TIMEOUT_MS);
        const dispatcherPid = Number(process.env.RELOGIN_DISPATCHER_PID);
        const parentWatch = Number.isInteger(dispatcherPid) && dispatcherPid > 0 ? setInterval(() => {
          try { process.kill(dispatcherPid, 0); } catch { aborted = true; child.kill('SIGTERM'); }
        }, 100) : undefined;
        parentWatch?.unref();
        child.on('error', reject);
        child.on('close', (code, signal) => {
          clearTimeout(timer); if (parentWatch) clearInterval(parentWatch); process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
          resolve({ code, signal, aborted, timeout: timedOut });
        });
      });
      if (childResult.code !== 0 || childResult.signal || childResult.aborted) {
        restore(); restoreArmed = false;
        const detail = lastLoginLog(slotDir);
        const aborted = childResult.timeout || childResult.aborted || !!childResult.signal;
        return { ok: false, slot: opts.slot, action: aborted ? 'aborted' : 'failed', message: `${aborted ? 'login aborted or timed out' : `codex login exited ${childResult.code}`}; slot unchanged${detail ? ` (${detail})` : ''}` };
      }
      const afterRaw = readAuth(authPath);
      const after = inspectAuth(afterRaw);
      if (!afterRaw || !after.refreshable || typeof afterRaw?.tokens?.access_token !== 'string') {
        restore(); restoreArmed = false;
        return { ok: false, slot: opts.slot, action: 'failed', message: 'codex login produced no usable credential; slot unchanged' };
      }
      if (before.identity && after.identity !== before.identity) {
        restore(); restoreArmed = false;
        return { ok: false, slot: opts.slot, action: 'failed', message: `logged in as ${after.identity ?? 'unknown'}, slot holds ${before.identity}; slot unchanged` };
      }
      if (existsSync(backup)) unlinkSync(backup);
      restoreArmed = false;
      return { ok: true, slot: opts.slot, action: 'logged-in', message: `codex slot ${opts.slot} re-logged in successfully` };
    }).then(async result => {
      if (!result.ok) return result;
      unbrickSlot(opts.stateRoot, opts.slot);
      clearProactiveRefreshFailure(opts.stateRoot, opts.slot);
      const refreshed = (await ensureFreshTokens({ stateRoot: opts.stateRoot, slot: opts.slot, force: true, tokenUrl: opts.tokenUrl }))[0];
      let warning: string | undefined;
      if (!refreshed || refreshed.action === 'failed' || refreshed.action === 'unrefreshable') warning = 'login succeeded, but the follow-up token refresh failed';
      try { await refreshUsage({ stateRoot: opts.stateRoot, slot: opts.slot, force: true }); } catch { warning = warning ?? 'login succeeded, but usage refresh failed'; }
      return { ...result, warning };
    });
  } finally {
    process.off('exit', onExit);
    restore();
  }
}

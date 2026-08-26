import { CLUSTER_WINDOW_MS, CLAUDE_REFRESH_WINDOW_MS, RED_MS, WARN_MS } from '@bravo/auth-balancer-contract';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discoverAccounts, readOAuth, resolveAuthswapRoot, resolveStateRoot } from './accounts.js';
import { setRefreshWarning } from './health.js';
import { refreshClaudeToken } from './oauth.js';
import { TokenRefresher, acquireLock, mergeCredentialFile, releaseLock, writeCredentialFile } from './refresh.js';

export type CheckSlot = {
  slot: string; account: string | null; deadline_at: number | null; deadline_in_ms: number | null;
  last_login_at: number | null; level: 'ok' | 'warn' | 'fail'; reason: string | null; command: string;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const days = (ms: number) => `${(ms / 86_400_000).toFixed(1)}d`;

export function checkClaude(now = Date.now(), authswapRoot = resolveAuthswapRoot()): CheckSlot[] {
  return discoverAccounts(authswapRoot).map(account => {
    const oauth = readOAuth(account.credentialPath);
    const deadline = oauth?.refreshTokenExpiresAt;
    const remaining = deadline === undefined ? null : deadline - now;
    const level: CheckSlot['level'] = !oauth || remaining === null || remaining <= 0 ? 'fail' : remaining < WARN_MS ? 'warn' : 'ok';
    const reason = !oauth ? 'no credential' : remaining === null ? 'deadline unknown' : remaining <= 0 ? 'deadline expired' : remaining < WARN_MS ? `due in ${days(remaining)}` : null;
    return {
      slot: account.slot, account: account.email ?? null, deadline_at: deadline ?? null,
      deadline_in_ms: remaining, last_login_at: deadline === undefined ? null : deadline - CLAUDE_REFRESH_WINDOW_MS,
      level, reason, command: `relogin claude ${account.slot}`,
    };
  });
}

function runClaude(scratch: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [], { env: { ...process.env, CLAUDE_CONFIG_DIR: scratch }, stdio: 'inherit' });
    let aborted = false;
    const forward = (signal: NodeJS.Signals) => { aborted = true; child.kill(signal); };
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
      resolve({ code, signal, aborted });
    });
  });
}

function printCluster(slot: string, deadline: number): void {
  for (const other of discoverAccounts()) {
    if (other.slot === slot) continue;
    const d = readOAuth(other.credentialPath)?.refreshTokenExpiresAt;
    if (d === undefined || Math.abs(d - deadline) >= CLUSTER_WINDOW_MS) continue;
    const fmt = (n: number) => new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' }).format(n);
    console.log(`warn  slot ${slot}'s new deadline (${fmt(deadline)}) is ${days(Math.abs(d - deadline))} from slot ${other.slot}'s (${fmt(d)}).`);
    console.log('      Two slots will die in the same week. Consider re-logging one of them');
    console.log('      early to spread them out.');
  }
}

export async function reloginClaudeSlot(slot: string, ifNeeded = false, tokenUrl?: string): Promise<number> {
  const account = discoverAccounts().find(item => item.slot === slot);
  if (!account) { console.error(`unknown slot ${slot}`); return 2; }
  const stateRoot = resolveStateRoot();
  const current = readOAuth(account.credentialPath);
  const remaining = (current?.refreshTokenExpiresAt ?? 0) - Date.now();
  if (ifNeeded && remaining > WARN_MS && current) {
    const refresher = new TokenRefresher({
      stateRoot,
      refresh: (token, options) => refreshClaudeToken(token, { ...options, tokenUrl }),
    });
    const outcome = await refresher.ensureFresh(account, true);
    if (outcome.status === 'fresh' || outcome.status === 'refreshed') {
      console.log(`slot ${slot} is fine (deadline in ${days(remaining)}); not logging in`);
      return 0;
    }
  }

  const tmpRoot = path.join(stateRoot, 'tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(tmpRoot, `relogin-claude-${slot}-`));
  try {
    console.log(`Logging in to claude slot ${slot} (${account.email ?? 'unknown'}).`);
    console.log('Type /login in the Claude session that opens, finish in the browser, then /exit.');
    console.log('Your existing credential is untouched until the new one is verified.');
    const child = await runClaude(scratch);
    if (child.aborted || child.signal) { console.error('login aborted; slot unchanged'); return 4; }
    let parsed: any;
    try { parsed = JSON.parse(readFileSync(path.join(scratch, '.credentials.json'), 'utf8')); }
    catch { console.error('no login was completed; slot unchanged'); return 4; }
    const tokens = parsed?.claudeAiOauth;
    if (!tokens || typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string' || typeof tokens.refreshTokenExpiresAt !== 'number' || tokens.refreshTokenExpiresAt <= Date.now()) {
      console.error('login produced an invalid credential; slot unchanged'); return 1;
    }
    let email: unknown;
    try { email = JSON.parse(readFileSync(path.join(scratch, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress; } catch { /* invalid below */ }
    if (email !== account.email) {
      console.error(`logged in as ${String(email ?? 'unknown')}, slot ${slot} holds ${account.email}; slot unchanged`); return 1;
    }
    let locked = false;
    for (let attempt = 0; attempt < 5 && !locked; attempt += 1) {
      locked = acquireLock(account.credentialPath, Date.now());
      if (!locked && attempt < 4) await sleep(2000);
    }
    if (!locked) { console.error(`credential for slot ${slot} is locked; slot unchanged`); return 1; }
    try {
      let raw = '{}';
      try { raw = readFileSync(account.credentialPath, 'utf8'); } catch { /* vanished */ }
      writeCredentialFile(account.credentialPath, mergeCredentialFile(raw, tokens));
    } finally { releaseLock(account.credentialPath); }
    setRefreshWarning(stateRoot, slot);
    console.log(`claude slot ${slot} re-logged in successfully`);
    printCluster(slot, tokens.refreshTokenExpiresAt);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

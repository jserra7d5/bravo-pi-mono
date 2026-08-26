#!/usr/bin/env node
import { AUTH_BALANCER_PROVIDERS } from '@bravo/auth-balancer-contract';
import { spawn } from 'node:child_process';
import { combineChecks, exitCodeForCheck, renderHuman, type ProviderPayload } from './check.js';
import { BalancerNotBuiltError, resolveBalancerCli } from './resolve.js';

export const HELP = `relogin — reset the OAuth session window for one balancer slot.

usage:
  relogin <claude|codex> <slot>              interactive re-login (always logs in)
  relogin <claude|codex> <slot> --if-needed  refresh first; log in only if that fails
  relogin --check [--json]                   deadlines for every slot, both providers
  relogin --help

why:
  Access tokens refresh themselves. Sessions do not. A Claude refresh token dies
  ~30 days after the interactive login that created it, and refreshing does NOT
  extend that clock — only logging in again does. Codex has no published
  deadline but its refresh chain can be revoked, and the recovery flow deletes
  the credential before it replaces it.

flags:
  --if-needed   Try a non-interactive refresh first. claude: skips the login only
                if the refresh-token deadline is more than 7 days out AND a
                forced refresh succeeds. codex: skips the login if a forced token
                refresh succeeds. Without this flag a login always happens.
  --json        Only valid with --check. The interactive flows own the terminal
                and emit no machine output.

safety:
  A failed, timed-out, or interrupted relogin always leaves the slot exactly as
  it was. Codex logins are destructive-first, so the credential is backed up
  before the flow starts and restored on any non-success exit — including a kill
  of this process (the backup is recovered on the next run).

exit codes:
  0  success (or --check found nothing past the warn threshold)
  1  relogin failed; the slot is unchanged
  2  usage error, or a balancer is not built
  3  --check found at least one slot inside the red threshold (< 2 days)
  4  the login was aborted or timed out; the slot is unchanged

examples:
  relogin --check
  relogin claude 1
  relogin codex 3
  relogin claude 2 --if-needed
`;

type Provider = (typeof AUTH_BALANCER_PROVIDERS)[number];
function run(provider: Provider, args: string[], mode: 'inherit' | 'capture'): Promise<{ code: number; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    // --check captures the child's stdout as JSON; node's SQLite ExperimentalWarning
    // would otherwise land on the inherited stderr and read as an error to the user.
    const argv = mode === 'capture' ? ['--no-warnings', resolveBalancerCli(provider), ...args] : [resolveBalancerCli(provider), ...args];
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, RELOGIN_DISPATCHER_PID: String(process.pid) },
      stdio: mode === 'inherit' ? 'inherit' : ['inherit', 'pipe', 'inherit'],
    });
    let stdout = '';
    if (mode === 'capture') child.stdout?.on('data', chunk => { stdout += chunk; });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
      resolve({ code: code ?? 1, signal, stdout });
    });
  });
}

async function check(json: boolean): Promise<number> {
  const [claude, codex] = await Promise.all([
    run('claude', ['relogin', '--check-json'], 'capture'),
    run('codex', ['relogin', '--check', '--json'], 'capture'),
  ]);
  if (claude.code !== 0 || codex.code !== 0) throw new Error('a balancer check failed');
  const c = JSON.parse(claude.stdout) as { accounts: ProviderPayload['accounts'] };
  const x = JSON.parse(codex.stdout) as ProviderPayload;
  const combined = combineChecks(c, x);
  console.log(json ? JSON.stringify(combined, null, 2) : renderHuman(combined, { color: !!process.stdout.isTTY }));
  return exitCodeForCheck(combined);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { process.stdout.write(HELP); return; }
  if (args[0] === '--check') {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== '--json')) { process.stderr.write(HELP); process.exitCode = 2; return; }
    process.exitCode = await check(args[1] === '--json'); return;
  }
  const provider = args[0] as Provider;
  const slot = args[1];
  const ifNeeded = args[2] === '--if-needed';
  if (!AUTH_BALANCER_PROVIDERS.includes(provider) || !slot || !/^\d+$/.test(slot) || args.length > 3 || (args[2] && !ifNeeded)) {
    process.stderr.write(HELP); process.exitCode = 2; return;
  }
  if (provider === 'claude') {
    const result = await run(provider, ['relogin', slot, ...(ifNeeded ? ['--if-needed'] : [])], 'inherit');
    if (result.signal) process.kill(process.pid, result.signal); else process.exitCode = result.code;
    return;
  }
  const result = await run(provider, ['relogin', '--slot', slot, ...(ifNeeded ? ['--if-needed'] : []), '--json'], 'capture');
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length) {
    try {
      const payload = JSON.parse(lines.join('\n')) as { message?: string; warning?: string };
      if (payload.message) console.log(payload.message);
      if (payload.warning) console.warn(`warn  ${payload.warning}`);
    } catch { /* balancer owns the diagnostic */ }
  }
  if (result.signal) process.kill(process.pid, result.signal); else process.exitCode = result.code;
}

main().catch(error => {
  console.error(error instanceof BalancerNotBuiltError ? error.message : `relogin: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof BalancerNotBuiltError ? 2 : 1;
});

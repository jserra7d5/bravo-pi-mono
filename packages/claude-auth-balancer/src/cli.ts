#!/usr/bin/env node
// claude-auth-balancer CLI.
//
//   claude-auth-balancer serve [--port N] [--allow-overage]
//   claude-auth-balancer status [--model M]
//   claude-auth-balancer accounts
//   claude-auth-balancer sweep

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AffinityStore } from './affinity.js';
import { discoverAccounts, loadAccountStates, resolveAuthswapRoot, resolveStateRoot } from './accounts.js';
import { TokenRefresher } from './refresh.js';
import { acquireSingletonLock, renderUnit, userUnitPath } from './daemon.js';
import type { SingletonLock } from './daemon.js';
import { MetricsStore } from './metrics.js';
import { computeHeadroom } from './policy.js';
import { DEFAULT_PORT, startProxy } from './proxy.js';
import type { ProxyLogEvent } from './proxy.js';

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function pct(n: number | undefined): string {
  return n === undefined ? '   -  ' : `${(n * 100).toFixed(1).padStart(5)}%`;
}

function ago(ms: number | undefined, now: number): string {
  if (ms === undefined) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

async function cmdServe(argv: string[]): Promise<void> {
  const port = Number(value(argv, 'port') ?? DEFAULT_PORT);
  const allowOverage = flag(argv, 'allow-overage');

  // Claimed before the port is bound. Two balancers on different ports would
  // both succeed at binding and then quietly share one state root — the exact
  // case the in-process atomicity of selection and lease-pinning does not cover.
  let lock: SingletonLock;
  try {
    lock = acquireSingletonLock(resolveStateRoot());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const drop = () => lock.release();
  process.on('exit', drop);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      drop();
      process.exit(0);
    });
  }
  const log = (e: ProxyLogEvent) => {
    const bits = [
      new Date().toISOString(),
      e.kind.padEnd(9),
      `${e.method} ${e.path}`,
      e.model ? `model=${e.model}` : '',
      e.slot ? `slot=${e.slot}` : '',
      e.decision ? `[${e.decision}]` : '',
      e.status ? `status=${e.status}` : '',
      e.reason ?? e.message ?? '',
    ].filter(Boolean);
    console.log(bits.join('  '));
  };

  const { url } = await startProxy({ port, allowOverage, log });
  console.log(`claude-auth-balancer listening on ${url}`);
  console.log(`state root : ${resolveStateRoot()}`);
  console.log(`credentials: ${resolveAuthswapRoot()}/providers/anthropic/credentials`);
  console.log(`overage    : ${allowOverage ? 'ALLOWED (will spend money past 100%)' : 'blocked'}`);
  console.log('');
  console.log('Point a client at it with:');
  console.log(`  export ANTHROPIC_BASE_URL=${url}`);
}

function cmdStatus(argv: string[]): void {
  const now = Date.now();
  const model = value(argv, 'model');
  const stateRoot = resolveStateRoot();
  const { states } = loadAccountStates({ stateRoot, nowMs: now });

  if (states.length === 0) {
    console.log('No Anthropic accounts found under', resolveAuthswapRoot());
    return;
  }

  console.log(`accounts (model=${model ?? 'any'})`);
  console.log('slot  email                                  5h      7d      7d_oi   headroom  binding  health');
  for (const s of states) {
    const h = computeHeadroom(s, model, now);
    const c = s.claims?.byId;
    console.log(
      [
        s.slot.padEnd(5),
        (s.email ?? '').padEnd(38).slice(0, 38),
        pct(c?.['5h']?.utilization),
        ' ',
        pct(c?.['7d']?.utilization),
        ' ',
        pct(c?.['7d_oi']?.utilization),
        ' ',
        h.headroom.toFixed(3).padStart(8),
        ' ',
        (h.bindingClaim ?? '-').padEnd(8),
        s.health.padEnd(13),
        (h.evacuating ? 'EVACUATING ' : '') + (h.overageAvailable ? 'overage ' : ''),
        `obs ${ago(s.observedAt, now)}`,
      ].join(''),
    );
  }

  const leases = new AffinityStore({ stateRoot }).list();
  console.log(`\nlive session leases: ${leases.length}`);
  for (const l of leases.slice(0, 20)) {
    console.log(`  ${l.session_id_hash.slice(0, 12)}  slot=${l.slot}  seen ${ago(l.last_seen_at, now)}`);
  }
}

function cmdAccounts(): void {
  const now = Date.now();
  const { states } = loadAccountStates({ stateRoot: resolveStateRoot(), nowMs: now });
  for (const s of states) {
    const exp =
      s.tokenExpiresAt === undefined
        ? 'unknown'
        : `${((s.tokenExpiresAt - now) / 3_600_000).toFixed(1)}h`;
    console.log(`slot ${s.slot}  ${s.email ?? '(unknown)'}  health=${s.health}  token expires in ${exp}`);
  }
}

/**
 * Install (or refresh) the systemd user unit and start it.
 *
 * A user unit, not a system one: the credentials live in the user's home and
 * the proxy has no business running as anything else.
 */
function cmdInstallService(argv: string[]): void {
  const port = Number(value(argv, 'port') ?? DEFAULT_PORT);
  const allowOverage = flag(argv, 'allow-overage');
  const target = userUnitPath();

  const unit = renderUnit({
    execPath: process.execPath,
    // Resolve to the real file rather than whatever shim is on PATH today, so
    // the unit keeps working after a PATH change or a shell rewrite.
    cliPath: fileURLToPath(import.meta.url),
    port,
    allowOverage,
  });

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, unit);
  console.log(`wrote ${target}`);

  const run = (...args: string[]): boolean => {
    const r = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
    return r.status === 0;
  };

  if (!run('daemon-reload')) {
    console.error('systemctl --user daemon-reload failed; is systemd user mode available?');
    process.exitCode = 1;
    return;
  }
  run('enable', 'claude-auth-balancer.service');
  // `restart` rather than `start`, so reinstalling picks up a changed port or
  // a changed overage decision instead of silently leaving the old one running.
  if (!run('restart', 'claude-auth-balancer.service')) {
    console.error('failed to start the service; check: systemctl --user status claude-auth-balancer');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`service running on port ${port}; overage ${allowOverage ? 'ALLOWED' : 'blocked'}`);
  console.log('  logs   : journalctl --user -u claude-auth-balancer -f');
  console.log('  status : systemctl --user status claude-auth-balancer');
  console.log('');
  console.log('For it to survive logout, enable lingering once:');
  console.log(`  sudo loginctl enable-linger ${os.userInfo().username}`);
  console.log('');
  console.log('Then point clients at it:');
  console.log(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
}

function cmdUninstallService(): void {
  const target = userUnitPath();
  spawnSync('systemctl', ['--user', 'disable', '--now', 'claude-auth-balancer.service'], {
    stdio: 'inherit',
  });
  try {
    rmSync(target);
    console.log(`removed ${target}`);
  } catch {
    console.log(`no unit at ${target}`);
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
}

function cmdSweep(): void {
  const removed = new AffinityStore({ stateRoot: resolveStateRoot() }).maybeSweep(true);
  console.log(`removed ${removed} expired lease file(s)`);
}

/**
 * Usage metrics. `--json` emits raw rows so a dashboard can consume them
 * directly; `--sql` runs an arbitrary read-only query against the store.
 */
function cmdMetrics(argv: string[]): void {
  const store = new MetricsStore(resolveStateRoot());
  const now = Date.now();
  const days = Number(value(argv, 'days') ?? 7);
  const json = flag(argv, 'json');
  const sql = value(argv, 'sql');

  try {
    if (sql) {
      const rows = store.query(sql);
      console.log(JSON.stringify(rows, null, json ? 0 : 2));
      return;
    }

    if (flag(argv, 'daily')) {
      const rows = store.daily(now, days);
      console.log(JSON.stringify(rows, null, json ? 0 : 2));
      return;
    }

    const rows = store.summary(now, days) as Record<string, number | string>[];
    if (json) {
      console.log(JSON.stringify(rows));
      return;
    }
    if (rows.length === 0) {
      console.log(`no usage recorded in the last ${days} day(s)`);
      return;
    }
    console.log(`usage, last ${days} day(s)`);
    console.log('slot  model                 reqs     input    output  cache-read cache-write     cost$  uncached$');
    for (const r of rows) {
      console.log(
        [
          String(r['slot']).padEnd(5),
          String(r['model']).padEnd(21).slice(0, 21),
          String(r['requests']).padStart(5),
          String(r['input_tokens']).padStart(10),
          String(r['output_tokens']).padStart(10),
          String(r['cache_read_tokens']).padStart(12),
          String(r['cache_write_tokens']).padStart(12),
          String(r['cost_usd']).padStart(10),
          String(r['uncached_usd']).padStart(11),
        ].join(' '),
      );
    }
  } finally {
    store.close();
  }
}

/**
 * Force a refresh pass now.
 *
 * The daemon does this on a timer; this is for checking that refresh works on
 * this machine without waiting, and for reviving slots after a long shutdown.
 */
async function cmdRefresh(): Promise<void> {
  const refresher = new TokenRefresher({
    log: e =>
      console.log(
        `slot ${e.slot}  ${e.email ?? ''}  ${e.outcome}${e.kind ? ` (${e.kind})` : ''}` +
          `${e.rotated ? '  refresh-token-rotated' : ''}` +
          `${e.expiresInMs !== undefined ? `  valid ${(e.expiresInMs / 3_600_000).toFixed(1)}h` : ''}` +
          `${e.message ? `  ${e.message}` : ''}`,
      ),
  });
  const accounts = discoverAccounts();
  const outcomes = await refresher.sweep(accounts);
  if (outcomes.length === 0) {
    console.log(`nothing to do: all ${accounts.length} account(s) are outside the refresh window`);
  }
}

function cmdPrune(argv: string[]): void {
  const store = new MetricsStore(resolveStateRoot());
  try {
    const days = Number(value(argv, 'days') ?? 30);
    const removed = store.prune(Date.now(), days);
    console.log(`pruned ${removed} raw request row(s) older than ${days}d (daily rollups kept)`);
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const [, , command = 'status', ...argv] = process.argv;
  switch (command) {
    case 'serve':
      await cmdServe(argv);
      return;
    case 'status':
      cmdStatus(argv);
      return;
    case 'accounts':
      cmdAccounts();
      return;
    case 'sweep':
      cmdSweep();
      return;
    case 'metrics':
      cmdMetrics(argv);
      return;
    case 'prune':
      cmdPrune(argv);
      return;
    case 'refresh':
      await cmdRefresh();
      return;
    case 'install-service':
      cmdInstallService(argv);
      return;
    case 'uninstall-service':
      cmdUninstallService();
      return;
    default:
      console.error(`unknown command: ${command}`);
      console.error(
        'usage: claude-auth-balancer <serve|status|accounts|metrics|refresh|sweep|prune|install-service>\n' +
          '  serve            [--port N] [--allow-overage]\n' +
          '  status           [--model M]\n' +
          '  metrics          [--days N] [--daily] [--json] [--sql "SELECT ..."]\n' +
          '  refresh          refresh any account near expiry, now\n' +
          '  prune            [--days N]\n' +
          '  install-service  [--port N] [--allow-overage]   systemd user unit\n' +
          '  uninstall-service',
      );
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

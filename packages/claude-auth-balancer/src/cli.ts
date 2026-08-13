#!/usr/bin/env node
// claude-auth-balancer CLI.
//
//   claude-auth-balancer serve [--port N] [--allow-overage]
//   claude-auth-balancer status [--model M]
//   claude-auth-balancer accounts
//   claude-auth-balancer sweep

import { AffinityStore } from './affinity.js';
import { loadAccountStates, resolveAuthswapRoot, resolveStateRoot } from './accounts.js';
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
    default:
      console.error(`unknown command: ${command}`);
      console.error(
        'usage: claude-auth-balancer <serve|status|accounts|metrics|sweep|prune>\n' +
          '  serve   [--port N] [--allow-overage]\n' +
          '  status  [--model M]\n' +
          '  metrics [--days N] [--daily] [--json] [--sql "SELECT ..."]\n' +
          '  prune   [--days N]',
      );
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { MetricsStore, dayKey } from '../src/metrics.js';
import { parseClaims } from '../src/claims.js';

const roots: string[] = [];
function store(): { store: MetricsStore; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cab-metrics-'));
  roots.push(root);
  return { store: new MetricsStore(root), root };
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 13, 12, 0, 0);

function record(s: MetricsStore, over: Partial<Parameters<MetricsStore['record']>[0]> = {}) {
  s.record({
    ts: T0,
    slot: '1',
    email: 'a@x.com',
    sessionHash: 'abc',
    model: 'claude-opus-5',
    endpoint: '/v1/messages',
    status: 200,
    decision: 'fresh',
    durationMs: 120,
    usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100_000 },
    ...over,
  });
}

test('day keys are UTC so charts do not shift with the host timezone', () => {
  assert.equal(dayKey(Date.UTC(2026, 7, 13, 23, 59, 0)), '2026-08-13');
  assert.equal(dayKey(Date.UTC(2026, 7, 14, 0, 1, 0)), '2026-08-14');
});

test('a request lands in both the raw table and the daily rollup', () => {
  const { store: s } = store();
  record(s);
  const raw = s.query('SELECT slot, model, cache_read_tokens, cost_usd FROM requests') as Record<string, number | string>[];
  assert.equal(raw.length, 1);
  assert.equal(raw[0]!['cache_read_tokens'], 100_000);
  assert.ok(Number(raw[0]!['cost_usd']) > 0);

  const rollup = s.query('SELECT day, slot, model, requests FROM usage_daily') as Record<string, number | string>[];
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0]!['day'], '2026-08-13');
  assert.equal(rollup[0]!['requests'], 1);
  s.close();
});

test('repeat requests accumulate in the rollup rather than duplicating rows', () => {
  const { store: s } = store();
  for (let i = 0; i < 5; i += 1) record(s);
  const rollup = s.query(
    'SELECT requests, cache_read_tokens, output_tokens FROM usage_daily',
  ) as Record<string, number>[];
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0]!['requests'], 5);
  assert.equal(rollup[0]!['cache_read_tokens'], 500_000);
  assert.equal(rollup[0]!['output_tokens'], 100);
  s.close();
});

test('rollups split by day, account, and model so a dashboard can slice on all three', () => {
  const { store: s } = store();
  record(s);
  record(s, { slot: '2' });
  record(s, { model: 'claude-fable-5' });
  record(s, { ts: T0 + DAY });
  const rows = s.query('SELECT day, slot, model FROM usage_daily ORDER BY day, slot, model') as Record<string, string>[];
  assert.equal(rows.length, 4);
  s.close();
});

test('claim utilization is captured per request for time-series charting', () => {
  const { store: s } = store();
  record(s, {
    claims: parseClaims({
      'anthropic-ratelimit-unified-5h-utilization': '0.46',
      'anthropic-ratelimit-unified-7d-utilization': '0.91',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.22',
    }),
  });
  const rows = s.query('SELECT util_5h, util_7d, util_7d_oi FROM requests') as Record<string, number>[];
  assert.equal(rows[0]!['util_5h'], 0.46);
  assert.equal(rows[0]!['util_7d'], 0.91);
  assert.equal(rows[0]!['util_7d_oi'], 0.22);
  s.close();
});

test('pruning drops raw rows but never the aggregate history', () => {
  const { store: s } = store();
  const now = T0 + 40 * DAY;
  record(s); // 40 days old
  record(s, { ts: now }); // today

  assert.equal((s.query('SELECT id FROM requests') as unknown[]).length, 2);
  const removed = s.prune(now, 30);
  assert.equal(removed, 1);

  const raw = s.query('SELECT id FROM requests') as unknown[];
  assert.equal(raw.length, 1, 'only the old raw row went');

  const rollup = s.query('SELECT day, requests FROM usage_daily ORDER BY day') as Record<string, number | string>[];
  assert.equal(rollup.length, 2, 'both days survive in the rollup');
  assert.equal(rollup[0]!['day'], '2026-08-13');
  s.close();
});

test('a second prune is a no-op rather than an error', () => {
  const { store: s } = store();
  record(s);
  const now = T0 + 40 * DAY;
  assert.equal(s.prune(now, 30), 1);
  assert.equal(s.prune(now, 30), 0);
  s.close();
});

test('summary aggregates from the rollup, so it survives pruning', () => {
  const { store: s } = store();
  record(s);
  const now = T0 + 40 * DAY;
  s.prune(now, 30);
  // The row is 40 days old; a 90-day summary must still find it.
  const rows = s.summary(now, 90) as Record<string, number | string>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['requests'], 1);
  s.close();
});

test('an unknown model records tokens but no fabricated cost', () => {
  const { store: s } = store();
  record(s, { model: 'mystery-model' });
  const rows = s.query('SELECT model, cost_usd, output_tokens FROM requests') as Record<string, number | string>[];
  assert.equal(rows[0]!['model'], 'mystery-model');
  assert.equal(rows[0]!['cost_usd'], 0);
  assert.equal(rows[0]!['output_tokens'], 20);
  s.close();
});

test('state survives reopening the database', () => {
  const { store: s, root } = store();
  record(s);
  s.close();
  const reopened = new MetricsStore(root);
  const rows = reopened.query('SELECT requests FROM usage_daily') as Record<string, number>[];
  assert.equal(rows[0]!['requests'], 1);
  reopened.close();
});

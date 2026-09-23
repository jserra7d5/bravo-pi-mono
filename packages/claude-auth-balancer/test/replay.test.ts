import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitMeter, Meter, fidelity, simulate } from '../src/replay.js';
import type { TraceRow } from '../src/replay.js';
import { capacityForTier, selectAccount } from '../src/policy.js';

const start = new Date('2026-09-12T01:00:00').getTime();
function row(id: number, ts: number, slot: string, u5: number, u7: number): TraceRow {
  return { id, ts, slot, session_hash: 's', model: 'opus', status: 200, cost_usd: 10, uncached_usd: 200, util_5h: u5, util_7d: u7, util_7d_oi: null };
}

test('meter opens a 5h window on first use, resets on :30, weekly cadence stays fixed', () => {
  const rates = { '1': { '5h': { general: .01, fable: .02 }, '7d': { general: .001, fable: .002 }, '7d_oi': { general: 0, fable: .004 } } };
  const m = new Meter(rates, { '1': start });
  m.burn(row(1, start + 12 * 60_000, '1', 0, 0));
  assert.equal(m.state('1', start + 12 * 60_000).reset['5h'], start + 5.5 * 3_600_000);
  assert.equal(m.state('1', start + 13 * 60_000).util['5h'], .1);
  assert.equal(m.state('1', start + 5.5 * 3_600_000).util['5h'], 0);
  assert.equal(m.state('1', start + 7 * 24 * 3_600_000).util['7d'], 0);
});

test('the cumulative fit recovers a known rate through 2-decimal readings and a reset', () => {
  // 5h burns 0.0008/$ and 7d 0.00025/$, read back floored to whole points.
  const rows: TraceRow[] = [];
  let u5 = 0, u7 = 0.1;
  for (let i = 0; i < 400; i += 1) {
    if (i === 200) u5 = 0; // a 5h rollover mid-trace
    u5 += 10 * 0.0008; u7 += 10 * 0.00025;
    rows.push(row(i, start + i * 60_000, '1', Math.floor(u5 * 100) / 100, Math.floor(u7 * 100) / 100));
  }
  const fit = fitMeter(rows);
  assert.ok(Math.abs(fit.rates['1']!['5h'].general / 0.0008 - 1) < 0.1, String(fit.rates['1']!['5h'].general));
  assert.ok(Math.abs(fit.rates['1']!['7d'].general / 0.00025 - 1) < 0.1, String(fit.rates['1']!['7d'].general));
  assert.deepEqual(fit.drops['1']!['5h'], [start + 200 * 60_000]);
});

test('the simulator serves on the real router and prices a forced move as a re-create', () => {
  const rates = (r5: number) => ({ '5h': { general: r5, fable: r5 }, '7d': { general: .0001, fable: .0002 }, '7d_oi': { general: 0, fable: .0004 } });
  const at = new Date('2026-09-15T00:00:00').getTime();
  const rows = [row(1, at, '1', 0, 0), row(2, at + 1000, '1', 0, 0), row(3, at + 2000, '2', 0, 0), row(4, at + 3000, '2', 0, 0)];
  const cap = { '1': capacityForTier('default_claude_max_20x'), '2': capacityForTier('default_claude_max_20x') };
  const score = simulate(rows, new Meter({ '1': rates(.001), '2': rates(.001) }, {}), selectAccount, () => undefined, cap);
  assert.equal(score.served, 4);
  assert.equal(score.unserved, 0);
  // One request fills a 5h window: the session's next request must move.
  const moved = simulate(rows.slice(0, 2), new Meter({ '1': rates(.1), '2': rates(.1) }, {}), selectAccount, () => undefined, cap);
  assert.equal(moved.recreates, 1);
  assert.equal(moved.recreateUsd, 190);
});

test('the fidelity gate fails a meter that cannot reproduce the trace', () => {
  const at = new Date('2026-09-15T00:00:00').getTime();
  const rows = [row(1, at, '1', .01, .01), row(2, at + 1000, '1', .5, .02)];
  const result = fidelity(rows, new Meter({ '1': { '5h': { general: .001, fable: .001 }, '7d': { general: .001, fable: .001 }, '7d_oi': { general: 0, fable: 0 } } }, {}), {});
  assert.equal(result.pass, false);
});

test('sessions warm when the policy takes over keep their recorded account', () => {
  const rates = { '5h': { general: .001, fable: .001 }, '7d': { general: .0001, fable: .0001 }, '7d_oi': { general: 0, fable: 0 } };
  const at = new Date('2026-09-15T00:00:00').getTime();
  const cap = { '1': capacityForTier('default_claude_max_20x'), '2': capacityForTier('default_claude_max_20x') };
  // Recorded on slot 2 just before the policy starts; slot 1 would win a fresh pick.
  const rows = [row(1, at - 60_000, '2', .3, .3), { ...row(2, at - 50_000, '1', 0, 0), session_hash: 'bystander' }, row(3, at + 1000, '2', .3, .3)];
  const warm = simulate(rows, new Meter({ '1': rates, '2': rates }, {}), selectAccount, () => undefined, cap, { startAt: at });
  assert.deepEqual(warm.slots, { '2': 1 });
  assert.equal(warm.recreates, 0);
  const cold = simulate([{ ...rows[1]! }, { ...rows[2]!, session_hash: 'other' }], new Meter({ '1': rates, '2': rates }, {}), selectAccount, () => undefined, cap, { startAt: at });
  assert.deepEqual(cold.slots, { '1': 1 }, 'the control: a fresh session goes to slot 1');
});

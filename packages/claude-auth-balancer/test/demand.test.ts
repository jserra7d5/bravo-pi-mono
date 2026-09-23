import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { parseClaims } from '../src/claims.js';
import {
  buildDemandModel,
  buildHourlyProfile,
  DEFAULT_K,
  DEFAULT_W20_PER_USD,
  DEMAND_STALE_MS,
  expectedDemand,
  fitW20PerUsd,
  rateLimitedDemand,
  readDemandModel,
  readDemandOverrides,
  sessionRate,
  weekHour,
  writeDemandModel,
} from '../src/demand.js';
import type { DemandModel } from '../src/demand.js';
import { HOUR_MS, MetricsStore } from '../src/metrics.js';

const roots: string[] = [];
function tmp(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cab-demand-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// Local midnight, so weekday/hour buckets do not depend on the host timezone.
const MON = new Date(2026, 8, 14, 0, 0, 0).getTime();

type Rec = { ts: number; slot?: string; session?: string; model?: string; status?: number; u5?: number; u7?: number; out?: number };
function record(s: MetricsStore, r: Rec): void {
  const headers: Record<string, string> = {};
  if (r.u5 !== undefined) headers['anthropic-ratelimit-unified-5h-utilization'] = String(r.u5);
  if (r.u7 !== undefined) headers['anthropic-ratelimit-unified-7d-utilization'] = String(r.u7);
  s.record({
    ts: r.ts,
    slot: r.slot ?? '1',
    sessionHash: r.session ?? 's1',
    model: r.model ?? 'claude-opus-5',
    endpoint: '/v1/messages',
    status: r.status ?? 200,
    decision: 'fresh',
    durationMs: 100,
    usage: { inputTokens: 0, outputTokens: r.out ?? 1000 },
    claims: parseClaims(headers),
  });
}

// --- hourly rollup ---------------------------------------------------------

test('the rollup folds closed hours once, with per-hour sessions, exhaustions and resets', () => {
  const s = new MetricsStore(tmp());
  const h0 = MON + 9 * HOUR_MS;
  record(s, { ts: h0 + 60_000, session: 'a', u5: 0.5, u7: 0.40 });
  record(s, { ts: h0 + 120_000, session: 'b', u5: 0.6, u7: 0.41 });
  record(s, { ts: h0 + 180_000, session: 'a', u5: 1.0, u7: 0.42 }); // exhausted
  record(s, { ts: h0 + HOUR_MS + 60_000, session: 'a', u5: 0.02, u7: 0.42 }); // 5h rolled over
  record(s, { ts: h0 + 2 * HOUR_MS + 60_000, session: 'a', u5: 0.03, u7: 0.01 }); // weekly reset
  record(s, { ts: h0 + 3 * HOUR_MS + 60_000, session: 'a', u5: 0.04, u7: 0.02 }); // still open

  assert.equal(s.rollupHours(h0 + 3 * HOUR_MS + 120_000), 3, 'three closed hours with traffic');
  assert.equal(s.rollupHours(h0 + 3 * HOUR_MS + 120_000), 0, 'idempotent');
  const rows = s.query(
    'SELECT hour, requests, sessions, exhaustions, util_5h_first f5, util_5h_last l5, reset_5h, reset_7d FROM usage_hourly ORDER BY hour',
  ) as Record<string, number>[];
  assert.deepEqual(rows.map(r => [r['requests'], r['sessions'], r['exhaustions'], r['reset_5h'], r['reset_7d']]), [
    [3, 2, 1, 0, 0],
    [1, 1, 0, 1, 0],
    [1, 1, 0, 0, 1],
  ]);
  assert.equal(rows[0]!['f5'], 0.5);
  assert.equal(rows[0]!['l5'], 1.0);
  const cost = s.query('SELECT SUM(cost_usd) c FROM usage_hourly')[0] as { c: number };
  const raw = s.query('SELECT SUM(cost_usd) c FROM requests WHERE ts < ?', [h0 + 3 * HOUR_MS])[0] as { c: number };
  assert.equal(cost.c, raw.c, 'cost is carried exactly');
  s.close();
});

test('an incremental rollup writes what a single backfill writes', () => {
  const trace = (s: MetricsStore) => {
    for (let i = 0; i < 40; i += 1) {
      const slot = String(1 + (i % 2));
      record(s, { ts: MON + i * 17 * 60_000, slot, session: `s${i % 5}`, u5: ((i * 7) % 100) / 100, u7: 0.3 + i / 200 });
    }
  };
  const end = MON + 12 * HOUR_MS;
  const once = new MetricsStore(tmp());
  trace(once);
  once.rollupHours(end);
  const steps = new MetricsStore(tmp());
  trace(steps);
  for (let t = MON + HOUR_MS + 5_000; t <= end; t += 2 * HOUR_MS + 1_234) steps.rollupHours(t);
  steps.rollupHours(end);
  for (const sql of ['SELECT * FROM usage_hourly ORDER BY hour, slot, model_class', 'SELECT * FROM fleet_hourly ORDER BY hour']) {
    assert.deepEqual(steps.query(sql), once.query(sql), sql);
  }
  once.close();
  steps.close();
});

test('an hour is censored when every account is at the ceiling, and empty hours still get a fleet row', () => {
  const s = new MetricsStore(tmp());
  record(s, { ts: MON + 60_000, slot: '1', u5: 0.2, u7: 0.96 });
  record(s, { ts: MON + 120_000, slot: '2', u5: 0.97, u7: 0.5 });
  // Hour 1: nothing. Hour 2: slot 2's 5h window rolled over.
  record(s, { ts: MON + 2 * HOUR_MS + 60_000, slot: '2', u5: 0.01, u7: 0.5 });
  s.rollupHours(MON + 3 * HOUR_MS);
  const fleet = s.query('SELECT censored g FROM fleet_hourly ORDER BY hour') as { g: number }[];
  assert.deepEqual(fleet.map(f => f.g), [1, 1, 0]);
  s.close();
});

// --- fitting -----------------------------------------------------------------

type Row = Parameters<typeof fitW20PerUsd>[0][number];

/** A slot's meter under a known rate, read back at 2-decimal resolution like the server's. */
function meter(slot: string, weekly: number, rate: { general: number; fable: number }, hours: number, fableEvery = 3): Row[] {
  const rows: Row[] = [];
  let used = 0.05;
  for (let h = 0; h < hours; h += 1) {
    const hour = MON + h * HOUR_MS;
    const general = 60 + (h % 5) * 10;
    const fable = h % fableEvery === 0 ? 50 : 0;
    used += (general * rate.general + fable * rate.fable) / weekly;
    const reading = Math.floor(used * 100) / 100;
    rows.push({ hour, slot, model_class: 'general', cost_usd: general, util_7d_last: reading, reset_7d: 0 });
    if (fable) rows.push({ hour, slot, model_class: 'fable', cost_usd: fable, util_7d_last: reading, reset_7d: 0 });
  }
  return rows;
}

test('the per-dollar fit recovers each model class and sizes a 5x meter by its plan', () => {
  const rate = { general: 1 / 4000, fable: 1 / 1800 };
  const rows = [...meter('1', 1, rate, 120), ...meter('5', 1 / 1.7, rate, 120, 2)];
  const fit = fitW20PerUsd(rows, slot => (slot === '5' ? 1 / 1.7 : 1))!;
  assert.ok(Math.abs(fit.general / rate.general - 1) < 0.1, `general ${1 / fit.general}`);
  assert.ok(Math.abs(fit.fable / rate.fable - 1) < 0.15, `fable ${1 / fit.fable}`);
});

test('a reset or an anomalous drop re-anchors the fit instead of reading as negative burn', () => {
  const rate = { general: 1 / 4000, fable: 1 / 1800 };
  const rows = meter('1', 1, rate, 120);
  // Hour 60: the server resets the meter (reset flag). Hour 90: it drops by
  // 0.1 without a flag (the 09-01 kind).
  for (const r of rows) {
    const h = (r.hour - MON) / HOUR_MS;
    if (h >= 60 && r.util_7d_last !== null) r.util_7d_last = Math.max(0, r.util_7d_last - 0.5);
    if (h === 60) r.reset_7d = 1;
    if (h >= 90 && r.util_7d_last !== null) r.util_7d_last = Math.max(0, r.util_7d_last - 0.1);
  }
  const fit = fitW20PerUsd(rows, () => 1)!;
  assert.ok(Math.abs(fit.general / rate.general - 1) < 0.1, `general ${1 / fit.general}`);
});

test('too little data to separate the classes gives one pooled rate, and too few samples none', () => {
  const rows = meter('1', 1, { general: 1 / 4000, fable: 1 / 4000 }, 120, 1_000);
  const fit = fitW20PerUsd(rows, () => 1)!;
  assert.equal(fit.general, fit.fable);
  assert.equal(fitW20PerUsd(rows.slice(0, 6), () => 1), undefined);
});

// --- hourly profile --------------------------------------------------------------

test('the profile learns the shape of the week and scales it to the latest week', () => {
  const now = MON + 21 * 24 * HOUR_MS;
  const hours: { hour: number; cost: number; censored: boolean }[] = [];
  for (let t = MON; t < now; t += HOUR_MS) {
    const weekend = [0, 6].includes(new Date(t).getDay());
    const week = Math.floor((t - MON) / (7 * 24 * HOUR_MS));
    // Weekdays 10, weekends 2; the last week spends twice as much.
    hours.push({ hour: t, cost: (weekend ? 2 : 10) * (week === 2 ? 2 : 1), censored: false });
  }
  const profile = buildHourlyProfile(hours, 0.001, now)!;
  const lastWeek = hours.filter(h => h.hour >= now - 168 * HOUR_MS).reduce((a, h) => a + h.cost, 0);
  const total = profile.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(total - lastWeek * 0.001) < 1e-9, 'sums to the latest week');
  const tueNoon = profile[weekHour(new Date(2026, 8, 15, 12).getTime())]!;
  const satNoon = profile[weekHour(new Date(2026, 8, 19, 12).getTime())]!;
  assert.ok(Math.abs(tueNoon / satNoon - 5) < 1e-9, `${tueNoon / satNoon}`);
  assert.equal(buildHourlyProfile(hours.slice(0, 167), 0.001, now), undefined, 'under a week: no profile');
});

test('a censored hour is left out rather than read as a quiet one', () => {
  const now = MON + 14 * 24 * HOUR_MS;
  const hours = [];
  for (let t = MON; t < now; t += HOUR_MS) hours.push({ hour: t, cost: 10, censored: false });
  // Tuesday 12:00 of the first week: the fleet was empty, so spend was 0.
  const tue = hours.find(h => h.hour === new Date(2026, 8, 15, 12).getTime())!;
  tue.cost = 0;
  const withGap = buildHourlyProfile(hours, 1, now)!;
  tue.censored = true;
  const skipped = buildHourlyProfile(hours, 1, now)!;
  const b = weekHour(tue.hour);
  assert.ok(withGap[b]! < skipped[b]!);
  assert.equal(Number(skipped[b]!.toFixed(9)), 10);
});

// --- integration and overrides ----------------------------------------------------

const flat = (perHour: number, overrides: DemandModel['overrides'] = []): DemandModel => ({
  computedAt: MON, w20PerUsd: { general: 1, fable: 1 }, k: 0.2, freshBurn: 0,
  hourly: new Array(168).fill(perHour), overrides,
});

test('demand integrates partial hours, applies date overrides, and caps at an account rate', () => {
  const d = flat(0.05);
  assert.equal(Number(expectedDemand(d, MON + 30 * 60_000, MON + 3 * HOUR_MS).toFixed(9)), 0.125);
  assert.equal(Number(rateLimitedDemand(d, MON, MON + 10 * HOUR_MS, 0.01).toFixed(9)), 0.1);
  const off = flat(0.05, [{ from: '2026-09-14', to: '2026-09-14', multiplier: 0 }]);
  assert.equal(expectedDemand(off, MON, MON + 24 * HOUR_MS), 0, 'a day off');
  assert.equal(Number(expectedDemand(off, MON, MON + 25 * HOUR_MS).toFixed(9)), 0.05, 'ends with the day');
});

test('a cold store gives defaults and no profile; expired overrides are dropped', () => {
  const s = new MetricsStore(tmp());
  const model = buildDemandModel({
    store: s, nowMs: MON, weeklyBySlot: () => 1, referenceSlots: ['1'],
    overrides: [
      { from: '2026-09-01', to: '2026-09-13', multiplier: 0.5 },
      { from: '2026-09-14', to: '2026-09-20', multiplier: 2 },
    ],
  });
  assert.equal(model.hourly, undefined);
  assert.equal(model.k, DEFAULT_K);
  assert.deepEqual(model.w20PerUsd, { general: DEFAULT_W20_PER_USD, fable: DEFAULT_W20_PER_USD });
  assert.deepEqual(model.overrides.map(o => o.multiplier), [2]);
  s.close();
});

test('the model built at a moment ignores everything recorded after it', () => {
  const trace = (s: MetricsStore, until: number) => {
    let u7 = 0.05;
    let u5 = 0;
    for (let t = MON; t < until; t += 20 * 60_000) {
      u7 += 0.002;
      u5 = (u5 + 0.01) % 1;
      record(s, { ts: t, session: `s${Math.floor(t / (3 * HOUR_MS))}`, u5, u7: Math.round(u7 * 100) / 100, out: 20_000 });
    }
    s.rollupHours(until);
  };
  const at = MON + 9 * 24 * HOUR_MS;
  const past = new MetricsStore(tmp());
  trace(past, at);
  const full = new MetricsStore(tmp());
  trace(full, at + 3 * 24 * HOUR_MS);
  const build = (s: MetricsStore) => buildDemandModel({ store: s, nowMs: at, weeklyBySlot: () => 1, referenceSlots: ['1'] });
  const a = build(past);
  assert.ok(a.hourly, 'nine days is enough for a profile');
  assert.deepEqual(build(full), a);
  const d = flat(0.05);
  assert.equal(sessionRate(full, `s${Math.floor(at / (3 * HOUR_MS))}`, at, d), sessionRate(past, `s${Math.floor(at / (3 * HOUR_MS))}`, at, d));
  past.close();
  full.close();
});

test('the persisted model is dropped once stale or unreadable', () => {
  const root = tmp();
  writeDemandModel(root, flat(0.05));
  assert.ok(readDemandModel(root, MON + DEMAND_STALE_MS));
  assert.equal(readDemandModel(root, MON + DEMAND_STALE_MS + 1), undefined);
  writeFileSync(path.join(root, 'state', 'demand.json'), '{not json');
  assert.equal(readDemandModel(root, MON), undefined);
});

test('the override file keeps only well-formed entries', () => {
  const root = tmp();
  mkdirSync(root, { recursive: true });
  assert.deepEqual(readDemandOverrides(root), [], 'no file');
  writeFileSync(path.join(root, 'demand-profile.json'), JSON.stringify({
    overrides: [
      { from: '2026-10-10', to: '2026-10-12', multiplier: 0.1 },
      { from: 'Oct 10', to: '2026-10-12', multiplier: 0.1 },
      { from: '2026-10-10', to: '2026-10-12', multiplier: -1 },
      null,
    ],
  }));
  assert.deepEqual(readDemandOverrides(root), [{ from: '2026-10-10', to: '2026-10-12', multiplier: 0.1 }]);
  writeFileSync(path.join(root, 'demand-profile.json'), '{"overrides": "all of them"}');
  assert.deepEqual(readDemandOverrides(root), []);
});

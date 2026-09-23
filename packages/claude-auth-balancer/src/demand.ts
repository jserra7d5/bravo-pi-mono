// Demand model: what the fleet is expected to spend, and when.
//
// Everything is in W20 — one Max 20x weekly budget. Three measured inputs,
// rebuilt on each usage sweep from the metrics store and persisted to
// `state/demand.json` so the statusline (a different process) reads the same
// numbers the router does:
//
//   * w20PerUsd — quota burned per dollar of list-price cost, fitted per model
//     class from weekly-meter movement against cost (cost is continuous and
//     complete; the meter moves in 1-point steps).
//   * k — a 20x's 5h window as a fraction of its weekly (ΣΔ7d / ΣΔ5h). It
//     drifts week to week, so it is always measured, never fixed.
//   * hourly — expected fleet demand for each local (weekday, hour), learned
//     from the operator's own history and scaled to the most recent week.
//
// Nothing about any particular day is hard-coded; the only operator input is
// an optional file of date-bounded multipliers for known one-offs.

import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { MetricsStore, ModelClass } from './metrics.js';
import { HOUR_MS } from './metrics.js';

export const WEEK_HOURS = 168;

/** Used only until the store holds enough history to measure. */
export const DEFAULT_K = 0.19;
/** ~$3.5–4.2k of list-price cost per W20, observed 2026-09. */
export const DEFAULT_W20_PER_USD = 1 / 3800;

/** Cost per fitted sample; ~5 meter points at the default rate, so quantization stays small. */
const SAMPLE_MIN_USD = 200;
const PROFILE_LOOKBACK_HOURS = 28 * 24;
const MIN_PROFILE_HOURS = 7 * 24;

export type DemandOverride = { from: string; to: string; multiplier: number };

export type DemandModel = {
  computedAt: number;
  w20PerUsd: Record<ModelClass, number>;
  k: number;
  /** Median first-hour burn of a fresh session, W20. */
  freshBurn: number;
  /**
   * Expected fleet demand in W20/hour, indexed by `weekHour(ts)`. Absent when
   * the store holds less than a week of history: the router then has no
   * demand terms rather than invented ones.
   */
  hourly?: number[];
  overrides: DemandOverride[];
};

/** Local weekday × 24 + local hour, 0..167. */
export function weekHour(ts: number): number {
  const d = new Date(ts);
  return d.getDay() * 24 + d.getHours();
}

function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function multiplierAt(model: DemandModel, ts: number): number {
  const day = localDate(ts);
  let m = 1;
  for (const o of model.overrides) if (day >= o.from && day <= o.to) m *= o.multiplier;
  return m;
}

/**
 * Integrate demand over [from, to), hour by hour, applying `perHour` to each
 * hour's expected demand (for a rate cap). Partial hours count pro rata.
 */
function integrate(model: DemandModel, from: number, to: number, perHour: (d: number) => number): number {
  if (!model.hourly || to <= from) return 0;
  let total = 0;
  for (let t = from; t < to; ) {
    const hourEnd = Math.min(to, Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS);
    const d = model.hourly[weekHour(t)]! * multiplierAt(model, t);
    total += perHour(d) * ((hourEnd - t) / HOUR_MS);
    t = hourEnd;
  }
  return total;
}

/** Expected fleet demand in [from, to), W20. */
export function expectedDemand(model: DemandModel, from: number, to: number): number {
  return integrate(model, from, to, d => d);
}

/** Demand one account could serve in [from, to) when it burns at most `ratePerHour` W20/h. */
export function rateLimitedDemand(model: DemandModel, from: number, to: number, ratePerHour: number): number {
  return integrate(model, from, to, d => Math.min(d, ratePerHour));
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

type HourRow = {
  hour: number;
  slot: string;
  model_class: ModelClass;
  cost_usd: number;
  util_7d_last: number | null;
  reset_7d: number;
};

/**
 * Weekly quota per dollar, per model class, by least squares over samples of
 * (Δ7d × weekly capacity) against (general $, Fable $). A sample closes once
 * it holds SAMPLE_MIN_USD of cost; a weekly reset or any fall in the reading
 * discards the open sample and re-anchors, which also drops anomalous
 * server-side resets without naming them.
 */
export function fitW20PerUsd(
  rows: HourRow[],
  weeklyBySlot: (slot: string) => number,
): Record<ModelClass, number> | undefined {
  const bySlot = new Map<string, HourRow[]>();
  for (const r of rows) (bySlot.get(r.slot) ?? bySlot.set(r.slot, []).get(r.slot)!).push(r);

  const samples: { y: number; g: number; f: number }[] = [];
  for (const [slot, list] of bySlot) {
    list.sort((a, b) => a.hour - b.hour);
    const weekly = weeklyBySlot(slot);
    let anchor: number | undefined;
    let g = 0;
    let f = 0;
    let hour = Number.NEGATIVE_INFINITY;
    // Rows for one hour arrive as up to two model classes; fold them first.
    for (let i = 0; i < list.length; ) {
      hour = list[i]!.hour;
      let cost = { general: 0, fable: 0 };
      let reading: number | null = null;
      let reset = false;
      for (; i < list.length && list[i]!.hour === hour; i += 1) {
        const r = list[i]!;
        cost[r.model_class] += r.cost_usd;
        if (r.util_7d_last !== null) reading = Math.max(reading ?? 0, r.util_7d_last);
        if (r.reset_7d) reset = true;
      }
      if (anchor === undefined || reset || (reading !== null && reading < anchor)) {
        if (reading !== null) anchor = reading;
        g = 0;
        f = 0;
        continue;
      }
      g += cost.general;
      f += cost.fable;
      if (reading !== null && g + f >= SAMPLE_MIN_USD) {
        samples.push({ y: (reading - anchor) * weekly, g, f });
        anchor = reading;
        g = 0;
        f = 0;
      }
    }
  }
  if (samples.length < 5) return undefined;

  let gg = 0, ff = 0, gf = 0, gy = 0, fy = 0, y = 0, x = 0;
  for (const s of samples) {
    gg += s.g * s.g; ff += s.f * s.f; gf += s.g * s.f; gy += s.g * s.y; fy += s.f * s.y;
    y += s.y; x += s.g + s.f;
  }
  const det = gg * ff - gf * gf;
  const pooled = x > 0 ? y / x : undefined;
  if (pooled === undefined || pooled <= 0) return undefined;
  if (det <= 1e-9 * gg * ff) return { general: pooled, fable: pooled };
  const a = (gy * ff - fy * gf) / det;
  const b = (fy * gg - gy * gf) / det;
  // Too little of one class to separate them: one pooled rate beats a wild fit.
  if (!(a > 0) || !(b > 0)) return { general: pooled, fable: pooled };
  return { general: a, fable: b };
}

/**
 * Expected W20/hour per local (weekday, hour) from hourly fleet cost.
 *
 * Each bucket's mean divides by how many times that hour occurred in the
 * lookback, traffic or not, so a quiet Saturday counts as quiet rather than
 * missing. Censored hours (the fleet was near-empty) are skipped: their low
 * spend may be missing quota, not missing work. A circular 3-hour average
 * smooths four-sample buckets. The shape is scaled to the most recent week's
 * spend, because demand trends and a flat mean lags it.
 */
export function buildHourlyProfile(
  hours: { hour: number; cost: number; censored: boolean }[],
  w20PerUsd: number,
  nowMs: number,
): number[] | undefined {
  if (hours.length < MIN_PROFILE_HOURS) return undefined;
  const sum = new Array<number>(WEEK_HOURS).fill(0);
  const count = new Array<number>(WEEK_HOURS).fill(0);
  for (const h of hours) {
    if (h.censored) continue;
    const b = weekHour(h.hour);
    sum[b] += h.cost;
    count[b] += 1;
  }
  const mean = sum.map((s, b) => (count[b]! > 0 ? s / count[b]! : 0));
  const smooth = mean.map((_, b) =>
    (mean[(b + WEEK_HOURS - 1) % WEEK_HOURS]! + mean[b]! + mean[(b + 1) % WEEK_HOURS]!) / 3,
  );
  const shapeTotal = smooth.reduce((a, v) => a + v, 0);
  if (shapeTotal <= 0) return undefined;

  // Scale: last 168 closed hours, corrected for any censored hours in it.
  const weekStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS - WEEK_HOURS * HOUR_MS;
  let recent = 0;
  let recentShare = 0;
  for (const h of hours) {
    if (h.hour < weekStart || h.censored) continue;
    recent += h.cost;
    recentShare += smooth[weekHour(h.hour)]! / shapeTotal;
  }
  const weeklyUsd = recentShare > 0.25 ? recent / recentShare : shapeTotal;
  return smooth.map(v => (v / shapeTotal) * weeklyUsd * w20PerUsd);
}

/** k = ΣΔ7d / ΣΔ5h over consecutive same-slot responses under 5 minutes apart. */
export function measureK(store: MetricsStore, sinceMs: number, untilMs: number, referenceSlots: string[]): number | undefined {
  if (referenceSlots.length === 0) return undefined;
  const marks = referenceSlots.map(() => '?').join(',');
  const row = store.query(
    `WITH r AS (
       SELECT util_5h u5, util_7d u7, ts,
              LAG(util_5h) OVER w p5, LAG(util_7d) OVER w p7, LAG(ts) OVER w pts
         FROM requests
        WHERE ts >= ? AND ts < ? AND slot IN (${marks}) AND util_5h IS NOT NULL AND util_7d IS NOT NULL
       WINDOW w AS (PARTITION BY slot ORDER BY ts))
     SELECT SUM(u7 - p7) d7, SUM(u5 - p5) d5 FROM r
      WHERE p5 IS NOT NULL AND ts - pts < 300000
        AND u5 >= p5 AND u7 >= p7 AND u7 - p7 <= 0.02`,
    [sinceMs, untilMs, ...referenceSlots],
  )[0] as { d7: number | null; d5: number | null } | undefined;
  if (!row?.d7 || !row.d5 || row.d5 < 1) return undefined;
  return row.d7 / row.d5;
}

/** Median first-hour cost of sessions whose first request was a fresh pick, times W20/$. */
function measureFreshBurn(store: MetricsStore, sinceMs: number, untilMs: number, w20PerUsd: Record<ModelClass, number>): number | undefined {
  const rows = store.query(
    `WITH first AS (
       SELECT session_hash, MIN(ts) t0 FROM requests
        WHERE ts >= ? AND ts < ? AND session_hash IS NOT NULL GROUP BY session_hash)
     SELECT SUM(CASE WHEN lower(r.model) LIKE '%fable%' THEN r.cost_usd ELSE 0 END) fable,
            SUM(CASE WHEN lower(r.model) LIKE '%fable%' THEN 0 ELSE r.cost_usd END) general
       FROM first JOIN requests r ON r.session_hash = first.session_hash
      WHERE r.ts < first.t0 + 3600000 AND r.ts < ?
        AND (SELECT decision FROM requests x WHERE x.session_hash = first.session_hash ORDER BY ts LIMIT 1) = 'fresh'
      GROUP BY first.session_hash`,
    [sinceMs, untilMs, untilMs],
  ) as { fable: number; general: number }[];
  if (rows.length < 5) return undefined;
  const burns = rows.map(r => r.general * w20PerUsd.general + r.fable * w20PerUsd.fable).sort((a, b) => a - b);
  return burns[Math.floor(burns.length / 2)];
}

/** Measured burn of one live session over the last hour, W20/hour. */
export function sessionRate(store: MetricsStore, sessionHash: string, nowMs: number, model: DemandModel): number | undefined {
  const row = store.query(
    `SELECT SUM(CASE WHEN lower(model) LIKE '%fable%' THEN cost_usd ELSE 0 END) fable,
            SUM(CASE WHEN lower(model) LIKE '%fable%' THEN 0 ELSE cost_usd END) general,
            COUNT(*) n
       FROM requests WHERE session_hash = ? AND ts >= ? AND ts < ?`,
    [sessionHash, nowMs - HOUR_MS, nowMs],
  )[0] as { fable: number | null; general: number | null; n: number } | undefined;
  if (!row || row.n === 0) return undefined;
  return (row.general ?? 0) * model.w20PerUsd.general + (row.fable ?? 0) * model.w20PerUsd.fable;
}

/** Reads only rows before `nowMs`, so a replay can build it at any simulated time. */
export function buildDemandModel(options: {
  store: MetricsStore;
  nowMs: number;
  /** Weekly capacity (W20) per slot, from its plan tier. */
  weeklyBySlot: (slot: string) => number;
  /** Slots on the reference (20x) plan, for measuring k. */
  referenceSlots: string[];
  overrides?: DemandOverride[];
}): DemandModel {
  const { store, nowMs } = options;
  const lookback = nowMs - PROFILE_LOOKBACK_HOURS * HOUR_MS;
  const hourRows = store.query(
    `SELECT hour, slot, model_class, cost_usd, util_7d_last, reset_7d FROM usage_hourly WHERE hour >= ? AND hour < ?`,
    [lookback, nowMs],
  ) as HourRow[];
  const recent = hourRows.filter(r => r.hour >= nowMs - 7 * 24 * HOUR_MS);
  const w20PerUsd = fitW20PerUsd(recent, options.weeklyBySlot)
    ?? fitW20PerUsd(hourRows, options.weeklyBySlot)
    ?? { general: DEFAULT_W20_PER_USD, fable: DEFAULT_W20_PER_USD };
  const k = measureK(store, nowMs - 7 * 24 * HOUR_MS, nowMs, options.referenceSlots)
    ?? measureK(store, lookback, nowMs, options.referenceSlots)
    ?? DEFAULT_K;

  const fleet = store.query(
    `SELECT f.hour, f.censored, COALESCE(SUM(u.cost_usd), 0) cost,
            COALESCE(SUM(CASE WHEN u.model_class = 'fable' THEN u.cost_usd ELSE 0 END), 0) fable_cost
       FROM fleet_hourly f LEFT JOIN usage_hourly u ON u.hour = f.hour
      WHERE f.hour >= ? AND f.hour < ? GROUP BY f.hour ORDER BY f.hour`,
    [lookback, nowMs],
  ) as { hour: number; censored: number; cost: number; fable_cost: number }[];
  // Blend the two classes' rates by their share of spend, so the profile is in W20.
  const totalCost = fleet.reduce((a, h) => a + h.cost, 0);
  const fableCost = fleet.reduce((a, h) => a + h.fable_cost, 0);
  const blended = totalCost > 0
    ? (w20PerUsd.general * (totalCost - fableCost) + w20PerUsd.fable * fableCost) / totalCost
    : w20PerUsd.general;
  const hourly = buildHourlyProfile(
    fleet.map(h => ({ hour: h.hour, cost: h.cost, censored: h.censored === 1 })),
    blended,
    nowMs,
  );

  const today = localDate(nowMs);
  return {
    computedAt: nowMs,
    w20PerUsd,
    k,
    freshBurn: measureFreshBurn(store, lookback, nowMs, w20PerUsd) ?? 0,
    hourly,
    overrides: (options.overrides ?? []).filter(o => o.to >= today),
  };
}

// ---------------------------------------------------------------------------
// Persistence and operator overrides
// ---------------------------------------------------------------------------

/** Demand older than this is not used: the sweep refreshes it every 15 minutes. */
export const DEMAND_STALE_MS = 2 * HOUR_MS;

function demandPath(stateRoot: string): string {
  return path.join(stateRoot, 'state', 'demand.json');
}

export function writeDemandModel(stateRoot: string, model: DemandModel): void {
  const target = demandPath(stateRoot);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(model), { mode: 0o600 });
  renameSync(tmp, target);
}

export function readDemandModel(stateRoot: string, nowMs: number): DemandModel | undefined {
  try {
    const parsed = JSON.parse(readFileSync(demandPath(stateRoot), 'utf8')) as DemandModel;
    if (typeof parsed.computedAt !== 'number' || nowMs - parsed.computedAt > DEMAND_STALE_MS) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * `~/.bravo/claude-auth-balancer/demand-profile.json`:
 *   { "overrides": [{ "from": "2026-10-10", "to": "2026-10-12", "multiplier": 0.1 }] }
 * Dates are local and inclusive. An entry past its `to` date is ignored.
 */
export function readDemandOverrides(stateRoot: string): DemandOverride[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateRoot, 'demand-profile.json'), 'utf8')) as {
      overrides?: unknown;
    };
    if (!Array.isArray(parsed.overrides)) return [];
    return parsed.overrides.filter(
      (o): o is DemandOverride =>
        !!o && typeof o === 'object' &&
        /^\d{4}-\d{2}-\d{2}$/.test(String((o as DemandOverride).from)) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String((o as DemandOverride).to)) &&
        typeof (o as DemandOverride).multiplier === 'number' && (o as DemandOverride).multiplier >= 0,
    );
  } catch {
    return [];
  }
}

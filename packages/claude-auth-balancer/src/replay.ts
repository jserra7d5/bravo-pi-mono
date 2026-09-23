// Offline, read-only trace replay. A failed meter gate invalidates policy conclusions.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSlotObservation, resolveWeeklyReserves } from './accounts.js';
import { parseClaims } from './claims.js';
import { buildDemandModel } from './demand.js';
import type { DemandModel } from './demand.js';
import { HOUR_MS, MetricsStore, modelClass, RESET_DROP } from './metrics.js';
import type { ModelClass } from './metrics.js';
import { applyWeeklyReserve, capacityForTier, computeHeadroom, selectAccount } from './policy.js';
import type { AccountState, SelectInput, Selection } from './policy.js';

const DAY = 24 * HOUR_MS;
const WEEK = 7 * DAY;
const FIT_END = new Date('2026-09-14T00:00:00').getTime();
const ANOMALY_FROM = new Date('2026-09-01T00:00:00').getTime();
const ANOMALY_TO = new Date('2026-09-08T00:00:00').getTime();
type ClaimKey = '5h' | '7d' | '7d_oi';
const CLAIMS: ClaimKey[] = ['5h', '7d', '7d_oi'];
export type TraceRow = { id: number; ts: number; slot: string; session_hash: string | null; model: string | null; status: number; cost_usd: number; uncached_usd: number; util_5h: number | null; util_7d: number | null; util_7d_oi: number | null };
const observed = (r: TraceRow, c: ClaimKey): number | null => c === '5h' ? r.util_5h : c === '7d' ? r.util_7d : r.util_7d_oi;
const valid = (ts: number) => ts < ANOMALY_FROM || ts >= ANOMALY_TO;
const roundHalfHour = (ts: number) => Math.ceil(ts / (HOUR_MS / 2)) * (HOUR_MS / 2);
const percentile = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]! : NaN;

type MeterSlot = { util: Record<ClaimKey, number>; reset: Record<ClaimKey, number>; opened5?: boolean };
export type Rates = Record<string, Record<ClaimKey, Record<ModelClass, number>>>;
export type Cadences = Record<string, number>;

/**
 * Util per dollar, per slot, claim and model class. Pairs of adjacent
 * responses under-read it by about half (a response's reading lags requests
 * still in flight on the slot), so it is fitted cumulatively instead: from an
 * anchor reading, cost accumulates until it is large against one quantization
 * step, then (Δreading, general $, Fable $) is one sample. A fall in the
 * reading (a reset, or an anomaly) discards the open sample and re-anchors.
 */
const SAMPLE_USD: Record<ClaimKey, number> = { '5h': 60, '7d': 200, '7d_oi': 200 };
export function fitMeter(rows: TraceRow[]): { rates: Rates; cadences: Cadences; drops: Record<string, Record<ClaimKey, number[]>>; weeklyResets: Record<string, number[]> } {
  const rates: Rates = {}, cadences: Cadences = {}, drops: Record<string, Record<ClaimKey, number[]>> = {};
  type Open = { anchor: number; g: number; f: number };
  const open = new Map<string, Open>();
  const samples = new Map<string, { y: number; g: number; f: number }[]>();
  const last = new Map<string, TraceRow>();
  for (const r of rows) {
    if (!valid(r.ts)) { last.delete(r.slot); for (const c of CLAIMS) open.delete(`${r.slot}/${c}`); continue; }
    const prev = last.get(r.slot);
    for (const c of CLAIMS) {
      const a = prev ? observed(prev, c) : null, b = observed(r, c);
      if (a !== null && b !== null && a - b > RESET_DROP) ((drops[r.slot] ??= { '5h': [], '7d': [], '7d_oi': [] })[c]).push(r.ts);
      if (r.ts >= FIT_END) continue;
      const key = `${r.slot}/${c}`;
      const o = open.get(key);
      if (c !== '7d_oi' || modelClass(r.model) === 'fable') {
        if (o) { if (modelClass(r.model) === 'fable') o.f += r.cost_usd; else o.g += r.cost_usd; }
      }
      if (b === null) continue;
      if (!o || b < o.anchor) { open.set(key, { anchor: b, g: 0, f: 0 }); continue; }
      if (o.g + o.f >= SAMPLE_USD[c]) {
        (samples.get(key) ?? (samples.set(key, []), samples.get(key)!)).push({ y: b - o.anchor, g: o.g, f: o.f });
        open.set(key, { anchor: b, g: 0, f: 0 });
      }
    }
    last.set(r.slot, r);
  }
  for (const [key, xs] of samples) {
    const [slot, claim] = key.split('/') as [string, ClaimKey];
    let gg = 0, ff = 0, gf = 0, gy = 0, fy = 0, y = 0, x = 0;
    for (const s of xs) { gg += s.g * s.g; ff += s.f * s.f; gf += s.g * s.f; gy += s.g * s.y; fy += s.f * s.y; y += s.y; x += s.g + s.f; }
    const pooled = x > 0 ? y / x : 0;
    const det = gg * ff - gf * gf;
    let general = pooled, fable = pooled;
    if (det > 1e-9 * gg * ff) {
      const a = (gy * ff - fy * gf) / det, b = (fy * gg - gy * gf) / det;
      if (a > 0 && b > 0) { general = a; fable = b; }
    }
    ((rates[slot] ??= { '5h': { general: 0, fable: 0 }, '7d': { general: 0, fable: 0 }, '7d_oi': { general: 0, fable: 0 } })[claim]) = { general, fable };
  }
  for (const [slot, d] of Object.entries(drops)) {
    // Anchor to the first post-anomaly observed weekly drop, rounded down to its hour.
    const first = d['7d'].find(t => t >= ANOMALY_TO);
    if (first !== undefined) cadences[slot] = Math.floor(first / HOUR_MS) * HOUR_MS;
  }
  // Weekly resets land on the hour; the first response after one shows the drop.
  const weeklyResets: Record<string, number[]> = {};
  for (const [slot, d] of Object.entries(drops)) {
    weeklyResets[slot] = [...new Set(d['7d'].filter(t => t >= ANOMALY_TO).map(t => Math.floor(t / HOUR_MS) * HOUR_MS))];
  }
  return { rates, cadences, drops, weeklyResets };
}

export class Meter {
  readonly slots = new Map<string, MeterSlot>();
  readonly resetEvents: Record<string, Record<ClaimKey, number[]>> = {};
  stranded = 0;
  /**
   * `weeklyResets`: observed weekly reset times per slot. A weekly reset is a
   * server event no routing decision moves, so the recorded ones are used as
   * they happened (including off-cadence ones); the cadence only projects
   * past the end of the trace.
   */
  constructor(
    readonly rates: Rates,
    readonly cadences: Cadences,
    readonly weekly: Record<string, number> = {},
    readonly weeklyResets: Record<string, number[]> = {},
  ) {}
  private nextWeekly(slot: string, now: number): number {
    const observedNext = this.weeklyResets[slot]?.find(t => t > now);
    if (observedNext !== undefined) return observedNext;
    const cadence = this.cadences[slot];
    return cadence === undefined ? now + WEEK : cadence + (Math.floor((now - cadence) / WEEK) + 1) * WEEK;
  }
  /** Set the meter to a recorded response's readings: the server's own state at that moment. */
  anchor(r: TraceRow, next5h?: number): void {
    const s = this.state(r.slot, r.ts);
    for (const c of CLAIMS) {
      const obs = observed(r, c);
      if (obs !== null) s.util[c] = Math.min(1, obs);
    }
    if (r.util_5h !== null && r.util_5h > 0 && !s.opened5) {
      s.opened5 = true;
      s.reset['5h'] = next5h ?? roundHalfHour(r.ts + 5 * HOUR_MS);
    }
  }
  state(slot: string, now: number): MeterSlot {
    let s = this.slots.get(slot);
    if (!s) {
      const next = this.nextWeekly(slot, now);
      s = { util: { '5h': 0, '7d': 0, '7d_oi': 0 }, reset: { '5h': 0, '7d': next, '7d_oi': next } };
      this.slots.set(slot, s);
    }
    for (const c of CLAIMS) if (s.reset[c] && now >= s.reset[c]) {
      if (c === '7d') this.stranded += (1 - s.util[c]) * (this.weekly[slot] ?? 1);
      if (c === '5h') {
        s.reset[c] = 0;
        s.opened5 = false;
      } else {
        s.reset[c] = this.nextWeekly(slot, now);
      }
      s.util[c] = 0;
      ((this.resetEvents[slot] ??= { '5h': [], '7d': [], '7d_oi': [] })[c]).push(now);
    }
    return s;
  }
  burn(r: TraceRow, slot = r.slot, cost = r.cost_usd): void {
    const s = this.state(slot, r.ts);
    if (!s.opened5) { s.reset['5h'] = roundHalfHour(r.ts + 5 * HOUR_MS); s.opened5 = true; }
    const cls = modelClass(r.model);
    for (const c of CLAIMS) if (c !== '7d_oi' || cls === 'fable') {
      s.util[c] = Math.min(1, s.util[c] + cost * (this.rates[slot]?.[c][cls] ?? 0));
    }
  }
}

/**
 * The open 5h window's reset, from the next observed 5h drop: resets land on
 * :30, and the first response after one shows it. Without this a meter
 * anchored mid-window guesses the phase, and back-to-back windows keep the
 * wrong phase for the rest of the trace.
 */
function next5hReset(drops: Record<string, Record<ClaimKey, number[]>>, r: TraceRow): number | undefined {
  const t = drops[r.slot]?.['5h'].find(d => d > r.ts && d - r.ts <= 5 * HOUR_MS);
  return t === undefined ? undefined : Math.floor(t / (HOUR_MS / 2)) * (HOUR_MS / 2);
}

export type Fidelity = { slot: string; claim: ClaimKey; n: number; max: number; p95: number; resets: number; reproduced: number; exhaustions: number; reproducedExhaustions: number };
export function fidelity(rows: TraceRow[], meter: Meter, drops: ReturnType<typeof fitMeter>['drops']): { details: Fidelity[]; pass: boolean } {
  const errors = new Map<string, number[]>();
  const exhaust = new Map<string, [number, number]>();
  const anchored = new Set<string>();
  for (const r of rows) {
    if (!valid(r.ts) || r.ts < FIT_END) continue;
    // Start each slot from its recorded state when validation begins, so the
    // error measured is the meter's drift over the held-out span, not the
    // accumulated drift of every week before it.
    if (!anchored.has(r.slot)) { meter.anchor(r, next5hReset(drops, r)); anchored.add(r.slot); continue; }
    const s = meter.state(r.slot, r.ts);
    meter.burn(r);
    for (const c of CLAIMS) {
      const obs = observed(r, c);
      if (obs === null) continue;
      const key = `${r.slot}/${c}`;
      (errors.get(key) ?? (errors.set(key, []), errors.get(key)!)).push(Math.abs(s.util[c] - obs) * 100);
      const e = exhaust.get(key) ?? [0, 0];
      if (obs >= 0.99) { e[0]++; if (s.util[c] >= 0.99) e[1]++; }
      exhaust.set(key, e);
    }
  }
  const details: Fidelity[] = [];
  for (const [key, xs] of errors) {
    const [slot, claim] = key.split('/') as [string, ClaimKey];
    const actual = (drops[slot]?.[claim] ?? []).filter(t => t >= FIT_END);
    const sim = meter.resetEvents[slot]?.[claim] ?? [];
    const reproduced = actual.filter(t => sim.some(u => Math.abs(u - t) <= (claim === '5h' ? HOUR_MS / 2 : HOUR_MS))).length;
    const e = exhaust.get(key) ?? [0, 0];
    details.push({ slot, claim, n: xs.length, max: Math.max(...xs), p95: percentile(xs, .95), resets: actual.length, reproduced, exhaustions: e[0], reproducedExhaustions: e[1] });
  }
  const pass = details.length > 0 && details.every(d => d.max <= (d.claim === '5h' ? 5 : 2) && d.reproduced === d.resets) && details.filter(d => d.claim === '5h').reduce((n, d) => n + d.reproducedExhaustions, 0) >= 3;
  return { details, pass };
}

export type Score = { served: number; unserved: number; unservedUsd: number; unservedWeekly: number; exhaustions5h: number; recreates: number; recreateUsd: number; pulls: number; stranded: number; slots: Record<string, number> };
export type Router = (input: SelectInput) => Selection;
export type SimulateOptions = {
  /** Replay with the demand profile shifted by three days (Saturday sees Tuesday). */
  fault?: boolean;
  /** The policy routes from here; before it the recorded routing is followed. */
  startAt?: number;
  drops?: ReturnType<typeof fitMeter>['drops'];
  /** The operator's weekly reserves, as the deployed router applies them. */
  reserves?: Map<string, number>;
};
export function simulate(rows: TraceRow[], meter: Meter, policy: Router, demandAt: (now: number) => DemandModel | undefined, capacity: Record<string, ReturnType<typeof capacityForTier>>, options: SimulateOptions = {}): Score {
  const { fault = false, startAt = FIT_END, drops = {}, reserves = new Map<string, number>() } = options;
  const score: Score = { served: 0, unserved: 0, unservedUsd: 0, unservedWeekly: 0, exhaustions5h: 0, recreates: 0, recreateUsd: 0, pulls: 0, stranded: 0, slots: {} };
  const leases = new Map<string, { slot: string; since: number; seen: number }>();
  const history = new Map<string, { ts: number; cost: number; cls: ModelClass }[]>();
  let scoring = false;
  for (const r of rows) {
    if (!valid(r.ts)) continue;
    // Before the policy takes over, the meter follows the recorded readings
    // and sessions keep the leases the recorded routing gave them, so the
    // policy inherits warm sessions rather than a cold fleet.
    if (r.ts < startAt) {
      meter.anchor(r, next5hReset(drops, r));
      if (r.session_hash) {
        const key = `${r.session_hash}\0${r.model ?? ''}`;
        const prior = leases.get(key);
        leases.set(key, { slot: r.slot, since: prior && prior.slot === r.slot ? prior.since : r.ts, seen: r.ts });
      }
      continue;
    }
    if (!scoring) { meter.stranded = 0; scoring = true; }
    const states: AccountState[] = Object.keys(capacity).map(slot => {
      const s = meter.state(slot, r.ts);
      const h: Record<string, string> = {};
      for (const c of CLAIMS) {
        h[`anthropic-ratelimit-unified-${c}-utilization`] = String(s.util[c]);
        if (s.reset[c]) h[`anthropic-ratelimit-unified-${c}-reset`] = String(s.reset[c] / 1000);
      }
      return { slot, health: 'ok', claims: parseClaims(h), capacity: capacity[slot], weeklyReserve: reserves.get(slot) };
    });
    const key = `${r.session_hash ?? `anonymous:${r.id}`}\0${r.model ?? ''}`;
    const lease = leases.get(key);
    const active = lease && r.ts - lease.seen < HOUR_MS ? lease : undefined;
    const demand = demandAt(r.ts);
    const hist = (history.get(key) ?? []).filter(h => h.ts >= r.ts - HOUR_MS);
    const sessionRate = hist.length && demand ? hist.reduce((v, h) => v + h.cost * demand.w20PerUsd[h.cls], 0) : undefined;
    const profile = fault && demand?.hourly ? { ...demand, hourly: demand.hourly.map((_, i) => demand.hourly![(i + 3 * 24) % 168]!) } : demand;
    const chosen = policy({ accounts: states, model: r.model ?? undefined, nowMs: r.ts, affinitySlot: active?.slot, affinitySince: active?.since, demand: profile, sessionRate });
    const slot = chosen.slot;
    // Served only if the server itself would serve it: raw claims, no reserve.
    const served = slot ? { ...states.find(s => s.slot === slot)!, weeklyReserve: undefined } : undefined;
    const headroom = served ? computeHeadroom(served, r.model ?? undefined, r.ts).headroom : 0;
    if (!slot || headroom <= 0) {
      score.unserved++;
      score.unservedUsd += r.cost_usd;
      // Weekly-bound: no account had weekly quota left for this model. The
      // rest ran out of 5h windows with weekly quota still standing.
      if (states.every(a => ['7d', ...(modelClass(r.model) === 'fable' ? ['7d_oi'] : [])].some(c => (meter.state(a.slot, r.ts).util[c as ClaimKey]) >= 1))) score.unservedWeekly++;
      continue;
    }
    const moved = Boolean(active && active.slot !== slot);
    const cost = moved ? r.uncached_usd : r.cost_usd;
    if (moved) { score.recreates++; score.recreateUsd += cost - r.cost_usd; if (chosen.reason.includes('weekly quota')) score.pulls++; }
    const state = meter.state(slot, r.ts);
    if (state.util['5h'] + cost * (meter.rates[slot]?.['5h'][modelClass(r.model)] ?? 0) >= 1 && state.util['5h'] < 1) score.exhaustions5h++;
    meter.burn(r, slot, cost);
    leases.set(key, { slot, since: moved || !active ? r.ts : active.since, seen: r.ts });
    history.set(key, [...hist, { ts: r.ts, cost, cls: modelClass(r.model) }]);
    score.served++;
    score.slots[slot] = (score.slots[slot] ?? 0) + 1;
  }
  score.stranded = meter.stranded;
  return score;
}

export async function runReplay(dbFile: string, stateRoot: string, oldPolicyPath?: string): Promise<{ report: string; pass: boolean }> {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const scratch = path.join(path.dirname(dbFile), `.replay-${process.pid}.sqlite3`);
  let rolled: MetricsStore | undefined;
  try {
    const rows = db.prepare('SELECT id,ts,slot,session_hash,model,status,cost_usd,uncached_usd,util_5h,util_7d,util_7d_oi FROM requests ORDER BY ts,id').all() as TraceRow[];
    if (!rows.length) throw new Error('empty requests trace');
    const fit = fitMeter(rows);
    const reserves = resolveWeeklyReserves();
    const check = fidelity(rows, new Meter(fit.rates, fit.cadences, {}, fit.weeklyResets), fit.drops);
    const capacity: Record<string, ReturnType<typeof capacityForTier>> = {};
    for (const slot of ['1', '2', '3', '4', '5', '6']) {
      const tier = JSON.parse(readFileSync(path.join(stateRoot, 'state', 'plans', `${slot}.json`), 'utf8')) as { tier: string };
      capacity[slot] = capacityForTier(tier.tier);
      // No observed meter on 5x: scale reference fits by the plan's relative capacity.
      if (!fit.rates[slot]) {
        fit.rates[slot] = { '5h': { ...fit.rates['1']!['5h'] }, '7d': { ...fit.rates['1']!['7d'] }, '7d_oi': { ...fit.rates['1']!['7d_oi'] } };
        for (const c of CLAIMS) for (const cls of ['general', 'fable'] as const) fit.rates[slot]![c][cls] /= c === '5h' ? capacity[slot]!.fiveHour : capacity[slot]!.weekly;
        // Its weekly cadence is known from the live observation, not from history.
        const reset = readSlotObservation(stateRoot, slot)?.claims?.byId['7d']?.reset;
        fit.cadences[slot] = reset !== undefined ? reset * 1000 : fit.cadences['1']!;
      }
    }
    // Roll up on a throwaway copy: never modify the input snapshot (or the live DB).
    copyFileSync(dbFile, scratch);
    rolled = new MetricsStore(path.dirname(scratch), path.basename(scratch));
    rolled.rollupHours(rows[rows.length - 1]!.ts + HOUR_MS);
    // buildDemandModel's queries are bounded by nowMs; all hourly rows are closed hours.
    const store = rolled;
    const cache = new Map<number, DemandModel>();
    const demandAt = (ts: number) => {
      const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
      let model = cache.get(hour);
      if (!model) {
        model = buildDemandModel({ store, nowMs: hour, weeklyBySlot: s => capacity[s]?.weekly ?? 1, referenceSlots: ['1', '2', '3', '4'] });
        cache.set(hour, model);
      }
      return model;
    };
    const imported: Router = oldPolicyPath ? (await import(pathToFileURL(path.resolve(oldPolicyPath)).href) as { selectAccount: Router }).selectAccount : selectAccount;
    // HEAD predates weekly reserves; hand it the reserve-applied view so both
    // policies route under the same rule and only the policy differs.
    const old: Router = input => imported({ ...input, accounts: input.accounts.map(applyWeeklyReserve) });
    const weekly = Object.fromEntries(Object.entries(capacity).map(([slot, plan]) => [slot, plan.weekly]));
    const oldScore = simulate(rows, new Meter(fit.rates, fit.cadences, weekly, fit.weeklyResets), old, () => undefined, capacity, { drops: fit.drops, reserves });
    const newScore = simulate(rows, new Meter(fit.rates, fit.cadences, weekly, fit.weeklyResets), selectAccount, demandAt, capacity, { drops: fit.drops, reserves });
    const saturdayStart = rows.find(r => r.ts >= FIT_END && new Date(r.ts).getDay() === 6)?.ts;
    if (saturdayStart === undefined) throw new Error('no Saturday in held-out trace');
    const saturdayEnd = new Date(saturdayStart);
    saturdayEnd.setHours(24, 0, 0, 0);
    const saturday = rows.filter(r => r.ts >= saturdayStart && r.ts < saturdayEnd.getTime());
    const fault = simulate(rows.filter(r => r.ts < saturdayEnd.getTime()), new Meter(fit.rates, fit.cadences, weekly, fit.weeklyResets), selectAccount, demandAt, capacity, { fault: true, startAt: saturdayStart, drops: fit.drops, reserves });
    const lines = [`trace ${rows.length} rows; fit < ${new Date(FIT_END).toISOString()}, validation >=; 09-01..09-07 excluded`, `fidelity ${check.pass ? 'PASS' : 'FAIL (safety comparisons NOT evidence)'}`, 'slot claim   n    max   p95 (points)   resets matched/observed   5h exhaustions matched/observed'];
    for (const d of check.details) lines.push(`${d.slot.padEnd(4)} ${d.claim.padEnd(5)} ${String(d.n).padStart(6)} ${d.max.toFixed(2).padStart(6)} ${d.p95.toFixed(2).padStart(6)}   ${d.reproduced}/${d.resets}   ${d.reproducedExhaustions}/${d.exhaustions}`);
    lines.push('safety (held-out; slots 5–6 plan-scaled sensitivity estimates; not evidence unless fidelity passes)', 'policy served unserved (weekly-bound) unserved$ 5h-exhaust re-creates recreate-extra$ stranded-W20 pulls');
    for (const [name, s] of [[oldPolicyPath ? 'OLD (HEAD)' : 'BASELINE (current, no demand)', oldScore], ['NEW', newScore]] as const) lines.push(`${name} ${s.served} ${s.unserved} (${s.unservedWeekly}) ${s.unservedUsd.toFixed(2)} ${s.exhaustions5h} ${s.recreates} ${s.recreateUsd.toFixed(2)} ${s.stranded.toFixed(2)} ${s.pulls}`);
    const topShare = Math.max(0, ...Object.values(fault.slots)) / Math.max(1, fault.served);
    lines.push(`injected Saturday with Tuesday's demand (warm leases carried in): requests=${saturday.length} warm moves: pulls=${fault.pulls} re-creates=${fault.recreates}; unserved=${fault.unserved}; busiest slot ${(topShare * 100).toFixed(0)}% of requests ${JSON.stringify(fault.slots)} (fresh picks concentrate on the earliest reset by design; a herd migration shows as re-creates)`);
    lines.push(`weekly reserves applied to both policies: ${reserves.size ? [...reserves].map(([s, f]) => `${s}=${f}`).join(' ') : 'none'} (HEAD gets the reserve-applied claims)`);
    lines.push('demand model: rebuilt hourly from rows before the simulated time. Meter inputs are not forward-only: an anchored 5h window takes its phase from the next recorded drop, and weekly resets are the recorded ones.');
    lines.push('meters start from recorded readings where validation / the policy starts; the weekly cadence from the first post-anomaly drop projects past the trace.');
    return { report: lines.join('\n'), pass: check.pass };
  } finally {
    db.close();
    rolled?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(scratch + suffix, { force: true });
  }
}

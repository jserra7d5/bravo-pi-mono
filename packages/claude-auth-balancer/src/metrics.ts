// Usage metrics store.
//
// One row per proxied request, plus a permanent daily rollup. Designed against
// the failure mode of the Codex balancer's database, which grew to ~1 GB/year
// because nothing ever pruned it and its hot foreign key had no index:
//
//   * raw rows have a retention window and are pruned;
//   * the rollup is small enough (~one row per day per account per model) to
//     keep forever, so long-range charts survive pruning;
//   * every column used for filtering or pruning is indexed;
//   * there are no foreign keys, so a prune is a plain ranged DELETE.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Claims } from './claims.js';
import type { Usage } from './usage.js';
import { computeCost } from './usage.js';

export type RequestRecord = {
  ts: number;
  slot: string;
  email?: string;
  sessionHash?: string;
  model?: string;
  endpoint: string;
  status: number;
  decision: string;
  durationMs: number;
  usage: Usage;
  claims?: Claims;
};

export const DEFAULT_RAW_RETENTION_DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  day               TEXT    NOT NULL,
  slot              TEXT    NOT NULL,
  email             TEXT,
  session_hash      TEXT,
  model             TEXT,
  endpoint          TEXT    NOT NULL,
  status            INTEGER NOT NULL,
  decision          TEXT,
  duration_ms       INTEGER,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  uncached_usd      REAL    NOT NULL DEFAULT 0,
  util_5h           REAL,
  util_7d           REAL,
  util_7d_oi        REAL
);
CREATE INDEX IF NOT EXISTS idx_requests_ts      ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_day     ON requests(day);
CREATE INDEX IF NOT EXISTS idx_requests_slot    ON requests(slot, ts);
CREATE INDEX IF NOT EXISTS idx_requests_model   ON requests(model, ts);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_hash, ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  day               TEXT    NOT NULL,
  slot              TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  uncached_usd      REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slot, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);

CREATE TABLE IF NOT EXISTS usage_hourly (
  hour              INTEGER NOT NULL,   -- epoch ms at the start of the UTC hour
  slot              TEXT    NOT NULL,
  model_class       TEXT    NOT NULL,   -- 'fable' | 'general'
  requests          INTEGER NOT NULL,
  sessions          INTEGER NOT NULL,   -- distinct in THIS hour; not summable across hours
  exhaustions       INTEGER NOT NULL,
  cost_usd          REAL    NOT NULL,
  uncached_usd      REAL    NOT NULL,
  util_5h_first     REAL, util_5h_last    REAL,
  util_7d_first     REAL, util_7d_last    REAL,
  util_7d_oi_first  REAL, util_7d_oi_last REAL,
  reset_5h          INTEGER NOT NULL,   -- the 5h reading fell by more than RESET_DROP in this hour
  reset_7d          INTEGER NOT NULL,   -- the 7d or 7d_oi reading did
  PRIMARY KEY (hour, slot, model_class)
);

-- One row per closed hour, traffic or not. censored: at the hour's end every
-- known slot was at or above 95% on 5h or 7d, so low demand in that hour may
-- be missing quota rather than missing work.
CREATE TABLE IF NOT EXISTS fleet_hourly (
  hour      INTEGER PRIMARY KEY,
  censored  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export type ModelClass = 'fable' | 'general';

/** Fable is the only model gated on its own weekly claim (`7d_oi`). */
export function modelClass(model: string | null | undefined): ModelClass {
  return model && model.toLowerCase().includes('fable') ? 'fable' : 'general';
}

export const HOUR_MS = 3_600_000;

/** A claim reading falling by more than this is a window reset, not noise. */
export const RESET_DROP = 0.3;

/** Claims every request is gated on, for the `censored` flag. */
const GATED = ['5h', '7d'] as const;

const CENSOR_UTILIZATION = 0.95;

type RawRow = {
  ts: number;
  slot: string;
  model: string | null;
  session_hash: string | null;
  status: number;
  cost_usd: number;
  uncached_usd: number;
  util_5h: number | null;
  util_7d: number | null;
  util_7d_oi: number | null;
};

type Readings = { '5h'?: number; '7d'?: number; '7d_oi'?: number };

type HourAcc = {
  requests: number;
  sessions: Set<string>;
  exhaustions: number;
  cost: number;
  uncached: number;
  first: Readings;
  last: Readings;
  reset5h: boolean;
  reset7d: boolean;
};

/** UTC day key, so charts do not shift when the host's timezone changes. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class MetricsStore {
  private readonly db: DatabaseSync;

  constructor(stateRoot: string, filename = 'metrics.sqlite3') {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(stateRoot, filename));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Without this, a second proxy process writing concurrently gets an
    // immediate SQLITE_BUSY and that request's metrics are dropped for good.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Record one request and fold it into the daily rollup in a single
   * transaction, so a prune of raw rows can never lose aggregate history.
   */
  record(record: RequestRecord): void {
    const cost = computeCost(record.model, record.usage);
    const day = dayKey(record.ts);
    const u = record.usage;
    const write1h = u.cacheCreation1hTokens ?? u.cacheCreationInputTokens ?? 0;
    const byId = record.claims?.byId;

    const values = {
      ts: record.ts,
      day,
      slot: record.slot,
      email: record.email ?? null,
      session: record.sessionHash ?? null,
      model: record.model ?? null,
      endpoint: record.endpoint,
      status: record.status,
      decision: record.decision,
      duration: Math.round(record.durationMs),
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadInputTokens ?? 0,
      cacheWrite: u.cacheCreationInputTokens ?? 0,
      cacheWrite1h: write1h,
      cost: cost?.totalUsd ?? 0,
      uncached: cost?.uncachedEquivalentUsd ?? 0,
      util5h: byId?.['5h']?.utilization ?? null,
      util7d: byId?.['7d']?.utilization ?? null,
      util7dOi: byId?.['7d_oi']?.utilization ?? null,
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO requests (
             ts, day, slot, email, session_hash, model, endpoint, status, decision, duration_ms,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
             cost_usd, uncached_usd, util_5h, util_7d, util_7d_oi
           ) VALUES (
             :ts, :day, :slot, :email, :session, :model, :endpoint, :status, :decision, :duration,
             :input, :output, :cacheRead, :cacheWrite, :cacheWrite1h,
             :cost, :uncached, :util5h, :util7d, :util7dOi
           )`,
        )
        .run(values as unknown as Record<string, null | number | bigint | string>);

      this.db
        .prepare(
          `INSERT INTO usage_daily (day, slot, model, requests, input_tokens, output_tokens,
                                    cache_read_tokens, cache_write_tokens, cost_usd, uncached_usd)
           VALUES (:day, :slot, :model, 1, :input, :output, :cacheRead, :cacheWrite, :cost, :uncached)
           ON CONFLICT(day, slot, model) DO UPDATE SET
             requests          = requests + 1,
             input_tokens      = input_tokens + excluded.input_tokens,
             output_tokens     = output_tokens + excluded.output_tokens,
             cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
             cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
             cost_usd          = cost_usd + excluded.cost_usd,
             uncached_usd      = uncached_usd + excluded.uncached_usd`,
        )
        .run({
          day,
          slot: values.slot,
          model: values.model ?? 'unknown',
          input: values.input,
          output: values.output,
          cacheRead: values.cacheRead,
          cacheWrite: values.cacheWrite,
          cost: values.cost,
          uncached: values.uncached,
        } as unknown as Record<string, null | number | bigint | string>);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Fold every closed hour not yet rolled up into `usage_hourly`.
   *
   * Idempotent: a watermark in `meta` records the last hour written, and each
   * hour is written once, only after it has closed. The first run backfills
   * everything `requests` still holds. Call it before `prune`, so no raw row
   * is deleted before it has been rolled up.
   */
  rollupHours(nowMs: number): number {
    const closedBefore = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const mark = this.db.prepare(`SELECT value FROM meta WHERE key = 'hourly_rolled_through'`).get() as
      | { value: string }
      | undefined;
    const earliest = this.db.prepare('SELECT MIN(ts) AS ts FROM requests').get() as { ts: number | null };
    if (earliest.ts === null) return 0;
    const from = mark ? Number(mark.value) : Math.floor(earliest.ts / HOUR_MS) * HOUR_MS;
    if (from >= closedBefore) return 0;

    // Each slot's last reading before the range seeds reset detection and the
    // fleet-wide `censored` state, so incremental runs agree with a backfill.
    const lastBySlot = new Map<string, Readings>();
    const seeds = this.db
      .prepare(
        `SELECT slot,
                (SELECT util_5h    FROM requests r2 WHERE r2.slot = r.slot AND r2.ts < ? AND util_5h    IS NOT NULL ORDER BY ts DESC LIMIT 1) AS u5,
                (SELECT util_7d    FROM requests r2 WHERE r2.slot = r.slot AND r2.ts < ? AND util_7d    IS NOT NULL ORDER BY ts DESC LIMIT 1) AS u7,
                (SELECT util_7d_oi FROM requests r2 WHERE r2.slot = r.slot AND r2.ts < ? AND util_7d_oi IS NOT NULL ORDER BY ts DESC LIMIT 1) AS uoi
           FROM (SELECT DISTINCT slot FROM requests) r`,
      )
      .all(from, from, from) as { slot: string; u5: number | null; u7: number | null; uoi: number | null }[];
    for (const seed of seeds) {
      const r: Readings = {};
      if (seed.u5 !== null) r['5h'] = seed.u5;
      if (seed.u7 !== null) r['7d'] = seed.u7;
      if (seed.uoi !== null) r['7d_oi'] = seed.uoi;
      lastBySlot.set(seed.slot, r);
    }

    const rows = this.db
      .prepare(
        `SELECT ts, slot, model, session_hash, status, cost_usd, uncached_usd, util_5h, util_7d, util_7d_oi
           FROM requests WHERE ts >= ? AND ts < ? ORDER BY ts`,
      )
      .all(from, closedBefore) as RawRow[];

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO usage_hourly (
         hour, slot, model_class, requests, sessions, exhaustions, cost_usd, uncached_usd,
         util_5h_first, util_5h_last, util_7d_first, util_7d_last, util_7d_oi_first, util_7d_oi_last,
         reset_5h, reset_7d
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFleet = this.db.prepare(
      'INSERT OR REPLACE INTO fleet_hourly (hour, censored) VALUES (?, ?)',
    );
    const censoredAt = (): boolean =>
      lastBySlot.size > 0 &&
      [...lastBySlot.values()].every(r => GATED.some(id => (r[id] ?? 0) >= CENSOR_UTILIZATION));

    let written = 0;
    let i = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let hour = from; hour < closedBefore; hour += HOUR_MS) {
        const acc = new Map<string, HourAcc>();
        for (; i < rows.length && rows[i]!.ts < hour + HOUR_MS; i += 1) {
          const row = rows[i]!;
          const key = `${row.slot}\u0000${modelClass(row.model)}`;
          let a = acc.get(key);
          if (!a) {
            a = { requests: 0, sessions: new Set(), exhaustions: 0, cost: 0, uncached: 0, first: {}, last: {}, reset5h: false, reset7d: false };
            acc.set(key, a);
          }
          a.requests += 1;
          if (row.session_hash) a.sessions.add(row.session_hash);
          if (row.status === 429 || (row.util_5h ?? 0) >= 1 || (row.util_7d ?? 0) >= 1 || (row.util_7d_oi ?? 0) >= 1) {
            a.exhaustions += 1;
          }
          a.cost += row.cost_usd;
          a.uncached += row.uncached_usd;
          const prior = lastBySlot.get(row.slot) ?? {};
          const next: Readings = { ...prior };
          for (const [id, value] of [['5h', row.util_5h], ['7d', row.util_7d], ['7d_oi', row.util_7d_oi]] as const) {
            if (value === null) continue;
            if (prior[id] !== undefined && prior[id]! - value > RESET_DROP) {
              if (id === '5h') a.reset5h = true;
              else a.reset7d = true;
            }
            a.first[id] ??= value;
            a.last[id] = value;
            next[id] = value;
          }
          lastBySlot.set(row.slot, next);
        }
        const censored = censoredAt();
        insertFleet.run(hour, censored ? 1 : 0);
        for (const [key, a] of acc) {
          const [slot, cls] = key.split('\u0000') as [string, ModelClass];
          insert.run(
            hour, slot, cls, a.requests, a.sessions.size, a.exhaustions, a.cost, a.uncached,
            a.first['5h'] ?? null, a.last['5h'] ?? null,
            a.first['7d'] ?? null, a.last['7d'] ?? null,
            a.first['7d_oi'] ?? null, a.last['7d_oi'] ?? null,
            a.reset5h ? 1 : 0, a.reset7d ? 1 : 0,
          );
          written += 1;
        }
      }
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('hourly_rolled_through', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(closedBefore));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return written;
  }

  /** Delete raw rows older than the retention window. Rollups are untouched. */
  prune(nowMs: number, retentionDays = DEFAULT_RAW_RETENTION_DAYS): number {
    const cutoff = nowMs - retentionDays * 86_400_000;
    const result = this.db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * Arbitrary query surface for dashboards, genuinely read-only.
   *
   * `prepare(sql).all()` places no constraint on statement type — it will run
   * `DROP TABLE usage_daily` as happily as a SELECT — so a pasted or mistyped
   * query could destroy the permanent rollup the retention design exists to
   * protect. `query_only` makes the promise real for the duration of the call.
   */
  query(sql: string, params: (string | number)[] = []): unknown[] {
    this.db.exec('PRAGMA query_only = ON');
    try {
      return this.db.prepare(sql).all(...params);
    } finally {
      this.db.exec('PRAGMA query_only = OFF');
    }
  }

  /** Per-account totals over the last `days`, from the permanent rollup. */
  summary(nowMs: number, days = 7): unknown[] {
    const from = dayKey(nowMs - days * 86_400_000);
    return this.db
      .prepare(
        `SELECT slot, model,
                SUM(requests)          AS requests,
                SUM(input_tokens)      AS input_tokens,
                SUM(output_tokens)     AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                ROUND(SUM(cost_usd), 4)      AS cost_usd,
                ROUND(SUM(uncached_usd), 4)  AS uncached_usd
           FROM usage_daily
          WHERE day >= ?
          GROUP BY slot, model
          ORDER BY cost_usd DESC`,
      )
      .all(from);
  }

  /** Daily series for charting. */
  daily(nowMs: number, days = 30): unknown[] {
    const from = dayKey(nowMs - days * 86_400_000);
    return this.db
      .prepare(
        `SELECT day, slot, model, requests, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens,
                ROUND(cost_usd, 4) AS cost_usd, ROUND(uncached_usd, 4) AS uncached_usd
           FROM usage_daily
          WHERE day >= ?
          ORDER BY day, slot, model`,
      )
      .all(from);
  }
}

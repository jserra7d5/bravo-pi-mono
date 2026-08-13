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

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

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

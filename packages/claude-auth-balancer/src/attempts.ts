import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertAuthBalancerAttemptV1,
  redactSecretsForJson,
  type AuthBalancerAttemptV1,
  type AttemptOutcome,
  type AttemptPhase,
  type EvidenceCode,
} from '@bravo/auth-balancer-contract';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_balancer_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  parent_attempt_id TEXT,
  provider TEXT NOT NULL,
  session_hash TEXT,
  public_model_id TEXT NOT NULL,
  endpoint_class TEXT NOT NULL,
  slot_id TEXT,
  account_hash TEXT,
  affinity_generation INTEGER,
  phase TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  transport_mode TEXT,
  transport_policy_version TEXT,
  connection_phase TEXT,
  socket_reused INTEGER,
  tls_session_reused INTEGER,
  request_bytes_written INTEGER,
  response_headers_received INTEGER,
  handshake_duration_ms REAL,
  response_bytes_received INTEGER,
  response_idle_ms INTEGER,
  error_code TEXT,
  evidence_codes_json TEXT NOT NULL,
  upstream_status INTEGER,
  wire_started INTEGER NOT NULL,
  content_started INTEGER NOT NULL,
  retry_eligible INTEGER NOT NULL,
  rotation_eligible INTEGER NOT NULL,
  wait_ms INTEGER,
  duration_ms REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_request ON auth_balancer_attempts(request_id, id);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_session ON auth_balancer_attempts(session_hash, id);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_slot ON auth_balancer_attempts(slot_id, id);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_created ON auth_balancer_attempts(created_at);
`;

/** Columns added after the table first shipped; existing databases gain them in place. */
const ADDED_COLUMNS = ['response_bytes_received INTEGER', 'response_idle_ms INTEGER'];

export type AttemptInput = Partial<AuthBalancerAttemptV1> & {
  request_id: string;
  public_model_id: string;
  endpoint_class: string;
  phase: AttemptPhase;
  outcome: AttemptOutcome;
  evidence_codes?: EvidenceCode[];
};

export function newRequestId(): string {
  return randomUUID();
}

export function newAttemptId(): string {
  return randomUUID();
}

function hashKeyPath(stateRoot: string): string {
  return path.join(stateRoot, 'state', 'attempt-hash-key');
}

function hashKey(stateRoot: string): Buffer {
  const target = hashKeyPath(stateRoot);
  try {
    return Buffer.from(readFileSync(target, 'utf8').trim(), 'hex');
  } catch {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString('hex');
    const tmp = `${target}.tmp.${process.pid}`;
    writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
    try {
      renameSync(tmp, target);
    } catch (error) {
      if (existsSync(target)) return Buffer.from(readFileSync(target, 'utf8').trim(), 'hex');
      throw error;
    }
    return Buffer.from(key, 'hex');
  }
}

export function scopedAttemptHash(stateRoot: string, label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash('sha256')
    .update(hashKey(stateRoot))
    .update('\0')
    .update(label)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 32);
}

function bool(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

export class AttemptStore {
  private readonly db: DatabaseSync;

  constructor(stateRoot: string, filename = 'metrics.sqlite3') {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(stateRoot, filename));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    const present = new Set(
      (this.db.prepare('PRAGMA table_info(auth_balancer_attempts)').all() as { name: string }[]).map(c => c.name),
    );
    for (const column of ADDED_COLUMNS) {
      if (!present.has(column.split(' ')[0]!)) this.db.exec(`ALTER TABLE auth_balancer_attempts ADD COLUMN ${column}`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  record(input: AttemptInput): AuthBalancerAttemptV1 {
    const attempt = assertAuthBalancerAttemptV1(redactSecretsForJson({
      schema_version: 1,
      attempt_id: newAttemptId(),
      provider: 'claude',
      evidence_codes: [],
      wire_started: false,
      content_started: false,
      retry_eligible: false,
      rotation_eligible: false,
      duration_ms: 0,
      created_at: new Date().toISOString(),
      ...input,
    }));
    this.db.prepare(
      `INSERT INTO auth_balancer_attempts (
         schema_version, attempt_id, request_id, parent_attempt_id, provider, session_hash,
         public_model_id, endpoint_class, slot_id, account_hash, affinity_generation, phase,
         outcome, reason_code, transport_mode, transport_policy_version, connection_phase,
         socket_reused, tls_session_reused, request_bytes_written, response_headers_received,
         handshake_duration_ms, response_bytes_received, response_idle_ms, error_code, evidence_codes_json, upstream_status, wire_started,
         content_started, retry_eligible, rotation_eligible, wait_ms, duration_ms, created_at
       ) VALUES (
         :schemaVersion, :attemptId, :requestId, :parentAttemptId, :provider, :sessionHash,
         :publicModelId, :endpointClass, :slotId, :accountHash, :affinityGeneration, :phase,
         :outcome, :reasonCode, :transportMode, :transportPolicyVersion, :connectionPhase,
         :socketReused, :tlsSessionReused, :requestBytesWritten, :responseHeadersReceived,
         :handshakeDurationMs, :responseBytesReceived, :responseIdleMs, :errorCode, :evidenceCodesJson, :upstreamStatus, :wireStarted,
         :contentStarted, :retryEligible, :rotationEligible, :waitMs, :durationMs, :createdAt
       )`,
    ).run({
      schemaVersion: attempt.schema_version,
      attemptId: attempt.attempt_id,
      requestId: attempt.request_id,
      parentAttemptId: attempt.parent_attempt_id ?? null,
      provider: attempt.provider,
      sessionHash: attempt.session_hash ?? null,
      publicModelId: attempt.public_model_id,
      endpointClass: attempt.endpoint_class,
      slotId: attempt.slot_id ?? null,
      accountHash: attempt.account_hash ?? null,
      affinityGeneration: attempt.affinity_generation ?? null,
      phase: attempt.phase,
      outcome: attempt.outcome,
      reasonCode: attempt.reason_code ?? null,
      transportMode: attempt.transport_mode ?? null,
      transportPolicyVersion: attempt.transport_policy_version ?? null,
      connectionPhase: attempt.connection_phase ?? null,
      socketReused: bool(attempt.socket_reused),
      tlsSessionReused: bool(attempt.tls_session_reused),
      requestBytesWritten: attempt.request_bytes_written ?? null,
      responseHeadersReceived: bool(attempt.response_headers_received),
      handshakeDurationMs: attempt.handshake_duration_ms ?? null,
      responseBytesReceived: attempt.response_bytes_received ?? null,
      responseIdleMs: attempt.response_idle_ms ?? null,
      errorCode: attempt.error_code ?? null,
      evidenceCodesJson: JSON.stringify(attempt.evidence_codes),
      upstreamStatus: attempt.upstream_status ?? null,
      wireStarted: attempt.wire_started ? 1 : 0,
      contentStarted: attempt.content_started ? 1 : 0,
      retryEligible: attempt.retry_eligible ? 1 : 0,
      rotationEligible: attempt.rotation_eligible ? 1 : 0,
      waitMs: attempt.wait_ms ?? null,
      durationMs: attempt.duration_ms,
      createdAt: attempt.created_at,
    } as unknown as Record<string, null | number | bigint | string>);
    return attempt;
  }

  query(sql: string, params: (string | number)[] = []): unknown[] {
    this.db.exec('PRAGMA query_only = ON');
    try {
      return this.db.prepare(sql).all(...params);
    } finally {
      this.db.exec('PRAGMA query_only = OFF');
    }
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { dataRoot } from "./paths.js";

export interface RootOwnerLease {
  schemaVersion: 1;
  leaseId: string;
  ownerId: string;
  rootSessionId?: string;
  workstreamId?: string;
  cwd: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export function leaseStorePath(): string {
  return join(dataRoot(), "root-owner-leases.jsonl");
}

function keyOf(input: { rootSessionId?: string; workstreamId?: string; cwd: string }): string {
  return [input.rootSessionId ?? "", input.workstreamId ?? "", resolve(input.cwd || process.cwd())].join("|");
}

function appendLease(record: RootOwnerLease): void {
  const path = leaseStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

export function readLeases(): RootOwnerLease[] {
  const path = leaseStorePath();
  if (!existsSync(path)) return [];
  const byKey = new Map<string, RootOwnerLease>();
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const lease = JSON.parse(line) as RootOwnerLease;
      if (lease?.schemaVersion !== 1 || !lease.ownerId) continue;
      byKey.set(keyOf(lease), lease);
    } catch {}
  }
  return [...byKey.values()];
}

export function acquireRootOwnerLease(input: {
  rootSessionId?: string;
  workstreamId?: string;
  cwd: string;
  ownerId?: string;
  ttlMs?: number;
  nowMs?: number;
}): RootOwnerLease {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? 10_000;
  const now = new Date(nowMs).toISOString();
  const ownerId = input.ownerId ?? `owner_${process.pid}_${randomBytes(4).toString("hex")}`;
  const lease: RootOwnerLease = {
    schemaVersion: 1,
    leaseId: `lease_${Date.now()}_${randomBytes(4).toString("hex")}`,
    ownerId,
    rootSessionId: input.rootSessionId,
    workstreamId: input.workstreamId,
    cwd: resolve(input.cwd || process.cwd()),
    pid: process.pid,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
  appendLease(lease);
  return lease;
}

export function heartbeatRootOwnerLease(input: {
  rootSessionId?: string;
  workstreamId?: string;
  cwd: string;
  ownerId: string;
  ttlMs?: number;
  nowMs?: number;
}): RootOwnerLease {
  return acquireRootOwnerLease(input);
}

export function currentRootOwnerLease(input: { rootSessionId?: string; workstreamId?: string; cwd: string }): RootOwnerLease | undefined {
  const key = keyOf(input);
  return readLeases().find((lease) => keyOf(lease) === key);
}

export function ownsRootLease(input: { rootSessionId?: string; workstreamId?: string; cwd: string; ownerId: string; nowMs?: number }): boolean {
  const lease = currentRootOwnerLease(input);
  if (!lease || lease.ownerId !== input.ownerId) return false;
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && expires > (input.nowMs ?? Date.now());
}

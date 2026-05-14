import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { leaseRoot } from "./config.js";
import { newLeaseId } from "./ids.js";
import { atomicWriteJson } from "./jsonl.js";
import { nowIso } from "./time.js";
import type { RootSessionLease } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface LeaseOptions {
  cwd: string;
  rootSessionId: string;
  ownerId: string;
  ttlMs?: number;
  nowMs?: number;
  leasesDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function leasePath(options: Pick<LeaseOptions, "cwd" | "rootSessionId" | "leasesDir" | "env">): string {
  return join(options.leasesDir ?? leaseRoot(options.cwd, undefined, options.env ?? process.env), `${options.rootSessionId}.json`);
}

export function acquireRootSessionLease(options: LeaseOptions): RootSessionLease {
  const nowMs = options.nowMs ?? Date.now();
  const now = nowIso(nowMs);
  const lease: RootSessionLease = {
    schemaVersion: SCHEMA_VERSION,
    leaseId: newLeaseId(nowMs),
    ownerId: options.ownerId,
    rootSessionId: options.rootSessionId,
    cwd: resolve(options.cwd),
    pid: process.pid,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: nowIso(nowMs + (options.ttlMs ?? 10_000)),
  };
  const path = leasePath(options);
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteJson(path, lease);
  return lease;
}

export function currentRootSessionLease(options: Pick<LeaseOptions, "cwd" | "rootSessionId" | "leasesDir" | "env">): RootSessionLease | undefined {
  const path = leasePath(options);
  if (!existsSync(path)) return undefined;
  const lease = JSON.parse(readFileSync(path, "utf8")) as RootSessionLease;
  if (resolve(lease.cwd) !== resolve(options.cwd)) return undefined;
  return lease;
}

export function ownsRootSessionLease(options: Pick<LeaseOptions, "cwd" | "rootSessionId" | "ownerId" | "leasesDir" | "env"> & { nowMs?: number }): boolean {
  const lease = currentRootSessionLease(options);
  if (!lease || lease.ownerId !== options.ownerId) return false;
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > (options.nowMs ?? Date.now());
}

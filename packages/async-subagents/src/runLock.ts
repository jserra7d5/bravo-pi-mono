import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

export interface RunMutationLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
}

export interface RunMutationLockResult<T> {
  value: T;
  waitedMs: number;
}

interface LockOwner {
  pid: number;
  token: string;
  host: string;
  processIdentity?: string;
  acquiredAt: string;
  heartbeatAt: string;
}

interface OwnerRecord {
  path: string;
  owner?: LockOwner;
  mtimeMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockDirForRun(runDir: string): string {
  return join(runDir, ".mutation.lock");
}

function newToken(): string {
  return randomBytes(12).toString("base64url");
}

const SELF_FALLBACK_PROCESS_IDENTITY = `node-self:${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;

interface LinuxProcessStat {
  identity?: string;
  state?: string;
}

export interface ProcessIdentitySnapshot {
  /** Definitive liveness only. Undefined means permission or platform uncertainty. */
  alive?: boolean;
  /** OS process-start identity token when available. */
  identity?: string;
  permissionDenied?: boolean;
}

function parseLinuxProcessStat(stat: string): LinuxProcessStat | undefined {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) return undefined;
  const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
  const state = fields[0];
  const startTicks = fields[19];
  return {
    state: state || undefined,
    identity: startTicks && /^\d+$/.test(startTicks) ? `linux-proc-start:${startTicks}` : undefined,
  };
}

function readLinuxProcessStat(pid: number): LinuxProcessStat | undefined {
  try {
    return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

export function probeProcessIdentity(pid: number): ProcessIdentitySnapshot {
  if (!Number.isInteger(pid) || pid <= 0) return {};
  const linuxStat = readLinuxProcessStat(pid);
  if (linuxStat?.state === "Z" || linuxStat?.state === "X" || linuxStat?.state === "x") {
    return { alive: false, identity: linuxStat.identity };
  }
  let alive: boolean | undefined;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") alive = false;
    if (code === "EPERM") return { identity: linuxStat?.identity, permissionDenied: true };
  }
  return { alive, identity: linuxStat?.identity ?? (pid === process.pid ? SELF_FALLBACK_PROCESS_IDENTITY : undefined) };
}

export function currentProcessIdentityToken(): string | undefined {
  return probeProcessIdentity(process.pid).identity;
}

function newOwner(): LockOwner {
  const now = new Date().toISOString();
  return { pid: process.pid, token: newToken(), host: hostname(), processIdentity: currentProcessIdentityToken(), acquiredAt: now, heartbeatAt: now };
}

function ownerFileName(token: string): string {
  return `owner.${token}.json`;
}

function ownerPath(lockDir: string, owner: Pick<LockOwner, "token">): string {
  return join(lockDir, ownerFileName(owner.token));
}

function isOwnerFile(name: string): boolean {
  return /^owner\.[A-Za-z0-9_-]+\.json$/.test(name);
}

function writeOwner(lockDir: string, owner: LockOwner): void {
  const finalPath = ownerPath(lockDir, owner);
  const tmpPath = join(lockDir, `.owner.${owner.token}.${process.pid}.${randomBytes(4).toString("base64url")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(owner), "utf8");
  renameSync(tmpPath, finalPath);
}

function readOwnerRecord(path: string): OwnerRecord | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string" || typeof parsed.host !== "string") return { path, mtimeMs: stat.mtimeMs };
    if (ownerFileName(parsed.token) !== basename(path)) return { path, mtimeMs: stat.mtimeMs };
    return {
      path,
      mtimeMs: stat.mtimeMs,
      owner: {
        pid: parsed.pid,
        token: parsed.token,
        host: parsed.host,
        processIdentity: typeof parsed.processIdentity === "string" ? parsed.processIdentity : undefined,
        acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
        heartbeatAt: typeof parsed.heartbeatAt === "string" ? parsed.heartbeatAt : parsed.acquiredAt ?? "",
      },
    };
  } catch {
    return { path, mtimeMs: stat.mtimeMs };
  }
}

function ownerRecords(lockDir: string): OwnerRecord[] {
  try {
    return readdirSync(lockDir).filter(isOwnerFile).flatMap((name) => readOwnerRecord(join(lockDir, name)) ?? []);
  } catch {
    return [];
  }
}

function heartbeatAgeMs(record: OwnerRecord, nowMs: number): number {
  const heartbeatMs = record.owner ? Date.parse(record.owner.heartbeatAt || record.owner.acquiredAt) : Number.NaN;
  return Number.isFinite(heartbeatMs) ? nowMs - heartbeatMs : nowMs - record.mtimeMs;
}

function ownerIsStale(record: OwnerRecord, staleMs: number, nowMs: number): boolean {
  const age = heartbeatAgeMs(record, nowMs);
  if (record.owner && record.owner.host === hostname()) {
    const snapshot = probeProcessIdentity(record.owner.pid);
    if (snapshot.alive === false) return true;
    if (snapshot.alive === true) {
      if (record.owner.processIdentity && snapshot.identity && snapshot.identity !== record.owner.processIdentity) return age >= staleMs;
      return false;
    }
    if (snapshot.permissionDenied) return false;
  }
  return age >= staleMs;
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function rmdirIfEmpty(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    return false;
  }
}

function cleanupStaleOrphanFiles(lockDir: string, staleMs: number, nowMs: number): boolean {
  let removed = false;
  let hasFreshEntry = false;
  try {
    for (const name of readdirSync(lockDir)) {
      const path = join(lockDir, name);
      try {
        const stat = statSync(path);
        if (nowMs - stat.mtimeMs >= staleMs) {
          unlinkIfExists(path);
          removed = true;
        } else {
          hasFreshEntry = true;
        }
      } catch {
        removed = true;
      }
    }
  } catch {
    return false;
  }
  if (hasFreshEntry) return removed;
  return rmdirIfEmpty(lockDir) || removed;
}

function tryRemoveStaleLock(lockDir: string, staleMs: number, nowMs: number): boolean {
  if (!existsSync(lockDir)) return false;
  const records = ownerRecords(lockDir);
  if (records.length === 0) return cleanupStaleOrphanFiles(lockDir, staleMs, nowMs);

  let removed = false;
  let live = false;
  for (const record of records) {
    if (ownerIsStale(record, staleMs, nowMs)) {
      try {
        unlinkIfExists(record.path);
        removed = true;
      } catch {
        live = true;
      }
    } else {
      live = true;
    }
  }
  if (live) return removed;
  return rmdirIfEmpty(lockDir);
}

function releaseOwnedLock(lockDir: string, owner: LockOwner): void {
  try {
    unlinkIfExists(ownerPath(lockDir, owner));
  } catch {
    return;
  }
  rmdirIfEmpty(lockDir);
}

function startHeartbeat(lockDir: string, owner: LockOwner, heartbeatMs: number): NodeJS.Timeout | undefined {
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return undefined;
  return setInterval(() => {
    try {
      if (!existsSync(ownerPath(lockDir, owner))) return;
      owner.heartbeatAt = new Date().toISOString();
      writeOwner(lockDir, owner);
    } catch {
      // Best effort. Stale cleanup uses heartbeat age and token-addressed release
      // prevents this holder from deleting a replacement lock.
    }
  }, heartbeatMs).unref();
}

function describeCurrentOwners(lockDir: string): string | undefined {
  const records = ownerRecords(lockDir);
  if (records.length === 0) return undefined;
  return records.map((record) => record.owner ? JSON.stringify(record.owner) : `unparseable:${record.path}`).join(",");
}

export async function withRunMutationLock<T>(runDir: string, fn: () => T | Promise<T>, options: RunMutationLockOptions = {}): Promise<RunMutationLockResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.max(5, Math.min(5_000, Math.floor(staleMs / 3)));
  const lockDir = lockDirForRun(runDir);
  const started = Date.now();
  let owner: LockOwner | undefined;

  while (!owner) {
    try {
      mkdirSync(lockDir);
      const candidate = newOwner();
      try {
        writeOwner(lockDir, candidate);
        owner = candidate;
        break;
      } catch (error) {
        rmdirIfEmpty(lockDir);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          await sleep(retryMs);
          continue;
        }
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const now = Date.now();
      tryRemoveStaleLock(lockDir, staleMs, now);
      if (now - started >= timeoutMs) {
        const currentOwners = describeCurrentOwners(lockDir);
        throw new Error(`timed out waiting for run mutation lock after ${timeoutMs}ms${currentOwners ? `; owners=${currentOwners}` : ""}`);
      }
      await sleep(Math.min(retryMs, Math.max(1, timeoutMs - (now - started))));
    }
  }

  const heartbeat = startHeartbeat(lockDir, owner, heartbeatMs);
  try {
    const value = await fn();
    return { value, waitedMs: Date.now() - started };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releaseOwnedLock(lockDir, owner);
  }
}

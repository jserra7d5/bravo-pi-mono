import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { BackgroundTaskRecord } from "./task-types.js";

const ACTIVE_LIFECYCLE_STATUSES = new Set<BackgroundTaskRecord["status"]>(["starting", "running", "blocked", "orphaned"]);
const REGISTRY_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 30_000;
const REGISTRY_LOCK_RETRY_MS = 25;
const REGISTRY_LOCK_HOST = hostname();
type RegistryLockOwner = { pid: number; hostname: string; token: string; acquiredAt: number; };

function isActiveLifecycle(record: BackgroundTaskRecord): boolean {
  return ACTIVE_LIFECYCLE_STATUSES.has(record.status);
}

function isTerminalMetadata(record: BackgroundTaskRecord): boolean {
  return record.status === "exited" || record.status === "failed" || record.status === "timed_out" || record.status === "killed";
}

function shouldPreferMetadata(active: BackgroundTaskRecord, metadata: BackgroundTaskRecord): boolean {
  if (isTerminalMetadata(metadata)) return true;
  if (metadata.updatedAt > active.updatedAt) return true;
  return metadata.updatedAt === active.updatedAt && activeStatusRank(metadata.status) > activeStatusRank(active.status);
}

function activeStatusRank(status: BackgroundTaskRecord["status"]): number {
  if (status === "starting") return 0;
  if (status === "running") return 1;
  if (status === "blocked") return 2;
  return 3;
}

function shouldSuppressActiveMetadataOverwrite(incoming: BackgroundTaskRecord, metadata: BackgroundTaskRecord): boolean {
  if (isTerminalMetadata(metadata)) return true;
  if (metadata.updatedAt < incoming.updatedAt) return false;
  if (metadata.updatedAt === incoming.updatedAt) return activeStatusRank(metadata.status) > activeStatusRank(incoming.status);
  return metadata.status === incoming.status || activeStatusRank(metadata.status) > activeStatusRank(incoming.status);
}

export class TaskRegistry {
  private records = new Map<string, BackgroundTaskRecord>();
  readonly registryPath: string;
  private readonly lockDir: string;
  private heldLockToken: string | undefined;

  constructor(readonly dataDir: string) {
    this.registryPath = join(dataDir, "registry.json");
    this.lockDir = join(dataDir, ".registry.lock");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as BackgroundTaskRecord[];
      this.records = new Map(parsed.filter(isActiveLifecycle).map((r) => [r.taskId, r]));
    } catch {
      this.records = new Map();
    }
  }

  list(includeCompleted = false): BackgroundTaskRecord[] {
    const records = includeCompleted ? this.loadAllMetadataRecords() : this.currentActiveRecords();
    return records.filter((r) => includeCompleted || isActiveLifecycle(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(taskId: string): BackgroundTaskRecord | undefined {
    const active = this.records.get(taskId);
    const metadata = this.loadMetadataRecord(taskId);
    if (!active) return metadata;
    if (!metadata) return active;
    return shouldPreferMetadata(active, metadata) ? metadata : active;
  }

  remove(taskId: string): boolean {
    if (!/^[A-Za-z0-9_.-]+$/.test(taskId)) return false;
    return this.withMutationLock(() => {
      this.load();
      const record = this.records.get(taskId) ?? this.loadMetadataRecord(taskId);
      if (!record || record.schemaVersion !== 1 || !isTerminalMetadata(record)) return false;
      const deletedActive = this.records.delete(taskId);
      const taskDir = join(this.dataDir, taskId);
      let deletedArtifact = false;
      if (existsSync(taskDir)) {
        rmSync(taskDir, { recursive: true, force: true });
        deletedArtifact = true;
      } else if (record?.metadataPath && existsSync(record.metadataPath)) {
        rmSync(record.metadataPath, { force: true });
        deletedArtifact = true;
      }
      if (deletedActive) this.persist(new Set([taskId]));
      return deletedActive || deletedArtifact;
    });
  }

  upsert(record: BackgroundTaskRecord): void {
    this.withMutationLock(() => {
      this.load();
      const existingMetadata = this.loadMetadataRecord(record.taskId);
      if (isActiveLifecycle(record) && !isTerminalMetadata(record) && existingMetadata && shouldSuppressActiveMetadataOverwrite(record, existingMetadata)) {
        if (isTerminalMetadata(existingMetadata)) this.records.delete(record.taskId);
        else this.records.set(record.taskId, existingMetadata);
        this.persist();
        return;
      }

      const updated = { ...record, updatedAt: new Date().toISOString() };
      if (isActiveLifecycle(updated)) this.records.set(updated.taskId, updated);
      else this.records.delete(updated.taskId);
      this.writeMetadataAtomically(updated);
      this.persist(isActiveLifecycle(updated) ? undefined : new Set([updated.taskId]));
    });
  }

  private loadMetadataRecord(taskId: string): BackgroundTaskRecord | undefined {
    if (!/^[A-Za-z0-9_.-]+$/.test(taskId)) return undefined;
    const metadataPath = join(this.dataDir, taskId, "metadata.json");
    if (!existsSync(metadataPath)) return undefined;
    try { return JSON.parse(readFileSync(metadataPath, "utf8")) as BackgroundTaskRecord; }
    catch { return undefined; }
  }

  private currentActiveRecords(): BackgroundTaskRecord[] {
    const active: BackgroundTaskRecord[] = [];
    for (const record of this.records.values()) {
      const metadata = this.loadMetadataRecord(record.taskId);
      const resolved = metadata && shouldPreferMetadata(record, metadata) ? metadata : record;
      if (isActiveLifecycle(resolved)) active.push(resolved);
    }
    return active;
  }

  private loadAllMetadataRecords(): BackgroundTaskRecord[] {
    const byId = new Map(this.currentActiveRecords().map((r) => [r.taskId, r]));
    try {
      for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const record = this.loadMetadataRecord(entry.name);
        if (record) byId.set(record.taskId, record);
      }
    } catch {
      // Fall back to the active lifecycle index.
    }
    return [...byId.values()];
  }

  private loadRegistryRecords(): BackgroundTaskRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as BackgroundTaskRecord[];
      return parsed.filter(isActiveLifecycle);
    } catch {
      return [];
    }
  }

  private resolveActiveCandidate(record: BackgroundTaskRecord): BackgroundTaskRecord | undefined {
    const metadata = this.loadMetadataRecord(record.taskId);
    const resolved = metadata && shouldPreferMetadata(record, metadata) ? metadata : record;
    return isActiveLifecycle(resolved) ? resolved : undefined;
  }

  private mergedActiveRecords(excludeTaskIds = new Set<string>()): BackgroundTaskRecord[] {
    const byId = new Map<string, BackgroundTaskRecord>();
    for (const record of this.loadRegistryRecords()) {
      if (!excludeTaskIds.has(record.taskId)) byId.set(record.taskId, record);
    }
    for (const record of this.records.values()) {
      if (!excludeTaskIds.has(record.taskId)) byId.set(record.taskId, record);
    }

    const merged: BackgroundTaskRecord[] = [];
    for (const record of byId.values()) {
      const resolved = this.resolveActiveCandidate(record);
      if (resolved) merged.push(resolved);
    }
    return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
  }

  private persist(excludeTaskIds = new Set<string>()): void {
    if (!this.heldLockToken) return this.withMutationLock(() => this.persist(excludeTaskIds));
    const tmp = `${this.registryPath}.${process.pid}.${this.heldLockToken}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.mergedActiveRecords(excludeTaskIds), null, 2));
    renameSync(tmp, this.registryPath);
  }

  private writeMetadataAtomically(record: BackgroundTaskRecord): void {
    if (!this.heldLockToken) return this.withMutationLock(() => this.writeMetadataAtomically(record));
    mkdirSync(dirname(record.metadataPath), { recursive: true, mode: 0o700 });
    const tmp = `${record.metadataPath}.${process.pid}.${this.heldLockToken}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, record.metadataPath);
  }

  private withMutationLock<T>(fn: () => T): T {
    if (this.heldLockToken) return fn();
    const token = `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
    this.acquireMutationLock(token);
    this.heldLockToken = token;
    try {
      return fn();
    } finally {
      this.heldLockToken = undefined;
      this.releaseMutationLock(token);
    }
  }

  private acquireMutationLock(token: string): void {
    const deadline = Date.now() + REGISTRY_LOCK_ACQUIRE_TIMEOUT_MS;
    while (true) {
      try {
        mkdirSync(this.lockDir, { mode: 0o700 });
        writeFileSync(this.lockOwnerPath(), JSON.stringify({ pid: process.pid, hostname: REGISTRY_LOCK_HOST, token, acquiredAt: Date.now() } satisfies RegistryLockOwner));
        return;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        this.removeDeadOrStaleMutationLock();
        if (Date.now() >= deadline) {
          throw new Error(`Timed out after ${REGISTRY_LOCK_ACQUIRE_TIMEOUT_MS}ms acquiring background bash task registry lock at ${this.lockDir}. Another process may be mutating the registry.`);
        }
        sleepSync(Math.min(REGISTRY_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private removeDeadOrStaleMutationLock(): void {
    const owner = this.readLockOwner();
    const stale = this.lockAgeMs(owner) > REGISTRY_LOCK_STALE_MS;
    const deadSameHost = owner?.hostname === REGISTRY_LOCK_HOST && !isPidAlive(owner.pid);
    if (stale || deadSameHost) rmSync(this.lockDir, { recursive: true, force: true });
  }

  private releaseMutationLock(token: string): void {
    const owner = this.readLockOwner();
    if (owner?.token === token) rmSync(this.lockDir, { recursive: true, force: true });
  }

  private readLockOwner(): RegistryLockOwner | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.lockOwnerPath(), "utf8")) as RegistryLockOwner;
      if (typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.token === "string") return parsed;
    } catch {
      // Fall back to lock directory mtime for malformed or missing owner metadata.
    }
    return undefined;
  }

  private lockAgeMs(owner: RegistryLockOwner | undefined): number {
    if (owner && Number.isFinite(owner.acquiredAt)) return Date.now() - owner.acquiredAt;
    try { return Date.now() - statSync(this.lockDir).mtimeMs; }
    catch { return 0; }
  }

  private lockOwnerPath(): string {
    return join(this.lockDir, "owner.json");
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

export function newTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `bg_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

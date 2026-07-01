import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackgroundTaskRecord } from "./task-types.js";

const ACTIVE_LIFECYCLE_STATUSES = new Set<BackgroundTaskRecord["status"]>(["starting", "running", "blocked", "orphaned"]);

function isActiveLifecycle(record: BackgroundTaskRecord): boolean {
  return ACTIVE_LIFECYCLE_STATUSES.has(record.status);
}

function isTerminalMetadata(record: BackgroundTaskRecord): boolean {
  return record.status === "exited" || record.status === "failed" || record.status === "timed_out" || record.status === "killed";
}

function shouldPreferMetadata(active: BackgroundTaskRecord, metadata: BackgroundTaskRecord): boolean {
  if (isTerminalMetadata(metadata)) return true;
  return metadata.updatedAt > active.updatedAt;
}

function activeStatusRank(status: BackgroundTaskRecord["status"]): number {
  if (status === "starting") return 0;
  if (status === "running") return 1;
  if (status === "blocked") return 2;
  return 3;
}

function shouldSuppressActiveMetadataOverwrite(incoming: BackgroundTaskRecord, metadata: BackgroundTaskRecord): boolean {
  if (isTerminalMetadata(metadata)) return true;
  if (metadata.updatedAt <= incoming.updatedAt) return false;
  return metadata.status === incoming.status || activeStatusRank(metadata.status) > activeStatusRank(incoming.status);
}

export class TaskRegistry {
  private records = new Map<string, BackgroundTaskRecord>();
  readonly registryPath: string;

  constructor(readonly dataDir: string) {
    this.registryPath = join(dataDir, "registry.json");
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
    const record = this.records.get(taskId) ?? this.loadMetadataRecord(taskId);
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
    if (deletedActive) this.persist();
    return deletedActive || deletedArtifact;
  }

  upsert(record: BackgroundTaskRecord): void {
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
    this.persist();
    writeFileSync(updated.metadataPath, JSON.stringify(updated, null, 2));
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

  private persist(): void {
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.currentActiveRecords(), null, 2));
    renameSync(tmp, this.registryPath);
  }
}

export function newTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `bg_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

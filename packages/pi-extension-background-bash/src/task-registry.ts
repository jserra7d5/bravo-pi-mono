import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackgroundTaskRecord } from "./task-types.js";

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
      this.records = new Map(parsed.map((r) => [r.taskId, r]));
    } catch {
      this.records = new Map();
    }
  }

  list(includeCompleted = false): BackgroundTaskRecord[] {
    const terminal = new Set(["exited", "failed", "timed_out", "killed", "orphaned"]);
    return [...this.records.values()].filter((r) => includeCompleted || !terminal.has(r.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(taskId: string): BackgroundTaskRecord | undefined { return this.records.get(taskId); }

  remove(taskId: string): boolean {
    const deleted = this.records.delete(taskId);
    if (deleted) this.persist();
    return deleted;
  }

  upsert(record: BackgroundTaskRecord): void {
    const updated = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(updated.taskId, updated);
    this.persist();
    writeFileSync(updated.metadataPath, JSON.stringify(updated, null, 2));
  }

  private persist(): void {
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(tmp, this.registryPath);
  }
}

export function newTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `bg_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

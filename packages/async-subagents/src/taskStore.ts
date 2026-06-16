import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { defaultRunRoot } from "./config.js";
import { SubagentError } from "./errors.js";
import { eventIdForSequence } from "./ids.js";
import { appendJsonl, atomicWriteJson, readJsonl } from "./jsonl.js";
import type { RunStore } from "./runStore.js";
import { deriveTaskReadiness, unresolvedDependencyIds } from "./taskState.js";
import { nowIso } from "./time.js";
import { SCHEMA_VERSION, type TaskEvent, type TaskEventType, type TaskRecord, type TaskStatus, type TaskView, type WaitCursor } from "./types.js";

export interface TaskPaths { taskRoot: string; highwatermarkPath: string; eventHighwatermarkPath: string; eventsPath: string; lockDir: string; tasksDir: string; receiptsDir: string; artifactsDir: string }
export interface CreateTaskSpec { alias?: string; title: string; description: string; dependsOn?: string[]; activeForm?: string; notes?: string }
export interface CreateTasksInput { parentRunId: string; createdBy?: string; tasks: CreateTaskSpec[] }
export interface CreateTasksResult { tasks: TaskView[]; aliasToId: Record<string, string>; newly_ready: TaskView[] }
export interface TaskUpdateInput { actor?: string; taskId?: string; status?: TaskStatus; title?: string; description?: string; dependsOn?: string[]; notes?: string; appendNotes?: string; activeForm?: string | null; addAttemptRunIds?: string[]; addReceiptPaths?: string[]; addArtifactPaths?: string[]; addEvidence?: string[]; force?: boolean }
export interface TaskUpdateResult { task: TaskView; changed: boolean; newly_ready: TaskView[]; invalidated?: TaskView[] }

const LOCK_TTL_MS = 30_000;
const TASK_STATUSES = new Set<TaskStatus>(["open", "active", "blocked", "done", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set<TaskStatus>(["failed", "cancelled"]);

interface TaskFileState { path: string; exists: boolean; size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }
interface MemoryTaskFileCacheEntry { state: TaskFileState; task: TaskRecord }
const memoryTaskFileCaches = new Map<string, MemoryTaskFileCacheEntry>();

function statTaskFile(path: string): TaskFileState {
  if (!existsSync(path)) return { path, exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0 };
  const stat = statSync(path);
  return { path, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}
function taskFileStateUnchanged(previous: TaskFileState, current: TaskFileState): boolean { return previous.path === current.path && previous.exists === current.exists && previous.size === current.size && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs && previous.dev === current.dev && previous.ino === current.ino; }
function cloneJsonValue<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function cloneTask(task: TaskRecord): TaskRecord { return cloneJsonValue(task); }
function validateTaskRecord(task: TaskRecord, path: string): TaskRecord {
  const status = (task as { status?: unknown }).status;
  if (typeof status !== "string" || !TASK_STATUSES.has(status as TaskStatus)) throw new SubagentError("TASK_SCHEMA_MIGRATION_REQUIRED", `task ${task.id ?? path} uses an old or invalid status; recreate or migrate milestone tasks`);
  const old = task as TaskRecord & { owner?: unknown; result?: unknown; attempts?: unknown; state?: unknown };
  if (old.state !== undefined) throw new SubagentError("TASK_SCHEMA_MIGRATION_REQUIRED", `task ${task.id ?? path} uses removed task state field; recreate or migrate milestone tasks`);
  if (old.owner !== undefined || old.result !== undefined || old.attempts !== undefined) throw new SubagentError("TASK_SCHEMA_MIGRATION_REQUIRED", `task ${task.id ?? path} uses removed child-owned task fields; recreate or migrate milestone tasks`);
  return task;
}
function readTaskFileCached(path: string): TaskRecord | undefined {
  const current = statTaskFile(path); const cached = memoryTaskFileCaches.get(path);
  if (cached && taskFileStateUnchanged(cached.state, current)) return cloneTask(cached.task);
  if (!current.exists) { memoryTaskFileCaches.delete(path); return undefined; }
  const task = validateTaskRecord(JSON.parse(readFileSync(path, "utf8")) as TaskRecord, path);
  memoryTaskFileCaches.set(path, { state: current, task: cloneTask(task) });
  return cloneTask(task);
}
function writeTaskFileCache(path: string, task: TaskRecord): void { try { memoryTaskFileCaches.set(path, { state: statTaskFile(path), task: cloneTask(task) }); } catch { memoryTaskFileCaches.delete(path); } }
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function safeSegment(id: string): string { if (!/^T-\d{4,}$/.test(id)) throw new SubagentError("INVALID_TASK_ID", `invalid task id: ${id}`); return id; }
function uniqueAppend(existing: string[] | undefined, additions: string[] | undefined): string[] | undefined { const values = [...(existing ?? []), ...(additions ?? []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())]; return values.length ? [...new Set(values)] : existing; }
function appendNotes(existing: string | undefined, addition: string | undefined): string | undefined { if (!addition?.trim()) return existing; return existing?.trim() ? `${existing.trim()}\n\n${addition.trim()}` : addition.trim(); }

export function newTaskToken(): string { throw new SubagentError("TASK_TOKENS_REMOVED", "task tokens were removed; start subagents directly and update milestones with task_update"); }
export function hashTaskToken(_token: string): string { throw new SubagentError("TASK_TOKENS_REMOVED", "task tokens were removed; start subagents directly and update milestones with task_update"); }
export function taskTokenMatches(_token: string, _hash: string): boolean { return false; }

export class TaskStore {
  readonly cwd: string; readonly runRoot: string; readonly env: NodeJS.ProcessEnv;
  constructor(options: { cwd?: string; runRoot?: string; env?: NodeJS.ProcessEnv } | RunStore = {}) { this.cwd = resolve(options.cwd ?? process.cwd()); this.env = options.env ?? process.env; this.runRoot = defaultRunRoot(this.cwd, options.runRoot, this.env); }
  pathsFor(rootSessionId: string): TaskPaths { const taskRoot = join(resolve(this.runRoot, ".."), "session-tasks", rootSessionId); return { taskRoot, highwatermarkPath: join(taskRoot, "highwatermark"), eventHighwatermarkPath: join(taskRoot, "event-highwatermark"), eventsPath: join(taskRoot, "events.jsonl"), lockDir: join(taskRoot, "lock"), tasksDir: join(taskRoot, "tasks"), receiptsDir: join(taskRoot, "receipts"), artifactsDir: join(taskRoot, "artifacts") }; }
  listTasks(rootSessionId: string, _options: { reconcile?: boolean | "nonblocking" } = {}): TaskRecord[] { return this.listTasksRaw(rootSessionId); }
  listTaskViews(rootSessionId: string): TaskView[] { const tasks = this.listTasksRaw(rootSessionId); return this.toViews(tasks); }
  readTask(rootSessionId: string, taskId: string): TaskRecord { return this.readTaskRaw(rootSessionId, taskId); }
  readTaskView(rootSessionId: string, taskId: string): TaskView { const all = this.listTasksRaw(rootSessionId); return this.toView(this.mustFind(all, taskId), all); }

  createTasks(rootSessionId: string, input: CreateTasksInput): CreateTasksResult { return this.withLock(rootSessionId, "create", () => {
    if (!input.tasks.length) throw new SubagentError("NO_TASKS", "tasks must not be empty");
    const aliases = input.tasks.flatMap((task) => task.alias ? [task.alias] : []); if (new Set(aliases).size !== aliases.length) throw new SubagentError("DUPLICATE_TASK_ALIAS", "task aliases must be unique");
    const existing = this.listTasksRaw(rootSessionId); const existingIds = new Set(existing.map((task) => task.id));
    const now = nowIso(); const aliasToId: Record<string, string> = {}; const allocated = input.tasks.map((task) => { const id = this.nextTaskId(rootSessionId); if (task.alias) aliasToId[task.alias] = id; return { spec: task, id }; });
    const newIds = new Set(allocated.map((item) => item.id));
    const records: TaskRecord[] = allocated.map(({ spec, id }) => {
      const dependsOn = (spec.dependsOn ?? []).map((dep) => aliasToId[dep] ?? dep);
      for (const dep of dependsOn) { if (dep === id) throw new SubagentError("SELF_DEPENDENCY", "task cannot depend on itself"); if (!existingIds.has(dep) && !newIds.has(dep)) throw new SubagentError("UNKNOWN_DEPENDENCY", `unknown dependency: ${dep}`); const existingDep = existing.find((task) => task.id === dep); if (existingDep && TERMINAL_STATUSES.has(existingDep.status as TaskStatus)) throw new SubagentError("INVALID_DEPENDENCY_STATUS", `cannot depend on ${existingDep.status} task ${dep}`); }
      return { schemaVersion: SCHEMA_VERSION, id, title: spec.title.trim(), description: spec.description.trim(), status: "open", dependsOn, activeForm: spec.activeForm, notes: spec.notes, createdBy: input.createdBy ?? input.parentRunId, parentRunId: input.parentRunId, createdAt: now, updatedAt: now };
    });
    this.assertAcyclic([...existing, ...records]);
    for (const task of records) { this.writeTask(rootSessionId, task); this.appendTaskEvent(rootSessionId, task.parentRunId, task.id, "task.created", `Created ${task.id}: ${task.title}`); }
    const all = [...existing, ...records]; const views = records.map((task) => this.toView(task, all));
    return { tasks: views, aliasToId, newly_ready: views.filter((task) => task.readiness === "ready") };
  }); }

  updateTask(rootSessionId: string, taskId: string, input: TaskUpdateInput): TaskUpdateResult { return this.withLock(rootSessionId, "update", () => {
    const before = this.listTasksRaw(rootSessionId); const original = this.mustFind(before, taskId); const preReady = new Map(before.map((task) => [task.id, deriveTaskReadiness(task, before)]));
    const now = nowIso(); let next: TaskRecord = { ...original };
    if (input.status !== undefined) { if (!TASK_STATUSES.has(input.status)) throw new SubagentError("INVALID_TASK_STATUS", `invalid task status: ${input.status}`); next.status = input.status; }
    if (input.title !== undefined) next.title = input.title.trim();
    if (input.description !== undefined) next.description = input.description.trim();
    if (input.dependsOn !== undefined) { const deps = input.dependsOn.map((dep) => dep.trim()).filter(Boolean); if (deps.includes(taskId)) throw new SubagentError("SELF_DEPENDENCY", "task cannot depend on itself"); const known = new Set(before.map((task) => task.id)); for (const dep of deps) if (!known.has(dep)) throw new SubagentError("UNKNOWN_DEPENDENCY", `unknown dependency: ${dep}`); next.dependsOn = [...new Set(deps)]; }
    if (input.notes !== undefined) next.notes = input.notes;
    next.notes = appendNotes(next.notes, input.appendNotes);
    if (Object.hasOwn(input, "activeForm")) next.activeForm = input.activeForm === null ? undefined : input.activeForm;
    next.lastAttemptRunIds = uniqueAppend(next.lastAttemptRunIds, input.addAttemptRunIds);
    next.receiptPaths = uniqueAppend(next.receiptPaths, input.addReceiptPaths);
    next.artifactPaths = uniqueAppend(next.artifactPaths, input.addArtifactPaths);
    next.evidence = uniqueAppend(next.evidence, input.addEvidence);
    next.updatedAt = now;
    const candidateAll = before.map((task) => task.id === taskId ? next : task);
    this.assertAcyclic(candidateAll);
    const downstreamIds = new Set(this.downstreamOf(taskId, candidateAll).map((task) => task.id));
    const affectedIds = new Set<string>();
    let simulatedAll = candidateAll;
    while (true) {
      const newlyAffected = simulatedAll.filter((task) => downstreamIds.has(task.id) && !affectedIds.has(task.id) && ["active", "done"].includes(task.status) && unresolvedDependencyIds(task, simulatedAll).length > 0);
      if (!newlyAffected.length) break;
      for (const task of newlyAffected) affectedIds.add(task.id);
      simulatedAll = simulatedAll.map((task) => affectedIds.has(task.id) ? { ...task, status: "open" as const, updatedAt: now } : task);
    }
    if (affectedIds.size && !input.force) throw new SubagentError("TASK_UPDATE_INVALIDATES_DEPENDENTS", "task update would invalidate active/done dependents", { affected: [...affectedIds] });
    const finalAll = input.force ? simulatedAll : candidateAll;
    const invalidated = finalAll.filter((task) => affectedIds.has(task.id));
    const changed = JSON.stringify(original) !== JSON.stringify(next) || invalidated.length > 0;
    if (changed) {
      for (const task of finalAll) {
        const prev = before.find((item) => item.id === task.id);
        if (!prev || JSON.stringify(prev) === JSON.stringify(task)) continue;
        this.writeTask(rootSessionId, task);
        this.appendTaskEvent(rootSessionId, task.parentRunId, task.id, task.status === "done" ? "task.done" : task.status === "failed" ? "task.failed" : task.status === "cancelled" ? "task.cancelled" : invalidated.some((item) => item.id === task.id) ? "task.invalidated" : "task.updated", `Updated ${task.id}`, { actor: input.actor });
      }
    }
    const views = this.toViews(finalAll); const updated = views.find((task) => task.id === taskId)!;
    const newly_ready = views.filter((task) => preReady.get(task.id) !== "ready" && task.readiness === "ready");
    return { task: updated, changed, newly_ready, ...(invalidated.length ? { invalidated: invalidated.map((task) => this.toView(task, finalAll)) } : {}) };
  }); }

  cancelTask(rootSessionId: string, taskId: string, input: { actor?: string; reason: string }): TaskRecord { return this.updateTask(rootSessionId, taskId, { actor: input.actor, status: "cancelled", appendNotes: input.reason }).task; }
  clearTasks(rootSessionId: string, input: { reason: string; actor?: string }): { count: number; affectedIds: string[] } { return this.withLock(rootSessionId, "clear", () => { const all = this.listTasksRaw(rootSessionId); const affected = all.filter((task) => task.status !== "done" && task.status !== "cancelled"); const now = nowIso(); for (const task of affected) { const updated = { ...task, status: "cancelled" as const, notes: appendNotes(task.notes, input.reason), updatedAt: now }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, task.id, "task.cancelled", input.reason, { actor: input.actor }); } return { count: affected.length, affectedIds: affected.map((task) => task.id) }; }); }

  claimTask(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_OWNERSHIP_REMOVED", "task-owned child lifecycle was removed; start subagents directly and update milestones with task_update"); }
  releaseClaim(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_OWNERSHIP_REMOVED", "task-owned child lifecycle was removed; use normal subagent controls"); }
  reconcileOwnedRun(..._args: unknown[]): TaskRecord | undefined { return undefined; }
  submitResult(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_CHILD_TOOLS_REMOVED", "task_submit_result was removed; children report normally and parents attach evidence with task_update"); }
  updateProgress(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_CHILD_TOOLS_REMOVED", "task_update_progress was removed; children emit subagent_event and parents update milestones with task_update"); }
  reportBlocked(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_CHILD_TOOLS_REMOVED", "task_report_blocked was removed; children use subagent_event type=blocked"); }
  acceptResult(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_ACCEPT_REMOVED", "task_accept_result was removed; use task_update with status=done after reviewing normal subagent results"); }
  reopenTask(..._args: unknown[]): TaskRecord { throw new SubagentError("TASK_REOPEN_REMOVED", "task_reopen was removed; use task_update with status=open and force when invalidating dependents"); }
  failTask(rootSessionId: string, taskId: string, input: { actor?: string; reason: string }): TaskRecord { return this.updateTask(rootSessionId, taskId, { actor: input.actor, status: "failed", appendNotes: input.reason }).task; }
  updateOwnerDisplayName(rootSessionId: string, taskId: string, _displayName: string): TaskRecord { return this.readTask(rootSessionId, taskId); }

  appendEvent(rootSessionId: string, event: TaskEvent): void { appendJsonl(this.pathsFor(rootSessionId).eventsPath, event); }
  readEvents(rootSessionId: string): TaskEvent[];
  readEvents(rootSessionId: string, cursor: WaitCursor): { records: TaskEvent[]; cursor: WaitCursor };
  readEvents(rootSessionId: string, cursor?: WaitCursor): TaskEvent[] | { records: TaskEvent[]; cursor: WaitCursor } { const result = readJsonl<TaskEvent>(this.pathsFor(rootSessionId).eventsPath, { offset: cursor?.eventOffset ?? 0 }); if (!cursor) return result.records; return { records: result.records, cursor: { eventOffset: result.nextOffset, lastEventId: result.lastId ?? cursor.lastEventId } }; }

  private toView(task: TaskRecord, all: TaskRecord[]): TaskView { return { ...task, readiness: deriveTaskReadiness(task, all), blockedBy: unresolvedDependencyIds(task, all) }; }
  private toViews(tasks: TaskRecord[]): TaskView[] { return tasks.map((task) => this.toView(task, tasks)); }
  private readTaskRaw(rootSessionId: string, taskId: string): TaskRecord { const path = join(this.pathsFor(rootSessionId).tasksDir, `${safeSegment(taskId)}.json`); const task = readTaskFileCached(path); if (!task) throw new SubagentError("TASK_NOT_FOUND", `task not found: ${taskId}`); return task; }
  private listTasksRaw(rootSessionId: string): TaskRecord[] { const paths = this.pathsFor(rootSessionId); mkdirSync(paths.tasksDir, { recursive: true }); return readdirSync(paths.tasksDir).filter((name) => name.endsWith(".json")).flatMap((name) => readTaskFileCached(join(paths.tasksDir, name)) ?? []).sort((a, b) => a.id.localeCompare(b.id)); }
  private writeTask(rootSessionId: string, task: TaskRecord): void { const path = join(this.pathsFor(rootSessionId).tasksDir, `${task.id}.json`); atomicWriteJson(path, task); writeTaskFileCache(path, task); }
  private nextTaskId(rootSessionId: string): string { const p = this.pathsFor(rootSessionId); mkdirSync(p.taskRoot, { recursive: true }); const current = existsSync(p.highwatermarkPath) ? Number(readFileSync(p.highwatermarkPath, "utf8")) : 0; const next = Number.isFinite(current) ? current + 1 : 1; writeFileSync(p.highwatermarkPath, String(next), "utf8"); return `T-${String(next).padStart(4, "0")}`; }
  private nextTaskEventSequence(rootSessionId: string): number { const p = this.pathsFor(rootSessionId); mkdirSync(p.taskRoot, { recursive: true }); const hwm = existsSync(p.eventHighwatermarkPath) ? Number(readFileSync(p.eventHighwatermarkPath, "utf8")) : undefined; const current = hwm !== undefined && Number.isSafeInteger(hwm) && hwm >= 1 ? hwm : Math.max(0, ...readJsonl<TaskEvent>(p.eventsPath).records.map((event) => Number.isSafeInteger(event.sequence) ? event.sequence : 0)); const next = current + 1; atomicWriteJson(p.eventHighwatermarkPath, next); return next; }
  private mustFind(tasks: TaskRecord[], taskId: string): TaskRecord { const task = tasks.find((item) => item.id === taskId); if (!task) throw new SubagentError("TASK_NOT_FOUND", `task not found: ${taskId}`); return task; }
  private assertAcyclic(tasks: TaskRecord[]): void { const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(tasks.map((task) => [task.id, task])); const visit = (id: string) => { if (visiting.has(id)) throw new SubagentError("CIRCULAR_DEPENDENCY_DETECTED", "task dependencies contain a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep); visiting.delete(id); visited.add(id); }; for (const task of tasks) visit(task.id); }
  private downstreamOf(taskId: string, tasks: TaskRecord[]): TaskRecord[] { const affected = new Set<string>(); const queue = [taskId]; while (queue.length) { const current = queue.shift()!; for (const candidate of tasks) { if (!candidate.dependsOn.includes(current) || affected.has(candidate.id)) continue; affected.add(candidate.id); queue.push(candidate.id); } } return tasks.filter((task) => affected.has(task.id)); }
  private appendTaskEvent(rootSessionId: string, parentRunId: string, taskId: string, type: TaskEventType, summary: string, options: { actor?: string; runId?: string; wake?: boolean; data?: Record<string, unknown> } = {}): void { const sequence = this.nextTaskEventSequence(rootSessionId); this.appendEvent(rootSessionId, { schemaVersion: SCHEMA_VERSION, eventId: eventIdForSequence(sequence), sequence, rootSessionId, parentRunId, taskId, type, summary, actor: options.actor, runId: options.runId, wake: false, data: options.data, createdAt: nowIso() }); }
  private withLock<T>(rootSessionId: string, command: string, fn: () => T): T { const paths = this.pathsFor(rootSessionId); mkdirSync(paths.taskRoot, { recursive: true }); const started = Date.now(); while (true) { try { mkdirSync(paths.lockDir); writeFileSync(join(paths.lockDir, "held.json"), JSON.stringify({ pid: process.pid, host: hostname(), ownerId: process.pid, command, createdAt: nowIso() })); break; } catch { if (this.breakStaleLock(paths.lockDir)) continue; if (Date.now() - started > 5_000) throw new SubagentError("TASK_LOCK_CONTENTION", "timed out acquiring task list lock"); sleep(75); } } try { return fn(); } finally { this.releaseLock(paths.lockDir); } }
  private releaseLock(lockDir: string): void { const path = join(lockDir, "held.json"); try { const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; host?: string }; if (held.host === hostname() && held.pid === process.pid) rmSync(lockDir, { recursive: true, force: true }); } catch { /* do not delete a lock we cannot prove we own */ } }
  private breakStaleLock(lockDir: string): boolean { const path = join(lockDir, "held.json"); try { const dirStat = statSync(lockDir); if (!existsSync(path)) { if (Date.now() - dirStat.mtimeMs > LOCK_TTL_MS) { rmSync(lockDir, { recursive: true, force: true }); return true; } return false; } const stat = statSync(path); if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) { rmSync(lockDir, { recursive: true, force: true }); return true; } const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; host?: string }; if (held.host === hostname() && held.pid) { try { process.kill(held.pid, 0); } catch { rmSync(lockDir, { recursive: true, force: true }); return true; } } } catch { try { const dirStat = statSync(lockDir); if (Date.now() - dirStat.mtimeMs <= LOCK_TTL_MS) return false; } catch { /* no usable lock dir */ } if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true }); return true; } return false; }
}

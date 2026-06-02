import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve, relative } from "node:path";
import { defaultRunRoot } from "./config.js";
import { SubagentError } from "./errors.js";
import { eventIdForSequence } from "./ids.js";
import { appendJsonl, atomicWriteJson, readJsonl } from "./jsonl.js";
import type { RunStore } from "./runStore.js";
import { isTerminalRunState } from "./schemas.js";
import { deriveTaskState } from "./taskState.js";
import { nowIso } from "./time.js";
import { SCHEMA_VERSION, type RunState, type TaskEvent, type TaskEventType, type TaskOwner, type TaskRecord, type TaskResultReceipt, type TerminalRunState, type WaitCursor } from "./types.js";

export interface TaskPaths { taskRoot: string; highwatermarkPath: string; eventHighwatermarkPath: string; eventsPath: string; lockDir: string; tasksDir: string; receiptsDir: string; artifactsDir: string }
export interface CreateTaskSpec { alias?: string; title: string; description: string; dependsOn?: string[]; activeForm?: string }
export interface CreateTasksInput { parentRunId: string; createdBy?: string; tasks: CreateTaskSpec[] }
export interface CreateTasksResult { tasks: TaskRecord[]; aliasToId: Record<string, string> }
export interface SubmitTaskResultInput { runId: string; taskToken: string; summary: string; receipt?: Record<string, unknown>; artifactPaths?: string[]; evidence?: string[]; commandsRun?: string[]; notes?: string }
export interface UpdateTaskProgressInput { runId: string; taskToken: string; summary?: string; activeForm?: string }
export interface ReportTaskBlockedInput { runId: string; taskToken: string; summary: string; notes?: string }
export interface AcceptTaskResultInput { actor?: string; summary?: string }
export interface ReopenTaskInput { actor?: string; reason: string; activeForm?: string; force?: boolean }
export interface FailTaskInput { actor?: string; reason: string; runId?: string }
export interface CancelTaskInput { actor?: string; reason: string }
export interface ReleaseTaskClaimInput { runId: string; reason?: string }
export interface ReconcileOwnedRunInput { runId: string; state: TerminalRunState; summary?: string; actor?: string }
type ReconcileMode = boolean | "nonblocking";

const LOCK_TTL_MS = 30_000;
const RECEIPT_MAX_BYTES = 32 * 1024;

interface TaskFileState {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface MemoryTaskFileCacheEntry {
  state: TaskFileState;
  task: TaskRecord;
}

const memoryTaskFileCaches = new Map<string, MemoryTaskFileCacheEntry>();

function statTaskFile(path: string): TaskFileState {
  if (!existsSync(path)) return { path, exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0 };
  const stat = statSync(path);
  return { path, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

function taskFileStateUnchanged(previous: TaskFileState, current: TaskFileState): boolean {
  return previous.path === current.path && previous.exists === current.exists && previous.size === current.size && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs && previous.dev === current.dev && previous.ino === current.ino;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneJsonValue(item)])) as T;
  }
  return value;
}

function cloneTask(task: TaskRecord): TaskRecord {
  return cloneJsonValue(task);
}

function readTaskFileCached(path: string): TaskRecord | undefined {
  const current = statTaskFile(path);
  const cached = memoryTaskFileCaches.get(path);
  if (cached && taskFileStateUnchanged(cached.state, current)) return cloneTask(cached.task);
  if (!current.exists) {
    memoryTaskFileCaches.delete(path);
    return undefined;
  }
  try {
    const task = JSON.parse(readFileSync(path, "utf8")) as TaskRecord;
    memoryTaskFileCaches.set(path, { state: current, task: cloneTask(task) });
    return cloneTask(task);
  } catch (error) {
    memoryTaskFileCaches.delete(path);
    throw error;
  }
}

function writeTaskFileCache(path: string, task: TaskRecord): void {
  try {
    memoryTaskFileCaches.set(path, { state: statTaskFile(path), task: cloneTask(task) });
  } catch {
    memoryTaskFileCaches.delete(path);
  }
}

export function newTaskToken(): string { return randomBytes(24).toString("base64url"); }
export function hashTaskToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function taskTokenMatches(token: string, hash: string): boolean { return hashTaskToken(token) === hash; }

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function safeSegment(id: string): string { if (!/^T-\d{4,}$/.test(id)) throw new SubagentError("INVALID_TASK_ID", `invalid task id: ${id}`); return id; }
function ensureUnder(path: string, roots: string[]): void { const p = resolve(path); if (!roots.some((root) => { const rel = relative(resolve(root), p); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); })) throw new SubagentError("PATH_OUTSIDE_ALLOWED_ROOTS", `path is outside allowed roots: ${path}`); }

export class TaskStore {
  readonly cwd: string;
  readonly runRoot: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(options: { cwd?: string; runRoot?: string; env?: NodeJS.ProcessEnv } | RunStore = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.env = options.env ?? process.env;
    this.runRoot = defaultRunRoot(this.cwd, options.runRoot, this.env);
  }

  pathsFor(rootSessionId: string): TaskPaths {
    const taskRoot = join(resolve(this.runRoot, ".."), "session-tasks", rootSessionId);
    return { taskRoot, highwatermarkPath: join(taskRoot, "highwatermark"), eventHighwatermarkPath: join(taskRoot, "event-highwatermark"), eventsPath: join(taskRoot, "events.jsonl"), lockDir: join(taskRoot, "lock"), tasksDir: join(taskRoot, "tasks"), receiptsDir: join(taskRoot, "receipts"), artifactsDir: join(taskRoot, "artifacts") };
  }

  listTasks(rootSessionId: string, options: { reconcile?: ReconcileMode } = {}): TaskRecord[] {
    const tasks = this.listTasksRaw(rootSessionId);
    if (options.reconcile === false) return tasks;
    let changed = false;
    for (const task of tasks) changed = this.lazyReconcile(rootSessionId, task, options.reconcile) || changed;
    return changed ? this.listTasksRaw(rootSessionId) : tasks;
  }

  readTask(rootSessionId: string, taskId: string): TaskRecord { const task = this.readTaskRaw(rootSessionId, taskId); return this.lazyReconcile(rootSessionId, task) ? this.readTaskRaw(rootSessionId, taskId) : task; }

  createTasks(rootSessionId: string, input: CreateTasksInput): CreateTasksResult { return this.withLock(rootSessionId, "create", () => {
    if (!input.tasks.length) throw new SubagentError("NO_TASKS", "tasks must not be empty");
    const aliases = input.tasks.flatMap((task) => task.alias ? [task.alias] : []); if (new Set(aliases).size !== aliases.length) throw new SubagentError("DUPLICATE_TASK_ALIAS", "task aliases must be unique");
    const existing = this.listTasksRaw(rootSessionId); const existingIds = new Set(existing.map((task) => task.id));
    const now = nowIso(); const aliasToId: Record<string, string> = {}; const allocated = input.tasks.map((task) => { const id = this.nextTaskId(rootSessionId); if (task.alias) aliasToId[task.alias] = id; return { spec: task, id }; });
    const newIds = new Set(allocated.map((item) => item.id));
    const records = allocated.map(({ spec, id }) => {
      const dependsOn = (spec.dependsOn ?? []).map((dep) => aliasToId[dep] ?? dep);
      for (const dep of dependsOn) { if (dep === id) throw new SubagentError("SELF_DEPENDENCY", "task cannot depend on itself"); if (!existingIds.has(dep) && !newIds.has(dep)) throw new SubagentError("UNKNOWN_DEPENDENCY", `unknown dependency: ${dep}`); const existingDep = existing.find((task) => task.id === dep); if (existingDep && ["failed", "cancelled"].includes(existingDep.status)) throw new SubagentError("INVALID_DEPENDENCY_STATUS", `cannot depend on ${existingDep.status} task ${dep}`); }
      return { schemaVersion: SCHEMA_VERSION, id, title: spec.title.trim(), description: spec.description.trim(), status: "pending" as const, dependsOn, activeForm: spec.activeForm, attempts: [], createdBy: input.createdBy ?? input.parentRunId, parentRunId: input.parentRunId, createdAt: now, updatedAt: now };
    });
    this.assertAcyclic([...existing, ...records]);
    for (const task of records) { this.writeTask(rootSessionId, task); this.appendTaskEvent(rootSessionId, task.parentRunId, task.id, "task.created", `Created ${task.id}: ${task.title}`, { wake: false }); }
    return { tasks: records, aliasToId };
  }); }

  claimTask(rootSessionId: string, taskId: string, owner: TaskOwner): TaskRecord { return this.withLock(rootSessionId, "claim", () => { const all = this.listTasksRaw(rootSessionId); const task = this.mustFind(all, taskId); if (deriveTaskState(task, all) !== "ready") throw new SubagentError("TASK_NOT_READY", `task ${taskId} is not ready`); const updated = { ...task, status: "running" as const, owner, attempts: [...task.attempts, { runId: owner.runId, agent: owner.agent, displayName: owner.displayName, startedAt: owner.assignedAt, status: "running" as const }], updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, updated.parentRunId, taskId, "task.claimed", `Claimed ${taskId}`, { runId: owner.runId }); return updated; }); }
  releaseClaim(rootSessionId: string, taskId: string, input: ReleaseTaskClaimInput): TaskRecord { return this.withLock(rootSessionId, "release", () => { const task = this.readTaskRaw(rootSessionId, taskId); if (task.owner?.runId !== input.runId) throw new SubagentError("TASK_OWNER_MISMATCH", "task owner mismatch"); const updated = { ...task, status: "pending" as const, owner: undefined, attempts: task.attempts.map((attempt) => attempt.runId === input.runId && !attempt.endedAt ? { ...attempt, endedAt: nowIso(), status: "cancelled" as const } : attempt), updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.released", input.reason ?? `Released ${taskId}`, { runId: input.runId }); return updated; }); }
  reconcileOwnedRun(rootSessionId: string, runId: string, input: ReconcileOwnedRunInput): TaskRecord | undefined { return this.withLock(rootSessionId, "reconcile", () => this.reconcileOwnedRunLocked(rootSessionId, runId, input)); }

  submitResult(rootSessionId: string, taskId: string, input: SubmitTaskResultInput): TaskRecord { return this.withLock(rootSessionId, "submit", () => { const task = this.readTaskRaw(rootSessionId, taskId); this.assertOwned(task, input.runId, input.taskToken); const summary = input.summary.trim(); if (!summary) throw new SubagentError("EMPTY_TASK_RESULT", "summary is required"); const paths = this.pathsFor(rootSessionId); const artifactPaths = input.artifactPaths?.map((p) => { ensureUnder(p, [paths.artifactsDir, this.cwd]); return p; }); let receiptPath: string | undefined; if (input.receipt) { const bytes = Buffer.byteLength(JSON.stringify(input.receipt), "utf8"); if (bytes > RECEIPT_MAX_BYTES) throw new SubagentError("TASK_RECEIPT_TOO_LARGE", "receipt exceeds 32KB"); receiptPath = join(paths.receiptsDir, `${taskId}-${input.runId}.json`); atomicWriteJson(receiptPath, { schemaVersion: SCHEMA_VERSION, taskId, runId: input.runId, submittedAt: nowIso(), receipt: input.receipt }); }
    const result: TaskResultReceipt = { state: "submitted", summary, receiptPath, artifactPaths, evidence: input.evidence, commandsRun: input.commandsRun, notes: input.notes, submittedAt: nowIso() }; const updated = { ...task, status: "result_ready" as const, result, attempts: task.attempts.map((attempt) => attempt.runId === input.runId && !attempt.endedAt ? { ...attempt, endedAt: result.submittedAt, status: "result_ready" as const } : attempt), updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.result_submitted", summary, { runId: input.runId, wake: true, data: { receiptPath } }); return updated; }); }
  updateProgress(rootSessionId: string, taskId: string, input: UpdateTaskProgressInput): TaskRecord { return this.withLock(rootSessionId, "progress", () => { const task = this.readTaskRaw(rootSessionId, taskId); this.assertOwned(task, input.runId, input.taskToken); const updated = { ...task, activeForm: input.activeForm ?? task.activeForm, updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.progress", input.summary ?? `Progress on ${taskId}`, { runId: input.runId }); return updated; }); }
  reportBlocked(rootSessionId: string, taskId: string, input: ReportTaskBlockedInput): TaskRecord { return this.withLock(rootSessionId, "blocked", () => { const task = this.readTaskRaw(rootSessionId, taskId); this.assertOwned(task, input.runId, input.taskToken); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.needs_input", input.summary, { runId: input.runId, wake: true, data: { notes: input.notes } }); return task; }); }
  acceptResult(rootSessionId: string, taskId: string, input: AcceptTaskResultInput): TaskRecord { return this.withLock(rootSessionId, "accept", () => { const task = this.readTaskRaw(rootSessionId, taskId); if (task.status !== "result_ready" || !task.result) throw new SubagentError("TASK_RESULT_NOT_READY", `task ${taskId} has no submitted result`); const updated = { ...task, status: "completed" as const, result: { ...task.result, state: "accepted" as const, acceptedAt: nowIso() }, updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.result_accepted", input.summary ?? `Accepted ${taskId}`, { actor: input.actor }); for (const dep of this.listTasksRaw(rootSessionId).filter((candidate) => candidate.dependsOn.includes(taskId) && deriveTaskState(candidate, this.listTasksRaw(rootSessionId)) === "ready")) this.appendTaskEvent(rootSessionId, dep.parentRunId, dep.id, "task.ready", `Task ready: ${dep.id}`, { wake: false }); return updated; }); }
  reopenTask(rootSessionId: string, taskId: string, input: ReopenTaskInput): TaskRecord { return this.withLock(rootSessionId, "reopen", () => { const task = this.readTaskRaw(rootSessionId, taskId); const all = this.listTasksRaw(rootSessionId); const affectedIds = new Set<string>(); const queue = [taskId]; while (queue.length) { const current = queue.shift()!; for (const candidate of all) { if (!candidate.dependsOn.includes(current) || affectedIds.has(candidate.id)) continue; affectedIds.add(candidate.id); queue.push(candidate.id); } } const affected = all.filter((candidate) => affectedIds.has(candidate.id) && ["running", "result_ready", "completed"].includes(candidate.status)); if (affected.length && !input.force) throw new SubagentError("REOPEN_HAS_AFFECTED_DEPENDENTS", "reopen would invalidate dependents", { affected: affected.map((item) => item.id) }); const now = nowIso(); if (input.force) { for (const dep of affected) { const depUpdated = { ...dep, status: "pending" as const, owner: undefined, result: dep.result ? { ...dep.result, state: "superseded" as const, rejectedAt: now } : undefined, attempts: dep.attempts.map((attempt) => !attempt.endedAt ? { ...attempt, endedAt: now, status: "cancelled" as const } : attempt), updatedAt: now }; this.writeTask(rootSessionId, depUpdated); this.appendTaskEvent(rootSessionId, dep.parentRunId, dep.id, "task.reopened", `Reopened because dependency ${taskId} was reopened`, { actor: input.actor, data: { invalidatedBy: taskId } }); } } const updated = { ...task, status: "pending" as const, owner: undefined, activeForm: input.activeForm ?? task.activeForm, result: task.result ? { ...task.result, state: "rejected" as const, rejectedAt: now } : undefined, updatedAt: now }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.reopened", input.reason, { actor: input.actor, data: { affected: affected.map((item) => item.id) } }); return updated; }); }
  failTask(rootSessionId: string, taskId: string, input: FailTaskInput): TaskRecord { return this.withLock(rootSessionId, "fail", () => { const task = this.readTaskRaw(rootSessionId, taskId); const updated = { ...task, status: "failed" as const, updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.failed", input.reason, { actor: input.actor, runId: input.runId, wake: true }); return updated; }); }
  cancelTask(rootSessionId: string, taskId: string, input: CancelTaskInput): TaskRecord { return this.withLock(rootSessionId, "cancel", () => { const task = this.readTaskRaw(rootSessionId, taskId); const updated = { ...task, status: "cancelled" as const, updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); this.appendTaskEvent(rootSessionId, task.parentRunId, taskId, "task.cancelled", input.reason, { actor: input.actor }); return updated; }); }
  clearTasks(rootSessionId: string, input: { reason: string; actor?: string }): { count: number; affectedIds: string[] } {
    return this.withLock(rootSessionId, "clear", () => {
      const all = this.listTasksRaw(rootSessionId);
      const affected: TaskRecord[] = [];
      const now = nowIso();
      for (const task of all) {
        if (task.status !== "completed" && task.status !== "cancelled") {
          const updated = {
            ...task,
            status: "cancelled" as const,
            attempts: task.attempts.map((attempt) => !attempt.endedAt ? { ...attempt, endedAt: now, status: "cancelled" as const } : attempt),
            updatedAt: now,
          };
          this.writeTask(rootSessionId, updated);
          this.appendTaskEvent(rootSessionId, task.parentRunId, task.id, "task.cancelled", input.reason, { actor: input.actor });
          affected.push(updated);
        }
      }
      return {
        count: affected.length,
        affectedIds: affected.map((t) => t.id),
      };
    });
  }
  updateOwnerDisplayName(rootSessionId: string, taskId: string, displayName: string): TaskRecord { return this.withLock(rootSessionId, "updateDisplayName", () => { const task = this.readTaskRaw(rootSessionId, taskId); if (task.owner) { task.owner.displayName = displayName; } task.attempts = task.attempts.map((attempt) => attempt.runId === task.owner?.runId ? { ...attempt, displayName } : attempt); task.updatedAt = nowIso(); this.writeTask(rootSessionId, task); return task; }); }
  appendEvent(rootSessionId: string, event: TaskEvent): void { appendJsonl(this.pathsFor(rootSessionId).eventsPath, event); }
  readEvents(rootSessionId: string): TaskEvent[];
  readEvents(rootSessionId: string, cursor: WaitCursor): { records: TaskEvent[]; cursor: WaitCursor };
  readEvents(rootSessionId: string, cursor?: WaitCursor): TaskEvent[] | { records: TaskEvent[]; cursor: WaitCursor } {
    const result = readJsonl<TaskEvent>(this.pathsFor(rootSessionId).eventsPath, { offset: cursor?.eventOffset ?? 0 });
    if (!cursor) return result.records;
    return { records: result.records, cursor: { eventOffset: result.nextOffset, lastEventId: result.lastId ?? cursor.lastEventId } };
  }

  private readTaskRaw(rootSessionId: string, taskId: string): TaskRecord { const path = join(this.pathsFor(rootSessionId).tasksDir, `${safeSegment(taskId)}.json`); const task = readTaskFileCached(path); if (!task) throw new SubagentError("TASK_NOT_FOUND", `task not found: ${taskId}`); return task; }
  private listTasksRaw(rootSessionId: string): TaskRecord[] { const paths = this.pathsFor(rootSessionId); mkdirSync(paths.tasksDir, { recursive: true }); return readdirSync(paths.tasksDir).filter((name) => name.endsWith(".json")).flatMap((name) => readTaskFileCached(join(paths.tasksDir, name)) ?? []).sort((a, b) => a.id.localeCompare(b.id)); }
  private writeTask(rootSessionId: string, task: TaskRecord): void { const path = join(this.pathsFor(rootSessionId).tasksDir, `${task.id}.json`); atomicWriteJson(path, task); writeTaskFileCache(path, task); }
  private nextTaskId(rootSessionId: string): string { const p = this.pathsFor(rootSessionId); mkdirSync(p.taskRoot, { recursive: true }); const current = existsSync(p.highwatermarkPath) ? Number(readFileSync(p.highwatermarkPath, "utf8")) : 0; const next = Number.isFinite(current) ? current + 1 : 1; writeFileSync(p.highwatermarkPath, String(next), "utf8"); return `T-${String(next).padStart(4, "0")}`; }
  private nextTaskEventSequence(rootSessionId: string): number {
    const p = this.pathsFor(rootSessionId);
    mkdirSync(p.taskRoot, { recursive: true });
    const hwm = existsSync(p.eventHighwatermarkPath) ? Number(readFileSync(p.eventHighwatermarkPath, "utf8")) : undefined;
    const current: number = hwm !== undefined && Number.isSafeInteger(hwm) && hwm >= 1
      ? hwm
      : Math.max(0, ...readJsonl<TaskEvent>(p.eventsPath).records.map((event) => Number.isSafeInteger(event.sequence) ? event.sequence : 0));
    const next = current + 1;
    atomicWriteJson(p.eventHighwatermarkPath, next);
    return next;
  }
  private mustFind(tasks: TaskRecord[], taskId: string): TaskRecord { const task = tasks.find((item) => item.id === taskId); if (!task) throw new SubagentError("TASK_NOT_FOUND", `task not found: ${taskId}`); return task; }
  private assertAcyclic(tasks: TaskRecord[]): void { const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(tasks.map((task) => [task.id, task])); const visit = (id: string) => { if (visiting.has(id)) throw new SubagentError("CIRCULAR_DEPENDENCY_DETECTED", "task dependencies contain a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep); visiting.delete(id); visited.add(id); }; for (const task of tasks) visit(task.id); }
  private assertOwned(task: TaskRecord, runId: string, token: string): void { if (task.status !== "running" || !task.owner) throw new SubagentError("TASK_NOT_RUNNING", `task ${task.id} is not running`); if (task.owner.runId !== runId || !taskTokenMatches(token, task.owner.tokenHash)) throw new SubagentError("TASK_OWNER_MISMATCH", "task owner identity did not match"); }
  private appendTaskEvent(rootSessionId: string, parentRunId: string, taskId: string, type: TaskEventType, summary: string, options: { actor?: string; runId?: string; wake?: boolean; data?: Record<string, unknown> } = {}): void { const sequence = this.nextTaskEventSequence(rootSessionId); this.appendEvent(rootSessionId, { schemaVersion: SCHEMA_VERSION, eventId: eventIdForSequence(sequence), sequence, rootSessionId, parentRunId, taskId, type, summary, actor: options.actor, runId: options.runId, wake: options.wake, data: options.data, createdAt: nowIso() }); }
  private reconcileOwnedRunLocked(rootSessionId: string, runId: string, input: ReconcileOwnedRunInput): TaskRecord | undefined { const task = this.listTasksRaw(rootSessionId).find((item) => item.owner?.runId === runId && item.status === "running"); if (!task) return undefined; const attempt = task.attempts.find((item) => item.runId === runId); if (attempt?.endedAt) return undefined; const terminal = input.state; const failed = terminal !== "completed"; const updated = { ...task, status: failed ? "failed" as const : "running" as const, attempts: task.attempts.map((item) => item.runId === runId && !item.endedAt ? { ...item, endedAt: nowIso(), status: failed ? "failed" as const : item.status } : item), updatedAt: nowIso() }; this.writeTask(rootSessionId, updated); const type: TaskEventType = failed ? "task.failed" : "task.needs_input"; this.appendTaskEvent(rootSessionId, task.parentRunId, task.id, type, failed ? `Task owner run ended ${terminal}` : `Owner run completed without task_submit_result`, { runId, wake: true, data: { runState: terminal, summary: input.summary } }); return updated; }
  private lazyReconcile(rootSessionId: string, task: TaskRecord, mode: ReconcileMode = true): boolean { if (!task.owner || task.status !== "running") return false; const attempt = task.attempts.find((item) => item.runId === task.owner?.runId); if (attempt?.endedAt) return false; try { const statusPath = join(this.runRoot, task.owner.runId, "status.json"); if (!existsSync(statusPath)) return false; const status = JSON.parse(readFileSync(statusPath, "utf8")) as { state?: string; summary?: string }; if (status.state && isTerminalRunState(status.state as RunState)) { if (mode === "nonblocking") { const result = this.tryWithLock(rootSessionId, "reconcile", () => this.reconcileOwnedRunLocked(rootSessionId, task.owner!.runId, { runId: task.owner!.runId, state: status.state as TerminalRunState, summary: status.summary })); return result.acquired ? Boolean(result.value) : false; } return Boolean(this.reconcileOwnedRun(rootSessionId, task.owner.runId, { runId: task.owner.runId, state: status.state as TerminalRunState, summary: status.summary })); } } catch { /* best effort */ } return false; }
  private tryWithLock<T>(rootSessionId: string, command: string, fn: () => T): { acquired: true; value: T } | { acquired: false } { const paths = this.pathsFor(rootSessionId); mkdirSync(paths.taskRoot, { recursive: true }); for (let attempt = 0; attempt < 2; attempt += 1) { let acquired = false; try { mkdirSync(paths.lockDir); writeFileSync(join(paths.lockDir, "held.json"), JSON.stringify({ pid: process.pid, host: hostname(), ownerId: process.pid, command, createdAt: nowIso() })); acquired = true; } catch { if (attempt === 0 && this.breakStaleLock(paths.lockDir)) continue; return { acquired: false }; } if (acquired) { try { return { acquired: true, value: fn() }; } finally { this.releaseLock(paths.lockDir); } } } return { acquired: false }; }
  private withLock<T>(rootSessionId: string, command: string, fn: () => T): T { const paths = this.pathsFor(rootSessionId); mkdirSync(paths.taskRoot, { recursive: true }); const started = Date.now(); while (true) { try { mkdirSync(paths.lockDir); writeFileSync(join(paths.lockDir, "held.json"), JSON.stringify({ pid: process.pid, host: hostname(), ownerId: process.pid, command, createdAt: nowIso() })); break; } catch { if (this.breakStaleLock(paths.lockDir)) continue; if (Date.now() - started > 5_000) throw new SubagentError("TASK_LOCK_CONTENTION", "timed out acquiring task list lock"); sleep(75); } } try { return fn(); } finally { this.releaseLock(paths.lockDir); } }
  private releaseLock(lockDir: string): void { const path = join(lockDir, "held.json"); try { const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; host?: string }; if (held.host === hostname() && held.pid === process.pid) rmSync(lockDir, { recursive: true, force: true }); } catch { /* do not delete a lock we cannot prove we own */ } }
  private breakStaleLock(lockDir: string): boolean { const path = join(lockDir, "held.json"); try { const dirStat = statSync(lockDir); if (!existsSync(path)) { if (Date.now() - dirStat.mtimeMs > LOCK_TTL_MS) { rmSync(lockDir, { recursive: true, force: true }); return true; } return false; } const stat = statSync(path); if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) { rmSync(lockDir, { recursive: true, force: true }); return true; } const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; host?: string }; if (held.host === hostname() && held.pid) { try { process.kill(held.pid, 0); } catch { rmSync(lockDir, { recursive: true, force: true }); return true; } } } catch { try { const dirStat = statSync(lockDir); if (Date.now() - dirStat.mtimeMs <= LOCK_TTL_MS) return false; } catch { /* no usable lock dir */ } if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true }); return true; } return false; }
}

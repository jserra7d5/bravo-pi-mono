import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentMetadata, AgentStatus } from "./types.js";
import { dataRoot, projectSlug } from "./paths.js";
import { assessResultDeliverable } from "./result.js";

export type TangoEvent = {
  schemaVersion: 1;
  eventId: string;
  type: "agent.status";
  time: string;
  agent: string;
  role?: string;
  mode?: AgentMetadata["mode"];
  status: AgentStatus;
  previousStatus?: AgentStatus;
  summary?: string;
  needs?: string;
  cwd: string;
  projectSlug: string;
  runDir: string;
  runId?: string;
  parentRunId?: string;
  parentRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  resultFinalizedAt?: string;
  resultReady?: boolean;
  resultIssue?: string;
  resultWarning?: string;
};

export type EventReadState = { offset: number; carry: string };

export function eventsPath(): string {
  return join(dataRoot(), "events.jsonl");
}

export function appendStatusEvent(meta: AgentMetadata, previousStatus?: AgentStatus): TangoEvent {
  const assessment = meta.status === "done" ? assessResultDeliverable(meta) : undefined;
  const event: TangoEvent = {
    schemaVersion: 1,
    eventId: `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "agent.status",
    time: new Date().toISOString(),
    agent: meta.name,
    role: meta.role,
    mode: meta.mode,
    status: meta.status,
    previousStatus,
    summary: meta.summary,
    needs: meta.needs,
    cwd: meta.cwd,
    projectSlug: projectSlug(meta.cwd),
    runDir: meta.runDir,
    runId: meta.runId,
    parentRunId: meta.parentRunId,
    parentRunDir: meta.parentRunDir,
    rootSessionId: meta.rootSessionId,
    workstreamId: meta.workstreamId,
    resultFinalizedAt: meta.resultFinalizedAt,
    resultReady: assessment?.resultReady,
    resultIssue: assessment?.resultIssue,
    resultWarning: assessment?.resultWarning,
  };
  appendEvent(event);
  return event;
}

export function appendEvent(event: TangoEvent): void {
  const path = eventsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a" });
}

export function initialEventOffset(fromStart: boolean): number {
  const path = eventsPath();
  if (fromStart || !existsSync(path)) return 0;
  return statSync(path).size;
}

export function readRecentEvents(maxEvents = 1000, maxBytes = 1024 * 1024): { events: TangoEvent[]; errors: string[]; truncated: boolean } {
  const path = eventsPath();
  if (!existsSync(path)) return { events: [], errors: [], truncated: false };
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(-maxEvents);
    const events: TangoEvent[] = [];
    const errors: string[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line) as TangoEvent); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    return { events, errors, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

export function readEvents(state: EventReadState): { events: TangoEvent[]; state: EventReadState; errors: string[] } {
  const path = eventsPath();
  if (!existsSync(path)) return { events: [], state: { offset: 0, carry: "" }, errors: [] };
  const size = statSync(path).size;
  let offset = state.offset > size ? 0 : state.offset;
  if (offset === size) return { events: [], state: { ...state, offset }, errors: [] };
  const fd = openSync(path, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    offset += bytesRead;
    const text = state.carry + buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/);
    const carry = text.endsWith("\n") || text.endsWith("\r") ? "" : (lines.pop() ?? "");
    const events: TangoEvent[] = [];
    const errors: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as TangoEvent); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    return { events, state: { offset, carry }, errors };
  } finally {
    closeSync(fd);
  }
}

export function eventMatchesCwd(event: TangoEvent, cwd: string): boolean {
  return event.projectSlug === projectSlug(resolve(cwd));
}

export function eventMatchesLineage(event: TangoEvent, cwd: string): boolean {
  const envRunId = process.env.TANGO_RUN_ID;
  const envRunDir = process.env.TANGO_RUN_DIR;
  const envRoot = process.env.TANGO_ROOT_SESSION_ID;
  const envWs = process.env.TANGO_WORKSTREAM_ID;

  const currentHasLineage = !!(envRunId || envRunDir || envRoot || envWs);
  if (currentHasLineage) {
    // High-confidence: direct run lineage (self or child)
    if (envRunId) {
      if (event.runId === envRunId || event.parentRunId === envRunId) return true;
    }
    if (envRunDir) {
      const normEnvRunDir = resolve(envRunDir);
      if (resolve(event.runDir) === normEnvRunDir || (event.parentRunDir && resolve(event.parentRunDir) === normEnvRunDir)) return true;
    }
    if (eventIsDescendantOfCurrentRun(event, envRunId, envRunDir)) return true;

    // Lower-confidence root/workstream (conjunctive if both present)
    if (envRoot || envWs) {
      const rootMatch = envRoot ? event.rootSessionId === envRoot : true;
      const wsMatch = envWs ? event.workstreamId === envWs : true;
      if (rootMatch && wsMatch) return true;
    }

    // Explicit lineage exists but event does not match: do NOT fall back to cwd
    return false;
  }

  // No usable lineage on current side: fallback to cwd
  return eventMatchesCwd(event, cwd);
}

function eventIsDescendantOfCurrentRun(event: TangoEvent, envRunId?: string, envRunDir?: string): boolean {
  if (!envRunId && !envRunDir) return false;
  const all = listEventMetadata();
  const byRunId = new Map<string, AgentMetadata>();
  const byRunDir = new Map<string, AgentMetadata>();
  for (const meta of all) {
    if (meta.runId) byRunId.set(meta.runId, meta);
    byRunDir.set(resolve(meta.runDir), meta);
  }
  let current = event.runId ? byRunId.get(event.runId) : undefined;
  if (!current && event.runDir) current = byRunDir.get(resolve(event.runDir));
  const targetRunDir = envRunDir ? resolve(envRunDir) : undefined;
  const visited = new Set<string>();
  while (current) {
    const key = current.runId ?? resolve(current.runDir);
    if (visited.has(key)) return false;
    visited.add(key);
    const parentRunId = current.parentRunId;
    const parentRunDir = current.parentRunDir;
    if (envRunId && parentRunId === envRunId) return true;
    if (targetRunDir && parentRunDir && resolve(parentRunDir) === targetRunDir) return true;
    current = parentRunId ? byRunId.get(parentRunId) : undefined;
    if (!current && parentRunDir) current = byRunDir.get(resolve(parentRunDir));
  }
  return false;
}

function listEventMetadata(): AgentMetadata[] {
  const runs = join(dataRoot(), "runs");
  if (!existsSync(runs)) return [];
  const metas: AgentMetadata[] = [];
  for (const project of readdirSync(runs)) {
    const root = join(runs, project);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const runDir = join(root, name);
      const metadataFile = join(runDir, "metadata.json");
      if (!existsSync(metadataFile)) continue;
      try { metas.push(JSON.parse(readFileSync(metadataFile, "utf8")) as AgentMetadata); } catch {}
    }
  }
  return metas;
}

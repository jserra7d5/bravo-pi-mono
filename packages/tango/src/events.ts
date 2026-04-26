import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentMetadata, AgentStatus } from "./types.js";
import { dataRoot, projectSlug } from "./paths.js";

export type TangoEvent = {
  schemaVersion: 1;
  eventId: string;
  type: "agent.status";
  time: string;
  agent: string;
  role?: string;
  status: AgentStatus;
  previousStatus?: AgentStatus;
  summary?: string;
  needs?: string;
  cwd: string;
  projectSlug: string;
  runDir: string;
  parentRunDir?: string;
};

export type EventReadState = { offset: number; carry: string };

export function eventsPath(): string {
  return join(dataRoot(), "events.jsonl");
}

export function appendStatusEvent(meta: AgentMetadata, previousStatus?: AgentStatus): TangoEvent {
  const event: TangoEvent = {
    schemaVersion: 1,
    eventId: `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "agent.status",
    time: new Date().toISOString(),
    agent: meta.name,
    role: meta.role,
    status: meta.status,
    previousStatus,
    summary: meta.summary,
    needs: meta.needs,
    cwd: meta.cwd,
    projectSlug: projectSlug(meta.cwd),
    runDir: meta.runDir,
    parentRunDir: meta.parentRunDir,
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultRunRoot, findProjectRoot } from "./config.js";
import { SubagentError } from "./errors.js";
import { appendJsonl, atomicWriteJson, readJsonl } from "./jsonl.js";
import { newRunId } from "./ids.js";
import { nowIso } from "./time.js";
import type { InboxMessage, RunEvent, RunIndexRecord, RunPaths, RunResult, RunStatus, WaitCursor } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface CreateRunDirectoryInput {
  runId?: string;
  cwd: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  contextPolicy?: RunIndexRecord["contextPolicy"];
  sessionPolicy?: RunIndexRecord["sessionPolicy"];
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
}

export interface RunStoreOptions {
  cwd?: string;
  runRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export class RunStore {
  readonly cwd: string;
  readonly runRoot: string;

  constructor(options: RunStoreOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.runRoot = defaultRunRoot(this.cwd, options.runRoot, options.env ?? process.env);
  }

  resolveRunRoot(cwd = this.cwd, configuredRoot?: string): string {
    return defaultRunRoot(cwd, configuredRoot);
  }

  indexPath(): string {
    return join(this.runRoot, "..", "run-index.jsonl");
  }

  pathsFor(runRef: { runId: string } | { runDir: string }): RunPaths {
    const runDir = "runDir" in runRef ? resolve(runRef.runDir) : this.resolveRunDir(runRef.runId);
    return {
      runRoot: this.runRoot,
      runDir,
      inboxPath: join(runDir, "inbox.jsonl"),
      eventsPath: join(runDir, "events.jsonl"),
      statusPath: join(runDir, "status.json"),
      resultPath: join(runDir, "result.json"),
      artifactsDir: join(runDir, "artifacts"),
      logsDir: join(runDir, "logs"),
      piSessionDir: join(runDir, "pi-session"),
      requestedPiSessionPath: join(runDir, "pi-session", "session.jsonl"),
      piSessionPath: join(runDir, "pi-session", "session.jsonl"),
    };
  }

  createRunDirectory(input: CreateRunDirectoryInput): { runId: string; paths: RunPaths; indexRecord: RunIndexRecord } {
    const runId = input.runId ?? newRunId();
    const paths = this.pathsFor({ runDir: join(this.runRoot, runId) });
    mkdirSync(paths.artifactsDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    mkdirSync(paths.piSessionDir, { recursive: true });
    writeFileSync(paths.inboxPath, "", { flag: "a" });
    writeFileSync(paths.eventsPath, "", { flag: "a" });
    const record: RunIndexRecord = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      runDir: paths.runDir,
      projectRoot: findProjectRoot(input.cwd),
      parentRunId: input.parentRunId,
      rootRunId: input.rootRunId,
      rootSessionId: input.rootSessionId,
      contextPolicy: input.contextPolicy,
      sessionPolicy: input.sessionPolicy,
      piSessionPath: input.piSessionPath ?? (input.sessionPolicy === "record" ? paths.piSessionPath : undefined),
      requestedPiSessionPath: input.requestedPiSessionPath ?? (input.sessionPolicy === "record" ? paths.requestedPiSessionPath : undefined),
      forkSourceSessionFile: input.forkSourceSessionFile,
      forkSourceLeafId: input.forkSourceLeafId,
      createdAt: nowIso(),
    };
    this.appendRunIndex(record);
    return { runId, paths, indexRecord: record };
  }

  appendRunIndex(record: RunIndexRecord): void {
    appendJsonl(this.indexPath(), record);
  }

  readRunIndex(): RunIndexRecord[] {
    return readJsonl<RunIndexRecord>(this.indexPath()).records;
  }

  resolveRunDir(runId: string): string {
    const records = this.readRunIndex().filter((record) => record.runId === runId);
    const latest = records.at(-1);
    if (!latest) throw new SubagentError("RUN_NOT_FOUND", `run not found: ${runId}`, { runId, indexPath: this.indexPath() });
    return latest.runDir;
  }

  writeStatus(status: RunStatus): void {
    atomicWriteJson(this.pathsFor({ runId: status.runId }).statusPath, status);
  }

  readStatus(runId: string): RunStatus {
    const path = this.pathsFor({ runId }).statusPath;
    if (!existsSync(path)) throw new SubagentError("STATUS_NOT_FOUND", `status not found for run: ${runId}`, { runId, path });
    return JSON.parse(readFileSync(path, "utf8")) as RunStatus;
  }

  appendEvent(runId: string, event: RunEvent): void {
    appendJsonl(this.pathsFor({ runId }).eventsPath, event);
  }

  readEvents(runId: string, cursor?: WaitCursor): { records: RunEvent[]; cursor: WaitCursor } {
    const result = readJsonl<RunEvent>(this.pathsFor({ runId }).eventsPath, { offset: cursor?.eventOffset ?? 0 });
    return { records: result.records, cursor: { eventOffset: result.nextOffset, lastEventId: result.lastId ?? cursor?.lastEventId } };
  }

  appendInboxMessage(runId: string, message: InboxMessage): void {
    appendJsonl(this.pathsFor({ runId }).inboxPath, message);
  }

  readInbox(runId: string, cursor?: WaitCursor): { records: InboxMessage[]; cursor: WaitCursor } {
    const result = readJsonl<InboxMessage>(this.pathsFor({ runId }).inboxPath, { offset: cursor?.eventOffset ?? 0 });
    return { records: result.records, cursor: { eventOffset: result.nextOffset, lastEventId: result.lastId ?? cursor?.lastEventId } };
  }

  writeResult(result: RunResult): void {
    atomicWriteJson(this.pathsFor({ runId: result.runId }).resultPath, result);
  }

  readResult(runId: string): RunResult | undefined {
    const path = this.pathsFor({ runId }).resultPath;
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as RunResult;
  }

  listDirectChildren(parentRunId: string): RunIndexRecord[] {
    return this.readRunIndex().filter((record) => record.parentRunId === parentRunId);
  }

  listRecentRuns(filter: Partial<Pick<RunIndexRecord, "parentRunId" | "rootSessionId">> = {}): RunIndexRecord[] {
    return this.readRunIndex().filter((record) => {
      if (filter.parentRunId && record.parentRunId !== filter.parentRunId) return false;
      if (filter.rootSessionId && record.rootSessionId !== filter.rootSessionId) return false;
      return true;
    });
  }
}

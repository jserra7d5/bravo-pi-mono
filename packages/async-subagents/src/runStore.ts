import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { asyncSubagentsHome, defaultRunRoot, findProjectRoot } from "./config.js";
import { SubagentError } from "./errors.js";
import { appendJsonl, atomicWriteJson, readJsonl } from "./jsonl.js";
import { newRunId } from "./ids.js";
import { nowIso } from "./time.js";
import { applyEventToSummary, applyResultToSummary, readSummaryFile, summaryFromStatus, summaryPathForRunDir, type RunIndexCache, type RunSummaryReadModel } from "./readModels.js";
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
  continuedFromRunId?: string;
  continuationRootRunId?: string;
  continuationSequence?: number;
  continuationOfPiSessionPath?: string;
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
  readonly env: NodeJS.ProcessEnv;

  constructor(options: RunStoreOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.env = options.env ?? process.env;
    this.runRoot = defaultRunRoot(this.cwd, options.runRoot, this.env);
  }

  resolveRunRoot(cwd = this.cwd, configuredRoot?: string): string {
    return defaultRunRoot(cwd, configuredRoot);
  }

  indexPath(): string {
    return join(this.runRoot, "..", "run-index.jsonl");
  }

  globalIndexPath(): string {
    return join(asyncSubagentsHome(this.env), "run-index.jsonl");
  }

  indexCachePath(): string {
    return join(this.runRoot, "..", "run-index-cache.json");
  }

  summaryPath(runId: string): string {
    return summaryPathForRunDir(this.pathsFor({ runId }).runDir);
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
      continuedFromRunId: input.continuedFromRunId,
      continuationRootRunId: input.continuationRootRunId,
      continuationSequence: input.continuationSequence,
      continuationOfPiSessionPath: input.continuationOfPiSessionPath,
      forkSourceSessionFile: input.forkSourceSessionFile,
      forkSourceLeafId: input.forkSourceLeafId,
      createdAt: nowIso(),
    };
    this.appendRunIndex(record);
    return { runId, paths, indexRecord: record };
  }

  appendRunIndex(record: RunIndexRecord): void {
    appendJsonl(this.indexPath(), record);
    if (resolve(this.globalIndexPath()) !== resolve(this.indexPath())) appendJsonl(this.globalIndexPath(), record);
    this.writeIndexCache(this.buildIndexCache(this.readRunIndexUncached()));
  }

  fallbackIndexPaths(): string[] {
    const paths = [
      join(findProjectRoot(this.cwd), ".subagents", "run-index.jsonl"),
      ...(this.env.ASYNC_SUBAGENTS_HOME ? [join(resolve(this.env.ASYNC_SUBAGENTS_HOME), "run-index.jsonl")] : []),
    ];
    return [...new Set(paths.map((path) => resolve(path)))].filter((path) => path !== resolve(this.indexPath()));
  }

  lookupIndexPaths(): string[] {
    return [...new Set([this.indexPath(), this.globalIndexPath(), ...this.fallbackIndexPaths()].map((path) => resolve(path)))];
  }

  private readRunIndexUncached(): RunIndexRecord[] {
    const records = readJsonl<RunIndexRecord>(this.indexPath()).records;
    for (const path of this.fallbackIndexPaths()) {
      if (existsSync(path)) records.push(...readJsonl<RunIndexRecord>(path).records);
    }
    return records;
  }

  private buildIndexCache(records: RunIndexRecord[]): RunIndexCache {
    const byRunId: Record<string, RunIndexRecord> = {};
    const childrenByParentRunId: Record<string, string[]> = {};
    const byRootSessionId: Record<string, string[]> = {};
    for (const record of records) {
      byRunId[record.runId] = record;
      (childrenByParentRunId[record.parentRunId] ??= []).push(record.runId);
      if (record.rootSessionId) (byRootSessionId[record.rootSessionId] ??= []).push(record.runId);
    }
    const sourcePath = this.indexPath();
    const sourceMtimeMs = existsSync(sourcePath) ? statSync(sourcePath).mtimeMs : 0;
    return { schemaVersion: SCHEMA_VERSION, rebuiltAt: nowIso(), sourcePath, sourceMtimeMs, records, byRunId, childrenByParentRunId, byRootSessionId };
  }

  private writeIndexCache(cache: RunIndexCache): void {
    atomicWriteJson(this.indexCachePath(), cache);
  }

  readIndexCache(): RunIndexCache {
    const cachePath = this.indexCachePath();
    const sourceMtimeMs = existsSync(this.indexPath()) ? statSync(this.indexPath()).mtimeMs : 0;
    if (existsSync(cachePath)) {
      try {
        const cache = JSON.parse(readFileSync(cachePath, "utf8")) as RunIndexCache;
        if (cache.schemaVersion === SCHEMA_VERSION && cache.sourceMtimeMs >= sourceMtimeMs) return cache;
      } catch {
        // Rebuild below.
      }
    }
    const cache = this.buildIndexCache(this.readRunIndexUncached());
    this.writeIndexCache(cache);
    return cache;
  }

  rebuildDerivedIndexes(): RunIndexCache {
    const cache = this.buildIndexCache(this.readRunIndexUncached());
    this.writeIndexCache(cache);
    for (const record of cache.records) {
      const summary = this.rebuildSummaryByRunDir(record.runDir, this.readSummaryByRunDir(record.runDir));
      if (summary) atomicWriteJson(summaryPathForRunDir(record.runDir), summary);
    }
    return cache;
  }

  readRunIndex(): RunIndexRecord[] {
    return this.readIndexCache().records;
  }

  readLookupRunIndex(): RunIndexRecord[] {
    const primary = this.readIndexCache().records;
    const records: RunIndexRecord[] = [...primary];
    for (const path of [this.globalIndexPath(), ...this.fallbackIndexPaths()].map((path) => resolve(path))) {
      if (path !== resolve(this.indexPath()) && existsSync(path)) records.push(...readJsonl<RunIndexRecord>(path).records);
    }
    return records;
  }

  resolveRunDir(runId: string): string {
    const cached = this.readIndexCache().byRunId[runId];
    if (cached) return cached.runDir;
    const records = this.readLookupRunIndex().filter((record) => record.runId === runId);
    const latest = records.at(-1);
    if (!latest) throw new SubagentError("RUN_NOT_FOUND", `run not found: ${runId}`, { runId, indexPath: this.indexPath() });
    return latest.runDir;
  }

  private rebuildSummaryByRunDir(runDir: string, previous?: RunSummaryReadModel): RunSummaryReadModel | undefined {
    const paths = this.pathsFor({ runDir });
    if (!existsSync(paths.statusPath)) return undefined;
    let summary = summaryFromStatus(JSON.parse(readFileSync(paths.statusPath, "utf8")) as RunStatus, runDir, previous);
    if (existsSync(paths.eventsPath)) {
      for (const event of readJsonl<RunEvent>(paths.eventsPath).records) summary = applyEventToSummary(summary, event);
    }
    if (existsSync(paths.resultPath)) summary = applyResultToSummary(summary, JSON.parse(readFileSync(paths.resultPath, "utf8")) as RunResult);
    return summary;
  }

  private readSummaryByRunDir(runDir: string): RunSummaryReadModel | undefined {
    return readSummaryFile(summaryPathForRunDir(runDir)) ?? this.rebuildSummaryByRunDir(runDir);
  }

  readRunSummary(runId: string): RunSummaryReadModel | undefined {
    return this.readSummaryByRunDir(this.pathsFor({ runId }).runDir);
  }

  readRunSummaries(filter: Partial<Pick<RunIndexRecord, "parentRunId" | "rootSessionId">> = {}): RunSummaryReadModel[] {
    const cache = this.readIndexCache();
    const records = filter.parentRunId
      ? (cache.childrenByParentRunId[filter.parentRunId] ?? []).map((runId) => cache.byRunId[runId]).filter(Boolean)
      : filter.rootSessionId
        ? (cache.byRootSessionId[filter.rootSessionId] ?? []).map((runId) => cache.byRunId[runId]).filter(Boolean)
        : cache.records;
    return records.flatMap((record) => {
      const summary = this.readSummaryByRunDir(record.runDir);
      return summary ? [summary] : [];
    });
  }

  writeStatus(status: RunStatus): void {
    const paths = this.pathsFor({ runId: status.runId });
    atomicWriteJson(paths.statusPath, status);
    atomicWriteJson(summaryPathForRunDir(paths.runDir), summaryFromStatus(status, paths.runDir, this.readSummaryByRunDir(paths.runDir)));
  }

  readStatus(runId: string): RunStatus {
    const path = this.pathsFor({ runId }).statusPath;
    if (!existsSync(path)) throw new SubagentError("STATUS_NOT_FOUND", `status not found for run: ${runId}`, { runId, path });
    return JSON.parse(readFileSync(path, "utf8")) as RunStatus;
  }

  appendEvent(runId: string, event: RunEvent): void {
    const paths = this.pathsFor({ runId });
    appendJsonl(paths.eventsPath, event);
    const previous = this.readSummaryByRunDir(paths.runDir);
    if (previous) atomicWriteJson(summaryPathForRunDir(paths.runDir), applyEventToSummary(previous, event));
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
    const paths = this.pathsFor({ runId: result.runId });
    atomicWriteJson(paths.resultPath, result);
    const previous = this.readSummaryByRunDir(paths.runDir);
    if (previous) atomicWriteJson(summaryPathForRunDir(paths.runDir), applyResultToSummary(previous, result));
  }

  readResult(runId: string): RunResult | undefined {
    const path = this.pathsFor({ runId }).resultPath;
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as RunResult;
  }

  listDirectChildren(parentRunId: string): RunIndexRecord[] {
    const cache = this.readIndexCache();
    return (cache.childrenByParentRunId[parentRunId] ?? []).map((runId) => cache.byRunId[runId]).filter(Boolean);
  }

  listRecentRuns(filter: Partial<Pick<RunIndexRecord, "parentRunId" | "rootSessionId">> = {}): RunIndexRecord[] {
    if (filter.parentRunId) return this.listDirectChildren(filter.parentRunId).filter((record) => !filter.rootSessionId || record.rootSessionId === filter.rootSessionId);
    const cache = this.readIndexCache();
    if (filter.rootSessionId) return (cache.byRootSessionId[filter.rootSessionId] ?? []).map((runId) => cache.byRunId[runId]).filter(Boolean);
    return cache.records;
  }
}

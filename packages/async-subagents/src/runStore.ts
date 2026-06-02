import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { asyncSubagentsHome, defaultRunRoot, findProjectRoot } from "./config.js";
import { SubagentError } from "./errors.js";
import { appendJsonl, atomicWriteJson, readJsonl, readJsonlRange } from "./jsonl.js";
import { newRunId } from "./ids.js";
import { nowIso } from "./time.js";
import { applyEventToSummary, applyResultToSummary, summaryFromStatus, summaryPathForRunDir, type RunIndexCache, type RunSummaryReadModel } from "./readModels.js";
import type { InboxMessage, RunEvent, RunIndexRecord, RunPaths, RunResult, RunStatus, WaitCursor } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

interface IndexSourceState {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  parsedOffset: number;
}

interface MemoryIndexCache {
  key: string;
  sources: IndexSourceState[];
  cache: RunIndexCache;
}

interface SummaryFileState {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface MemorySummaryCacheEntry {
  state: SummaryFileState;
  summary: RunSummaryReadModel;
}

const memoryIndexCaches = new Map<string, MemoryIndexCache>();
const memorySummaryCaches = new Map<string, MemorySummaryCacheEntry>();

function sourceKey(paths: string[]): string {
  return paths.map((path) => resolve(path)).join("\0");
}

function statIndexSource(path: string): IndexSourceState {
  if (!existsSync(path)) return { path, exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0, parsedOffset: 0 };
  const stat = statSync(path);
  return { path, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino, parsedOffset: 0 };
}

function statSummaryFile(path: string): SummaryFileState {
  const key = resolve(path);
  if (!existsSync(key)) return { path: key, exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0 };
  const stat = statSync(key);
  return { path: key, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

function sourcesUnchanged(previous: IndexSourceState[], current: IndexSourceState[]): boolean {
  return previous.length === current.length && previous.every((source, index) => {
    const next = current[index];
    return Boolean(next) && source.path === next.path && source.exists === next.exists && source.size === next.size && source.mtimeMs === next.mtimeMs && source.ctimeMs === next.ctimeMs && source.dev === next.dev && source.ino === next.ino;
  });
}

function sourceIdentityMatches(previous: IndexSourceState, next: IndexSourceState): boolean {
  return previous.path === next.path && previous.exists === next.exists && previous.dev === next.dev && previous.ino === next.ino;
}

function summaryStateUnchanged(previous: SummaryFileState, current: SummaryFileState): boolean {
  return previous.path === current.path && previous.exists === current.exists && previous.size === current.size && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs && previous.dev === current.dev && previous.ino === current.ino;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneJsonValue(item)])) as T;
  }
  return value;
}

function cloneSummary(summary: RunSummaryReadModel): RunSummaryReadModel {
  return cloneJsonValue(summary);
}

let summaryCacheDiskReadCountForTest = 0;

function readSummaryFileCached(path: string): RunSummaryReadModel | undefined {
  const key = resolve(path);
  const current = statSummaryFile(key);
  const cached = memorySummaryCaches.get(key);
  if (cached && summaryStateUnchanged(cached.state, current)) return cloneSummary(cached.summary);
  if (!current.exists) {
    memorySummaryCaches.delete(key);
    return undefined;
  }
  try {
    summaryCacheDiskReadCountForTest += 1;
    const summary = JSON.parse(readFileSync(key, "utf8")) as RunSummaryReadModel;
    memorySummaryCaches.set(key, { state: current, summary: cloneSummary(summary) });
    return cloneSummary(summary);
  } catch {
    memorySummaryCaches.delete(key);
    return undefined;
  }
}

function invalidateSummaryCache(path: string): void {
  memorySummaryCaches.delete(resolve(path));
}

export function summaryCacheStatsForTest(): { diskReads: number } {
  return { diskReads: summaryCacheDiskReadCountForTest };
}

export function resetSummaryCacheStatsForTest(): void {
  summaryCacheDiskReadCountForTest = 0;
}

function hasUnparsedTail(sources: IndexSourceState[]): boolean {
  return sources.some((source) => source.exists && source.parsedOffset < source.size);
}

function cloneRecord(record: RunIndexRecord): RunIndexRecord {
  return { ...record };
}

function cloneStringArrayMap(map: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, [...value]]));
}

function cloneIndexCache(cache: RunIndexCache): RunIndexCache {
  return {
    ...cache,
    records: cache.records.map(cloneRecord),
    byRunId: Object.fromEntries(Object.entries(cache.byRunId).map(([key, value]) => [key, cloneRecord(value)])),
    childrenByParentRunId: cloneStringArrayMap(cache.childrenByParentRunId),
    byRootSessionId: cloneStringArrayMap(cache.byRootSessionId),
  };
}

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
    if (memoryIndexCaches.has(this.indexCacheKey())) this.getIndexCache();
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

  private indexSourcePaths(): string[] {
    return [...new Set([this.indexPath(), ...this.fallbackIndexPaths()].map((path) => resolve(path)))];
  }

  private indexCacheKey(): string {
    return sourceKey(this.indexSourcePaths());
  }

  private readRunIndexSourcesUncached(): { records: RunIndexRecord[]; sources: IndexSourceState[] } {
    const records: RunIndexRecord[] = [];
    const sources: IndexSourceState[] = [];
    for (const path of this.indexSourcePaths()) {
      const state = statIndexSource(path);
      if (state.exists) {
        const result = readJsonl<RunIndexRecord>(path);
        records.push(...result.records.map(cloneRecord));
        state.parsedOffset = result.nextOffset;
      }
      sources.push(state);
    }
    return { records, sources };
  }

  private readRunIndexUncached(): RunIndexRecord[] {
    return this.readRunIndexSourcesUncached().records;
  }

  private applyIndexRecord(cache: RunIndexCache, record: RunIndexRecord): void {
    const cloned = cloneRecord(record);
    cache.records.push(cloned);
    cache.byRunId[cloned.runId] = cloned;
    (cache.childrenByParentRunId[cloned.parentRunId] ??= []).push(cloned.runId);
    if (cloned.rootSessionId) (cache.byRootSessionId[cloned.rootSessionId] ??= []).push(cloned.runId);
  }

  private buildIndexCache(records: RunIndexRecord[], sourceMtimeMs?: number): RunIndexCache {
    const cache: RunIndexCache = {
      schemaVersion: SCHEMA_VERSION,
      rebuiltAt: nowIso(),
      sourcePath: this.indexPath(),
      sourceMtimeMs: sourceMtimeMs ?? (existsSync(this.indexPath()) ? statSync(this.indexPath()).mtimeMs : 0),
      records: [],
      byRunId: {},
      childrenByParentRunId: {},
      byRootSessionId: {},
    };
    for (const record of records) this.applyIndexRecord(cache, record);
    return cache;
  }

  private writeIndexCache(cache: RunIndexCache): void {
    atomicWriteJson(this.indexCachePath(), cache);
  }

  private currentIndexSourceStates(): IndexSourceState[] {
    return this.indexSourcePaths().map(statIndexSource);
  }

  private rebuildMemoryIndexCache(key: string): MemoryIndexCache {
    let before = this.currentIndexSourceStates();
    let { records, sources } = this.readRunIndexSourcesUncached();
    let after = this.currentIndexSourceStates();
    for (let attempts = 0; !sourcesUnchanged(before, after) && attempts < 2; attempts += 1) {
      before = after;
      ({ records, sources } = this.readRunIndexSourcesUncached());
      after = this.currentIndexSourceStates();
    }
    sources = sources.map((source, index) => ({ ...after[index], parsedOffset: source.parsedOffset }));
    const cache = this.buildIndexCache(records, after[0]?.mtimeMs ?? 0);
    return { key, sources, cache };
  }

  private refreshMemoryIndexCache(warm: MemoryIndexCache, current: IndexSourceState[]): MemoryIndexCache {
    try {
      for (let index = 0; index < current.length; index += 1) {
        const previous = warm.sources[index];
        const next = current[index];
        if (!previous || !sourceIdentityMatches(previous, next) || (previous.exists && !next.exists) || next.size < previous.parsedOffset) {
          return this.rebuildMemoryIndexCache(warm.key);
        }
        if (!next.exists || next.size === previous.parsedOffset) {
          warm.sources[index] = { ...next, parsedOffset: previous.parsedOffset };
          continue;
        }
        const result = readJsonlRange<RunIndexRecord>(next.path, previous.parsedOffset, next.size);
        if (result.nextOffset < previous.parsedOffset || result.nextOffset > next.size) return this.rebuildMemoryIndexCache(warm.key);
        for (const record of result.records) this.applyIndexRecord(warm.cache, record);
        warm.sources[index] = { ...next, parsedOffset: result.nextOffset };
      }
      warm.cache.sourceMtimeMs = current[0]?.mtimeMs ?? 0;
      return warm;
    } catch {
      return this.rebuildMemoryIndexCache(warm.key);
    }
  }

  // Shared internal cache: hot-path callers must treat returned records/maps as read-only and never expose them by reference.
  private getIndexCache(): RunIndexCache {
    const key = this.indexCacheKey();
    const current = this.currentIndexSourceStates();
    const warm = memoryIndexCaches.get(key);
    if (!warm) {
      const rebuilt = this.rebuildMemoryIndexCache(key);
      memoryIndexCaches.set(key, rebuilt);
      return rebuilt.cache;
    }
    if (!sourcesUnchanged(warm.sources, current) || hasUnparsedTail(warm.sources)) {
      try {
        const refreshed = this.refreshMemoryIndexCache(warm, current);
        memoryIndexCaches.set(key, refreshed);
        return refreshed.cache;
      } catch (error) {
        memoryIndexCaches.delete(key);
        throw error;
      }
    }
    return warm.cache;
  }

  readIndexCache(): RunIndexCache {
    return cloneIndexCache(this.getIndexCache());
  }

  rebuildDerivedIndexes(): RunIndexCache {
    const key = this.indexCacheKey();
    const rebuilt = this.rebuildMemoryIndexCache(key);
    memoryIndexCaches.set(key, rebuilt);
    const cache = rebuilt.cache;
    this.writeIndexCache(cache);
    for (const record of cache.records) {
      const summary = this.rebuildSummaryByRunDir(record.runDir, this.readSummaryByRunDir(record.runDir));
      if (summary) {
        const path = summaryPathForRunDir(record.runDir);
        atomicWriteJson(path, summary);
        invalidateSummaryCache(path);
      }
    }
    return this.readIndexCache();
  }

  readRunIndex(): RunIndexRecord[] {
    return this.getIndexCache().records.map(cloneRecord);
  }

  readLookupRunIndex(): RunIndexRecord[] {
    const primary = this.getIndexCache().records.map(cloneRecord);
    const records: RunIndexRecord[] = [...primary];
    for (const path of [this.globalIndexPath(), ...this.fallbackIndexPaths()].map((path) => resolve(path))) {
      if (path !== resolve(this.indexPath()) && existsSync(path)) records.push(...readJsonl<RunIndexRecord>(path).records);
    }
    return records;
  }

  resolveRunDir(runId: string): string {
    const cached = this.getIndexCache().byRunId[runId];
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
    return readSummaryFileCached(summaryPathForRunDir(runDir)) ?? this.rebuildSummaryByRunDir(runDir);
  }

  readRunSummary(runId: string): RunSummaryReadModel | undefined {
    return this.readSummaryByRunDir(this.pathsFor({ runId }).runDir);
  }

  readRunSummaries(filter: Partial<Pick<RunIndexRecord, "parentRunId" | "rootSessionId">> = {}): RunSummaryReadModel[] {
    const cache = this.getIndexCache();
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
    const summaryPath = summaryPathForRunDir(paths.runDir);
    const summary = summaryFromStatus(status, paths.runDir, this.readSummaryByRunDir(paths.runDir));
    atomicWriteJson(summaryPath, summary);
    invalidateSummaryCache(summaryPath);
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
    if (previous) {
      const summaryPath = summaryPathForRunDir(paths.runDir);
      const summary = applyEventToSummary(previous, event);
      atomicWriteJson(summaryPath, summary);
      invalidateSummaryCache(summaryPath);
    }
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
    if (previous) {
      const summaryPath = summaryPathForRunDir(paths.runDir);
      const summary = applyResultToSummary(previous, result);
      atomicWriteJson(summaryPath, summary);
      invalidateSummaryCache(summaryPath);
    }
  }

  readResult(runId: string): RunResult | undefined {
    const path = this.pathsFor({ runId }).resultPath;
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as RunResult;
  }

  listDirectChildren(parentRunId: string): RunIndexRecord[] {
    const cache = this.getIndexCache();
    return (cache.childrenByParentRunId[parentRunId] ?? []).map((runId) => cache.byRunId[runId]).filter(Boolean).map(cloneRecord);
  }

  listRecentRuns(filter: Partial<Pick<RunIndexRecord, "parentRunId" | "rootSessionId">> = {}): RunIndexRecord[] {
    if (filter.parentRunId) return this.listDirectChildren(filter.parentRunId).filter((record) => !filter.rootSessionId || record.rootSessionId === filter.rootSessionId);
    const cache = this.getIndexCache();
    if (filter.rootSessionId) return (cache.byRootSessionId[filter.rootSessionId] ?? []).map((runId) => cache.byRunId[runId]).filter(Boolean).map(cloneRecord);
    return cache.records.map(cloneRecord);
  }
}

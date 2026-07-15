import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./jsonl.js";
import { reconcileUnderLock } from "./lifecycle.js";
import { withRunMutationLock } from "./runLock.js";
import { RunStore } from "./runStore.js";
import { bucketForState } from "./schemas.js";
import type { RunEvent, RunResult, RunState, RunStatus } from "./types.js";

const RESULT_BODY_MAX_CHARS = 16_000;
const RESULT_MARKER = "\n\n[Result body truncated; use `async-subagents result --run-id RUN_ID` for the full result.]";

export interface WatchLine {
  runId?: string;
  state?: RunState;
  bucket?: ReturnType<typeof bucketForState>;
  summary?: string;
  supervisorAlive?: "alive" | "dead" | "unknown";
  attentionReason?: string;
  updatedAt?: string;
  staleForMs?: number;
  resultSummary?: string;
  resultBody?: string;
  resultReported?: boolean;
  resultPath?: string;
  error?: string;
  allSettled?: boolean;
}

export interface WatchSubagentsOptions {
  cwd: string;
  runIds: string[];
  intervalSeconds?: number;
  includeResultBody?: boolean;
  /** NDJSON sink; defaults to stdout. */
  write?: (line: string) => void;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function attentionReason(status: RunStatus, events: RunEvent[]): string | undefined {
  if (status.state === "waiting_for_input") return "question";
  if (status.state === "blocked") return "blocked";
  if (status.state !== "paused") return undefined;
  const latest = [...events].reverse().find((event) => event.type === "status" && event.data?.reason);
  const reason = latest?.data?.reason;
  return reason === "timeout" ? "budget_expired" : typeof reason === "string" ? reason : "parent_pause";
}

function cappedResultBody(body: string, runId: string): string {
  const chars = [...body];
  if (chars.length <= RESULT_BODY_MAX_CHARS) return body;
  const marker = RESULT_MARKER.replace("RUN_ID", runId);
  const markerChars = [...marker];
  return `${chars.slice(0, Math.max(0, RESULT_BODY_MAX_CHARS - markerChars.length)).join("")}${marker}`;
}

async function terminalResultFields(store: RunStore, runId: string, includeBody: boolean): Promise<Partial<WatchLine>> {
  const paths = store.pathsFor({ runId });
  const markerPath = join(paths.runDir, "result-reported.json");
  const mutation = await withRunMutationLock(paths.runDir, () => {
    const result = store.readResult(runId);
    if (!result) return { result: undefined as RunResult | undefined, reported: false };
    if (!includeBody) return { result, reported: existsSync(markerPath) };
    if (existsSync(markerPath)) return { result, reported: true };
    atomicWriteJson(markerPath, { schemaVersion: 1, runId, reportedAt: new Date().toISOString() });
    return { result, reported: false, body: result.body === undefined ? undefined : cappedResultBody(result.body, runId) };
  });
  const { result, reported, body } = mutation.value;
  if (!result) return { resultSummary: "Result file is missing", resultPath: paths.resultPath };
  if (body !== undefined) return { resultSummary: result.summary ?? "", resultBody: body, resultPath: paths.resultPath };
  if (reported) return { resultSummary: result.summary ?? "", resultReported: true, resultPath: paths.resultPath };
  return { resultSummary: result.summary ?? "", resultPath: paths.resultPath };
}

/** Poll canonical run files and emit the D2 NDJSON stream through `write`. */
export async function watchSubagents(options: WatchSubagentsOptions): Promise<void> {
  if (!options.runIds.length) throw new Error("watch requires at least one --run-id");
  const store = new RunStore({ cwd: options.cwd });
  const write = options.write ?? ((line) => process.stdout.write(line));
  const emit = (line: WatchLine) => write(`${JSON.stringify(line)}\n`);
  const previous = new Map<string, string>();
  const settled = new Map<string, boolean>();
  const intervalMs = Math.max(1, (options.intervalSeconds ?? 5) * 1000);

  while (!options.signal?.aborted) {
    for (const runId of options.runIds) {
      try {
        // pathsFor resolves through the run index; watch never scans project run directories.
        store.pathsFor({ runId });
        const reconciled = await reconcileUnderLock(store, runId);
        const status = reconciled.status;
        const bucket = bucketForState(status.state);
        settled.set(runId, bucket !== "busy");
        const transitionKey = status.state;
        if (previous.get(runId) === transitionKey) continue;
        previous.set(runId, transitionKey);
        const updatedAtMs = Date.parse(status.updatedAt);
        const line: WatchLine = {
          runId,
          state: status.state,
          bucket,
          summary: `${bucket}: ${status.summary ?? status.state}`,
          supervisorAlive: reconciled.supervisorAlive,
          updatedAt: status.updatedAt,
          staleForMs: Number.isFinite(updatedAtMs) ? Math.max(0, Date.now() - updatedAtMs) : undefined,
        };
        if (bucket === "attention") line.attentionReason = attentionReason(status, store.readEvents(runId).records);
        if (bucket === "terminal") Object.assign(line, await terminalResultFields(store, runId, options.includeResultBody !== false));
        emit(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transitionKey = `error:${message}`;
        if (previous.get(runId) !== transitionKey) {
          previous.set(runId, transitionKey);
          emit({ runId, error: message });
        }
        settled.set(runId, true);
      }
    }
    if (options.runIds.every((runId) => settled.get(runId) === true)) {
      emit({ allSettled: true });
      return;
    }
    await sleep(intervalMs, options.signal);
  }
}

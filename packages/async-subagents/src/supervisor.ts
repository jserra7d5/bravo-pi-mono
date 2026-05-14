import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createResultEvent, createStartedEvent, createTerminalEvent } from "./events.js";
import { createRunResult } from "./result.js";
import { RunStore } from "./runStore.js";
import { updateRunStatus } from "./status.js";
import { nowIso } from "./time.js";
import type { PiCommand } from "./piHarness.js";
import type { RunResult, TerminalRunState } from "./types.js";

export interface SupervisorFakeInput {
  mode: "immediate";
  state?: TerminalRunState;
  body?: string;
  summary?: string;
  delayMs?: number;
  exitCode?: number;
}

export interface SupervisorInput {
  runId: string;
  runRoot: string;
  cwd: string;
  parentRunId: string;
  agentName: string;
  command: PiCommand;
  maxRunMs?: number;
  fake?: SupervisorFakeInput;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summaryFromOutput(body: string, fallback: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 200) : fallback;
}

function appendLog(path: string, text: string): void {
  if (!text) return;
  appendFileSync(path, text, "utf8");
}

async function finalizeRun(input: SupervisorInput, output: { state: TerminalRunState; stdout?: string; stderr?: string; error?: RunResult["error"] }): Promise<RunResult> {
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const status = store.readStatus(input.runId);
  const body = output.stdout?.trim() || output.stderr?.trim() || undefined;
  const result = createRunResult({
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: output.state,
    startedAt: status.startedAt,
    summary: summaryFromOutput(body ?? "", output.state === "completed" ? "Completed" : `Run ${output.state}`),
    body,
    error: output.error ?? null,
  });

  store.writeResult(result);
  store.appendEvent(input.runId, createResultEvent({ sequence: 2, result }));

  store.writeStatus(
    updateRunStatus(status, {
      state: output.state,
      writerRole: "child-runtime",
      resultReady: true,
      lastActivityAt: result.createdAt,
      lastEventId: "evt_000003",
      summary: result.summary,
      error: output.error ?? null,
    }),
  );
  store.appendEvent(
    input.runId,
    createTerminalEvent({
      sequence: 3,
      runId: input.runId,
      parentRunId: input.parentRunId,
      state: output.state,
      summary: result.summary,
      error: output.error,
    }),
  );
  return result;
}

export async function runSupervisor(input: SupervisorInput): Promise<RunResult> {
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const status = store.readStatus(input.runId);
  const paths = store.pathsFor({ runId: input.runId });

  store.writeStatus(
    updateRunStatus(status, {
      state: "running",
      writerRole: "child-runtime",
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      summary: "Starting child process",
    }),
  );
  store.appendEvent(input.runId, createStartedEvent({ sequence: 1, runId: input.runId, parentRunId: input.parentRunId, command: input.command.command }));

  if (input.fake?.mode === "immediate") {
    if (input.fake.delayMs) await sleep(input.fake.delayMs);
    const state = input.fake.state ?? (input.fake.exitCode && input.fake.exitCode !== 0 ? "failed" : "completed");
    return finalizeRun(input, {
      state,
      stdout: input.fake.body ?? input.fake.summary ?? "Fake child completed",
      error: state === "completed" ? null : { code: "FAKE_CHILD_FAILED", message: input.fake.summary ?? "fake child failed" },
    });
  }

  return new Promise<RunResult>((resolve) => {
    const stdoutPath = join(paths.logsDir, "stdout.log");
    const stderrPath = join(paths.logsDir, "stderr.log");
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const child = spawn(input.command.command, input.command.args, {
      cwd: input.command.cwd,
      env: {
        ...process.env,
        ...input.command.env,
        ASYNC_SUBAGENTS_RUN_ID: input.runId,
        ASYNC_SUBAGENTS_RUN_DIR: paths.runDir,
        ASYNC_SUBAGENTS_PARENT_RUN_ID: input.parentRunId,
        ASYNC_SUBAGENT_RUN_ID: input.runId,
        ASYNC_SUBAGENT_RUN_DIR: paths.runDir,
        ASYNC_SUBAGENT_PARENT_RUN_ID: input.parentRunId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const started = store.readStatus(input.runId);
    store.writeStatus(updateRunStatus(started, { pid: child.pid, summary: child.pid ? `Running child process ${child.pid}` : "Running child process" }));

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      appendLog(stdoutPath, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      appendLog(stderrPath, chunk.toString("utf8"));
    });

    const settle = (state: TerminalRunState, error?: RunResult["error"]): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      void finalizeRun(input, { state, stdout, stderr, error }).then(resolve);
    };

    child.once("error", (error) => {
      appendLog(stderrPath, `${error.message}\n`);
      settle("failed", { code: "SPAWN_FAILED", message: error.message });
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle("completed");
      } else {
        settle("failed", { code: "CHILD_EXITED", message: `child exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`, details: { code, signal } });
      }
    });

    if (input.maxRunMs && input.maxRunMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process may already have exited.
        }
        settle("expired", { code: "MAX_RUN_MS_EXPIRED", message: `child exceeded maxRunMs ${input.maxRunMs}` });
      }, input.maxRunMs);
    }
  });
}

export async function supervisorMain(argv = process.argv.slice(2)): Promise<void> {
  const inputIndex = argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
  if (!inputPath) throw new Error("usage: async-subagents supervisor --input <path>");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as SupervisorInput;
  try {
    await runSupervisor(input);
  } catch (error) {
    writeFileSync(
      join(new RunStore({ cwd: input.cwd, runRoot: input.runRoot }).pathsFor({ runId: input.runId }).logsDir, "supervisor-error.log"),
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      { flag: "a" },
    );
    throw error;
  }
}

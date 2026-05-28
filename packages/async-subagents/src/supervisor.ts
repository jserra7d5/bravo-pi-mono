import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStartedEvent } from "./events.js";
import { finalizeTerminalRun } from "./lifecycle.js";
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
  codexAuthBalancer?: {
    authswapPath: string;
    isolatedDir: string;
    selectedSlot: string;
    timeoutMs: number;
    metadata?: Record<string, unknown>;
  };
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

function childLaunchUsesNoExtensions(command: PiCommand): boolean {
  return command.args.includes("--no-extensions");
}

function providerExtensionHint(model: string): string {
  return [
    `Model "${model}" is not available in the isolated child Pi launch.`,
    "Async subagents launch child Pi with --no-extensions and then load only extensions declared on the agent or selected variant.",
    "If this model is registered by a Pi provider extension, add that extension to the agent/variant extensions list.",
    "Use a loadable extension module path, for example /path/to/package/extensions/pi/index.ts or /path/to/package/dist/extensions/pi/index.js; a package extension directory may not be enough for the child -e launch path.",
  ].join(" ");
}

export function augmentChildFailureDiagnostics(command: PiCommand, stderr: string, error?: RunResult["error"]): { stderr: string; error?: RunResult["error"] } {
  const match = stderr.match(/Model "([^"]+)" not found/);
  if (!match || !childLaunchUsesNoExtensions(command)) return { stderr, error };
  const hint = providerExtensionHint(match[1]);
  const augmentedStderr = stderr.includes(hint) ? stderr : `${stderr.trimEnd()}\n\n${hint}\n`;
  return {
    stderr: augmentedStderr,
    error: error ? { ...error, message: `${error.message}. ${hint}` } : error,
  };
}

function authswapExitClassification(error: unknown): { classification: string; retryable: boolean; safeCleanup: boolean; message: string } {
  if (!error) return { classification: "success", retryable: false, safeCleanup: true, message: "sync-back completed" };
  const nodeError = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: unknown };
  const message = nodeError.message ?? String(error);
  const code = String(nodeError.code ?? "");
  if (nodeError.killed || /timed out|timeout/i.test(message) || code === "6" || code === "124") return { classification: "timeout", retryable: true, safeCleanup: false, message };
  if (/conflict|generation|hash|changed|mismatch/i.test(message) || code === "65" || code === "409") return { classification: "conflict", retryable: false, safeCleanup: false, message };
  return { classification: code ? `exit-${code}` : "failed", retryable: false, safeCleanup: false, message };
}

function writeAuthswapRetentionMarker(balancer: NonNullable<SupervisorInput["codexAuthBalancer"]>, result: { classification: string; message: string }): void {
  const marker = join(balancer.isolatedDir, "ASYNC_SUBAGENTS_RETAINED.json");
  try {
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, provider: "authswap", classification: result.classification, retainUntil: "manual-cleanup-after-sync-back", isolatedDir: balancer.isolatedDir, slot: balancer.selectedSlot, message: result.message.replace(/[A-Za-z0-9+/=._-]{24,}/g, "<redacted>") }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* best-effort marker */ }
}

export function authswapSyncBackAndCleanup(input: Pick<SupervisorInput, "codexAuthBalancer">): Promise<void> {
  const balancer = input.codexAuthBalancer;
  if (!balancer) return Promise.resolve();
  const args = ["codex", "--sync-back", "--json", "--isolated-dir", balancer.isolatedDir, "--slot", balancer.selectedSlot];
  const attempt = (remaining: number): Promise<{ classification: string; retryable: boolean; safeCleanup: boolean; message: string }> => new Promise((resolve) => {
    execFile(balancer.authswapPath, args, { timeout: balancer.timeoutMs, maxBuffer: 64 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error) => {
      const result = authswapExitClassification(error);
      if (error && remaining > 0 && result.retryable) setTimeout(() => void attempt(remaining - 1).then(resolve), 250);
      else resolve(result);
    });
  });
  return attempt(1).then((result) => {
    if (result.safeCleanup) {
      try { rmSync(balancer.isolatedDir, { recursive: true, force: true }); } catch { writeAuthswapRetentionMarker(balancer, { classification: "cleanup-failed", message: "sync-back succeeded but cleanup failed" }); }
    } else {
      writeAuthswapRetentionMarker(balancer, result);
    }
  });
}

async function finalizeRun(input: SupervisorInput, output: { state: TerminalRunState; stdout?: string; stderr?: string; error?: RunResult["error"] }): Promise<RunResult> {
  await authswapSyncBackAndCleanup(input);
  const store = new RunStore({ cwd: input.cwd, runRoot: input.runRoot });
  const status = store.readStatus(input.runId);
  const body = output.stdout?.trim() || output.stderr?.trim() || undefined;
  return finalizeTerminalRun(store, {
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: output.state,
    writerRole: "child-runtime",
    startedAt: status.startedAt,
    summary: summaryFromOutput(body ?? "", output.state === "completed" ? "Completed" : `Run ${output.state}`),
    body,
    error: output.error ?? null,
  });
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
    store.writeStatus(updateRunStatus(started, { pid: child.pid, processHealth: child.pid ? "alive" : "unknown", summary: child.pid ? `Running child process ${child.pid}` : "Running child process" }));

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
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const diagnostics = state === "failed" ? augmentChildFailureDiagnostics(input.command, rawStderr, error) : { stderr: rawStderr, error };
      if (diagnostics.stderr !== rawStderr) appendLog(stderrPath, diagnostics.stderr.slice(rawStderr.length));
      void finalizeRun(input, { state, stdout, stderr: diagnostics.stderr, error: diagnostics.error }).then(resolve);
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

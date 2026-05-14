import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDefinition } from "./agentDefinitions.js";
import { buildPiCommand, writeLaunchLog, type PiCommand } from "./piHarness.js";
import { assemblePrompt } from "./promptAssembly.js";
import { createRootSession, readRootSession } from "./rootSession.js";
import { RunStore } from "./runStore.js";
import { createInitialStatus } from "./status.js";
import { runSupervisor, type SupervisorFakeInput, type SupervisorInput } from "./supervisor.js";
import { waitSubagents } from "./wait.js";
import type { SubagentStartResult, SubagentWaitResult, TerminalRunState } from "./types.js";
import { createRunResult } from "./result.js";
import { createRunEvent } from "./events.js";

export interface StartFakeChildInput {
  mode: "child";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxRunMs?: number;
}

export interface StartFakeImmediateInput extends SupervisorFakeInput {
  mode: "immediate";
}

export interface StartSubagentInput {
  agent: string;
  task: string;
  cwd?: string;
  runRoot?: string;
  parentRunId?: string;
  rootRunId?: string;
  rootSessionId?: string;
  depth?: number;
  files?: string[];
  startMode?: "async" | "wait" | "sync";
  waitUntil?: "interesting" | "terminal" | "result" | "event";
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  piBin?: string;
  env?: Record<string, string>;
  fake?: StartFakeImmediateInput | StartFakeChildInput;
}

const here = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      if (basename(current) === "async-subagents") return current;
    } catch {
      // Continue walking; basename cannot normally throw for a resolved path.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start, "..");
    current = parent;
  }
}

function resolveRootIdentity(input: StartSubagentInput, cwd: string): { parentRunId: string; rootRunId: string; rootSessionId: string } {
  if (input.parentRunId) {
    return {
      parentRunId: input.parentRunId,
      rootRunId: input.rootRunId ?? input.parentRunId,
      rootSessionId: input.rootSessionId ?? input.parentRunId,
    };
  }
  const existing = readRootSession({ cwd, rootSessionId: input.rootSessionId });
  const identity = existing ?? createRootSession({ cwd, rootSessionId: input.rootSessionId });
  return {
    parentRunId: identity.parentRunId,
    rootRunId: input.rootRunId ?? identity.parentRunId,
    rootSessionId: identity.rootSessionId,
  };
}

function fakeChildCommand(input: StartFakeChildInput, cwd: string): PiCommand {
  const script = `
const delay = Number(process.env.ASYNC_SUBAGENTS_FAKE_DELAY_MS || "0");
setTimeout(() => {
  console.log(process.env.ASYNC_SUBAGENTS_FAKE_BODY || "Fake child completed");
  process.exit(Number(process.env.ASYNC_SUBAGENTS_FAKE_EXIT_CODE || "0"));
}, delay);
`;
  return {
    command: input.command ?? process.execPath,
    args: input.args ?? ["-e", script],
    cwd: resolve(input.cwd ?? cwd),
    env: input.env ?? {},
  };
}

function writeSupervisorInput(runDir: string, input: SupervisorInput): string {
  const path = join(runDir, "logs", "supervisor-input.json");
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return path;
}

function writeLauncherFailure(store: RunStore, input: SupervisorInput, message: string): void {
  const status = store.readStatus(input.runId);
  const result = createRunResult({
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: "failed",
    startedAt: status.startedAt,
    summary: "Supervisor launch failed",
    body: message,
    error: { code: "SUPERVISOR_LAUNCH_FAILED", message },
  });
  store.writeResult(result);
  store.appendEvent(input.runId, createRunEvent({ sequence: 2, runId: input.runId, parentRunId: input.parentRunId, type: "result", summary: result.summary, body: result.body, wake: true }));
  store.writeStatus({ ...status, state: "failed", resultReady: true, updatedAt: result.createdAt, summary: result.summary, error: result.error });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnDetachedSupervisor(inputPath: string): Promise<string | undefined> {
  const cliPath = join(findPackageRoot(here), "dist", "src", "cli.js");
  if (!existsSync(cliPath)) return `supervisor CLI is not built: ${cliPath}`;
  let spawnError: string | undefined;
  const child = spawn(process.execPath, [cliPath, "supervisor", "--input", inputPath], { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    spawnError = error.message;
  });
  child.unref();
  await delay(150);
  if (spawnError) return spawnError;
  if (child.exitCode !== null) return `supervisor exited before taking ownership with code ${child.exitCode}`;
  return undefined;
}

export async function startSubagent(input: StartSubagentInput): Promise<SubagentStartResult> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const store = new RunStore({ cwd, runRoot: input.runRoot });
  const root = resolveRootIdentity(input, cwd);
  const definition = resolveAgentDefinition(input.agent, { cwd, env: process.env });
  const { runId, paths } = store.createRunDirectory({
    cwd,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
  });

  const initialStatus = createInitialStatus({
    runId,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
    agentName: definition.name,
    agentSource: definition.source,
    definitionPath: definition.definitionPath,
    mode: definition.mode,
    cwd,
    state: "queued",
  });
  store.writeStatus(initialStatus);

  const prompt = assemblePrompt({
    definition,
    runPaths: paths,
    task: input.task,
    cwd,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    depth: input.depth ?? 0,
    files: input.files,
  });

  const piCommand = buildPiCommand({
    piBin: input.piBin,
    systemPath: prompt.systemPath,
    taskPath: prompt.taskPath,
    runDir: paths.runDir,
    cwd,
    tools: definition.tools,
    skills: prompt.skills,
    extensions: prompt.extensions,
    model: prompt.model,
    extraEnv: input.env,
  });
  const command = input.fake?.mode === "child" ? fakeChildCommand(input.fake, cwd) : piCommand;
  writeLaunchLog(paths.runDir, command);

  const supervisorInput: SupervisorInput = {
    runId,
    runRoot: store.runRoot,
    cwd,
    parentRunId: root.parentRunId,
    agentName: definition.name,
    command,
    maxRunMs: input.fake?.mode === "child" ? input.fake.maxRunMs ?? prompt.maxRunMs : prompt.maxRunMs,
    fake: input.fake?.mode === "immediate" ? input.fake : undefined,
  };
  const supervisorInputPath = writeSupervisorInput(paths.runDir, supervisorInput);

  if (input.fake?.mode === "immediate") {
    await runSupervisor(supervisorInput);
  } else {
    const spawnError = await spawnDetachedSupervisor(supervisorInputPath);
    if (spawnError && !store.readResult(runId)) writeLauncherFailure(store, supervisorInput, spawnError);
  }

  let waitResult: SubagentWaitResult | undefined;
  const startMode = input.startMode ?? "async";
  if (startMode === "wait" || startMode === "sync") {
    waitResult = await waitSubagents(store, {
      runIds: [runId],
      timeoutMs: input.waitTimeoutMs ?? (startMode === "sync" || startMode === "wait" ? 300_000 : 0),
      pollIntervalMs: input.pollIntervalMs,
      includeResult: true,
      includeStatus: true,
      until: input.waitUntil ?? (startMode === "sync" ? "result" : "interesting"),
    });
  }

  const status = store.readStatus(runId);
  const terminalStates: TerminalRunState[] = ["completed", "failed", "cancelled", "expired"];
  const terminal = terminalStates.includes(status.state as TerminalRunState);
  return {
    runId,
    runDir: paths.runDir,
    agentName: definition.name,
    state: status.state,
    started: status.state === "running" || terminal,
    waited: Boolean(waitResult),
    waitResult,
    next: terminal ? [{ tool: "subagent_result", args: { runId } }] : [{ tool: "subagent_wait", args: { runIds: [runId] } }],
  };
}

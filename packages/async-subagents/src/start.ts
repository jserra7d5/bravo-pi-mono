import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDefinition } from "./agentDefinitions.js";
import { buildPiCommand, childControlEventTool, childControlExtensionPath, writeLaunchLogWithMetadata, type PiCommand } from "./piHarness.js";
import { assemblePrompt } from "./promptAssembly.js";
import { finalizeTerminalRun } from "./lifecycle.js";
import { assignDisplayName } from "./namePacks.js";
import { branchPiSession, type BranchPiSession, type ParentPiSessionRef } from "./piSession.js";
import { createRootSession, readRootSession } from "./rootSession.js";
import { RunStore } from "./runStore.js";
import { createInitialStatus } from "./status.js";
import { runSupervisor, type SupervisorFakeInput, type SupervisorInput } from "./supervisor.js";
import { waitSubagents } from "./wait.js";
import type { ContextPolicy, SessionPolicy, SubagentStartResult, SubagentWaitResult, TerminalRunState, ThinkingLevel } from "./types.js";

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
  name?: string;
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
  context?: ContextPolicy;
  session?: SessionPolicy;
  allowFreshFallback?: boolean;
  parentPiSessionRef?: ParentPiSessionRef | null;
  branchSession?: BranchPiSession;
  thinkingLevel?: ThinkingLevel;
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
  finalizeTerminalRun(store, {
    runId: input.runId,
    parentRunId: input.parentRunId,
    agentName: input.agentName,
    state: "failed",
    writerRole: "launcher",
    summary: "Supervisor launch failed",
    body: message,
    error: { code: "SUPERVISOR_LAUNCH_FAILED", message },
  });
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
  const selectedThinkingLevel = input.thinkingLevel ?? definition.thinkingLevel;
  const requestedContextPolicy = input.context ?? definition.context ?? "fresh";
  const requestedSessionPolicy = input.session ?? definition.session ?? "record";
  const { runId, paths } = store.createRunDirectory({
    cwd,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
    contextPolicy: requestedContextPolicy,
    sessionPolicy: requestedSessionPolicy,
  });
  const display = assignDisplayName({ runRoot: store.runRoot, requestedName: input.name });
  let contextPolicy = requestedContextPolicy;
  const sessionPolicy = requestedSessionPolicy;
  const requestedPiSessionPath = sessionPolicy === "record" ? paths.requestedPiSessionPath : undefined;
  let piSessionPath = sessionPolicy === "record" ? paths.requestedPiSessionPath : undefined;
  let forkSourceSessionFile: string | undefined;
  let forkSourceLeafId: string | undefined;
  let forkFallback: { allowed: boolean; used: boolean; reason?: string } | null = null;

  const runtimeBuiltinTools = [childControlEventTool];
  const runtimeExtensionPaths = [childControlExtensionPath];
  const launchLogPath = join(paths.logsDir, "launch.json");

  const initialStatus = createInitialStatus({
    runId,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
    displayName: display.displayName,
    namePack: display.namePack,
    agentName: definition.name,
    agentSource: definition.source,
    definitionPath: definition.definitionPath,
    mode: definition.mode,
    model: definition.model,
    thinkingLevel: selectedThinkingLevel,
    contextPolicy,
    sessionPolicy,
    piSessionPath,
    requestedPiSessionPath,
    forkFallback,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    launchLogPath,
    inboxPath: paths.inboxPath,
    cwd,
    state: "queued",
  });
  store.writeStatus(initialStatus);

  const failBeforeLaunch = (code: string, message: string, details?: unknown): SubagentStartResult => {
    const result = finalizeTerminalRun(store, {
      runId,
      parentRunId: root.parentRunId,
      agentName: definition.name,
      state: "failed",
      writerRole: "launcher",
      summary: message,
      body: message,
      error: { code, message, details },
    });
    return {
      runId,
      runDir: paths.runDir,
      agentName: definition.name,
      displayName: display.displayName,
      namePack: display.namePack,
      state: result.state,
      started: false,
      waited: false,
      contextPolicy,
      sessionPolicy,
      model: definition.model,
      thinkingLevel: selectedThinkingLevel,
      piSessionPath,
      requestedPiSessionPath,
      skills: definition.skills,
      tools: definition.tools,
      maxRunMs: definition.maxRunMs,
      maxSubagentDepth: definition.maxSubagentDepth,
      next: [{ tool: "subagent_result", args: { runId } }],
    };
  };

  if (requestedContextPolicy === "fork" && sessionPolicy !== "record") {
    return failBeforeLaunch("INVALID_SESSION_POLICY", "context: fork requires session: record", { context: requestedContextPolicy, session: sessionPolicy });
  }

  if (requestedContextPolicy === "fork") {
    const ref = input.parentPiSessionRef;
    if (!ref) {
      if (!input.allowFreshFallback) {
        return failBeforeLaunch("PARENT_PI_SESSION_UNAVAILABLE", "context: fork requires parent Pi session file and leaf id", { allowFreshFallback: false });
      }
      contextPolicy = "fresh";
      forkFallback = { allowed: true, used: true, reason: "parent Pi session reference unavailable" };
    } else {
      forkSourceSessionFile = ref.sessionFile;
      forkSourceLeafId = ref.leafId;
      try {
        piSessionPath = (input.branchSession ?? branchPiSession)({
          parentSessionFile: ref.sessionFile,
          leafId: ref.leafId,
          piSessionDir: paths.piSessionDir,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!input.allowFreshFallback) {
          const failedFork = store.readStatus(runId);
          store.writeStatus({
            ...failedFork,
            forkSourceSessionFile,
            forkSourceLeafId,
            updatedAt: new Date().toISOString(),
          });
          return failBeforeLaunch("PI_SESSION_BRANCH_FAILED", "failed to create branched Pi session", { reason, parentSessionFile: ref.sessionFile, leafId: ref.leafId });
        }
        contextPolicy = "fresh";
        piSessionPath = requestedPiSessionPath;
        forkFallback = { allowed: true, used: true, reason };
      }
    }
    const branched = store.readStatus(runId);
    store.writeStatus({
      ...branched,
      contextPolicy,
      piSessionPath,
      requestedPiSessionPath,
      forkSourceSessionFile,
      forkSourceLeafId,
      forkFallback,
      updatedAt: new Date().toISOString(),
    });
  }

  const prompt = assemblePrompt({
    definition,
    runPaths: paths,
    task: input.task,
    contextPolicy,
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
    sessionPolicy,
    piSessionPath,
    requestedPiSessionPath,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    skills: prompt.skills,
    extensions: prompt.extensions,
    model: prompt.model,
    thinkingLevel: selectedThinkingLevel,
    contextPolicy,
    forkSourceSessionFile,
    forkSourceLeafId,
    forkFallback,
    rootSessionId: root.rootSessionId,
    parentRunId: root.parentRunId,
    extraEnv: input.env,
  });
  const command = input.fake?.mode === "child" ? fakeChildCommand(input.fake, cwd) : piCommand;
  writeLaunchLogWithMetadata(paths.runDir, command, {
    model: prompt.model,
    thinkingLevel: selectedThinkingLevel,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    skills: prompt.skills,
    extensions: prompt.extensions,
    contextPolicy,
    sessionPolicy,
    requestedPiSessionPath,
    piSessionPath,
    forkSourceSessionFile,
    forkSourceLeafId,
    forkFallback,
    rootSessionId: root.rootSessionId,
    parentRunId: root.parentRunId,
  });

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
    displayName: display.displayName,
    namePack: display.namePack,
    state: status.state,
    model: status.model,
    thinkingLevel: status.thinkingLevel,
    started: status.state === "running" || terminal,
    waited: Boolean(waitResult),
    waitResult,
    contextPolicy: status.contextPolicy,
    sessionPolicy: status.sessionPolicy,
    piSessionPath: status.piSessionPath,
    requestedPiSessionPath: status.requestedPiSessionPath,
    skills: definition.skills,
    tools: definition.tools,
    maxRunMs: definition.maxRunMs,
    maxSubagentDepth: definition.maxSubagentDepth,
    next: terminal ? [{ tool: "subagent_result", args: { runId } }] : [{ tool: "subagent_wait", args: { runIds: [runId] } }],
  };
}

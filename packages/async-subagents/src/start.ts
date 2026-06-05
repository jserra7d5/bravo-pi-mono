import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAgentVariant, resolveAgentDefinition } from "./agentDefinitions.js";
import { loadAsyncSubagentsConfig, type CodexAuthBalancerConfig } from "./config.js";
import { buildPiCommand, childControlEventTool, childControlExtensionPath, childControlTaskTools, inheritedExtensionPathsFromEnv, writeLaunchLogWithMetadata, type PiCommand } from "./piHarness.js";
import { assemblePrompt } from "./promptAssembly.js";
import { SubagentError } from "./errors.js";
import { finalizeTerminalRun } from "./lifecycle.js";
import { assignDisplayName } from "./namePacks.js";
import { branchPiSession, type BranchPiSession, type ParentPiSessionRef } from "./piSession.js";
import { createRootSession, readRootSession } from "./rootSession.js";
import { RunStore } from "./runStore.js";
import { createInitialStatus } from "./status.js";
import { codexBalancerSyncBackAndCleanup, runSupervisor, type SupervisorFakeInput, type SupervisorInput } from "./supervisor.js";
import type { ContextPolicy, SessionPolicy, SubagentStartResult, TerminalRunState, ThinkingLevel, TaskRecord } from "./types.js";
import { prepareLaunch } from "@bravo/codex-auth-balancer";

export interface StartFakeChildInput {
  mode: "child";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  effectiveMaxRunMs?: number;
}

export interface StartFakeImmediateInput extends SupervisorFakeInput {
  mode: "immediate";
}

export interface StartSubagentInput {
  runId?: string;
  agent: string;
  variant?: string;
  task: string;
  cwd?: string;
  runRoot?: string;
  parentRunId?: string;
  rootRunId?: string;
  rootSessionId?: string;
  depth?: number;
  files?: string[];
  skills?: string[];
  context?: ContextPolicy;
  session?: SessionPolicy;
  allowFreshFallback?: boolean;
  parentPiSessionRef?: ParentPiSessionRef | null;
  branchSession?: BranchPiSession;
  piSessionPathOverride?: string;
  requestedPiSessionPathOverride?: string;
  continuation?: {
    continuedFromRunId: string;
    continuationRootRunId?: string;
    continuationSequence?: number;
    continuationOfPiSessionPath?: string;
  };
  thinkingLevel?: ThinkingLevel;
  piBin?: string;
  env?: Record<string, string>;
  fake?: StartFakeImmediateInput | StartFakeChildInput;
  taskAssignment?: { task: TaskRecord; token: string; dependencies?: TaskRecord[] };
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

function childModelSearchTerm(model: string): string {
  return model.includes("/") ? model.split("/").at(-1) || model : model;
}

function extensionArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-e" || args[i] === "--extension") && args[i + 1]) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

function isCodexModel(model?: string, onlyForProviders: string[] = ["openai-codex", "openai-codex-responses"]): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  const provider = lower.includes("/") ? lower.split("/")[0] : "";
  if (provider) return onlyForProviders.includes(provider);
  return onlyForProviders.includes(lower) || lower.includes("codex");
}

function isCodexBalancedProviderModel(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  const provider = lower.includes("/") ? lower.split("/")[0] : lower;
  return provider === "bravo-codex-balanced";
}

function modelListed(output: string, model: string): boolean {
  const [provider, modelId] = model.includes("/") ? model.split(/\/(.+)/) as [string, string] : [undefined, model];
  return output.split(/\r?\n/).some((line) => {
    if (!line.includes(modelId)) return false;
    return provider ? line.includes(provider) : true;
  });
}

export interface ModelPreflightResult {
  ok: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  message?: string;
}

function providerExtensionHint(model: string): string {
  return [
    `Model "${model}" is not available in the isolated child Pi launch.`,
    "Async subagents launch child Pi with --no-extensions and then load only extensions declared on the agent or selected variant.",
    "If this model is registered by a Pi provider extension, add that extension to the agent/variant extensions list.",
    "Use a loadable extension module path, for example /path/to/package/extensions/pi/index.ts or /path/to/package/dist/extensions/pi/index.js; a package extension directory may not be enough for the child -e launch path.",
  ].join(" ");
}

export async function preflightPiModelAvailability(command: PiCommand, model: string, timeoutMs = 15_000): Promise<ModelPreflightResult> {
  const extensions = extensionArgs(command.args);
  const args = [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    ...extensions.flatMap((extension) => ["-e", extension]),
    "--list-models",
    childModelSearchTerm(model),
  ];
  const renderedCommand = [command.command, ...args].join(" ");

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const child = spawn(command.command, args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      resolve({ ok: false, command: renderedCommand, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), message: `model preflight timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, command: renderedCommand, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), message: error.message });
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const ok = exitCode === 0 && modelListed(`${stdout}\n${stderr}`, model);
      resolve({ ok, command: renderedCommand, stdout, stderr, exitCode, signal, message: ok ? undefined : providerExtensionHint(model) });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CodexBalancerLaunch {
  enabled: true;
  isolatedDir: string;
  selectedSlot: string;
  env: Record<string, string>;
  metadata: Record<string, unknown>;
}

const BALANCED_PI_CONFIG_ENTRIES = [
  "AGENTS.md",
  "APPEND_SYSTEM.md",
  "SYSTEM.md",
  "keybindings.json",
  "models.json",
  "npm",
  "git",
  "prompts",
  "settings.json",
  "skills",
  "themes",
  "tools",
  "extensions",
];

function sourcePiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function linkIfPresent(source: string, dest: string): void {
  if (!existsSync(source) || existsSync(dest)) return;
  symlinkSync(source, dest, lstatSync(source).isDirectory() ? "dir" : "file");
}

function mirrorPiAgentConfig(piAgentDir: string): void {
  const sourceAgentDir = sourcePiAgentDir();
  for (const entry of BALANCED_PI_CONFIG_ENTRIES) linkIfPresent(join(sourceAgentDir, entry), join(piAgentDir, entry));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function prepareCodexBalancer(config: CodexAuthBalancerConfig, model: string | undefined, runDir: string, runId: string, rootRunId: string, ttlMs: number): Promise<CodexBalancerLaunch | undefined> {
  if (!config.enabled || isCodexBalancedProviderModel(model) || !isCodexModel(model, config.onlyForProviders)) return undefined;
  const isolatedDir = join(runDir, "auth", "codex-balancer");
  mkdirSync(isolatedDir, { recursive: true, mode: 0o700 });
  try { if ((statSync(isolatedDir).mode & 0o777) !== 0o700) chmodSync(isolatedDir, 0o700); } catch { /* mkdir already failed if unavailable */ }
  const prepared = await withTimeout(prepareLaunch(isolatedDir, { stateRoot: config.stateDir, runId, rootRunId, reservationTtlMs: ttlMs }), config.timeoutMs, "codex auth balancer prepare-launch");
  mirrorPiAgentConfig(prepared.pi_agent_dir);
  return { enabled: true, isolatedDir, selectedSlot: prepared.selected_slot, env: prepared.env, metadata: { enabled: true, provider: "bravo", mode: "process-env", selectedSlot: prepared.selected_slot, reservationId: prepared.metadata.reservation_id, launchId: prepared.metadata.launch_id, policyVersion: prepared.selection?.policy_version, label: prepared.label, reason: prepared.reason, status: prepared.status, primaryRemainingPercent: prepared.primary_remaining_percent, secondaryRemainingPercent: prepared.secondary_remaining_percent } };
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
  const baseDefinition = resolveAgentDefinition(input.agent, { cwd, env: process.env });
  const definition = applyAgentVariant(baseDefinition, input.variant);
  const selectedThinkingLevel = input.thinkingLevel ?? definition.thinkingLevel;
  const requestedContextPolicy = input.context ?? definition.context ?? "fresh";
  const requestedSessionPolicy = input.session ?? definition.session ?? "record";
  const { runId, paths } = store.createRunDirectory({
    runId: input.runId,
    cwd,
    parentRunId: root.parentRunId,
    rootRunId: root.rootRunId,
    rootSessionId: root.rootSessionId,
    contextPolicy: requestedContextPolicy,
    sessionPolicy: requestedSessionPolicy,
    piSessionPath: input.piSessionPathOverride,
    requestedPiSessionPath: input.requestedPiSessionPathOverride,
    continuedFromRunId: input.continuation?.continuedFromRunId,
    continuationRootRunId: input.continuation?.continuationRootRunId,
    continuationSequence: input.continuation?.continuationSequence,
    continuationOfPiSessionPath: input.continuation?.continuationOfPiSessionPath,
  });
  const display = assignDisplayName({ runRoot: store.runRoot });
  let contextPolicy = requestedContextPolicy;
  const sessionPolicy = requestedSessionPolicy;
  const requestedPiSessionPath = sessionPolicy === "record" ? input.requestedPiSessionPathOverride ?? paths.requestedPiSessionPath : undefined;
  let piSessionPath = sessionPolicy === "record" ? input.piSessionPathOverride ?? paths.requestedPiSessionPath : undefined;
  let forkSourceSessionFile: string | undefined;
  let forkSourceLeafId: string | undefined;
  let forkFallback: { allowed: boolean; used: boolean; reason?: string } | null = null;

  const runtimeBuiltinTools = input.taskAssignment ? [childControlEventTool, ...childControlTaskTools] : [childControlEventTool];
  const runtimeExtensionPaths = [childControlExtensionPath];
  const launchLogPath = join(paths.logsDir, "launch.json");
  const asyncSubagentsConfig = loadAsyncSubagentsConfig({ cwd, env: { ...process.env, ...(input.env ?? {}) } });
  const maxRunSeconds = definition.maxRunSeconds ?? asyncSubagentsConfig.defaultMaxRunSeconds;
  if (!Number.isFinite(maxRunSeconds) || maxRunSeconds <= 0) throw new SubagentError("INVALID_AGENT_DEFINITION", "maxRunSeconds must be a positive finite number");
  const effectiveMaxRunMs = Math.ceil(maxRunSeconds * 1000);

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
    variant: input.variant,
    model: definition.model,
    thinkingLevel: selectedThinkingLevel,
    contextPolicy,
    sessionPolicy,
    piSessionPath,
    requestedPiSessionPath,
    continuedFromRunId: input.continuation?.continuedFromRunId,
    continuationRootRunId: input.continuation?.continuationRootRunId,
    continuationSequence: input.continuation?.continuationSequence,
    continuationOfPiSessionPath: input.continuation?.continuationOfPiSessionPath,
    forkFallback,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    launchLogPath,
    inboxPath: paths.inboxPath,
    effectiveMaxRunMs,
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
      variant: input.variant,
      state: result.state,
      started: false,
      waited: false,
      contextPolicy,
      sessionPolicy,
      model: definition.model,
      thinkingLevel: selectedThinkingLevel,
      piSessionPath,
      requestedPiSessionPath,
      continuedFromRunId: input.continuation?.continuedFromRunId,
      continuationRootRunId: input.continuation?.continuationRootRunId,
      continuationSequence: input.continuation?.continuationSequence,
      continuationOfPiSessionPath: input.continuation?.continuationOfPiSessionPath,
      skills: definition.skills,
      tools: definition.tools,
      maxRunSeconds,
      effectiveMaxRunMs,
      maxSubagentDepth: definition.maxSubagentDepth,
      task: input.taskAssignment ? { taskId: input.taskAssignment.task.id, title: input.taskAssignment.task.title } : undefined,
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
    skills: input.skills,
    taskAssignment: input.taskAssignment ? { task: input.taskAssignment.task, dependencies: input.taskAssignment.dependencies } : undefined,
  });

  let codexAuthBalancer: CodexBalancerLaunch | undefined;
  try {
    codexAuthBalancer = await prepareCodexBalancer(asyncSubagentsConfig.codexAuthBalancer, prompt.model, paths.runDir, runId, root.rootRunId, effectiveMaxRunMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (asyncSubagentsConfig.codexAuthBalancer.failClosed) return failBeforeLaunch("CODEX_AUTH_BALANCER_FAILED", message);
  }
  const taskEnv: Record<string, string> = {
    ASYNC_SUBAGENTS_RUN_ID: runId,
    ASYNC_SUBAGENTS_PARENT_RUN_ID: root.parentRunId,
    ASYNC_SUBAGENTS_ROOT_SESSION_ID: root.rootSessionId,
    ...(input.taskAssignment
      ? {
          ASYNC_SUBAGENTS_TASK_ID: input.taskAssignment.task.id,
          ASYNC_SUBAGENTS_TASK_TOKEN: input.taskAssignment.token,
        }
      : {}),
  };
  const balancedProviderEnv: Record<string, string> = !codexAuthBalancer && isCodexBalancedProviderModel(prompt.model) && asyncSubagentsConfig.codexAuthBalancer.stateDir
    ? { CODEX_AUTH_BALANCER_HOME: asyncSubagentsConfig.codexAuthBalancer.stateDir }
    : {};
  const effectiveExtraEnv = codexAuthBalancer ? { ...(input.env ?? {}), ...taskEnv, ...codexAuthBalancer.env } : { ...(input.env ?? {}), ...taskEnv, ...balancedProviderEnv };
  const inheritedExtensionPaths = inheritedExtensionPathsFromEnv({ ...process.env, ...effectiveExtraEnv });

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
    defaultExtensionPaths: asyncSubagentsConfig.defaultExtensions.map((extension) => extension.realPath),
    defaultExtensionTools: asyncSubagentsConfig.defaultExtensions.flatMap((extension) => extension.tools),
    inheritedExtensionPaths,
    extensions: prompt.extensions,
    model: prompt.model,
    thinkingLevel: selectedThinkingLevel,
    contextPolicy,
    forkSourceSessionFile,
    forkSourceLeafId,
    forkFallback,
    rootSessionId: root.rootSessionId,
    parentRunId: root.parentRunId,
    continuation: input.continuation,
    extraEnv: effectiveExtraEnv,
  });
  const command = input.fake?.mode === "child" ? fakeChildCommand(input.fake, cwd) : piCommand;
  writeLaunchLogWithMetadata(paths.runDir, command, {
    variant: input.variant,
    model: prompt.model,
    thinkingLevel: selectedThinkingLevel,
    userBuiltinTools: definition.tools,
    runtimeBuiltinTools,
    runtimeExtensionPaths,
    skills: prompt.skills,
    defaultExtensionsConfigPath: asyncSubagentsConfig.configPath,
    defaultExtensions: asyncSubagentsConfig.defaultExtensions,
    defaultExtensionTools: asyncSubagentsConfig.defaultExtensions.flatMap((extension) => extension.tools),
    inheritedExtensions: inheritedExtensionPaths,
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
    continuation: input.continuation,
    codexAuthBalancer: codexAuthBalancer?.metadata,
  });

  if (prompt.model && !input.fake) {
    const preflight = await preflightPiModelAvailability(command, prompt.model);
    writeFileSync(join(paths.logsDir, "model-preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`, "utf8");
    if (!preflight.ok) {
      await codexBalancerSyncBackAndCleanup({ codexAuthBalancer: codexAuthBalancer ? { isolatedDir: codexAuthBalancer.isolatedDir, selectedSlot: codexAuthBalancer.selectedSlot, stateDir: asyncSubagentsConfig.codexAuthBalancer.stateDir, timeoutMs: asyncSubagentsConfig.codexAuthBalancer.timeoutMs, metadata: codexAuthBalancer.metadata } : undefined });
      return failBeforeLaunch("MODEL_PREFLIGHT_FAILED", preflight.message ?? `model preflight failed for ${prompt.model}`, preflight);
    }
  }

  const supervisorInput: SupervisorInput = {
    runId,
    runRoot: store.runRoot,
    cwd,
    parentRunId: root.parentRunId,
    agentName: definition.name,
    command,
    effectiveMaxRunMs: input.fake?.mode === "child" ? input.fake.effectiveMaxRunMs ?? effectiveMaxRunMs : effectiveMaxRunMs,
    fake: input.fake?.mode === "immediate" ? input.fake : undefined,
    codexAuthBalancer: codexAuthBalancer ? { isolatedDir: codexAuthBalancer.isolatedDir, selectedSlot: codexAuthBalancer.selectedSlot, stateDir: asyncSubagentsConfig.codexAuthBalancer.stateDir, timeoutMs: asyncSubagentsConfig.codexAuthBalancer.timeoutMs, metadata: codexAuthBalancer.metadata } : undefined,
  };
  const supervisorInputPath = writeSupervisorInput(paths.runDir, supervisorInput);

  if (input.fake?.mode === "immediate") {
    await runSupervisor(supervisorInput);
  } else {
    const spawnError = await spawnDetachedSupervisor(supervisorInputPath);
    if (spawnError && !store.readResult(runId)) writeLauncherFailure(store, supervisorInput, spawnError);
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
    variant: status.variant,
    state: status.state,
    model: status.model,
    thinkingLevel: status.thinkingLevel,
    started: status.state === "running" || terminal,
    waited: false,
    contextPolicy: status.contextPolicy,
    sessionPolicy: status.sessionPolicy,
    piSessionPath: status.piSessionPath,
    requestedPiSessionPath: status.requestedPiSessionPath,
    continuedFromRunId: status.continuedFromRunId,
    continuationRootRunId: status.continuationRootRunId,
    continuationSequence: status.continuationSequence,
    continuationOfPiSessionPath: status.continuationOfPiSessionPath,
    skills: prompt.skills,
    tools: definition.tools,
    maxRunSeconds,
    effectiveMaxRunMs,
    maxSubagentDepth: definition.maxSubagentDepth,
    task: input.taskAssignment ? { taskId: input.taskAssignment.task.id, title: input.taskAssignment.task.title } : undefined,
    next: terminal ? [{ tool: "subagent_result", args: { runId } }] : [],
  };
}

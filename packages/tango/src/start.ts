import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMetadata, CommandSpec, RoleConfig, StartOptions } from "./types.js";
import { runDirFor } from "./paths.js";
import { assembleSystemPrompt, loadRole } from "./roles.js";
import { readMetadata, transitionStatus, writeMetadata } from "./metadata.js";
import { buildPiCommand } from "./harnesses/pi.js";
import { buildGenericCommand } from "./harnesses/generic.js";
import { buildClaudeCommand } from "./harnesses/claude.js";
import { startTmux } from "./runtime/tmux.js";
import { isTerminalStatus } from "./lifecycle.js";

export async function startAgent(options: StartOptions): Promise<{ meta: AgentMetadata; command: CommandSpec; role?: RoleConfig }> {
  let role: RoleConfig | undefined;
  if (options.roleName) role = loadRole(options.roleName);
  const harness = options.harness ?? role?.harness ?? "pi";
  const mode = options.mode ?? role?.mode ?? (harness === "generic" ? "interactive" : "oneshot");
  const runDir = runDirFor(options.cwd, options.name);
  if (existsSync(runDir) && options.clean) rmSync(runDir, { recursive: true, force: true });
  if (existsSync(runDir) && !options.clean) throw new Error(`Run already exists: ${options.name}. Use --clean to replace it.`);
  mkdirSync(runDir, { recursive: true });
  const homeDir = join(runDir, "home");
  mkdirSync(homeDir, { recursive: true });

  const now = new Date().toISOString();
  const meta: AgentMetadata = {
    name: options.name,
    role: role?.name,
    harness,
    mode,
    status: "created",
    cwd: options.cwd,
    task: options.task,
    runDir,
    homeDir,
    tmuxSocket: join(runDir, "tmux.sock"),
    tmuxSession: "tango",
    createdAt: now,
    updatedAt: now,
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    parentRunId: process.env.TANGO_RUN_ID,
    parentRunDir: process.env.TANGO_RUN_DIR,
    rootSessionId: process.env.TANGO_ROOT_SESSION_ID,
    workstreamId: process.env.TANGO_WORKSTREAM_ID,
    model: options.model ?? role?.model,
    thinking: options.thinking ?? role?.thinking,
    effort: options.effort ?? role?.effort,
  };

  const effectiveRole = role ? { ...role, harness, model: meta.model, thinking: meta.thinking, effort: meta.effort, recursive: options.recursive ?? role.recursive } : undefined;
  const system = effectiveRole ? assembleSystemPrompt(effectiveRole) : "You are a helpful coding agent.";
  const systemFile = join(runDir, "system.md");
  const taskFile = join(runDir, "task.md");
  writeFileSync(systemFile, `${system}\n`, "utf8");
  writeFileSync(taskFile, `${options.task}\n`, "utf8");

  const command = harness === "generic"
    ? buildGenericCommand(meta, options.task)
    : harness === "claude"
      ? buildClaudeCommand(meta, effectiveRole, systemFile, options.task)
      : buildPiCommand(meta, effectiveRole, systemFile, options.task);
  writeFileSync(join(runDir, "command.json"), `${JSON.stringify(redactCommand(command), null, 2)}\n`, "utf8");
  writeMetadata(meta);

  if (options.dryRun) return { meta, command: redactCommand(command), role };

  const running = transitionStatus(meta.runDir, "running");
  if (mode === "oneshot") startOneshotSupervisor(running, command);
  else startTmux(meta.tmuxSocket, meta.tmuxSession, command);
  return { meta: readMetadata(meta.runDir), command: redactCommand(command), role };
}

function redactCommand(command: CommandSpec): CommandSpec {
  const keep = new Set(["HOME", "PATH", "PI_CODING_AGENT_DIR", "TANGO_HOME", "TANGO_REAL_HOME", "TANGO_AGENT_HOME", "TANGO_AGENT_NAME", "TANGO_RUN_ID", "TANGO_RUN_DIR", "TANGO_PARENT_RUN_DIR", "TANGO_ROOT_SESSION_ID", "TANGO_WORKSTREAM_ID", "CLAUDE_CODE_SHELL_PREFIX"]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(command.env)) {
    if (keep.has(key)) env[key] = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key) ? "<redacted>" : value;
  }
  return { ...command, env };
}

function extractResultText(parser: CommandSpec["resultParser"], event: any, current: string): string {
  if (parser === "pi-json") {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const parts = event.message.content ?? [];
      for (const part of parts) if (part.type === "text") current = part.text;
    }
    return current;
  }
  if (parser === "claude-stream-json") {
    if (event.type === "result" && typeof event.result === "string") return event.result;
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const text = event.message.content.filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
      if (text) return current ? `${current}\n${text}` : text;
    }
  }
  return current;
}

export function runtimeCommandPath(runDir: string): string { return join(runDir, "command.runtime.json"); }

function startOneshotSupervisor(meta: AgentMetadata, command: CommandSpec): void {
  const runtimePath = runtimeCommandPath(meta.runDir);
  writeFileSync(runtimePath, `${JSON.stringify(command, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(runtimePath, 0o600); } catch {}
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const supervisorEnv = { ...process.env } as Record<string, string>;
  const tangoHome = process.env.TANGO_HOME ?? command.env.TANGO_HOME;
  if (tangoHome) supervisorEnv.TANGO_HOME = tangoHome;
  const supervisor = spawn(process.execPath, [cliPath, "runner", "oneshot", "--run-dir", meta.runDir], {
    cwd: meta.cwd,
    env: supervisorEnv,
    detached: true,
    stdio: "ignore",
  });
  supervisor.unref();
}

export async function runOneshotFromRuntime(runDir: string): Promise<void> {
  const meta = readMetadata(runDir);
  const command = JSON.parse(readFileSync(runtimeCommandPath(runDir), "utf8")) as CommandSpec;
  await runOneshot(meta, command);
}

export async function runOneshot(meta: AgentMetadata, spec: CommandSpec): Promise<void> {
  const eventsFile = join(meta.runDir, "events.jsonl");
  const outFile = join(meta.runDir, "output.log");
  const errFile = join(meta.runDir, "stderr.log");
  const resultFile = join(meta.runDir, "result.md");
  await new Promise<void>((resolve) => {
    const proc = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    meta.pid = proc.pid;
    writeMetadata(meta);
    let buffer = "";
    let finalText = "";
    let plainOutput = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      plainOutput += text;
      writeFileSync(outFile, text, { flag: "a" });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processJsonLine(line);
    });
    proc.stderr.on("data", (chunk: Buffer) => writeFileSync(errFile, chunk.toString(), { flag: "a" }));
    proc.on("close", (code: number | null) => {
      if (buffer.trim()) processJsonLine(buffer);
      const current = readMetadata(meta.runDir);
      current.exitCode = code ?? 0;
      current.resultFile = resultFile;
      writeFileSync(resultFile, finalText || plainOutput || "", "utf8");
      writeMetadata(current);
      if (!isTerminalStatus(current.status)) transitionStatus(meta.runDir, current.exitCode === 0 ? "done" : "error");
      resolve();
    });
    proc.on("error", (error: Error) => {
      transitionStatus(meta.runDir, "error", error.message);
      resolve();
    });
    function processJsonLine(line: string) {
      if (!line.trim()) return;
      writeFileSync(eventsFile, `${line}\n`, { flag: "a" });
      try {
        const event = JSON.parse(line);
        finalText = extractResultText(spec.resultParser ?? "pi-json", event, finalText);
      } catch {}
    }
  });
}

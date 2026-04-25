import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMetadata, CommandSpec, RoleConfig, StartOptions } from "./types.js";
import { runDirFor } from "./paths.js";
import { assembleSystemPrompt, loadRole } from "./roles.js";
import { writeMetadata } from "./metadata.js";
import { buildPiCommand } from "./harnesses/pi.js";
import { buildGenericCommand } from "./harnesses/generic.js";
import { startTmux } from "./runtime/tmux.js";

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
    parentRunDir: process.env.TANGO_RUN_DIR,
  };

  const effectiveRole = role ? { ...role, harness, recursive: options.recursive ?? role.recursive } : undefined;
  const system = effectiveRole ? assembleSystemPrompt(effectiveRole) : "You are a helpful coding agent.";
  const systemFile = join(runDir, "system.md");
  const taskFile = join(runDir, "task.md");
  writeFileSync(systemFile, `${system}\n`, "utf8");
  writeFileSync(taskFile, `${options.task}\n`, "utf8");

  const command = harness === "generic" ? buildGenericCommand(meta, options.task) : buildPiCommand(meta, effectiveRole, systemFile, options.task);
  writeFileSync(join(runDir, "command.json"), `${JSON.stringify(redactCommand(command), null, 2)}\n`, "utf8");
  writeMetadata(meta);

  if (options.dryRun) return { meta, command: redactCommand(command), role };

  meta.status = "running";
  writeMetadata(meta);
  if (mode === "oneshot") await runOneshot(meta, command);
  else startTmux(meta.tmuxSocket, meta.tmuxSession, command);
  return { meta, command: redactCommand(command), role };
}

function redactCommand(command: CommandSpec): CommandSpec {
  const keep = new Set(["HOME", "PATH", "PI_CODING_AGENT_DIR", "TANGO_AGENT_NAME", "TANGO_RUN_DIR", "TANGO_PARENT_RUN_DIR"]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(command.env)) {
    if (keep.has(key)) env[key] = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key) ? "<redacted>" : value;
  }
  return { ...command, env };
}

async function runOneshot(meta: AgentMetadata, spec: CommandSpec): Promise<void> {
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
      meta.exitCode = code ?? 0;
      meta.status = meta.exitCode === 0 ? "done" : "error";
      meta.resultFile = resultFile;
      writeFileSync(resultFile, finalText || plainOutput || "", "utf8");
      writeMetadata(meta);
      resolve();
    });
    proc.on("error", (error: Error) => {
      meta.status = "error";
      meta.summary = error.message;
      writeMetadata(meta);
      resolve();
    });
    function processJsonLine(line: string) {
      if (!line.trim()) return;
      writeFileSync(eventsFile, `${line}\n`, { flag: "a" });
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const parts = event.message.content ?? [];
          for (const part of parts) if (part.type === "text") finalText = part.text;
        }
      } catch {}
    }
  });
}

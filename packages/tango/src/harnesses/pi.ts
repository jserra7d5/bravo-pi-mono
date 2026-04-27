import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMetadata, CommandSpec, RoleConfig } from "../types.js";
import { packageRoot } from "../paths.js";
import { wantsToolOrchestration } from "../roles.js";
import { resolveSkillFile } from "../skillResolver.js";

export function buildPiCommand(meta: AgentMetadata, role: RoleConfig | undefined, systemFile: string, task: string, options: { prepareHome?: boolean } = {}): CommandSpec {
  const mode = meta.mode;
  const args: string[] = [];
  if (mode === "oneshot") args.push("--mode", "json", "-p");
  args.push("--no-session");
  if (role?.contextFiles !== true) args.push("--no-context-files");
  args.push("--no-skills", "--no-prompt-templates");
  args.push("--no-extensions");
  const explicitExtensions = [...(role?.extensions ?? [])];
  explicitExtensions.unshift(join(packageRoot(), "extensions", "pi", "metrics.ts"));
  if (role?.tools?.includes("bash")) explicitExtensions.unshift(join(packageRoot(), "extensions", "pi", "tool-home.ts"));
  if (wantsToolOrchestration(role)) explicitExtensions.unshift(join(packageRoot(), "extensions", "pi", "index.ts"));
  for (const ext of explicitExtensions) args.push("-e", resolveResource(ext, "extension"));
  const model = meta.model ?? role?.model;
  if (model) args.push("--model", resolvePiModelPattern(model));
  const thinking = meta.thinking ?? role?.thinking;
  if (thinking) args.push("--thinking", thinking);
  if (role?.tools?.length) args.push("--tools", role.tools.join(","));
  args.push("--append-system-prompt", systemFile);
  for (const skill of role?.skills ?? []) args.push("--skill", resolveSkillFile(skill, meta.cwd));
  args.push(`Task: ${task}`);

  return {
    command: "pi",
    args,
    cwd: meta.cwd,
    env: baseEnv(meta, { seedAuth: options.prepareHome !== false }),
    resultParser: "pi-json",
  };
}

export function baseEnv(meta: AgentMetadata, options: { seedAuth?: boolean } = {}): Record<string, string> {
  const realHome = process.env.HOME ?? homedir();
  const piAgentDir = join(meta.homeDir, ".pi", "agent");
  if (options.seedAuth !== false) seedPiAuth(piAgentDir);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: meta.homeDir,
    TANGO_REAL_HOME: realHome,
    TANGO_AGENT_HOME: meta.homeDir,
    TANGO_HOME: process.env.TANGO_HOME ?? join(realHome, ".tango"),
    PI_CODING_AGENT_DIR: piAgentDir,
    TANGO_AGENT_NAME: meta.name,
    TANGO_RUN_DIR: meta.runDir,
  };
  if (meta.runId) env.TANGO_RUN_ID = meta.runId;
  if (meta.parentRunDir) env.TANGO_PARENT_RUN_DIR = meta.parentRunDir;
  if (meta.rootSessionId) env.TANGO_ROOT_SESSION_ID = meta.rootSessionId;
  if (meta.workstreamId) env.TANGO_WORKSTREAM_ID = meta.workstreamId;
  return env;
}

function seedPiAuth(targetPiAgentDir: string): void {
  const sourcePiAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent");
  mkdirSync(targetPiAgentDir, { recursive: true });
  for (const file of ["auth.json", "settings.json", "models.json"]) {
    const source = join(sourcePiAgentDir, file);
    const target = join(targetPiAgentDir, file);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
  }
}

function resolvePiModelPattern(model: string): string {
  if (model.includes("/")) return model;

  const settings = readPiSettings();
  const defaultProvider = typeof settings?.defaultProvider === "string" ? settings.defaultProvider : undefined;
  const defaultModel = typeof settings?.defaultModel === "string" ? settings.defaultModel : undefined;
  if (defaultProvider && defaultModel === model) return `${defaultProvider}/${model}`;

  const enabledModels = Array.isArray(settings?.enabledModels) ? settings.enabledModels.filter((entry): entry is string => typeof entry === "string") : [];
  const exactSuffixMatches = enabledModels.filter((entry) => !entry.includes("*") && entry.endsWith(`/${model}`));
  if (exactSuffixMatches.length === 1) return exactSuffixMatches[0];

  return model;
}

function readPiSettings(): Record<string, unknown> | undefined {
  const sourcePiAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent");
  const source = join(sourcePiAgentDir, "settings.json");
  if (!existsSync(source)) return undefined;
  try {
    return JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resolveResource(value: string, _type: string): string {
  return resolve(value);
}

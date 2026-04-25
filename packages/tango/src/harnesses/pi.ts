import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMetadata, CommandSpec, RoleConfig } from "../types.js";
import { packageRoot, packageSkillsDir, userSkillsDir } from "../paths.js";
import { wantsToolOrchestration } from "../roles.js";

export function buildPiCommand(meta: AgentMetadata, role: RoleConfig | undefined, systemFile: string, task: string): CommandSpec {
  const mode = meta.mode;
  const args: string[] = [];
  if (mode === "oneshot") args.push("--mode", "json", "-p");
  args.push("--no-session");
  if (role?.contextFiles !== true) args.push("--no-context-files");
  args.push("--no-skills", "--no-prompt-templates");
  args.push("--no-extensions");
  const explicitExtensions = [...(role?.extensions ?? [])];
  if (wantsToolOrchestration(role)) explicitExtensions.unshift(join(packageRoot(), "extensions", "pi", "index.ts"));
  for (const ext of explicitExtensions) args.push("-e", resolveResource(ext, "extension"));
  const model = meta.model ?? role?.model;
  if (model) args.push("--model", model);
  const thinking = meta.thinking ?? role?.thinking;
  if (thinking) args.push("--thinking", thinking);
  if (role?.tools?.length) args.push("--tools", role.tools.join(","));
  args.push("--append-system-prompt", systemFile);
  for (const skill of role?.skills ?? []) args.push("--skill", resolveSkill(skill));
  args.push(`Task: ${task}`);

  return {
    command: "pi",
    args,
    cwd: meta.cwd,
    env: baseEnv(meta),
  };
}

export function baseEnv(meta: AgentMetadata): Record<string, string> {
  const piAgentDir = join(meta.homeDir, ".pi", "agent");
  seedPiAuth(piAgentDir);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: meta.homeDir,
    PI_CODING_AGENT_DIR: piAgentDir,
    TANGO_AGENT_NAME: meta.name,
    TANGO_RUN_DIR: meta.runDir,
  };
  if (meta.parentRunDir) env.TANGO_PARENT_RUN_DIR = meta.parentRunDir;
  return env;
}

function seedPiAuth(targetPiAgentDir: string): void {
  const sourcePiAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent");
  mkdirSync(targetPiAgentDir, { recursive: true });
  for (const file of ["auth.json", "settings.json"]) {
    const source = join(sourcePiAgentDir, file);
    const target = join(targetPiAgentDir, file);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
  }
}

function resolveSkill(skill: string): string {
  const candidates = [
    skill,
    join(userSkillsDir(), skill, "SKILL.md"),
    join(userSkillsDir(), `${skill}.md`),
    join(packageSkillsDir(), skill, "SKILL.md"),
    join(packageSkillsDir(), `${skill}.md`),
  ].map((p) => resolve(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Skill not found: ${skill}`);
  return found;
}

function resolveResource(value: string, _type: string): string {
  return resolve(value);
}

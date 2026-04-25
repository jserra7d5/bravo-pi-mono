import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMetadata, CommandSpec, RoleConfig } from "../types.js";
import { packageSkillsDir, userSkillsDir } from "../paths.js";

export function buildClaudeCommand(meta: AgentMetadata, role: RoleConfig | undefined, systemFile: string, task: string): CommandSpec {
  if (role?.extensions?.length) throw new Error(`Role ${role.name} uses harness=claude but declares extensions. Pi extensions are only supported by harness=pi.`);
  prepareClaudeHome(meta, role);

  const args: string[] = [];
  if (meta.mode === "oneshot") args.push("--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence");
  args.push("--no-chrome");
  args.push("--name", meta.name);
  args.push("--permission-mode", "bypassPermissions");
  args.push("--setting-sources", "user");
  args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  args.push("--disallowed-tools", "Task");
  const model = meta.model ?? role?.model;
  if (model) args.push("--model", model);
  const effort = meta.effort ?? role?.effort;
  if (effort) args.push("--effort", effort);
  args.push("--system-prompt-file", systemFile);
  args.push("--", `Task: ${task}`);

  return {
    command: "claude",
    args,
    cwd: meta.cwd,
    env: claudeEnv(meta),
    resultParser: meta.mode === "oneshot" ? "claude-stream-json" : "plain",
  };
}

function claudeEnv(meta: AgentMetadata): Record<string, string> {
  const realHome = process.env.HOME ?? homedir();
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: meta.homeDir,
    TANGO_HOME: process.env.TANGO_HOME ?? join(realHome, ".tango"),
    TANGO_AGENT_NAME: meta.name,
    TANGO_RUN_DIR: meta.runDir,
  };
  if (meta.parentRunDir) env.TANGO_PARENT_RUN_DIR = meta.parentRunDir;
  return env;
}

function prepareClaudeHome(meta: AgentMetadata, role: RoleConfig | undefined): void {
  const claudeDir = join(meta.homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  seedClaudeAuthAndSettings(meta);
  for (const skill of role?.skills ?? []) copyClaudeSkill(skill, join(claudeDir, "skills"));
}

function seedClaudeAuthAndSettings(meta: AgentMetadata): void {
  const realHome = process.env.HOME ?? homedir();
  const sourceCredentials = join(realHome, ".claude", ".credentials.json");
  const targetClaudeDir = join(meta.homeDir, ".claude");
  mkdirSync(targetClaudeDir, { recursive: true });
  if (existsSync(sourceCredentials)) copyFileSync(sourceCredentials, join(targetClaudeDir, ".credentials.json"));

  const sourceRootConfig = join(realHome, ".claude.json");
  const sourceNestedConfig = join(realHome, ".claude", ".claude.json");
  const sourceConfig = configHasOauth(sourceNestedConfig) ? sourceNestedConfig : sourceRootConfig;
  const source = readJsonFile(sourceConfig);
  const projects = {
    [meta.cwd]: {
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
    },
  };
  const config: Record<string, unknown> = {
    theme: source?.theme ?? "dark",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: source?.lastOnboardingVersion ?? "2.1.119",
    hasSeenTasksHint: true,
    tipsHistory: source?.tipsHistory ?? {},
    projects,
  };
  if (source?.oauthAccount !== undefined) config.oauthAccount = source.oauthAccount;
  writeFileSync(join(meta.homeDir, ".claude.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const settings = {
    permissions: { defaultMode: "bypassPermissions" },
    skipDangerousModePermissionPrompt: true,
    theme: source?.theme ?? "dark",
  };
  writeFileSync(join(targetClaudeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function configHasOauth(path: string): boolean {
  return readJsonFile(path)?.oauthAccount !== undefined;
}

function readJsonFile(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function copyClaudeSkill(skill: string, targetSkillsDir: string): void {
  const source = resolveSkillDir(skill);
  const name = skill.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "skill";
  const target = join(targetSkillsDir, name);
  mkdirSync(targetSkillsDir, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

function resolveSkillDir(skill: string): string {
  const candidates = [
    skill,
    join(userSkillsDir(), skill, "claude"),
    join(userSkillsDir(), skill),
    join(packageSkillsDir(), skill, "claude"),
    join(packageSkillsDir(), skill),
  ].map((p) => resolve(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Skill not found: ${skill}`);
  if (!statSync(found).isDirectory()) throw new Error(`Claude skill must be a directory: ${skill}`);
  return found;
}

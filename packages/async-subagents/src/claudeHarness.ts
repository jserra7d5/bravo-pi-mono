import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { SubagentError } from "./errors.js";
import type { ClaudeAuthHome, ClaudeExecutionMode, ClaudeMemoryIsolation } from "./types.js";

export type ClaudeHarnessMode = "oneshot" | "interactive";

export interface ClaudeSkillInstallRequest {
  name: string;
  sourceDir: string;
  approvedRoots?: string[];
  maxFiles?: number;
  maxBytes?: number;
}

export interface InstalledClaudeSkill {
  name: string;
  sourcePath: string;
  targetPath: string;
  compatibility: "claude-native" | "pi-style";
}

export interface PrepareClaudeHomeInput {
  runDir: string;
  mode: ClaudeHarnessMode;
  cwd?: string;
  mcpServerCommand?: string;
  mcpServerArgs?: string[];
  skills?: ClaudeSkillInstallRequest[];
  operatorHome?: string;
  authHome?: ClaudeAuthHome;
}

export interface PrepareClaudeHomeResult {
  homeDir: string;
  settingsPath: string;
  mcpConfigPath: string;
  installedSkills: InstalledClaudeSkill[];
  executionMode: ClaudeExecutionMode;
  authHome: ClaudeAuthHome;
  memoryIsolation: ClaudeMemoryIsolation;
  shellHomeDir: string;
  shellWrapperPath: string;
}

export interface BuildClaudeCommandInput {
  runDir: string;
  cwd: string;
  systemPath: string;
  displayName: string;
  mode?: ClaudeHarnessMode;
  model?: string;
  effort?: string;
  claudeBin?: string;
  settingsPath?: string;
  mcpConfigPath?: string;
  homeDir?: string;
  shellHomeDir?: string;
  shellWrapperPath?: string;
  extraEnv?: Record<string, string>;
}

export interface ClaudeCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  executionMode: ClaudeExecutionMode;
  memoryIsolation: ClaudeMemoryIsolation;
  requestedModel?: string;
  resolvedModel: ClaudeCanonicalModel;
  homeDir?: string;
  shellHomeDir?: string;
  shellWrapperPath?: string;
}

export const DEFAULT_CLAUDE_SONNET_MODEL = "claude-sonnet-5";
export const DEFAULT_CLAUDE_OPUS_MODEL = "claude-opus-4-8";
export const DEFAULT_CLAUDE_FABLE_MODEL = "claude-fable-5";
export const CLAUDE_CANONICAL_MODELS = [DEFAULT_CLAUDE_SONNET_MODEL, DEFAULT_CLAUDE_OPUS_MODEL, DEFAULT_CLAUDE_FABLE_MODEL] as const;
export type ClaudeCanonicalModel = typeof CLAUDE_CANONICAL_MODELS[number];
export const CLAUDE_MODEL_ALIASES: Record<string, ClaudeCanonicalModel> = {
  sonnet: DEFAULT_CLAUDE_SONNET_MODEL,
  opus: DEFAULT_CLAUDE_OPUS_MODEL,
  fable: DEFAULT_CLAUDE_FABLE_MODEL,
};
export const CLAUDE_CONSTANT_PROMPT = "Begin the assigned async-subagents task.";
const DEFAULT_MAX_SKILL_FILES = 200;
const DEFAULT_MAX_SKILL_BYTES = 2_000_000;

export function resolveClaudeModel(model?: string): { requestedModel?: string; resolvedModel: ClaudeCanonicalModel } {
  if (!model) return { resolvedModel: DEFAULT_CLAUDE_SONNET_MODEL };
  const resolved = CLAUDE_MODEL_ALIASES[model] ?? model;
  if ((CLAUDE_CANONICAL_MODELS as readonly string[]).includes(resolved)) return { requestedModel: model, resolvedModel: resolved as ClaudeCanonicalModel };
  throw new SubagentError("UNSUPPORTED_CLAUDE_MODEL", `unsupported Claude model: ${model}`);
}

function assertSafeSkillName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`invalid Claude skill name: ${name}`);
  }
}

function isInside(child: string, parent: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  const childRelative = relative(resolvedParent, resolvedChild);
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function assertInside(child: string, parent: string): void {
  if (!isInside(child, parent)) throw new Error(`path escapes allowed root: ${child}`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function installClaudeSkill(request: ClaudeSkillInstallRequest, skillsDir: string, seen: Set<string>): InstalledClaudeSkill {
  assertSafeSkillName(request.name);
  if (seen.has(request.name)) throw new Error(`duplicate Claude skill name: ${request.name}`);
  seen.add(request.name);
  const sourcePath = resolve(request.sourceDir);
  const stat = lstatSync(sourcePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Claude skill must be a real directory: ${request.name}`);
  const realSource = realpathSync.native(sourcePath);
  const approvedRoots = request.approvedRoots?.map((root) => realpathSync.native(resolve(root)));
  if (approvedRoots?.length && !approvedRoots.some((root) => isInside(realSource, root))) {
    throw new Error(`Claude skill sourceDir is outside approved roots: ${request.name}`);
  }
  if (!existsSync(join(realSource, "SKILL.md"))) throw new Error(`Claude skill directory must contain SKILL.md: ${request.name}`);
  const maxFiles = request.maxFiles ?? DEFAULT_MAX_SKILL_FILES;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  let files = 0;
  let bytes = 0;
  const targetPath = resolve(skillsDir, request.name);
  assertInside(targetPath, skillsDir);
  rmSync(targetPath, { recursive: true, force: true });
  cpSync(realSource, targetPath, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const sourceStat = lstatSync(source);
      if (sourceStat.isSymbolicLink()) throw new Error(`Claude skill contains unsupported symlink: ${source}`);
      assertInside(realpathSync.native(source), realSource);
      if (sourceStat.isFile()) {
        files += 1;
        bytes += sourceStat.size;
        if (files > maxFiles) throw new Error(`Claude skill exceeds file count limit: ${request.name}`);
        if (bytes > maxBytes) throw new Error(`Claude skill exceeds byte limit: ${request.name}`);
      }
      return true;
    },
  });
  return {
    name: request.name,
    sourcePath: realSource,
    targetPath,
    compatibility: basename(dirname(realSource)) === request.name && basename(realSource) === "claude" ? "claude-native" : "pi-style",
  };
}

export function prepareClaudeHome(input: PrepareClaudeHomeInput): PrepareClaudeHomeResult {
  if (input.mode === "interactive" && !input.mcpServerCommand) {
    throw new SubagentError("CLAUDE_MCP_REQUIRED", "interactive Claude mode requires an async-subagents MCP server command");
  }
  const artifactsDir = join(input.runDir, "artifacts");
  const runHomeDir = join(input.runDir, "home");
  const authHome = input.authHome ?? "seeded-run-home";
  if (authHome === "operator-home" && (input.skills?.length ?? 0) > 0) {
    throw new SubagentError("CLAUDE_OPERATOR_HOME_SKILLS_UNSUPPORTED", "operator-home auth cannot guarantee run-local Claude skill visibility; use seeded-run-home for Claude skills");
  }
  const homeDir = authHome === "operator-home" ? input.operatorHome ?? homedir() : runHomeDir;
  const shellHomeDir = join(input.runDir, "shell-home");
  const binDir = join(input.runDir, "bin");
  const shellWrapperPath = join(binDir, "async-subagents-bash");
  const skillsDir = join(runHomeDir, ".claude", "skills");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(shellHomeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(shellWrapperPath, `#!/usr/bin/env bash\nset -euo pipefail\nexport HOME=${shellSingleQuote(shellHomeDir)}\nif [ "$#" -gt 0 ]; then\n  cmd="$1"\n  shift\n  exec "\${BASH:-bash}" -c "$cmd" -- "$@"\nfi\nexec "\${BASH:-bash}"\n`, { encoding: "utf8", mode: 0o755 });

  if (authHome === "seeded-run-home") {
    const credentialsSource = join(input.operatorHome ?? homedir(), ".claude", ".credentials.json");
    if (!existsSync(credentialsSource)) throw new SubagentError("CLAUDE_AUTH_CREDENTIALS_MISSING", `Claude OAuth credentials missing: ${credentialsSource}`);
    const credentialsStat = lstatSync(credentialsSource);
    if (!credentialsStat.isFile() || credentialsStat.isSymbolicLink()) throw new SubagentError("CLAUDE_AUTH_CREDENTIALS_INVALID", `Claude OAuth credentials must be a regular file: ${credentialsSource}`);
    const credentialsTarget = join(runHomeDir, ".claude", ".credentials.json");
    mkdirSync(dirname(credentialsTarget), { recursive: true });
    JSON.parse(readFileSync(credentialsSource, "utf8"));
    cpSync(credentialsSource, credentialsTarget, { dereference: false });
    const statePath = join(runHomeDir, ".claude.json");
    const projectState = input.cwd ? {
      [resolve(input.cwd)]: {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: ["async_subagents"],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
      },
    } : {};
    writeFileSync(statePath, JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.197",
      theme: "dark",
      projects: projectState,
    }, null, 2), "utf8");
  }

  const settingsPath = join(artifactsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    permissions: {
      defaultMode: "bypassPermissions",
      allow: ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)", "mcp__async_subagents__*"],
      deny: [],
    },
    skipDangerousModePermissionPrompt: true,
    includeGitInstructions: false,
    spinnerTipsEnabled: false,
    feedbackSurveyRate: 0,
    skillListingBudgetFraction: 0.02,
  }, null, 2), "utf8");

  const mcpConfigPath = join(artifactsDir, "mcp.json");
  const mcpServers = input.mode === "interactive"
    ? { async_subagents: { command: input.mcpServerCommand!, args: input.mcpServerArgs ?? [], env: { NODE_OPTIONS: "--no-warnings" } } }
    : {};
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), "utf8");

  const seen = new Set<string>();
  const installedSkills = (input.skills ?? []).map((skill) => installClaudeSkill(skill, skillsDir, seen));
  return { homeDir, settingsPath, mcpConfigPath, installedSkills, executionMode: "dangerous-auth", authHome, memoryIsolation: "best-effort-non-bare", shellHomeDir, shellWrapperPath };
}

export function buildClaudeCommand(input: BuildClaudeCommandInput): ClaudeCommand {
  const mode = input.mode ?? "interactive";
  const settingsPath = input.settingsPath ?? join(input.runDir, "artifacts", "settings.json");
  const mcpConfigPath = input.mcpConfigPath ?? join(input.runDir, "artifacts", "mcp.json");
  const { requestedModel, resolvedModel } = resolveClaudeModel(input.model);
  const args = [
    ...(mode === "oneshot" ? ["--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence"] : []),
    "--no-chrome",
    "--name", input.displayName,
    "--dangerously-skip-permissions",
    "--settings", settingsPath,
    "--setting-sources", "user",
    "--strict-mcp-config", "--mcp-config", mcpConfigPath,
    "--disallowed-tools", "Task",
    "--model", resolvedModel,
    "--effort", input.effort ?? "high",
    "--system-prompt-file", input.systemPath,
    "--",
    CLAUDE_CONSTANT_PROMPT,
  ];
  const homeDir = input.homeDir ?? join(input.runDir, "home");
  const shellHomeDir = input.shellHomeDir ?? join(input.runDir, "shell-home");
  const shellWrapperPath = input.shellWrapperPath ?? join(input.runDir, "bin", "async-subagents-bash");
  return {
    command: input.claudeBin ?? "claude",
    args,
    cwd: input.cwd,
    env: {
      ...(input.extraEnv ?? {}),
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CODE_SHELL_PREFIX: shellWrapperPath,
    },
    executionMode: "dangerous-auth",
    memoryIsolation: "best-effort-non-bare",
    requestedModel,
    resolvedModel,
    homeDir,
    shellHomeDir,
    shellWrapperPath,
  };
}

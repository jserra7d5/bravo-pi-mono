import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMetadata, CommandSpec, RoleConfig, ThinkingLevel } from "../types.js";
import { resolveSkillDir } from "../skillResolver.js";

const GEMINI_DEFAULT_MODEL = "gemini-3.1-pro-preview";
const GEMINI_ALLOWED_MODELS = new Set(["gemini-3.1-pro-preview", "gemini-3-flash-preview"]);

export function buildGeminiCommand(meta: AgentMetadata, role: RoleConfig | undefined, systemFile: string, task: string, options: { prepareHome?: boolean } = {}): CommandSpec {
  if (role?.extensions?.length) throw new Error(`Role ${role.name} uses harness=gemini but declares extensions. Pi extensions are only supported by harness=pi.`);
  const model = validateGeminiModel(meta.model ?? role?.model ?? GEMINI_DEFAULT_MODEL);
  if (options.prepareHome !== false) prepareGeminiHome(meta, role, model);

  const prompt = geminiPrompt(systemFile, task);
  const args: string[] = [];
  args.push("--model", model);
  args.push("--yolo");
  args.push("--skip-trust");

  if (meta.mode === "oneshot") {
    args.push("--prompt", prompt);
    args.push("--output-format", "text");
  } else {
    args.push("--prompt-interactive", prompt);
  }

  return {
    command: "gemini",
    args,
    cwd: meta.cwd,
    env: geminiEnv(meta),
    resultParser: "plain",
  };
}

function geminiPrompt(systemFile: string, task: string): string {
  let system = "You are a helpful coding agent.";
  try { system = readFileSync(systemFile, "utf8").trim(); } catch {}
  return `System instructions:\n${system}\n\nTask:\n${task}`;
}

function geminiEnv(meta: AgentMetadata): Record<string, string> {
  const realHome = process.env.HOME ?? homedir();
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: meta.homeDir,
    TANGO_REAL_HOME: realHome,
    TANGO_AGENT_HOME: meta.homeDir,
    TANGO_HOME: process.env.TANGO_HOME ?? join(realHome, ".tango"),
    TANGO_AGENT_NAME: meta.name,
    TANGO_RUN_DIR: meta.runDir,
  };
  if (meta.runId) env.TANGO_RUN_ID = meta.runId;
  if (meta.parentRunDir) env.TANGO_PARENT_RUN_DIR = meta.parentRunDir;
  if (meta.rootSessionId) env.TANGO_ROOT_SESSION_ID = meta.rootSessionId;
  if (meta.workstreamId) env.TANGO_WORKSTREAM_ID = meta.workstreamId;
  return env;
}

function prepareGeminiHome(meta: AgentMetadata, role: RoleConfig | undefined, model: string): void {
  const geminiDir = join(meta.homeDir, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  seedGeminiAuthAndSettings(meta, role, model);
  for (const skill of role?.skills ?? []) copyGeminiSkill(skill, join(geminiDir, "skills"), meta.cwd);
}

function validateGeminiModel(model: string): string {
  if (GEMINI_ALLOWED_MODELS.has(model)) return model;
  throw new Error(`Invalid Gemini model: ${model}. Expected gemini-3.1-pro-preview or gemini-3-flash-preview.`);
}

function seedGeminiAuthAndSettings(meta: AgentMetadata, role: RoleConfig | undefined, model: string): void {
  const realHome = process.env.HOME ?? homedir();
  const sourceGeminiDir = join(realHome, ".gemini");
  const targetGeminiDir = join(meta.homeDir, ".gemini");
  mkdirSync(targetGeminiDir, { recursive: true });

  for (const file of ["oauth_creds.json", "google_accounts.json", "installation_id", "state.json", "projects.json"]) {
    const source = join(sourceGeminiDir, file);
    if (existsSync(source)) copyFileSync(source, join(targetGeminiDir, file));
  }

  const sourceSettings = join(sourceGeminiDir, "settings.json");
  const settings = readJsonFile(sourceSettings) ?? {};
  const merged = {
    ...settings,
    security: {
      ...(typeof settings.security === "object" && settings.security !== null ? settings.security as Record<string, unknown> : {}),
      folderTrust: {
        ...(typeof (settings as any).security?.folderTrust === "object" && (settings as any).security.folderTrust !== null ? (settings as any).security.folderTrust : {}),
        enabled: false,
      },
    },
    modelConfigs: mergeGeminiThinkingConfig(settings.modelConfigs, role?.thinking ?? meta.thinking, model),
  };
  writeFileSync(join(targetGeminiDir, "settings.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  writeFileSync(join(targetGeminiDir, "trustedFolders.json"), `${JSON.stringify({ [meta.cwd]: "TRUST_FOLDER" }, null, 2)}\n`, "utf8");
}

function mergeGeminiThinkingConfig(existing: unknown, thinking: ThinkingLevel | undefined, model: string): Record<string, unknown> {
  const modelConfigs = typeof existing === "object" && existing !== null ? { ...existing as Record<string, unknown> } : {};
  const override = geminiThinkingOverride(thinking, model);
  if (!override) return modelConfigs;
  const currentOverrides = Array.isArray(modelConfigs.overrides) ? modelConfigs.overrides : [];
  return { ...modelConfigs, overrides: [...currentOverrides, override] };
}

function geminiThinkingOverride(thinking: ThinkingLevel | undefined, model: string): Record<string, unknown> | undefined {
  const thinkingLevel = geminiThinkingLevel(thinking);
  if (!thinkingLevel) return undefined;
  return {
    match: { model },
    modelConfig: {
      generateContentConfig: {
        thinkingConfig: { thinkingLevel },
      },
    },
  };
}

function geminiThinkingLevel(thinking: ThinkingLevel | undefined): "LOW" | "MEDIUM" | "HIGH" | undefined {
  if (!thinking || thinking === "off") return undefined;
  if (thinking === "minimal" || thinking === "low") return "LOW";
  if (thinking === "medium") return "MEDIUM";
  return "HIGH";
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function copyGeminiSkill(skill: string, targetSkillsDir: string, cwd = process.cwd()): void {
  const source = resolveSkillDir(skill, cwd);
  const name = skill.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "skill";
  const target = join(targetSkillsDir, name);
  mkdirSync(targetSkillsDir, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

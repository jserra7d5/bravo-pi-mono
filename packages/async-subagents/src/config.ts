import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { SubagentError } from "./errors.js";

export function asyncSubagentsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ASYNC_SUBAGENTS_HOME ? resolve(env.ASYNC_SUBAGENTS_HOME) : join(env.HOME || homedir(), ".async-subagents");
}

export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, "package.json")) || existsSync(join(current, ".subagents"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function projectScope(cwd: string): string {
  const projectRoot = findProjectRoot(cwd);
  return createHash("sha256").update(projectRoot).digest("base64url").slice(0, 16);
}

export function defaultRunRoot(cwd: string, configuredRoot?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (configuredRoot) return resolve(configuredRoot);
  return join(asyncSubagentsHome(env), "projects", projectScope(cwd), "runs");
}

export function sessionRoot(cwd: string, configuredRoot?: string, env: NodeJS.ProcessEnv = process.env): string {
  const runRoot = defaultRunRoot(cwd, configuredRoot, env);
  return resolve(runRoot, "..", "sessions");
}

export function leaseRoot(cwd: string, configuredRoot?: string, env: NodeJS.ProcessEnv = process.env): string {
  const runRoot = defaultRunRoot(cwd, configuredRoot, env);
  return resolve(runRoot, "..", "leases");
}

export interface DefaultExtensionEntry {
  path: string;
  realPath: string;
  approved: true;
  source: "user-config";
  projectLocal: boolean;
  tools: string[];
}

export interface AsyncSubagentsConfig {
  version: 1;
  defaultExtensions: DefaultExtensionEntry[];
  configPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new SubagentError("INVALID_CONFIG", `unknown key ${key} in ${context}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(asyncSubagentsHome(env), "config.json");
}

export function loadAsyncSubagentsConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): AsyncSubagentsConfig {
  const env = options.env ?? process.env;
  const path = configPath(env);
  if (!existsSync(path)) return { version: 1, defaultExtensions: [], configPath: path };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SubagentError("INVALID_CONFIG", `failed to parse async-subagents config: ${path}`, { path, error: error instanceof Error ? error.message : String(error) });
  }
  if (!isRecord(parsed)) throw new SubagentError("INVALID_CONFIG", `async-subagents config must be an object: ${path}`, { path });
  assertOnlyKeys(parsed, ["version", "defaultExtensions"], path);
  if (parsed.version !== 1) throw new SubagentError("INVALID_CONFIG", `async-subagents config version must be 1: ${path}`, { path, version: parsed.version });
  const rawDefaults = parsed.defaultExtensions ?? [];
  if (!Array.isArray(rawDefaults)) throw new SubagentError("INVALID_CONFIG", `defaultExtensions must be an array: ${path}`, { path });

  const projectRoot = options.cwd ? findProjectRoot(options.cwd) : undefined;
  const seenRealPaths = new Set<string>();
  const defaultExtensions: DefaultExtensionEntry[] = [];
  rawDefaults.forEach((entry, index) => {
    const context = `${path}.defaultExtensions[${index}]`;
    if (!isRecord(entry)) throw new SubagentError("INVALID_CONFIG", `default extension entry must be an object: ${context}`, { path, index });
    assertOnlyKeys(entry, ["path", "approved", "tools"], context);
    if (entry.approved !== true) throw new SubagentError("INVALID_CONFIG", `default extension entry must include approved: true: ${context}`, { path, index });
    if (typeof entry.path !== "string" || !isAbsolute(entry.path)) throw new SubagentError("INVALID_CONFIG", `default extension path must be an absolute path: ${context}`, { path, index });
    if (!existsSync(entry.path)) throw new SubagentError("INVALID_CONFIG", `default extension path does not exist: ${entry.path}`, { path, index, extensionPath: entry.path });
    const realPath = realpathSync(entry.path);
    const tools = entry.tools === undefined ? [] : entry.tools;
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !/^[A-Za-z0-9_-]+$/.test(tool))) {
      throw new SubagentError("INVALID_CONFIG", `default extension tools must be an array of tool names: ${context}`, { path, index });
    }
    if (seenRealPaths.has(realPath)) return;
    seenRealPaths.add(realPath);
    defaultExtensions.push({
      path: entry.path,
      realPath,
      approved: true,
      source: "user-config",
      projectLocal: projectRoot ? isWithin(projectRoot, realPath) : false,
      tools,
    });
  });

  return { version: 1, defaultExtensions, configPath: path };
}

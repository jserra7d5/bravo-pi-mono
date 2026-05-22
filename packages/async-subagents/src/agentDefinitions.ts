import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asyncSubagentsHome } from "./config.js";
import { SubagentError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import { THINKING_LEVELS } from "./schemas.js";
import type { AgentDefinitionSource, AgentMode, ContextPolicy, CwdPolicy, ResultFormat, SessionPolicy, ThinkingLevel } from "./types.js";

export interface AgentDefinitionVariant {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  includes?: string[];
  mode?: AgentMode;
  context?: ContextPolicy;
  session?: SessionPolicy;
  maxRunMs?: number;
  maxSubagentDepth?: number;
  cwdPolicy?: CwdPolicy;
  resultFormat?: ResultFormat;
}

export interface MarkdownAgentDefinition {
  name?: string;
  description: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  includes?: string[];
  mode?: AgentMode;
  context?: ContextPolicy;
  session?: SessionPolicy;
  maxRunMs?: number;
  maxSubagentDepth?: number;
  cwdPolicy?: CwdPolicy;
  resultFormat?: ResultFormat;
  variants?: Record<string, AgentDefinitionVariant>;
}

export interface PromptFragment {
  name: string;
  path: string;
  body: string;
  source: AgentDefinitionSource;
}

export interface ResolvedAgentDefinition extends MarkdownAgentDefinition {
  name: string;
  description: string;
  body: string;
  source: AgentDefinitionSource;
  definitionPath: string;
  mode: AgentMode;
  context: ContextPolicy;
  session: SessionPolicy;
  cwdPolicy: CwdPolicy;
  resultFormat: ResultFormat;
  tools: string[];
  skills: string[];
  extensions: string[];
  includes: string[];
  variants: Record<string, AgentDefinitionVariant>;
}

export interface DiscoverAgentDefinitionsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  allowProjectPathCapabilities?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json")) && basename(current) === "async-subagents") return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start, "..");
    current = parent;
  }
}

export const packageRoot = findPackageRoot(here);
export const builtinAgentsDir = join(packageRoot, "agents");

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function stringArray(value: unknown, field: string, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be an array of strings in ${path}`);
  }
  return value;
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be a string in ${path}`);
  return value;
}

function optionalNumber(value: unknown, field: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be a number in ${path}`);
  return value;
}

function assertEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T, path: string): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be one of ${allowed.join(", ")} in ${path}`);
}

function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], path: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be one of ${allowed.join(", ")} in ${path}`);
}

function isPathCapability(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.includes("/") || value.includes("\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseAgentVariant(name: string, value: unknown, path: string): AgentDefinitionVariant {
  if (!isRecord(value)) throw new SubagentError("INVALID_AGENT_DEFINITION", `variant ${name} must be a map in ${path}`);
  const allowed = new Set(["model", "thinkingLevel", "thinking_level", "tools", "skills", "extensions", "includes", "mode", "context", "session", "maxRunMs", "maxSubagentDepth", "cwdPolicy", "resultFormat"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SubagentError("INVALID_AGENT_DEFINITION", `unknown variant field ${key} in ${path}`);
  }
  return {
    model: optionalString(value.model, `variants.${name}.model`, path),
    thinkingLevel: optionalEnum(value.thinkingLevel ?? value.thinking_level, `variants.${name}.thinkingLevel`, THINKING_LEVELS, path),
    tools: value.tools === undefined ? undefined : stringArray(value.tools, `variants.${name}.tools`, path),
    skills: value.skills === undefined ? undefined : stringArray(value.skills, `variants.${name}.skills`, path),
    extensions: value.extensions === undefined ? undefined : stringArray(value.extensions, `variants.${name}.extensions`, path),
    includes: value.includes === undefined ? undefined : stringArray(value.includes, `variants.${name}.includes`, path),
    mode: optionalEnum(value.mode, `variants.${name}.mode`, ["oneshot", "interactive"] as const, path),
    context: optionalEnum(value.context, `variants.${name}.context`, ["fresh", "fork"] as const, path),
    session: optionalEnum(value.session, `variants.${name}.session`, ["record", "none"] as const, path),
    maxRunMs: optionalNumber(value.maxRunMs, `variants.${name}.maxRunMs`, path),
    maxSubagentDepth: optionalNumber(value.maxSubagentDepth, `variants.${name}.maxSubagentDepth`, path),
    cwdPolicy: optionalEnum(value.cwdPolicy, `variants.${name}.cwdPolicy`, ["inherit", "explicit", "sandbox"] as const, path),
    resultFormat: optionalEnum(value.resultFormat, `variants.${name}.resultFormat`, ["text", "json", "files"] as const, path),
  };
}

function parseAgentVariants(value: unknown, path: string): Record<string, AgentDefinitionVariant> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new SubagentError("INVALID_AGENT_DEFINITION", `variants must be a map in ${path}`);
  return Object.fromEntries(Object.entries(value).map(([name, variant]) => [name, parseAgentVariant(name, variant, path)]));
}

export function applyAgentVariant(definition: ResolvedAgentDefinition, variantName?: string): ResolvedAgentDefinition {
  if (!variantName) return definition;
  const variant = definition.variants[variantName];
  if (!variant) {
    throw new SubagentError("AGENT_VARIANT_NOT_FOUND", `agent variant not found: ${definition.name}/${variantName}`, {
      agent: definition.name,
      variant: variantName,
      availableVariants: Object.keys(definition.variants).sort(),
    });
  }
  return {
    ...definition,
    model: variant.model ?? definition.model,
    thinkingLevel: variant.thinkingLevel ?? definition.thinkingLevel,
    tools: variant.tools ?? definition.tools,
    skills: variant.skills ?? definition.skills,
    extensions: variant.extensions ?? definition.extensions,
    includes: variant.includes ?? definition.includes,
    mode: variant.mode ?? definition.mode,
    context: variant.context ?? definition.context,
    session: variant.session ?? definition.session,
    maxRunMs: variant.maxRunMs ?? definition.maxRunMs,
    maxSubagentDepth: variant.maxSubagentDepth ?? definition.maxSubagentDepth,
    cwdPolicy: variant.cwdPolicy ?? definition.cwdPolicy,
    resultFormat: variant.resultFormat ?? definition.resultFormat,
  };
}

export function parseAgentDefinitionFile(path: string, source: AgentDefinitionSource, options: { allowProjectPathCapabilities?: boolean } = {}): ResolvedAgentDefinition {
  const parsed = parseFrontmatter(readFileSync(path, "utf8"), path);
  const name = optionalString(parsed.data.name, "name", path) ?? basename(path, ".md");
  const description = optionalString(parsed.data.description, "description", path);
  if (!description) throw new SubagentError("INVALID_AGENT_DEFINITION", `description is required in ${path}`);
  const skills = stringArray(parsed.data.skills, "skills", path);
  const extensions = stringArray(parsed.data.extensions, "extensions", path);
  const variants = parseAgentVariants(parsed.data.variants, path);
  if (source === "project" && !options.allowProjectPathCapabilities) {
    const variantCapabilities = Object.values(variants).flatMap((variant) => [...(variant.skills ?? []), ...(variant.extensions ?? [])]);
    const pathCapabilities = [...skills, ...extensions, ...variantCapabilities].filter(isPathCapability);
    if (pathCapabilities.length) {
      throw new SubagentError("UNTRUSTED_PROJECT_CAPABILITY", "project-local path-based skills/extensions require explicit approval", {
        path,
        capabilities: pathCapabilities,
      });
    }
  }
  return {
    name,
    description,
    model: optionalString(parsed.data.model, "model", path),
    thinkingLevel: optionalEnum(parsed.data.thinkingLevel ?? parsed.data.thinking_level, "thinkingLevel", THINKING_LEVELS, path),
    tools: stringArray(parsed.data.tools, "tools", path),
    skills,
    extensions,
    includes: stringArray(parsed.data.includes, "includes", path),
    variants,
    mode: assertEnum(parsed.data.mode, "mode", ["oneshot", "interactive"] as const, "oneshot", path),
    context: assertEnum(parsed.data.context, "context", ["fresh", "fork"] as const, "fresh", path),
    session: assertEnum(parsed.data.session, "session", ["record", "none"] as const, "record", path),
    maxRunMs: optionalNumber(parsed.data.maxRunMs, "maxRunMs", path),
    maxSubagentDepth: optionalNumber(parsed.data.maxSubagentDepth, "maxSubagentDepth", path),
    cwdPolicy: assertEnum(parsed.data.cwdPolicy, "cwdPolicy", ["inherit", "explicit", "sandbox"] as const, "inherit", path),
    resultFormat: assertEnum(parsed.data.resultFormat, "resultFormat", ["text", "json", "files"] as const, "text", path),
    body: parsed.body,
    source,
    definitionPath: path,
  };
}

function addDefinitions(map: Map<string, ResolvedAgentDefinition>, files: string[], source: AgentDefinitionSource, options: DiscoverAgentDefinitionsOptions): void {
  for (const path of files) {
    const definition = parseAgentDefinitionFile(path, source, options);
    map.set(definition.name, definition);
  }
}

export function discoverAgentDefinitions(options: DiscoverAgentDefinitionsOptions): Map<string, ResolvedAgentDefinition> {
  const env = options.env ?? process.env;
  const userRoot = options.userHome ? resolve(options.userHome) : asyncSubagentsHome(env);
  const definitions = new Map<string, ResolvedAgentDefinition>();
  addDefinitions(definitions, mdFiles(builtinAgentsDir), "builtin", options);
  addDefinitions(definitions, mdFiles(join(userRoot, "agents")), "user", options);
  addDefinitions(definitions, mdFiles(join(resolve(options.cwd), ".agents")), "project", options);
  addDefinitions(definitions, mdFiles(join(resolve(options.cwd), ".agents", "subagents")), "project", options);
  return definitions;
}

export function resolveAgentDefinition(name: string, options: DiscoverAgentDefinitionsOptions): ResolvedAgentDefinition {
  const definition = discoverAgentDefinitions(options).get(name);
  if (!definition) throw new SubagentError("AGENT_NOT_FOUND", `agent definition not found: ${name}`, { name });
  return definition;
}

export function loadIncludeFragments(definition: ResolvedAgentDefinition, options: DiscoverAgentDefinitionsOptions): PromptFragment[] {
  const roots: Array<{ source: AgentDefinitionSource; dir: string }> = [
    { source: "builtin", dir: join(builtinAgentsDir, "..", "includes") },
    { source: "user", dir: join(options.userHome ? resolve(options.userHome) : asyncSubagentsHome(options.env ?? process.env), "includes") },
    { source: "project", dir: join(resolve(options.cwd), ".agents", "includes") },
  ];
  return definition.includes.map((include) => {
    for (const root of roots) {
      const path = include.endsWith(".md") ? join(root.dir, include) : join(root.dir, `${include}.md`);
      if (existsSync(path)) return { name: include, path, body: readFileSync(path, "utf8").trim(), source: root.source };
    }
    throw new SubagentError("INCLUDE_NOT_FOUND", `include not found for agent ${definition.name}: ${include}`, { include, roots });
  });
}

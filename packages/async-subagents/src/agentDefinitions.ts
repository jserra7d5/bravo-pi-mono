import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asyncSubagentsHome } from "./config.js";
import { SubagentError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import { THINKING_LEVELS } from "./schemas.js";
import type { AgentDefinitionSource, AgentHarness, AgentMode, ClaudeDefinitionOptions, ClaudeEffort, ContextPolicy, CwdPolicy, HarnessBoundaryProvenance, ResultFormat, SessionPolicy, ThinkingLevel } from "./types.js";

export interface AgentDefinitionVariant {
  harness?: AgentHarness;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  effort?: ClaudeEffort;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  includes?: string[];
  mode?: AgentMode;
  claude?: ClaudeDefinitionOptions;
  context?: ContextPolicy;
  session?: SessionPolicy;
  maxRunSeconds?: number;
  maxSubagentDepth?: number;
  cwdPolicy?: CwdPolicy;
  resultFormat?: ResultFormat;
  harnessNeutral?: boolean;
}

export interface MarkdownAgentDefinition {
  name?: string;
  description: string;
  harness?: AgentHarness;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  effort?: ClaudeEffort;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  includes?: string[];
  mode?: AgentMode;
  claude?: ClaudeDefinitionOptions;
  context?: ContextPolicy;
  session?: SessionPolicy;
  maxRunSeconds?: number;
  maxSubagentDepth?: number;
  cwdPolicy?: CwdPolicy;
  resultFormat?: ResultFormat;
  harnessNeutral?: boolean;
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
  harness: AgentHarness;
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
  notInheritedAcrossHarness?: HarnessBoundaryProvenance[];
  excludedAcrossHarness?: HarnessBoundaryProvenance[];
  inheritedAcrossHarness?: HarnessBoundaryProvenance[];
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

function optionalBoolean(value: unknown, field: string, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be a boolean in ${path}`);
  return value;
}

function optionalPositiveNumber(value: unknown, field: string, path: string): number | undefined {
  const parsed = optionalNumber(value, field, path);
  if (parsed !== undefined && parsed <= 0) throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be a positive number in ${path}`);
  return parsed;
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

/**
 * Turn a declared Pi extension into a path the child can actually load.
 *
 * The child launches with `--no-extensions` and each extension is passed verbatim as
 * `-e <value>`, resolved against the CHILD's cwd — the target repo, not this package. So a
 * built-in template cannot name an extension by relative path, and an absolute path would
 * pin the template to one machine's checkout. Package subpath specifiers
 * (`@bravo/web-evidence-cache/extensions/pi`) resolve here, at definition-load time,
 * through normal node resolution, which makes a built-in template portable.
 *
 * Absolute paths, relative paths, and bare names pass through untouched: user- and
 * project-scoped definitions that already name a file, and pi's own named extensions,
 * keep working exactly as before.
 */
function resolveExtensionSpecifier(value: string, field: string, path: string): string {
  // Absolute and relative paths, and bare names (an opaque extension identifier pi resolves
  // itself), are not ours to touch. Only a package subpath specifier gets resolved.
  if (value.startsWith("/") || value.startsWith(".") || !value.includes("/")) return value;
  try {
    return fileURLToPath(import.meta.resolve(value));
  } catch (error) {
    throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} could not resolve Pi extension ${value} in ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      path,
      specifier: value,
      hint: "Declare an extension as an absolute path, or as a package specifier whose package exports that subpath (for example @bravo/web-evidence-cache/extensions/pi).",
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const unsupportedMcpFields = new Set(["extraMcpServers", "claudeExtraMcpServers", "mcpServers", "mcpConfig"]);

function throwIfUnsupportedMcpField(key: string, field: string, path: string): void {
  if (unsupportedMcpFields.has(key)) {
    throw new SubagentError("EXTRA_MCP_UNSUPPORTED", `${field}.${key} is not supported in ${path}`);
  }
}

function parseClaudeOptions(value: unknown, field: string, path: string): ClaudeDefinitionOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SubagentError("INVALID_AGENT_DEFINITION", `${field} must be a map in ${path}`);
  const allowed = new Set(["executionMode", "authHome", "mode"]);
  for (const key of Object.keys(value)) {
    throwIfUnsupportedMcpField(key, field, path);
    if (!allowed.has(key)) throw new SubagentError("INVALID_AGENT_DEFINITION", `unknown ${field} field ${key} in ${path}`);
  }
  return {
    executionMode: optionalEnum(value.executionMode, `${field}.executionMode`, ["dangerous-auth"] as const, path),
    authHome: optionalEnum(value.authHome, `${field}.authHome`, ["seeded-run-home", "operator-home"] as const, path),
    mode: optionalEnum(value.mode, `${field}.mode`, ["oneshot", "interactive"] as const, path),
  };
}

function validateClaudeResolved(definition: Pick<ResolvedAgentDefinition, "name" | "harness" | "tools" | "extensions" | "thinkingLevel" | "claude">, path: string): void {
  if (definition.harness !== "claude") return;
  if (definition.tools.length) throw new SubagentError("INVALID_AGENT_DEFINITION", `Claude agent ${definition.name} cannot declare Pi tools in ${path}`);
  if (definition.extensions.length) throw new SubagentError("INVALID_AGENT_DEFINITION", `Claude agent ${definition.name} cannot declare Pi extensions in ${path}`);
  if (definition.thinkingLevel) throw new SubagentError("INVALID_AGENT_DEFINITION", `Claude agent ${definition.name} cannot declare Pi thinkingLevel in ${path}`);
  if (definition.claude?.executionMode && definition.claude.executionMode !== "dangerous-auth") throw new SubagentError("INVALID_AGENT_DEFINITION", `unsupported Claude executionMode in ${path}`);
}

function parseAgentVariant(name: string, value: unknown, path: string): AgentDefinitionVariant {
  if (!isRecord(value)) throw new SubagentError("INVALID_AGENT_DEFINITION", `variant ${name} must be a map in ${path}`);
  const allowed = new Set(["harness", "model", "thinkingLevel", "thinking_level", "effort", "tools", "skills", "extensions", "includes", "mode", "claude", "context", "session", "maxRunSeconds", "maxRunMs", "maxSubagentDepth", "cwdPolicy", "resultFormat", "harnessNeutral"]);
  for (const key of Object.keys(value)) {
    throwIfUnsupportedMcpField(key, `variants.${name}`, path);
    if (key === "maxRunMs") throw new SubagentError("INVALID_AGENT_DEFINITION", `variants.${name}.maxRunMs has been replaced by variants.${name}.maxRunSeconds in ${path}; use seconds, for example maxRunSeconds: 1800`);
    if (!allowed.has(key)) throw new SubagentError("INVALID_AGENT_DEFINITION", `unknown variant field ${key} in ${path}`);
  }
  const harness = optionalEnum(value.harness, `variants.${name}.harness`, ["pi", "claude"] as const, path);
  if (harness === "claude") {
    if (value.tools !== undefined) throw new SubagentError("INVALID_AGENT_DEFINITION", `variants.${name}.tools is Pi-only and cannot be set on a Claude variant in ${path}`);
    if (value.extensions !== undefined) throw new SubagentError("INVALID_AGENT_DEFINITION", `variants.${name}.extensions is Pi-only and cannot be set on a Claude variant in ${path}`);
    if (value.thinkingLevel !== undefined || value.thinking_level !== undefined) throw new SubagentError("INVALID_AGENT_DEFINITION", `variants.${name}.thinkingLevel is Pi-only and cannot be set on a Claude variant in ${path}`);
  }
  return {
    harness,
    model: optionalString(value.model, `variants.${name}.model`, path),
    thinkingLevel: optionalEnum(value.thinkingLevel ?? value.thinking_level, `variants.${name}.thinkingLevel`, THINKING_LEVELS, path),
    effort: optionalString(value.effort, `variants.${name}.effort`, path),
    tools: value.tools === undefined ? undefined : stringArray(value.tools, `variants.${name}.tools`, path),
    skills: value.skills === undefined ? undefined : stringArray(value.skills, `variants.${name}.skills`, path),
    extensions: value.extensions === undefined ? undefined : stringArray(value.extensions, `variants.${name}.extensions`, path).map((entry) => resolveExtensionSpecifier(entry, `variants.${name}.extensions`, path)),
    includes: value.includes === undefined ? undefined : stringArray(value.includes, `variants.${name}.includes`, path),
    mode: optionalEnum(value.mode, `variants.${name}.mode`, ["oneshot", "interactive"] as const, path),
    claude: parseClaudeOptions(value.claude, `variants.${name}.claude`, path),
    context: optionalEnum(value.context, `variants.${name}.context`, ["fresh", "fork"] as const, path),
    session: optionalEnum(value.session, `variants.${name}.session`, ["record", "none"] as const, path),
    maxRunSeconds: optionalPositiveNumber(value.maxRunSeconds, `variants.${name}.maxRunSeconds`, path),
    maxSubagentDepth: optionalNumber(value.maxSubagentDepth, `variants.${name}.maxSubagentDepth`, path),
    cwdPolicy: optionalEnum(value.cwdPolicy, `variants.${name}.cwdPolicy`, ["inherit", "explicit", "sandbox"] as const, path),
    resultFormat: optionalEnum(value.resultFormat, `variants.${name}.resultFormat`, ["text", "json", "files"] as const, path),
    harnessNeutral: optionalBoolean(value.harnessNeutral, `variants.${name}.harnessNeutral`, path),
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
  const harness = variant.harness ?? definition.harness;
  const crossesHarness = harness !== definition.harness;
  const notInheritedAcrossHarness: HarnessBoundaryProvenance[] = [];
  const excludedAcrossHarness: HarnessBoundaryProvenance[] = [];
  const inheritedAcrossHarness: HarnessBoundaryProvenance[] = [];
  if (crossesHarness && harness === "claude") {
    if (!definition.harnessNeutral) {
      throw new SubagentError("INVALID_AGENT_DEFINITION", `Claude variant ${definition.name}/${variantName} cannot inherit base Pi prompt body unless base sets harnessNeutral: true in ${definition.definitionPath}`);
    }
    inheritedAcrossHarness.push({ field: "body", source: "base", reason: "neutral-compatible" });
    if (definition.tools.length) notInheritedAcrossHarness.push({ field: "tools", source: "base", reason: "pi-only" });
    if (definition.extensions.length) notInheritedAcrossHarness.push({ field: "extensions", source: "base", reason: "pi-only" });
    if (definition.thinkingLevel) notInheritedAcrossHarness.push({ field: "thinkingLevel", source: "base", reason: "pi-only" });
    if (definition.includes.length && variant.includes === undefined) excludedAcrossHarness.push({ field: "includes", source: "base", reason: "harness-boundary" });
  }
  const resolved: ResolvedAgentDefinition = {
    ...definition,
    harness,
    model: variant.model ?? definition.model,
    thinkingLevel: crossesHarness && harness === "claude" ? undefined : variant.thinkingLevel ?? definition.thinkingLevel,
    effort: variant.effort ?? definition.effort,
    tools: crossesHarness && harness === "claude" ? [] : variant.tools ?? definition.tools,
    skills: variant.skills ?? definition.skills,
    extensions: crossesHarness && harness === "claude" ? [] : variant.extensions ?? definition.extensions,
    includes: crossesHarness && harness === "claude" ? variant.includes ?? [] : variant.includes ?? definition.includes,
    mode: variant.mode ?? variant.claude?.mode ?? definition.claude?.mode ?? (harness === "claude" ? "interactive" : definition.mode),
    claude: { ...definition.claude, ...variant.claude },
    context: variant.context ?? definition.context,
    session: variant.session ?? definition.session,
    maxRunSeconds: variant.maxRunSeconds ?? definition.maxRunSeconds,
    maxSubagentDepth: variant.maxSubagentDepth ?? definition.maxSubagentDepth,
    cwdPolicy: variant.cwdPolicy ?? definition.cwdPolicy,
    resultFormat: variant.resultFormat ?? definition.resultFormat,
    harnessNeutral: variant.harnessNeutral ?? definition.harnessNeutral,
    notInheritedAcrossHarness: [...(definition.notInheritedAcrossHarness ?? []), ...notInheritedAcrossHarness],
    excludedAcrossHarness: [...(definition.excludedAcrossHarness ?? []), ...excludedAcrossHarness],
    inheritedAcrossHarness: [...(definition.inheritedAcrossHarness ?? []), ...inheritedAcrossHarness],
  };
  validateClaudeResolved(resolved, definition.definitionPath);
  return resolved;
}

export function parseAgentDefinitionFile(path: string, source: AgentDefinitionSource, options: { allowProjectPathCapabilities?: boolean } = {}): ResolvedAgentDefinition {
  const parsed = parseFrontmatter(readFileSync(path, "utf8"), path);
  const topLevelAllowed = new Set(["name", "description", "harness", "model", "thinkingLevel", "thinking_level", "effort", "tools", "skills", "extensions", "includes", "mode", "claude", "context", "session", "maxRunSeconds", "maxRunMs", "maxSubagentDepth", "cwdPolicy", "resultFormat", "harnessNeutral", "variants"]);
  for (const key of Object.keys(parsed.data)) {
    throwIfUnsupportedMcpField(key, "frontmatter", path);
    if (!topLevelAllowed.has(key)) throw new SubagentError("INVALID_AGENT_DEFINITION", `unknown top-level field ${key} in ${path}`);
  }
  const name = optionalString(parsed.data.name, "name", path) ?? basename(path, ".md");
  const description = optionalString(parsed.data.description, "description", path);
  if (!description) throw new SubagentError("INVALID_AGENT_DEFINITION", `description is required in ${path}`);
  const skills = stringArray(parsed.data.skills, "skills", path);
  const extensions = stringArray(parsed.data.extensions, "extensions", path).map((entry) => resolveExtensionSpecifier(entry, "extensions", path));
  const variants = parseAgentVariants(parsed.data.variants, path);
  if (parsed.data.maxRunMs !== undefined) throw new SubagentError("INVALID_AGENT_DEFINITION", `maxRunMs has been replaced by maxRunSeconds in ${path}; use seconds, for example maxRunSeconds: 1800`);
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
  const harness = assertEnum(parsed.data.harness, "harness", ["pi", "claude"] as const, "pi", path);
  const definition: ResolvedAgentDefinition = {
    name,
    description,
    harness,
    model: optionalString(parsed.data.model, "model", path),
    thinkingLevel: optionalEnum(parsed.data.thinkingLevel ?? parsed.data.thinking_level, "thinkingLevel", THINKING_LEVELS, path),
    effort: optionalString(parsed.data.effort, "effort", path),
    tools: stringArray(parsed.data.tools, "tools", path),
    skills,
    extensions,
    includes: stringArray(parsed.data.includes, "includes", path),
    variants,
    claude: parseClaudeOptions(parsed.data.claude, "claude", path),
    mode: parsed.data.mode === undefined && harness === "claude" ? "interactive" : assertEnum(parsed.data.mode, "mode", ["oneshot", "interactive"] as const, "oneshot", path),
    context: assertEnum(parsed.data.context, "context", ["fresh", "fork"] as const, "fresh", path),
    session: assertEnum(parsed.data.session, "session", ["record", "none"] as const, "record", path),
    maxRunSeconds: optionalPositiveNumber(parsed.data.maxRunSeconds, "maxRunSeconds", path),
    maxSubagentDepth: optionalNumber(parsed.data.maxSubagentDepth, "maxSubagentDepth", path),
    cwdPolicy: assertEnum(parsed.data.cwdPolicy, "cwdPolicy", ["inherit", "explicit", "sandbox"] as const, "inherit", path),
    resultFormat: assertEnum(parsed.data.resultFormat, "resultFormat", ["text", "json", "files"] as const, "text", path),
    harnessNeutral: optionalBoolean(parsed.data.harnessNeutral, "harnessNeutral", path),
    body: parsed.body,
    source,
    definitionPath: path,
  };
  validateClaudeResolved(definition, path);
  return definition;
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

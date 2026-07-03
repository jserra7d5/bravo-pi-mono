import { applyAgentVariant, discoverAgentDefinitions, type AgentDefinitionVariant, type ResolvedAgentDefinition } from "../../src/agentDefinitions.js";
import { resolveClaudeModel } from "../../src/claudeHarness.js";

export interface AgentCatalogVariantEntry {
  name: string;
  harness: string;
  thinkingLevel?: string;
  effort?: string;
  mode?: string;
  executionMode?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  notInheritedAcrossHarness?: string[];
  access: AgentAccess;
  capabilities: string[];
  invalidReason?: string;
}

export interface AgentCatalogEntry {
  name: string;
  description: string;
  harness: string;
  thinkingLevel?: string;
  effort?: string;
  mode?: string;
  executionMode?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  invalidReason?: string;
  variants: AgentCatalogVariantEntry[];
  access: AgentAccess;
  capabilities: string[];
}

export interface AgentCatalogRenderOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

type AgentAccess = "read-only" | "mutation-capable";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch", "web_lookup"]);

function hasAny(values: string[], needles: Set<string>): boolean {
  return values.some((value) => needles.has(value));
}

function sanitizeCatalogText(value: string, max = 180): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[`*_#[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function capabilitySummary(tools: string[], skills: string[], extensions: string[], harness = "pi"): { access: AgentAccess; capabilities: string[] } {
  if (harness === "claude") return { access: "mutation-capable", capabilities: ["claude-code", "mcp-child-control", ...(skills.length ? ["skills"] : [])] };
  const capabilities: string[] = [];
  const mutationCapable = hasAny(tools, MUTATION_TOOLS);

  if (hasAny(tools, READ_TOOLS)) capabilities.push("read");
  if (tools.includes("bash")) capabilities.push("bash");
  if (hasAny(tools, WEB_TOOLS)) capabilities.push("web");
  if (skills.length) capabilities.push("skills");
  if (extensions.length) capabilities.push("extensions");

  return { access: mutationCapable ? "mutation-capable" : "read-only", capabilities };
}

function variantEntry(definition: ResolvedAgentDefinition, name: string, variant: AgentDefinitionVariant): AgentCatalogVariantEntry {
  const entryName = sanitizeCatalogText(name, 48);
  try {
    const resolved = applyAgentVariant(definition, name);
    const summary = capabilitySummary(resolved.tools ?? [], resolved.skills, resolved.extensions, resolved.harness);
    const claudeModel = resolved.harness === "claude" ? resolveClaudeModel(resolved.model) : undefined;
    return {
      name: entryName,
      harness: resolved.harness,
      thinkingLevel: resolved.harness === "claude" ? undefined : resolved.thinkingLevel,
      effort: resolved.harness === "claude" ? resolved.effort : undefined,
      mode: resolved.mode,
      executionMode: resolved.harness === "claude" ? resolved.claude?.executionMode ?? "dangerous-auth" : undefined,
      model: claudeModel?.resolvedModel,
      requestedModel: claudeModel?.requestedModel,
      resolvedModel: claudeModel?.resolvedModel,
      notInheritedAcrossHarness: resolved.notInheritedAcrossHarness?.map((item) => `${item.field} (${item.reason})`),
      ...summary,
    };
  } catch (error) {
    const harness = variant.harness ?? definition.harness;
    const summary = capabilitySummary([], [], [], harness);
    let invalidReason = error instanceof Error ? error.message : String(error);
    let claudeModel: ReturnType<typeof resolveClaudeModel> | undefined;
    if (harness === "claude") {
      try {
        claudeModel = resolveClaudeModel(variant.model ?? definition.model);
      } catch (modelError) {
        invalidReason = `${invalidReason}; ${modelError instanceof Error ? modelError.message : String(modelError)}`;
      }
    }
    return {
      name: entryName,
      harness,
      thinkingLevel: harness === "claude" ? undefined : variant.thinkingLevel ?? definition.thinkingLevel,
      effort: harness === "claude" ? variant.effort ?? definition.effort : undefined,
      mode: harness === "claude" ? variant.mode ?? variant.claude?.mode ?? definition.claude?.mode ?? "interactive" : variant.mode ?? definition.mode,
      executionMode: harness === "claude" ? variant.claude?.executionMode ?? definition.claude?.executionMode ?? "dangerous-auth" : undefined,
      model: claudeModel?.resolvedModel,
      requestedModel: claudeModel?.requestedModel,
      resolvedModel: claudeModel?.resolvedModel,
      invalidReason: sanitizeCatalogText(invalidReason, 220),
      ...summary,
    };
  }
}

export function catalogEntry(definition: ResolvedAgentDefinition): AgentCatalogEntry {
  const summary = capabilitySummary(definition.tools ?? [], definition.skills, definition.extensions, definition.harness);
  let claudeModel: ReturnType<typeof resolveClaudeModel> | undefined;
  let invalidReason: string | undefined;
  if (definition.harness === "claude") {
    try {
      claudeModel = resolveClaudeModel(definition.model);
    } catch (error) {
      invalidReason = sanitizeCatalogText(error instanceof Error ? error.message : String(error), 220);
    }
  }

  return {
    name: sanitizeCatalogText(definition.name, 64),
    description: sanitizeCatalogText(definition.description),
    harness: definition.harness,
    thinkingLevel: definition.harness === "claude" ? undefined : definition.thinkingLevel,
    effort: definition.harness === "claude" ? definition.effort : undefined,
    mode: definition.mode,
    executionMode: definition.harness === "claude" ? definition.claude?.executionMode ?? "dangerous-auth" : undefined,
    model: claudeModel?.resolvedModel,
    requestedModel: claudeModel?.requestedModel,
    resolvedModel: claudeModel?.resolvedModel,
    invalidReason,
    variants: Object.entries(definition.variants)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, variant]) => variantEntry(definition, name, variant)),
    ...summary,
  };
}

export function discoverAgentCatalog(options: AgentCatalogRenderOptions): AgentCatalogEntry[] {
  return [...discoverAgentDefinitions({ cwd: options.cwd, env: options.env }).values()]
    .map(catalogEntry)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function capabilitiesText(capabilities: string[]): string {
  return capabilities.length ? capabilities.join(", ") : "none";
}

function variantText(variants: AgentCatalogVariantEntry[]): string {
  if (!variants.length) return "none";
  return variants.map((variant) => {
    const budget = variant.harness === "claude" ? `effort: ${variant.effort ?? "default"}` : `thinking: ${variant.thinkingLevel ?? "default"}`;
    const variantModel = variant.invalidReason && !variant.resolvedModel ? "unavailable" : variant.resolvedModel ?? variant.model ?? "claude-sonnet-5";
    const model = variant.harness === "claude" ? `; model: ${variantModel}` : "";
    const mode = variant.harness === "claude" ? `${model}; mode: ${variant.mode ?? "interactive"}; execution: ${variant.executionMode ?? "dangerous-auth"}; memory: best-effort-non-bare` : "";
    const provenance = variant.notInheritedAcrossHarness?.length ? `; not inherited: ${variant.notInheritedAcrossHarness.join(", ")}` : "";
    const invalid = variant.invalidReason ? `; unavailable: ${variant.invalidReason}` : "";
    return `${variant.name} (harness: ${variant.harness}; ${budget}${mode}; access: ${variant.access}; capabilities: ${capabilitiesText(variant.capabilities)}${provenance}${invalid})`;
  }).join(", ");
}

export function renderAgentCatalog(entries: AgentCatalogEntry[]): string {
  if (!entries.length) return "No subagent definitions discovered for this workspace.";
  return entries.map((entry) => {
    const entryModel = entry.invalidReason && !entry.resolvedModel ? "unavailable" : entry.resolvedModel ?? entry.model ?? "claude-sonnet-5";
    const budget = entry.harness === "claude" ? `effort: ${entry.effort ?? "default"}; model: ${entryModel}; mode: ${entry.mode ?? "interactive"}; execution: ${entry.executionMode ?? "dangerous-auth"}; memory: best-effort-non-bare` : `thinking: ${entry.thinkingLevel ?? "default"}`;
    const invalid = entry.invalidReason ? `; unavailable: ${entry.invalidReason}` : "";
    return `- \`${entry.name}\`\n  description: ${JSON.stringify(entry.description)}\n  harness: ${entry.harness}; ${budget}; access: ${entry.access}; capabilities: ${capabilitiesText(entry.capabilities)}${invalid}; variants: ${variantText(entry.variants)}`;
  }).join("\n");
}

export function renderDiscoveredAgentCatalog(options: AgentCatalogRenderOptions): string {
  try {
    return renderAgentCatalog(discoverAgentCatalog(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Subagent catalog unavailable: ${sanitizeCatalogText(message, 220)}`;
  }
}

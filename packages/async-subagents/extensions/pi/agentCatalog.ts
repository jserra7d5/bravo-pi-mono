import { discoverAgentDefinitions, type AgentDefinitionVariant, type ResolvedAgentDefinition } from "../../src/agentDefinitions.js";

export interface AgentCatalogVariantEntry {
  name: string;
  thinkingLevel?: string;
  access: AgentAccess;
  capabilities: string[];
}

export interface AgentCatalogEntry {
  name: string;
  description: string;
  thinkingLevel?: string;
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

function capabilitySummary(tools: string[], skills: string[], extensions: string[]): { access: AgentAccess; capabilities: string[] } {
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
  const summary = capabilitySummary(variant.tools ?? definition.tools, variant.skills ?? definition.skills, variant.extensions ?? definition.extensions);
  return {
    name: sanitizeCatalogText(name, 48),
    thinkingLevel: variant.thinkingLevel ?? definition.thinkingLevel,
    ...summary,
  };
}

export function catalogEntry(definition: ResolvedAgentDefinition): AgentCatalogEntry {
  const summary = capabilitySummary(definition.tools ?? [], definition.skills, definition.extensions);

  return {
    name: sanitizeCatalogText(definition.name, 64),
    description: sanitizeCatalogText(definition.description),
    thinkingLevel: definition.thinkingLevel,
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
    const thinking = variant.thinkingLevel ?? "default";
    return `${variant.name} (thinking: ${thinking}; access: ${variant.access}; capabilities: ${capabilitiesText(variant.capabilities)})`;
  }).join(", ");
}

export function renderAgentCatalog(entries: AgentCatalogEntry[]): string {
  if (!entries.length) return "No subagent definitions discovered for this workspace.";
  return entries.map((entry) => {
    const thinking = entry.thinkingLevel ?? "default";
    return `- \`${entry.name}\`\n  description: ${JSON.stringify(entry.description)}\n  thinking: ${thinking}; access: ${entry.access}; capabilities: ${capabilitiesText(entry.capabilities)}; variants: ${variantText(entry.variants)}`;
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

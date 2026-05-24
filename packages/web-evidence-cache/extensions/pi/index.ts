import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readConfig } from "../../src/config.js";
import { registryFor } from "../../src/cache.js";
import { braveSearch } from "../../src/brave.js";
import { assignSearchIdentities, searchContentSummary } from "../../src/search.js";
import { contextError, toolExecutionError } from "../../src/errors.js";
import { fetchContentSummary, fetchEvidence } from "../../src/fetch.js";
import { lookupContentSummary, lookupResult } from "../../src/lookup.js";
import type { EvidenceFormat, LookupMatchMode, SearchMode, WebFetchResult, WebLookupResult, WebSearchResult, WebSearchResultItem } from "../../src/types.js";
import { appendWebEvidencePrompt } from "./promptModule.js";
import { renderFetchCall, renderFetchResult, renderLookupCall, renderLookupResult, renderSearchCall, renderSearchResult } from "./renderers.js";

const SHARED_GUIDANCE = [
  "Use web_search only to discover candidate pages on the live web; titles and snippets are discovery leads, not evidence.",
  "Navigate search results by selecting promising aliases or UUID ids, then call web_fetch with those refs before relying on page content.",
  "Use web_fetch for promising search results or URLs that must be read, cited, or searched locally; read READ NEXT/best_path first and verify partial/weak extraction warnings before citing.",
  "Use web_lookup only after web_fetch, as recall-oriented search within already-fetched local artifacts; use match_mode=all or phrase to reduce noisy broad hits, and read READ NEXT/best_path context before relying on a hit.",
  "If web_lookup returns no matches, try broader or synonym terms, remove filters, fetch more sources, or run web_search; no matches are not proof of absence.",
  "Read artifact paths returned by web_fetch and web_lookup with normal filesystem tools before citing evidence; orientation previews/snippets are not citable evidence.",
  "Prefer primary sources and official documentation when choosing what to fetch.",
];

export const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query for discovering candidate pages. Treat returned titles/snippets as navigation leads; fetch selected refs before using evidence." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of discovery results to return." })),
  search_mode: Type.Optional(Type.String({ description: "Optional advanced knob. Defaults to auto. Allowed: auto, exact, broad. Use exact for quoted/phrase-sensitive discovery; use broad when initial discovery is too narrow." })),
  domains: Type.Optional(Type.Array(Type.String({ description: "Domain to include, converted to site: filters." }), { description: "Optional allowed domains for discovery." })),
  exclude_domains: Type.Optional(Type.Array(Type.String({ description: "Domain to exclude, converted to -site: filters." }), { description: "Optional domains to avoid in discovery." })),
  recency: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional Brave freshness/recency filter." })),
});

export const webFetchSchema = Type.Object({
  refs: Type.Array(Type.String({ description: "Absolute http(s) URLs, web_search result aliases/IDs, or previously fetched page UUIDs. Other strings are invalid refs." }), { minItems: 1, maxItems: 10 }),
  format: Type.Optional(Type.String({ description: "Advanced optional knob; normally omit it. Defaults to auto. Allowed: auto, semantic_html, markdown, text." })),
  refresh: Type.Optional(Type.String({ description: "Advanced optional knob; normally omit it. Defaults to auto. Use force only when you need to refetch a cached URL/page UUID. Allowed: auto, force." })),
});

export const webLookupSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  format: Type.Optional(Type.String({ description: "Optional advanced knob. Defaults to auto. Artifact format to return in lookup best_path/best_format. Allowed: auto, semantic_html, markdown, text." })),
  match_mode: Type.Optional(Type.String({ description: "Optional advanced knob. Defaults to any. Allowed: any, all, phrase. any returns chunks matching at least one query term; all requires every query term/quoted phrase; phrase searches the whole query as one phrase. Use all or phrase to reduce noisy broad hits." })),
});

type WebSearchArgs = Static<typeof webSearchSchema>;
type WebFetchArgs = Static<typeof webFetchSchema>;
type WebLookupArgs = Static<typeof webLookupSchema>;

type WebFetchRefresh = "auto" | "force";

const EVIDENCE_FORMATS: readonly EvidenceFormat[] = ["auto", "semantic_html", "markdown", "text"];
const SEARCH_MODES: readonly SearchMode[] = ["auto", "exact", "broad"];
const LOOKUP_MATCH_MODES: readonly LookupMatchMode[] = ["any", "all", "phrase"];
const WEB_FETCH_REFRESHES: readonly WebFetchRefresh[] = ["auto", "force"];

function response<T>(content: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: content }], details };
}

function validateAllowed<T extends string>(tool: string, field: string, value: string | undefined, allowed: readonly T[], defaultValue: T, recovery: string): T {
  if (value === undefined) return defaultValue;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw contextError(
    `Invalid ${tool} ${field}: ${value}. Allowed values: ${allowed.join(", ")}.`,
    recovery,
  );
}

function validateEvidenceFormat(tool: string, value: string | undefined): EvidenceFormat {
  return validateAllowed(tool, "format", value, EVIDENCE_FORMATS, "auto", "Omit format for the default auto behavior, or pass one of: auto, semantic_html, markdown, text.");
}

function validateWebFetchRefresh(value: string | undefined): WebFetchRefresh {
  return validateAllowed("web_fetch", "refresh", value, WEB_FETCH_REFRESHES, "auto", "Omit refresh for the default auto behavior, or pass one of: auto, force.");
}

function validateSearchMode(value: string | undefined): SearchMode {
  return validateAllowed("web_search", "search_mode", value, SEARCH_MODES, "auto", "Omit search_mode for the default auto behavior, or pass one of: auto, exact, broad.");
}

function validateLookupMatchMode(value: string | undefined): LookupMatchMode {
  return validateAllowed("web_lookup", "match_mode", value, LOOKUP_MATCH_MODES, "any", "Omit match_mode for the default any behavior, or pass one of: any, all, phrase.");
}

async function resolveFetchRef(ref: string, ctx: ExtensionContext): Promise<{ url: string; sourceResultId?: string }> {
  const registry = await registryFor(ctx);
  const search = registry.db.findSearchRef(ref);
  if (search) return { url: search.url, sourceResultId: search.id };
  const page = registry.db.findPageByIdOrAlias(ref);
  if (page) return { url: page.final_url ?? page.url, sourceResultId: page.source_result_id };
  if (/^https?:\/\//i.test(ref)) return { url: ref };
  throw toolExecutionError(
    `Invalid web_fetch ref: ${ref} is not an absolute http(s) URL, web_search result alias/ID, or fetched page UUID.`,
    "Pass an absolute http(s) URL, a web_search result alias/ID, or a fetched page UUID.",
  );
}

export function buildWebEvidenceTools() {
  return [
    defineTool({
      name: "web_search",
      label: "Web Search",
      description: "Discover candidate pages on the live web. Returns navigation leads with aliases and UUID ids; call web_fetch on selected refs before relying on content as evidence.",
      promptSnippet: "web_search: live web discovery only; titles/snippets are leads, not evidence. Select result aliases/UUID ids and follow with web_fetch for pages worth reading or citing.",
      promptGuidelines: SHARED_GUIDANCE,
      parameters: webSearchSchema,
      renderShell: "self",
      renderCall: renderSearchCall,
      renderResult: renderSearchResult,
      async execute(_toolCallId: string, params: WebSearchArgs, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WebSearchResult>> {
        const searchMode = validateSearchMode(params.search_mode);
        const config = readConfig();
        const registry = await registryFor(ctx);
        const searchInput = {
          query: params.query,
          limit: params.limit,
          search_mode: searchMode,
          domains: params.domains,
          exclude_domains: params.exclude_domains,
          recency: params.recency,
        };
        const raw = await braveSearch(searchInput, config, signal);
        const records = assignSearchIdentities(raw, searchInput, () => `r${registry.nextResultAlias++}`);
        registry.db.insertSearchResults(records);
        const results: WebSearchResultItem[] = records.map((r) => ({ id: r.id, alias: r.alias, title: r.title, url: r.url, snippet: r.snippet, provider: r.provider }));
        return response(searchContentSummary(records), { results, count: results.length, truncated: false, next_cursor: null });
      },
    }),
    defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description: "Fetch selected URLs, web_search result refs, or fetched page UUIDs into local readable artifacts and index them; returns visually prioritized READ NEXT/best_path plus all artifact paths in details.",
      promptSnippet: "web_fetch: use after selecting promising leads; normally pass only { refs }; format/refresh are optional advanced knobs that default to auto. Read READ NEXT/best_path first and verify partial/weak extraction warnings before citing.",
      promptGuidelines: SHARED_GUIDANCE,
      parameters: webFetchSchema,
      renderShell: "self",
      renderCall: renderFetchCall,
      renderResult: renderFetchResult,
      async execute(_toolCallId: string, params: WebFetchArgs, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WebFetchResult>> {
        const format = validateEvidenceFormat("web_fetch", params.format);
        const refresh = validateWebFetchRefresh(params.refresh);
        const registry = await registryFor(ctx);
        const config = readConfig();
        const results = [];
        for (const ref of params.refs) {
          results.push(await fetchEvidence(await resolveFetchRef(ref, ctx), registry, config, format, refresh, signal));
        }
        return response(fetchContentSummary(results), { results, count: results.length, truncated: false });
      },
    }),
    defineTool({
      name: "web_lookup",
      label: "Web Lookup",
      description: "Recall-oriented search only over already-fetched local web evidence artifacts; optional match_mode any/all/phrase controls noisy broad hits; no matches are not proof of absence.",
      promptSnippet: "web_lookup: BM25 lookup inside local artifacts already created by web_fetch; match_mode defaults to any, use all/phrase when common terms create noisy hits; read READ NEXT/best_path context, and treat no matches as a cue to broaden/fetch more, not proof of absence.",
      promptGuidelines: SHARED_GUIDANCE,
      parameters: webLookupSchema,
      renderShell: "self",
      renderCall: renderLookupCall,
      renderResult: renderLookupResult,
      async execute(_toolCallId: string, params: WebLookupArgs, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WebLookupResult>> {
        const format = validateEvidenceFormat("web_lookup", params.format);
        const matchMode = validateLookupMatchMode(params.match_mode);
        const registry = await registryFor(ctx);
        const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
        const results = registry.db.lookup(params.query, limit, params.domain, format, matchMode);
        const details = lookupResult(results, limit);
        return response(lookupContentSummary(details.results), details);
      },
    }),
  ];
}

export default function webEvidenceCacheExtension(pi: ExtensionAPI) {
  for (const tool of buildWebEvidenceTools()) pi.registerTool(tool as never);
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: appendWebEvidencePrompt(event.systemPrompt),
  }));
}

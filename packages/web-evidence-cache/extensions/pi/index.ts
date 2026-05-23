import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readConfig } from "../../src/config.js";
import { registryFor } from "../../src/cache.js";
import { braveSearch } from "../../src/brave.js";
import { assignSearchIdentities, searchContentSummary } from "../../src/search.js";
import { toolExecutionError } from "../../src/errors.js";
import { fetchContentSummary, fetchEvidence } from "../../src/fetch.js";
import { lookupContentSummary, lookupResult } from "../../src/lookup.js";
import type { WebFetchResult, WebLookupResult, WebSearchResult, WebSearchResultItem } from "../../src/types.js";
import { appendWebEvidencePrompt } from "./promptModule.js";
import { renderFetchCall, renderFetchResult, renderLookupCall, renderLookupResult, renderSearchCall, renderSearchResult } from "./renderers.js";

const SHARED_GUIDANCE = [
  "Use web_search only to discover candidate pages on the live web; titles and snippets are not evidence.",
  "Use web_fetch for promising search results or URLs that must be read, cited, or searched locally; prefer best_path and verify partial/weak extraction before citing.",
  "Use web_lookup only after web_fetch, as recall-oriented search within already-fetched local artifacts; no matches are not proof of absence.",
  "Read artifact paths returned by web_fetch and web_lookup with normal filesystem tools before citing evidence.",
  "Prefer primary sources and official documentation when choosing what to fetch.",
];

export const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query for discovering candidate pages. Do not treat returned titles/snippets as evidence." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of discovery results to return." })),
  search_mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("exact"), Type.Literal("broad")], { description: "Use exact for quoted/phrase-sensitive discovery; use broad when initial discovery is too narrow." })),
  domains: Type.Optional(Type.Array(Type.String({ description: "Domain to include, converted to site: filters." }), { description: "Optional allowed domains for discovery." })),
  exclude_domains: Type.Optional(Type.Array(Type.String({ description: "Domain to exclude, converted to -site: filters." }), { description: "Optional domains to avoid in discovery." })),
  recency: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional Brave freshness/recency filter." })),
});

export const webFetchSchema = Type.Object({
  refs: Type.Array(Type.String({ description: "Absolute http(s) URLs, web_search result aliases/IDs, or previously fetched page UUIDs. Other strings are invalid refs." }), { minItems: 1, maxItems: 10 }),
  format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("semantic_html"), Type.Literal("markdown"), Type.Literal("text")], { description: "Artifact format to prefer in best_path/best_format. Allowed: auto, semantic_html, markdown, text." })),
  refresh: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("force")], { description: "Use auto to reuse already-fetched pages by URL/page UUID; use force to fetch again. Allowed: auto, force." })),
});

export const webLookupSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("semantic_html"), Type.Literal("markdown"), Type.Literal("text")], { description: "Artifact format to return in lookup best_path/best_format. Lookup is recall-oriented over fetched artifacts only, not proof of absence. Allowed: auto, semantic_html, markdown, text." })),
});

type WebSearchArgs = Static<typeof webSearchSchema>;
type WebFetchArgs = Static<typeof webFetchSchema>;
type WebLookupArgs = Static<typeof webLookupSchema>;

function response<T>(content: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: content }], details };
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
      description: "Discover candidate pages on the live web. Returns leads only; use web_fetch before relying on content as evidence.",
      promptSnippet: "web_search: live web discovery only; titles/snippets are leads, not evidence. Follow with web_fetch for pages worth reading or citing.",
      promptGuidelines: SHARED_GUIDANCE,
      parameters: webSearchSchema,
      renderShell: "self",
      renderCall: renderSearchCall,
      renderResult: renderSearchResult,
      async execute(_toolCallId: string, params: WebSearchArgs, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WebSearchResult>> {
        const config = readConfig();
        const registry = await registryFor(ctx);
        const raw = await braveSearch(params, config, signal);
        const records = assignSearchIdentities(raw, params, () => `r${registry.nextResultAlias++}`);
        registry.db.insertSearchResults(records);
        const results: WebSearchResultItem[] = records.map((r) => ({ id: r.id, alias: r.alias, title: r.title, url: r.url, snippet: r.snippet, provider: r.provider }));
        return response(searchContentSummary(records), { results, count: results.length, truncated: false, next_cursor: null });
      },
    }),
    defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description: "Fetch selected URLs, web_search result refs, or fetched page UUIDs into local readable artifacts and index them; returns best_path/best_format plus all artifact paths.",
      promptSnippet: "web_fetch: use after selecting promising leads; read best_path first and verify partial/weak extraction before citing.",
      promptGuidelines: SHARED_GUIDANCE,
      parameters: webFetchSchema,
      renderShell: "self",
      renderCall: renderFetchCall,
      renderResult: renderFetchResult,
      async execute(_toolCallId: string, params: WebFetchArgs, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WebFetchResult>> {
        const registry = await registryFor(ctx);
        const config = readConfig();
        const format = params.format ?? "auto";
        const results = [];
        for (const ref of params.refs) {
          results.push(await fetchEvidence(await resolveFetchRef(ref, ctx), registry, config, format, params.refresh ?? "auto", signal));
        }
        return response(fetchContentSummary(results), { results, count: results.length, truncated: false });
      },
    }),
    defineTool({
      name: "web_lookup",
      label: "Web Lookup",
      description: "Recall-oriented search only over already-fetched local web evidence artifacts; no matches are not proof of absence.",
      promptSnippet: "web_lookup: recall-oriented BM25 lookup inside local artifacts already created by web_fetch; not live web search or proof of absence.",
      promptGuidelines: SHARED_GUIDANCE,
      parameters: webLookupSchema,
      renderShell: "self",
      renderCall: renderLookupCall,
      renderResult: renderLookupResult,
      async execute(_toolCallId: string, params: WebLookupArgs, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WebLookupResult>> {
        const registry = await registryFor(ctx);
        const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
        const results = registry.db.lookup(params.query, limit, params.domain, params.format ?? "auto");
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

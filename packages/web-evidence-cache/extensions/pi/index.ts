import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readConfig } from "../../src/config.js";
import { registryFor } from "../../src/cache.js";
import { braveSearch } from "../../src/brave.js";
import { assignSearchIdentities, searchContentSummary } from "../../src/search.js";
import { fetchContentSummary, fetchEvidence } from "../../src/fetch.js";
import { lookupContentSummary, lookupResult } from "../../src/lookup.js";
import type { WebFetchResult, WebLookupResult, WebSearchResult, WebSearchResultItem } from "../../src/types.js";
import { appendWebEvidencePrompt } from "./promptModule.js";
import { renderFetchCall, renderFetchResult, renderLookupCall, renderLookupResult, renderSearchCall, renderSearchResult } from "./renderers.js";

const SHARED_GUIDANCE = [
  "web_search searches the live web for candidate pages; snippets are leads, not evidence.",
  "web_fetch materializes promising results or URLs as local temp artifacts and indexes them automatically.",
  "web_lookup searches only fetched local web artifacts; use web_search for new discovery.",
  "Read artifact paths returned by web_fetch and web_lookup with normal filesystem tools before citing evidence.",
  "Prefer primary sources and official documentation when choosing what to fetch.",
];

export const webSearchSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  fetch_top: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  search_mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("exact"), Type.Literal("broad")])),
  domains: Type.Optional(Type.Array(Type.String())),
  exclude_domains: Type.Optional(Type.Array(Type.String())),
  recency: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const webFetchSchema = Type.Object({
  refs: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
  format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("semantic_html"), Type.Literal("markdown"), Type.Literal("text")])),
  refresh: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("force")])),
});

export const webLookupSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("semantic_html"), Type.Literal("markdown"), Type.Literal("text")])),
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
  return { url: ref };
}

export function buildWebEvidenceTools() {
  return [
    defineTool({
      name: "web_search",
      label: "Web Search",
      description: "Search the live web for candidate pages.",
      promptSnippet: "web_search: live web discovery for candidate pages; fetch before treating snippets as evidence.",
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
        const fetchTop = Math.min(params.fetch_top ?? 0, results.length);
        for (let i = 0; i < fetchTop; i++) {
          const fetched = await fetchEvidence({ url: results[i].url, sourceResultId: results[i].id }, registry, config, "auto", "auto", signal);
          results[i].fetched = true;
          results[i].page_id = fetched.id;
          results[i].artifact_dir = fetched.artifact_dir;
        }
        return response(searchContentSummary(records), { results, count: results.length, truncated: false, next_cursor: null });
      },
    }),
    defineTool({
      name: "web_fetch",
      label: "Web Fetch",
      description: "Fetch URLs or web_search result refs into local temp artifacts and index them.",
      promptSnippet: "web_fetch: materialize selected URLs or search result refs as local readable artifacts.",
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
      description: "Search fetched local web evidence artifacts.",
      promptSnippet: "web_lookup: BM25 lookup inside already-fetched web artifacts only.",
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

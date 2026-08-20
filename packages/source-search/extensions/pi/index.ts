import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { discoverSourceSearch, appendSourceSearchPrompt } from "../../src/discovery.js";
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT, rankedSearch } from "../../src/api.js";
import { renderQueryResult } from "../../src/render.js";
import type { QueryResponse } from "../../src/types.js";

const rankedSearchSchema = Type.Object({
  query: Type.String({ description: "Broad lexical/BM25 search query for source discovery. Use plain terms, not query DSL syntax." }),
  path: Type.Optional(Type.String({ description: "Optional path to search/restrict. Searches that file or directory directly, using git-visible files when the path is inside a checkout." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULT_LIMIT, description: `Maximum ranked hits to return (default ${DEFAULT_RESULT_LIMIT}, maximum ${MAX_RESULT_LIMIT}). Start with the default; narrow path/query before increasing.` })),
  boosts: Type.Optional(Type.Array(Type.Object({
    term: Type.String({ minLength: 1, description: "Plain lexical term or short phrase whose matches should be ranked higher or lower." }),
    weight: Type.Number({ exclusiveMinimum: 0, maximum: 10, description: "Ranking multiplier for this term. Use >1 to prefer, <1 to down-rank, and 1 for neutral. Does not filter results." }),
  }), { maxItems: 20, description: "Optional ranking weights for important or less-important terms. This changes ordering only; use excludeTerms to filter unwanted topics." })),
  excludeTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, description: "Optional plain terms or short phrases to filter out of results. Use only for clearly unwanted noise topics, not as proof of absence." })),
});

type RankedSearchArgs = Static<typeof rankedSearchSchema>;

function response(content: string, details: QueryResponse): AgentToolResult<QueryResponse> {
  return { content: [{ type: "text", text: content }], details };
}

type CwdProvider = (ctx: unknown) => string;

export function buildSourceSearchTools(getCwd: CwdProvider = (ctx) => cwdOf(ctx)) {
  return [defineTool({
    name: "ranked_search",
    label: "Ranked Search",
    description: "Live ranked lexical discovery across the current or requested directory. Uses git-visible files when inside a checkout; otherwise walks the live filesystem. Returns evidence packets with paths, matched fields, structured snippet windows, and optional enclosing context; use grep/read for exact evidence after selecting promising paths.",
    promptSnippet: "ranked_search: live broad ranked lexical source discovery; not semantic. Searches the current/requested directory, using git-visible files inside checkouts. Returns compact evidence packets (path/score, fields, selected snippet windows, optional context). Start with the default 3 results; narrow path/query before increasing (maximum 10). Use first when available, optionally with boosts/excludeTerms for ranking noise control, then confirm exact evidence with grep/read.",
    promptGuidelines: [
      "Use ranked_search for broad lexical source discovery; it is live folder-portable lexical ranking, not semantic search.",
      "Start with the default 3 results. Narrow the path or query before increasing the limit (maximum 10).",
      "Read result evidence packets as ranked paths with matchedFields (filename/path/content), selected snippet line windows, and optional enclosing context; inspect with read/grep before citing.",
      "Use boosts when some query terms matter more or less: weight >1 ranks matching files higher, weight <1 ranks them lower, and boosts never filter results. If a phrase/down-weight warning says reranking used a bounded candidate set, broaden/adjust the query when recall matters.",
      "Use excludeTerms only for clearly unwanted noise topics; it filters results and is not proof of absence.",
      "Do not put boost, boolean, or field syntax in query. Pass plain query terms plus typed boosts/excludeTerms instead.",
      "Use grep for exact strings/regex confirmation and read for inspecting known files.",
      "If terminology may differ, try synonyms or related identifiers.",
    ],
    parameters: rankedSearchSchema,
    renderShell: "self",
    async execute(_toolCallId: string, params: RankedSearchArgs, signal, _onUpdate, ctx): Promise<AgentToolResult<QueryResponse>> {
      const cwd = getCwd(ctx);
      const result = await rankedSearch({ cwd, query: params.query, path: params.path, limit: params.limit, boosts: params.boosts, excludeTerms: params.excludeTerms, signal });
      return response(renderQueryResult(result), result);
    },
  })];
}

function cwdOf(ctx: unknown, fallback = process.cwd()): string {
  const direct = (ctx as { cwd?: unknown } | undefined)?.cwd;
  if (typeof direct === "string") return direct;
  const optionsCwd = (ctx as { systemPromptOptions?: { cwd?: unknown } } | undefined)?.systemPromptOptions?.cwd;
  if (typeof optionsCwd === "string") return optionsCwd;
  return fallback;
}

export default async function sourceSearchExtension(pi: ExtensionAPI): Promise<void> {
  let activeCwd = process.cwd();
  for (const tool of buildSourceSearchTools((ctx) => cwdOf(ctx, activeCwd))) pi.registerTool(tool as never);

  pi.on("before_agent_start", async (event, ctx) => {
    activeCwd = cwdOf(event, cwdOf(ctx, activeCwd));
    const discovery = await discoverSourceSearch(activeCwd);
    return { systemPrompt: appendSourceSearchPrompt(event.systemPrompt, discovery) };
  });
}

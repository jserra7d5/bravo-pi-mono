import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createBashTool, defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { discoverSourceSearch, appendSourceSearchPrompt } from "../../src/discovery.js";
import { renderQueryResult } from "../../src/render.js";
import { findSidecar, queryRepo, sourceSearchCliPath } from "../../src/sidecar.js";
import { resolveRepoPath, resolveWorkspaceSearch } from "../../src/workspace.js";
import type { QueryResponse } from "../../src/types.js";

const rankedSearchSchema = Type.Object({
  query: Type.String({ description: "Broad lexical/BM25 search query for repository discovery. Use plain terms, not query DSL syntax." }),
  path: Type.Optional(Type.String({ description: "Optional path inside the current git checkout to search/restrict." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum ranked hits to return (default 10)." })),
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

function failureSummary(warnings: string[]): string | undefined {
  const failures = warnings.filter((warning) => /: /.test(warning));
  if (!failures.length) return undefined;
  return `Workspace ranked_search failed for all configured repos: ${failures.join("; ")}`;
}

export function buildSourceSearchTools() {
  return [defineTool({
    name: "ranked_search",
    label: "Ranked Search",
    description: "Ranked lexical/BM25 discovery across the current git checkout. Returns evidence packets with paths, matched fields, structured snippet windows, and optional enclosing context; use grep/read for exact evidence after selecting promising paths.",
    promptSnippet: "ranked_search: broad ranked lexical repo discovery; not semantic. Returns compact evidence packets (path/score, fields, selected snippet windows, optional context). Use first when Source Search is available, optionally with boosts/excludeTerms for ranking noise control, then confirm exact evidence with grep/read.",
    promptGuidelines: [
      "Use ranked_search for broad lexical source discovery; it is BM25 lexical search, not semantic search.",
      "Read result evidence packets as ranked paths with matchedFields (filename/path/content), selected snippet line windows, and optional enclosing context; inspect with read/grep before citing.",
      "Use boosts when some query terms matter more or less: weight >1 ranks matching files higher, weight <1 ranks them lower, and boosts never filter results. If a phrase/down-weight warning says reranking used a bounded candidate set, broaden/adjust the query when recall matters.",
      "Use excludeTerms only for clearly unwanted noise topics; it filters results and is not proof of absence.",
      "Do not put boost, boolean, or field syntax in query. Pass plain query terms plus typed boosts/excludeTerms instead.",
      "Use grep for exact strings/regex confirmation and read for inspecting known files.",
      "If terminology may differ, try synonyms or related identifiers.",
      "Do not use Source Search CLI/index commands unless setting up or debugging Source Search failures.",
    ],
    parameters: rankedSearchSchema,
    renderShell: "self",
    async execute(_toolCallId: string, params: RankedSearchArgs, _signal, _onUpdate, ctx): Promise<AgentToolResult<QueryResponse>> {
      const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
      const scope = await resolveRepoPath(ctx.cwd, params.path);
      if (scope) {
        const result = await queryRepo(scope.repoRoot, params.query, limit, scope.pathPrefix, params.boosts, params.excludeTerms);
        return response(renderQueryResult(result), result);
      }

      const workspace = await resolveWorkspaceSearch(ctx.cwd, params.path);
      if (workspace) {
        if (!workspace.repos.length) {
          const result: QueryResponse = { protocolVersion: 1, ok: false, hits: [], count: 0, error: "No configured workspace repo matched the requested ranked_search path." };
          return response(renderQueryResult(result), result);
        }
        const perRepoLimit = Math.min(50, Math.max(limit, limit * 2));
        const responses = await Promise.all(workspace.repos.map(async (repo) => {
          try {
            return { repo, result: await queryRepo(repo.repoRoot, params.query, perRepoLimit, repo.pathPrefix, params.boosts, params.excludeTerms) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { repo, result: { protocolVersion: 1, ok: false, hits: [], count: 0, error: message } satisfies QueryResponse };
          }
        }));
        const hits = responses.flatMap(({ repo, result }) => result.hits.map((hit) => ({ ...hit, repo: repo.name, path: `${repo.name}/${hit.path}` }))).sort((a, b) => b.score - a.score).slice(0, limit);
        const warnings = [
          ...(workspace.opportunistic ? ["Using opportunistic immediate child git checkout scope because no .bravo/source-search.json workspace config was found; configure workspace.repos for stable names/default repos and curated excludes."] : []),
          ...responses.flatMap(({ repo, result }) => [
            ...(result.warnings ?? []).map((w) => `${repo.name}: ${w}`),
            ...(result.ok ? [] : [`${repo.name}: ${result.error ?? "search failed"}`]),
          ]),
        ];
        const allReposFailed = hits.length === 0 && responses.every(({ result }) => !result.ok);
        const childFreshness = new Set(responses.map(({ result }) => result.indexFreshness).filter(Boolean));
        const indexFreshness = responses.some(({ result }) => !result.ok)
          ? "partial"
          : childFreshness.size === 1
            ? [...childFreshness][0]
            : childFreshness.has("live")
              ? "mixed-live"
              : "fresh";
        const result: QueryResponse = {
          protocolVersion: 1,
          ok: !allReposFailed,
          repoRoot: workspace.workspaceRoot,
          query: params.query,
          boosts: params.boosts,
          excludeTerms: params.excludeTerms,
          hits,
          count: hits.length,
          indexFreshness,
          warnings,
          error: allReposFailed ? failureSummary(warnings) ?? "Workspace ranked_search failed for all configured repos." : undefined,
        };
        return response(renderQueryResult(result), result);
      }

      const result: QueryResponse = { protocolVersion: 1, ok: false, hits: [], count: 0, error: "No git checkout or configured workspace found for ranked_search. Use the source-search skill to configure a workspace or run from inside a git checkout." };
      return response(renderQueryResult(result), result);
    },
  })];
}

function cwdOf(ctx: unknown): string {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" ? cwd : process.cwd();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function ensureCliShim(cliPath: string): Promise<string> {
  const dir = join(homedir(), ".cache", "pi-coding-agent", "source-search", "bin");
  const shim = join(dir, "source-search");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(shim, `#!/usr/bin/env bash\nexec node ${shellQuote(cliPath)} "$@"\n`, { mode: 0o700 });
  await chmod(shim, 0o700);
  return dir;
}

function prependPath(pathValue: string | undefined, dir: string): string {
  const parts = (pathValue ?? "").split(":").filter(Boolean);
  return [dir, ...parts.filter((part) => part !== dir)].join(":");
}

export default async function sourceSearchExtension(pi: ExtensionAPI): Promise<void> {
  for (const tool of buildSourceSearchTools()) pi.registerTool(tool as never);

  const cliPath = await sourceSearchCliPath();
  const sidecarPath = await findSidecar();
  const shimDir = await ensureCliShim(cliPath);
  process.env.SOURCE_SEARCH_CLI = cliPath;
  process.env.SOURCE_SEARCH_SIDECAR = sidecarPath;
  process.env.PATH = prependPath(process.env.PATH, shimDir);

  const bashTool = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: {
        ...env,
        SOURCE_SEARCH_CLI: cliPath,
        SOURCE_SEARCH_SIDECAR: sidecarPath,
        PATH: prependPath(env.PATH, shimDir),
      },
    }),
  });
  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, _ctx) => bashTool.execute(id, params, signal, onUpdate),
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const discovery = await discoverSourceSearch(cwdOf(ctx));
    return { systemPrompt: appendSourceSearchPrompt(event.systemPrompt, discovery) };
  });
}

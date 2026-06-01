import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createContextMap, readContextMap } from "../../src/index.js";

const createSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "Broad repository/docs question to route into source handles." }),
  roots: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
  max_slices: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  seed: Type.Optional(Type.Array(Type.Object({ path: Type.String(), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }) }), { description: "Optional known refs to include in the map." })),
  exclude: Type.Optional(Type.Array(Type.Object({ path: Type.String(), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }) }), { description: "Optional refs/ranges to suppress when they overlap candidate slices." })),
});
const readSchema = Type.Object({ map_id: Type.String(), slice_ids: Type.Array(Type.Union([Type.String(), Type.Number()]), { minItems: 1, maxItems: 20 }) });

type CreateArgs = Static<typeof createSchema>;
type ReadArgs = Static<typeof readSchema>;
function cwdOf(ctx: unknown): string { const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd; return typeof cwd === "string" ? cwd : process.cwd(); }
function result<T>(details: T): AgentToolResult<T> { return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; }

export function buildContextMapTools() {
  return [
    defineTool({
      name: "context_map_create",
      label: "Create Context Map",
      description: "Create a durable orientation map for broad code/docs discovery. Returns source handles, not final evidence.",
      promptSnippet: "context_map_create: for broad/ambiguous/handoff-oriented discovery. Treat output as orientation only; read selected slices before relying on exact claims.",
      promptGuidelines: ["Use direct read/grep for named files.", "Use ranked_search for narrow lexical lookup.", "Use context_map_read on selected slices before exact claims."],
      parameters: createSchema,
      renderShell: "self",
      async execute(_id, params: CreateArgs, _signal, _onUpdate, ctx) { return result(await createContextMap(cwdOf(ctx), params)); },
    }),
    defineTool({
      name: "context_map_read",
      label: "Read Context Map Slices",
      description: "Materialize exact source text for selected slices from a context map.",
      promptSnippet: "context_map_read: materialize selected context-map slices as exact source before citing or relying on claims.",
      parameters: readSchema,
      renderShell: "self",
      async execute(_id, params: ReadArgs, _signal, _onUpdate, ctx) { return result(await readContextMap(cwdOf(ctx), params.map_id, params.slice_ids)); },
    }),
  ];
}

export default async function contextMapsExtension(pi: ExtensionAPI): Promise<void> {
  for (const tool of buildContextMapTools()) pi.registerTool(tool as never);
}

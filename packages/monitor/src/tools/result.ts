import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { NotFoundError } from "../errors.js";

export function buildResultTool(_pi: ExtensionAPI, store: JsonlMonitorStore) {
  return {
    name: "monitor_result",
    label: "Monitor Result",
    description: "Get latest or historical results for a monitor.",
    parameters: Type.Object({
      monitor_id: Type.String(),
      limit: Type.Optional(Type.Number({ default: 5 })),
      acked: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, params: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      const results = await store.listResults(params.monitor_id, {
        limit: params.limit ?? 5,
        acked: params.acked,
      });
      return {
        content: [{ type: "text" as const, text: `${results.length} result(s) for monitor ${m.monitor_id}` }],
        details: { monitor_id: m.monitor_id, results },
      };
    },
  };
}

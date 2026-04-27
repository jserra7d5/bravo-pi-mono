import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { NotFoundError } from "../errors.js";

export function buildLookTool(_pi: ExtensionAPI, store: JsonlMonitorStore) {
  return {
    name: "monitor_look",
    label: "Monitor Look",
    description: "Inspect a monitor's full configuration and recent results.",
    parameters: Type.Object({
      monitor_id: Type.String(),
      include_results: Type.Optional(Type.Number({ default: 5, description: "Number of recent results to include" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      const results = await store.listResults(params.monitor_id, { limit: params.include_results ?? 5 });
      return {
        content: [{ type: "text" as const, text: `Monitor ${m.monitor_id} state=${m.state}` }],
        details: { monitor: m, results },
      };
    },
  };
}

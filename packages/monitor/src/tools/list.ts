import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";

export function buildListTool(_pi: ExtensionAPI, store: JsonlMonitorStore) {
  return {
    name: "monitor_list",
    label: "Monitor List",
    description: "List durable monitors with optional filters.",
    parameters: Type.Object({
      states: Type.Optional(Type.Array(StringEnum(["created", "running", "paused", "triggered", "succeeded", "failed", "stopped", "canceled", "expired", "archived"] as const))),
      scope: Type.Optional(StringEnum(["session", "root_session", "workspace"] as const)),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      include_archived: Type.Optional(Type.Boolean({ default: false })),
      limit: Type.Optional(Type.Number({ default: 50 })),
    }),
    async execute(_toolCallId: string, params: any) {
      const items = await store.list({
        states: params.states,
        scope: params.scope,
        labels: params.labels,
        include_archived: params.include_archived,
        limit: params.limit ?? 50,
      });

      return {
        content: [{ type: "text" as const, text: `Found ${items.length} monitor(s)` }],
        details: { monitors: items.map((m) => ({ monitor_id: m.monitor_id, name: m.name, state: m.state, next_run_at: m.next_run_at })) },
      };
    },
  };
}

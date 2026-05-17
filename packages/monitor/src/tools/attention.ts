import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { getRuntimeIdentity, monitorBelongsToRuntime } from "../runtime/identity.js";

export function buildAttentionTool(_pi: ExtensionAPI, store: JsonlMonitorStore) {
  return {
    name: "monitor_attention",
    label: "Monitor Attention",
    description: "List triggered or failed monitor results that have not been acknowledged.",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["session", "root_session", "workspace"] as const)),
      include_all_sessions: Type.Optional(Type.Boolean({ default: false, description: "Include attention owned by other Pi sessions." })),
      limit: Type.Optional(Type.Number({ default: 20 })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const identity = getRuntimeIdentity(ctx);
      const monitors = (await store.list({ scope: params.scope, include_archived: false, limit: 500 }))
        .filter((m) => params.include_all_sessions || monitorBelongsToRuntime(m, identity));
      const items: any[] = [];
      for (const m of monitors) {
        const results = await store.listResults(m.monitor_id, { acked: false, limit: params.limit ?? 20 });
        for (const r of results) {
          if (!r.triggered && r.status !== "error") continue;
          items.push({
            monitor_id: m.monitor_id,
            name: m.name,
            state: m.state,
            result_id: r.result_id,
            status: r.status,
            triggered: r.triggered,
            created_at: r.created_at,
            message: r.attention_delivery?.message ?? m.attention.message,
            wake_delivered: r.attention_delivery?.wake_delivered,
            wake_error: r.attention_delivery?.wake_error,
            notify_delivered: r.attention_delivery?.notify_delivered,
            notify_error: r.attention_delivery?.notify_error,
          });
        }
      }
      items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const limited = items.slice(0, params.limit ?? 20);
      return {
        content: [{ type: "text" as const, text: limited.length ? `Found ${limited.length} pending monitor attention item(s)` : "No pending monitor attention." }],
        details: { attention: limited },
      };
    },
  };
}

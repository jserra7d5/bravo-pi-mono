import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorState } from "../schema/types.js";
import { getRuntimeIdentity, monitorBelongsToRuntime } from "../runtime/identity.js";

function toStoreState(state: string): MonitorState[] {
  if (state === "event") return ["triggered"];
  if (state === "ended") return ["succeeded", "completed"];
  return [state as MonitorState];
}

function toModelState(state: MonitorState): string {
  if (state === "triggered") return "event";
  if (state === "succeeded" || state === "completed") return "ended";
  if (state === "created" || state === "paused") return "running";
  return state;
}

export function buildListTool(_pi: ExtensionAPI, store: JsonlMonitorStore) {
  return {
    name: "monitor_list",
    label: "Monitor List",
    description: "List durable monitors with optional filters.",
    parameters: Type.Object({
      states: Type.Optional(Type.Array(StringEnum(["running", "event", "failed", "ended", "stopped", "expired"] as const))),
      scope: Type.Optional(StringEnum(["session", "root_session", "workspace"] as const)),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      include_archived: Type.Optional(Type.Boolean({ default: false })),
      include_all_sessions: Type.Optional(Type.Boolean({ default: false, description: "Include monitors owned by other Pi sessions." })),
      limit: Type.Optional(Type.Number({ default: 50 })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const identity = getRuntimeIdentity(ctx);
      let items = await store.list({
        states: params.states ? ([...new Set((params.states as string[]).flatMap(toStoreState))] as MonitorState[]) : undefined,
        scope: params.scope,
        labels: params.labels,
        include_archived: params.include_archived,
        limit: params.include_all_sessions ? params.limit ?? 50 : undefined,
      });
      if (!params.include_all_sessions) items = items.filter((m) => monitorBelongsToRuntime(m, identity)).slice(0, params.limit ?? 50);

      const compact = items.map((m) => ({ monitor_id: m.monitor_id, name: m.name, state: toModelState(m.state), kind: (m.metadata as any)?.kind ?? (m.check as any).type, next_run_at: m.next_run_at, output_path: (m.metadata as any)?.output_path ?? (m.check as any).output_path, last_event_summary: m.last_triggered_at ? `last triggered at ${m.last_triggered_at}` : undefined }));
      const rows = compact.map((m) => `${m.monitor_id} ${m.state} ${m.kind}${m.name ? ` ${m.name}` : ""}${m.output_path ? ` output=${m.output_path}` : ""}`);
      return {
        content: [{ type: "text" as const, text: [`Found ${items.length} monitor(s)`, ...rows].join("\n") }],
        details: { ok: true, items: compact, count: compact.length },
      };
    },
  };
}

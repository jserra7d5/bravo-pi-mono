import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import { NotFoundError } from "../errors.js";
import { generateEventId } from "../ids.js";
import { nowISO } from "../time.js";

export function buildStopTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService) {
  return {
    name: "monitor_stop",
    label: "Monitor Stop",
    description: "Stop a monitor permanently. Preserves result history.",
    parameters: Type.Object({
      monitor_id: Type.String(),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      const updated = await store.update(params.monitor_id, undefined, { state: "stopped", next_run_at: undefined });
      await store.appendEvent({
        event_id: generateEventId(),
        monitor_id: params.monitor_id,
        type: "stopped",
        created_at: nowISO(),
      });
      await status?.refresh(ctx);
      return {
        content: [{ type: "text" as const, text: `Monitor ${updated.monitor_id} stopped` }],
        details: { monitor_id: updated.monitor_id, state: updated.state },
      };
    },
  };
}

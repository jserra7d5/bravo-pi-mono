import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { generateEventId } from "../ids.js";
import { nowISO } from "../time.js";

export function buildPauseTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService) {
  return {
    name: "monitor_pause",
    label: "Monitor Pause",
    description: "Pause a running monitor without destroying it.",
    parameters: Type.Object({
      monitor_id: Type.String(),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      if (m.state !== "running") throw new ValidationError(`Cannot pause monitor in state ${m.state}`);
      const updated = await store.update(params.monitor_id, undefined, { state: "paused" });
      await store.appendEvent({
        event_id: generateEventId(),
        monitor_id: params.monitor_id,
        type: "paused",
        created_at: nowISO(),
      });
      await status?.refresh(ctx);
      return {
        content: [{ type: "text" as const, text: `Monitor ${updated.monitor_id} paused` }],
        details: { monitor_id: updated.monitor_id, state: updated.state },
      };
    },
  };
}

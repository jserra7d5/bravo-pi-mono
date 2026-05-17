import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { generateEventId } from "../ids.js";
import { nowISO } from "../time.js";

export function buildResumeTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService) {
  return {
    name: "monitor_resume",
    label: "Monitor Resume",
    description: "Resume a paused monitor.",
    parameters: Type.Object({
      monitor_id: Type.String(),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      if (m.state !== "paused") throw new ValidationError(`Cannot resume monitor in state ${m.state}`);
      const updated = await store.update(params.monitor_id, undefined, { state: "running" });
      await store.appendEvent({
        event_id: generateEventId(),
        monitor_id: params.monitor_id,
        type: "resumed",
        created_at: nowISO(),
      });
      await status?.refresh(ctx);
      return {
        content: [{ type: "text" as const, text: `Monitor ${updated.monitor_id} resumed` }],
        details: { monitor_id: updated.monitor_id, state: updated.state },
      };
    },
  };
}

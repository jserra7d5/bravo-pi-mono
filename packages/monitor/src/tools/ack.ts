import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import { NotFoundError, ValidationError } from "../errors.js";

export function buildAckTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService) {
  return {
    name: "monitor_ack",
    label: "Monitor Ack",
    description: "Acknowledge triggered or failed monitor results.",
    parameters: Type.Object({
      monitor_id: Type.Optional(Type.String()),
      result_id: Type.Optional(Type.String()),
      all: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const selectors = [params.monitor_id, params.result_id, params.all].filter((v) => v !== undefined);
      if (selectors.length !== 1) throw new ValidationError("Provide exactly one of monitor_id, result_id, or all");

      if (params.monitor_id) {
        const m = await store.get(params.monitor_id);
        if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      }

      const acked = await store.ackResults({
        monitor_id: params.monitor_id,
        result_id: params.result_id,
        all: params.all,
      });

      if (acked === 0 && params.result_id) {
        throw new NotFoundError(`Result ${params.result_id} not found`);
      }

      await status?.refresh(ctx);

      if (params.all) {
        return {
          content: [{ type: "text" as const, text: `Acknowledged ${acked} result(s) across all monitors` }],
          details: { acked },
        };
      }

      if (params.result_id) {
        return {
          content: [{ type: "text" as const, text: `Acknowledged result ${params.result_id}` }],
          details: { result_id: params.result_id },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Acknowledged ${acked} result(s) for monitor ${params.monitor_id}` }],
        details: { monitor_id: params.monitor_id, acked },
      };
    },
  };
}

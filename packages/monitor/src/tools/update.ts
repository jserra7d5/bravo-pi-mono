import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { validateSchedule, validateCondition } from "../validation.js";

export function buildUpdateTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService) {
  return {
    name: "monitor_update",
    label: "Monitor Update",
    description: "Update mutable fields of an existing monitor.",
    parameters: Type.Object({
      monitor_id: Type.String(),
      expected_version: Type.Optional(Type.Number()),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      schedule: Type.Optional(Type.Object({
        start_at: Type.Optional(Type.String()),
        delay_ms: Type.Optional(Type.Number()),
        interval_ms: Type.Optional(Type.Number()),
        deadline_at: Type.Optional(Type.String()),
        max_runs: Type.Optional(Type.Number()),
        timeout_ms: Type.Optional(Type.Number()),
        backoff: Type.Optional(Type.Object({
          strategy: Type.String(),
          initial_ms: Type.Optional(Type.Number()),
          max_ms: Type.Optional(Type.Number()),
        })),
      })),
      condition: Type.Optional(Type.Object({ type: Type.String() }, { additionalProperties: true })),
      attention: Type.Optional(Type.Object({
        notify: Type.Optional(Type.Boolean()),
        wake_agent: Type.Optional(Type.Boolean()),
        message: Type.Optional(Type.String()),
        throttle_ms: Type.Optional(Type.Number()),
      })),
      retention: Type.Optional(Type.Object({
        max_results: Type.Optional(Type.Number()),
        max_events: Type.Optional(Type.Number()),
        ttl_ms: Type.Optional(Type.Number()),
      })),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);

      const patch: any = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.description !== undefined) patch.description = params.description;
      if (params.schedule !== undefined) {
        validateSchedule(params.schedule);
        patch.schedule = params.schedule;
      }
      if (params.condition !== undefined) {
        validateCondition(params.condition);
        patch.condition = params.condition;
      }
      if (params.attention !== undefined) patch.attention = { ...m.attention, ...params.attention };
      if (params.retention !== undefined) patch.retention = { ...m.retention, ...params.retention };
      if (params.labels !== undefined) patch.labels = params.labels;
      if (params.metadata !== undefined) patch.metadata = params.metadata;

      const updated = await store.update(params.monitor_id, params.expected_version, patch);
      await status?.refresh(ctx);
      return {
        content: [{ type: "text" as const, text: `Monitor ${updated.monitor_id} updated to version ${updated.version}` }],
        details: { monitor_id: updated.monitor_id, version: updated.version, state: updated.state },
      };
    },
  };
}

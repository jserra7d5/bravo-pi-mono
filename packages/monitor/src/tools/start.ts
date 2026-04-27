import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import type { MonitorRecord } from "../schema/types.js";
import { generateMonitorId } from "../ids.js";
import { nowISO } from "../time.js";
import { validateCheck, validateSchedule, validateCondition, validateAttention, validateRetention, validateLabels, validateStateTransition } from "../validation.js";

const DEFAULT_ATTENTION = { notify: true, wake_agent: false, throttle_ms: 30000 };
const DEFAULT_RETENTION = { max_results: 100, max_events: 500 };

export function buildStartTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService) {
  return {
    name: "monitor_start",
    label: "Monitor Start",
    description: "Create a durable background monitor with a schedule and check.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Human-readable monitor name" })),
      description: Type.Optional(Type.String()),
      scope: Type.Optional(StringEnum(["session", "root_session", "workspace"] as const)),
      check: Type.Object({
        type: StringEnum(["timer", "file"] as const),
        path: Type.Optional(Type.String()),
        mode: Type.Optional(StringEnum(["exists", "missing", "modified_since_start", "contains"] as const)),
        pattern: Type.Optional(Type.String()),
        encoding: Type.Optional(Type.String({ default: "utf8" })),
      }),
      schedule: Type.Object({
        start_at: Type.Optional(Type.String({ description: "ISO date string" })),
        delay_ms: Type.Optional(Type.Number()),
        interval_ms: Type.Optional(Type.Number()),
        deadline_at: Type.Optional(Type.String()),
        max_runs: Type.Optional(Type.Number()),
        timeout_ms: Type.Optional(Type.Number()),
        backoff: Type.Optional(Type.Object({
          strategy: StringEnum(["none", "linear", "exponential"] as const),
          initial_ms: Type.Optional(Type.Number()),
          max_ms: Type.Optional(Type.Number()),
        })),
      }),
      condition: Type.Optional(Type.Object({
        type: StringEnum(["always", "observation_status", "text_contains", "and", "or", "not"] as const),
      }, { additionalProperties: true })),
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
      idempotency_key: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const check: any = { type: params.check.type };
      if (params.check.path) check.path = params.check.path;
      if (params.check.mode) check.mode = params.check.mode;
      if (params.check.pattern) check.pattern = params.check.pattern;
      if (params.check.encoding) check.encoding = params.check.encoding;

      validateCheck(check);
      validateSchedule(params.schedule);
      validateCondition(params.condition);
      validateAttention(params.attention ?? DEFAULT_ATTENTION);
      validateRetention(params.retention ?? DEFAULT_RETENTION);
      validateLabels(params.labels ?? {});

      if (params.idempotency_key) {
        const existing = (await store.list({ include_archived: false })).find((m) => m.metadata?.idempotency_key === params.idempotency_key);
        if (existing) {
          return {
            content: [{ type: "text" as const, text: `Monitor ${existing.monitor_id} already exists` }],
            details: { monitor_id: existing.monitor_id, state: existing.state, next_run_at: existing.next_run_at, idempotent: true },
          };
        }
      }

      const monitorId = generateMonitorId();
      const sessionId = ctx?.sessionManager?.getSessionFile?.() ?? process.env.PI_SESSION_ID ?? "";
      const rootSessionId = process.env.TANGO_ROOT_SESSION_ID ?? process.env.PI_ROOT_SESSION_ID;
      const workspaceId = process.env.TANGO_WORKSTREAM_ID ?? process.cwd();
      const now = nowISO();

      let nextRunAt: string | undefined;
      if (params.schedule.start_at) {
        nextRunAt = params.schedule.start_at;
      } else if (typeof params.schedule.delay_ms === "number") {
        nextRunAt = new Date(Date.now() + params.schedule.delay_ms).toISOString();
      } else if (typeof params.schedule.interval_ms === "number") {
        nextRunAt = new Date(Date.now() + params.schedule.interval_ms).toISOString();
      } else {
        nextRunAt = now;
      }

      const record: MonitorRecord = {
        monitor_id: monitorId,
        version: 1,
        owner: {
          actor_id: ctx?.actor_id ?? "system",
          actor_type: "system",
          session_id: sessionId,
          root_session_id: rootSessionId,
          workspace_id: workspaceId,
        },
        scope: params.scope ?? "session",
        name: params.name,
        description: params.description,
        state: "running",
        check,
        schedule: params.schedule,
        condition: params.condition,
        attention: { ...DEFAULT_ATTENTION, ...(params.attention ?? {}) },
        retention: { ...DEFAULT_RETENTION, ...(params.retention ?? {}) },
        labels: params.labels ?? {},
        metadata: { ...(params.metadata ?? {}), ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}) },
        created_at: now,
        updated_at: now,
        next_run_at: nextRunAt,
        failure_count: 0,
        consecutive_failure_count: 0,
        run_count: 0,
      };

      await store.create(record);
      await status?.refresh(ctx);

      return {
        content: [{ type: "text" as const, text: `Monitor ${monitorId} created` }],
        details: { monitor_id: monitorId, state: record.state, next_run_at: nextRunAt },
      };
    },
  };
}

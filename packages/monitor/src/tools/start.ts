import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import type { MonitorRecord } from "../schema/types.js";
import type { StreamMonitorManager } from "../stream/stream-manager.js";
import { generateMonitorId } from "../ids.js";
import { nowISO } from "../time.js";
import { validateCheck, validateSchedule, validateCondition, validateAttention, validateRetention, validateLabels, validateStateTransition } from "../validation.js";
import { getRuntimeIdentity, monitorBelongsToRuntime } from "../runtime/identity.js";

const DEFAULT_ATTENTION = { notify: true, wake_agent: false, throttle_ms: 30000 };
const DEFAULT_RETENTION = { max_results: 100, max_events: 500 };

function startMessage(monitorId: string, record: MonitorRecord, nextRunAt?: string, outputFile?: string): string {
  const lines = [`Monitor ${monitorId} created`, `state=${record.state} version=${record.version}`];
  if (record.check.type === "command") {
    lines.push(`next: use monitor_output monitor_id=${monitorId}`);
    if (outputFile) lines.push(`output_file=${outputFile}`);
    lines.push(`notify=${record.attention.notify} wake_agent=${record.attention.wake_agent}`);
  } else if (nextRunAt) {
    lines.push(`next_run_at=${nextRunAt}`);
  }
  return lines.join("\n");
}

export function buildStartTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService, streams?: StreamMonitorManager) {
  return {
    name: "monitor_start",
    label: "Monitor Start",
    description: "Create a durable background monitor. Use check.type='timer' or 'file' for scheduled checks; use check.type='command' for durable shell-command monitors with output read through monitor_output.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Human-readable monitor name" })),
      description: Type.Optional(Type.String()),
      scope: Type.Optional(StringEnum(["session", "root_session", "workspace"] as const)),
      check: Type.Object({
        type: StringEnum(["timer", "file", "command"] as const),
        command: Type.Optional(Type.String({ description: "Shell command for check.type='command'. Use monitor_output to read captured stdout/stderr." })),
        cwd: Type.Optional(Type.String({ description: "Working directory for command monitors." })),
        shell: Type.Optional(Type.Boolean({ description: "Whether to run command through a shell. Defaults to true." })),
        timeout_ms: Type.Optional(Type.Number({ description: "Optional command runtime timeout in milliseconds." })),
        event_throttle_ms: Type.Optional(Type.Number({ description: "Minimum batching delay before command output wakes the agent." })),
        max_lines_per_turn: Type.Optional(Type.Number({ description: "Maximum command output lines batched into one wake-up." })),
        tail_bytes: Type.Optional(Type.Number({ description: "Default tail size for monitor_output." })),
        path: Type.Optional(Type.String()),
        mode: Type.Optional(StringEnum(["exists", "missing", "modified_since_start", "contains", "stream", "exit"] as const)),
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
      if (params.check.command) check.command = params.check.command;
      if (params.check.cwd) check.cwd = params.check.cwd;
      if (params.check.shell !== undefined) check.shell = params.check.shell;
      for (const k of ["timeout_ms", "event_throttle_ms", "max_lines_per_turn", "tail_bytes"] as const) if (params.check[k] !== undefined) check[k] = params.check[k];
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

      const identity = getRuntimeIdentity(ctx);

      if (params.idempotency_key) {
        const existing = (await store.list({ include_archived: false })).find((m) => m.metadata?.idempotency_key === params.idempotency_key && monitorBelongsToRuntime(m, identity));
        if (existing) {
          return {
            content: [{ type: "text" as const, text: `Monitor ${existing.monitor_id} already exists` }],
            details: { monitor_id: existing.monitor_id, state: existing.state, next_run_at: existing.next_run_at, idempotent: true },
          };
        }
      }

      const monitorId = generateMonitorId();
      const sessionId = identity.session_id ?? "";
      const rootSessionId = identity.root_session_id;
      const workspaceId = identity.workspace_id;
      const now = nowISO();

      let nextRunAt: string | undefined;
      if (check.type !== "command") {
        if (params.schedule.start_at) {
          nextRunAt = params.schedule.start_at;
        } else if (typeof params.schedule.delay_ms === "number") {
          nextRunAt = new Date(Date.now() + params.schedule.delay_ms).toISOString();
        } else if (typeof params.schedule.interval_ms === "number") {
          nextRunAt = new Date(Date.now() + params.schedule.interval_ms).toISOString();
        } else {
          nextRunAt = now;
        }
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
      let streamState: any;
      if (check.type === "command") {
        if (!streams) throw new Error("Command monitors are not available");
        streamState = streams.start({ command: check.command, description: params.description ?? params.name ?? monitorId, cwd: check.cwd, timeout_ms: check.timeout_ms, notify: record.attention.notify, wake_agent: record.attention.wake_agent, event_throttle_ms: check.event_throttle_ms, max_lines_per_turn: check.max_lines_per_turn, shell: check.shell, stream_id: monitorId, monitor_id: monitorId, store }, ctx);
      }
      await status?.refresh(ctx);

      return {
        content: [{ type: "text" as const, text: startMessage(monitorId, record, nextRunAt, streamState?.output_file) }],
        details: { ok: true, monitor_id: monitorId, state: record.state, next_run_at: nextRunAt, output_file: streamState?.output_file },
      };
    },
  };
}

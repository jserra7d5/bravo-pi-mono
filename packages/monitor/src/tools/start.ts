import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import type { MonitorRecord } from "../schema/types.js";
import type { StreamMonitorManager } from "../stream/stream-manager.js";
import { generateMonitorId } from "../ids.js";
import { nowISO } from "../time.js";
import { validateCheck, validateSchedule, validateCondition, validateAttention, validateRetention, validateLabels } from "../validation.js";
import { getRuntimeIdentity, monitorBelongsToRuntime } from "../runtime/identity.js";
import { resolveStateRoot } from "../store/state-path.js";
import { ValidationError } from "../errors.js";

const DEFAULT_ATTENTION = { notify: true, wake_agent: false, throttle_ms: 30000 };
const DEFAULT_V2_ATTENTION = { notify: false, wake_agent: false, throttle_ms: 5000 };
const DEFAULT_RETENTION = { max_results: 100, max_events: 500 };

type WakeMode = "never" | "on_event" | "on_failure" | "on_terminal";

function outputPathFor(monitorId: string): string {
  const dir = join(resolveStateRoot(), "monitors", monitorId);
  mkdirSync(dir, { recursive: true });
  return join(dir, "output.log");
}

function toMs(seconds: unknown, name: string): number | undefined {
  if (seconds === undefined) return undefined;
  if (!Number.isFinite(seconds as number) || (seconds as number) < 0) throw new ValidationError(`${name} must be a non-negative number of seconds`);
  return Math.round((seconds as number) * 1000);
}

function attentionFromWake(wake: WakeMode | undefined, throttleS: unknown, legacy: any) {
  const mode = wake ?? (legacy ? undefined : "on_failure");
  const attention = { ...(legacy ? DEFAULT_ATTENTION : DEFAULT_V2_ATTENTION), ...(legacy ?? {}) };
  if (mode) {
    attention.notify = false;
    attention.wake_agent = mode !== "never";
  }
  const throttle = toMs(throttleS, "throttle_s");
  if (throttle !== undefined) attention.throttle_ms = throttle;
  return attention;
}

function isObviousWorkload(command: string): boolean {
  return /(^|\s)(npm|pnpm|yarn)\s+(run\s+)?(test|build|dev|start)\b|(^|\s)(pytest|cargo\s+test|go\s+test|make\s+(test|build|install)|docker\s+build)\b/.test(command);
}

function normalizeStartParams(params: any, monitorId: string): { check: any; schedule: any; attention: any; condition: any; metadata: Record<string, unknown>; outputPath?: string; warnings: string[]; v2: boolean } {
  const warnings: string[] = [];
  if (!params.kind) {
    if (!params.check || typeof params.check !== "object") {
      throw new ValidationError("monitor_start requires either v2 kind ('stream', 'poll', or 'file') or a legacy check object. Recovery: pass kind with command/path fields, or pass legacy check and schedule.");
    }
    const check: any = { type: params.check.type };
    if (params.check.command) check.command = params.check.command;
    if (params.check.cwd) check.cwd = params.check.cwd;
    if (params.check.shell !== undefined) check.shell = params.check.shell;
    for (const k of ["timeout_ms", "event_throttle_ms", "max_lines_per_turn", "tail_bytes"] as const) if (params.check[k] !== undefined) check[k] = params.check[k];
    if (params.check.path) check.path = params.check.path;
    if (params.check.mode) check.mode = params.check.mode;
    if (params.check.pattern) check.pattern = params.check.pattern;
    if (params.check.encoding) check.encoding = params.check.encoding;
    return { check, schedule: params.schedule, attention: { ...DEFAULT_ATTENTION, ...(params.attention ?? {}) }, condition: params.condition, metadata: params.metadata ?? {}, warnings, v2: false };
  }

  const outputPath = outputPathFor(monitorId);
  const commonMetadata = { ...(params.metadata ?? {}), monitor_v2: true, kind: params.kind, output_path: outputPath, wake: params.wake ?? "on_failure" };
  const attention = attentionFromWake(params.wake, params.throttle_s, undefined);
  const lifespanMs = toMs(params.monitor_lifespan_s, "monitor_lifespan_s");
  const commandTimeoutMs = toMs(params.command_timeout_s, "command_timeout_s");
  const scheduleBase: any = { ...(lifespanMs ? { deadline_at: new Date(Date.now() + lifespanMs).toISOString() } : {}) };

  if (params.kind === "stream") {
    if (!params.command || typeof params.command !== "string") throw new ValidationError("stream monitor requires command");
    if (isObviousWorkload(params.command)) throw new ValidationError("Monitor is an observer, not background bash: use background bash for workload commands such as tests/builds/dev servers.");
    const check = { type: "command", command: params.command, cwd: params.cwd, shell: params.shell, timeout_ms: commandTimeoutMs, event_throttle_ms: toMs(params.throttle_s, "throttle_s"), mode: "stream", output_path: outputPath, emit: params.emit ?? "line", projection: params.projection };
    return { check, schedule: scheduleBase, attention, condition: undefined, metadata: commonMetadata, outputPath, warnings, v2: true };
  }

  if (params.kind === "poll") {
    if (!params.command || typeof params.command !== "string") throw new ValidationError("poll monitor requires command");
    if (!Number.isFinite(params.interval_s) || params.interval_s < 5) throw new ValidationError("poll monitor requires interval_s >= 5");
    if (params.shell === false) throw new ValidationError("poll monitor shell:false is not supported for command strings; omit shell or set shell:true. True shellless execution requires argv form, which monitor_start does not expose.");
    if (isObviousWorkload(params.command)) throw new ValidationError("Monitor poll commands must observe external state, not run workloads; use background bash for tests/builds.");
    const check = { type: "command", command: params.command, cwd: params.cwd, shell: params.shell, timeout_ms: commandTimeoutMs, mode: "poll", output_path: outputPath, emit: params.emit ?? "state_change", projection: params.projection };
    return { check, schedule: { ...scheduleBase, interval_ms: toMs(params.interval_s, "interval_s") }, attention, condition: undefined, metadata: commonMetadata, outputPath, warnings, v2: true };
  }

  if (params.kind === "file") {
    if (!params.path || typeof params.path !== "string") throw new ValidationError("file monitor requires path");
    const mode = params.file_mode === "modified" ? "modified_since_start" : params.file_mode;
    const check = { type: "file", path: params.path, mode, pattern: params.pattern, encoding: params.encoding ?? "utf8" };
    if (params.interval_s !== undefined && (!Number.isFinite(params.interval_s) || params.interval_s < 5)) throw new ValidationError("file monitor requires interval_s >= 5");
    const schedule = { ...scheduleBase, interval_ms: toMs(params.interval_s ?? 5, "interval_s") };
    return { check, schedule, attention, condition: undefined, metadata: commonMetadata, outputPath, warnings, v2: true };
  }

  throw new ValidationError(`Unsupported monitor kind: ${params.kind}`);
}

function startMessage(monitorId: string, record: MonitorRecord, nextRunAt?: string, outputPath?: string, warnings: string[] = []): string {
  const kind = (record.metadata as any)?.kind ?? (record.check as any).type;
  const lines = [`Monitor ${monitorId} started`, `state=${record.state} kind=${kind}`];
  if (outputPath) lines.push(`output_path=${outputPath}`, `read details with the read tool`);
  if (nextRunAt) lines.push(`next_run_at=${nextRunAt}`);
  if (warnings.length) lines.push(...warnings.map((w) => `warning=${w}`));
  return lines.join("\n");
}

export function buildStartTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService, streams?: StreamMonitorManager) {
  return {
    name: "monitor_start",
    label: "Monitor Start",
    description: "Start a durable observer monitor (stream, poll, or file). Monitor observes external state/events; use background bash to run workloads. Output is written to a generated output_path for the read tool.",
    parameters: Type.Object({
      kind: StringEnum(["stream", "poll", "file"] as const),
      name: Type.Optional(Type.String({ description: "Human-readable monitor name" })),
      description: Type.Optional(Type.String()),
      wake: Type.Optional(StringEnum(["never", "on_event", "on_failure", "on_terminal"] as const)),
      throttle_s: Type.Optional(Type.Number({ description: "Minimum seconds between model wake batches." })),
      monitor_lifespan_s: Type.Optional(Type.Number({ description: "Optional total monitor lifespan in seconds." })),
      command: Type.Optional(Type.String({ description: "Observer command for kind='stream' or kind='poll'; not for running workloads." })),
      cwd: Type.Optional(Type.String()),
      shell: Type.Optional(Type.Boolean({ description: "shell:false is rejected for poll command strings." })),
      emit: Type.Optional(StringEnum(["line", "state_change", "terminal"] as const)),
      projection: Type.Optional(Type.Unknown()),
      command_timeout_s: Type.Optional(Type.Number()),
      interval_s: Type.Optional(Type.Number({ description: "Poll interval in seconds for kind='poll' or kind='file'; minimum 5." })),
      path: Type.Optional(Type.String({ description: "File path for kind='file'." })),
      file_mode: Type.Optional(StringEnum(["exists", "missing", "modified", "contains"] as const)),
      pattern: Type.Optional(Type.String({ description: "Required for file_mode='contains'." })),
      encoding: Type.Optional(StringEnum(["utf8"] as const)),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      idempotency_key: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const identity = getRuntimeIdentity(ctx);

      if (params.idempotency_key) {
        const existing = (await store.list({ include_archived: false })).find((m) => m.metadata?.idempotency_key === params.idempotency_key && monitorBelongsToRuntime(m, identity));
        if (existing) {
          return {
            content: [{ type: "text" as const, text: `Monitor ${existing.monitor_id} already exists\noutput_path=${existing.metadata?.output_path ?? (existing.check as any).output_path ?? ""}`.trim() }],
            details: { ok: true, monitor_id: existing.monitor_id, state: existing.state, kind: existing.metadata?.kind, name: existing.name, output_path: existing.metadata?.output_path ?? (existing.check as any).output_path, wake: existing.metadata?.wake, next_action: existing.next_run_at ? "wait" : "inspect_output", next_run_at: existing.next_run_at, idempotent: true },
          };
        }
      }

      const active = (await store.list({ include_archived: false })).filter((m) => monitorBelongsToRuntime(m, identity) && ["created", "running", "paused"].includes(m.state));
      if (active.length >= 25) throw new ValidationError("active monitor cap reached (25); stop unused monitors before starting another.");

      const monitorId = generateMonitorId();
      const normalized = normalizeStartParams(params, monitorId);
      const { check, schedule, attention, condition, metadata, outputPath, warnings, v2 } = normalized;

      validateCheck(check);
      validateSchedule(schedule);
      validateCondition(condition);
      validateAttention(attention);
      validateRetention(params.retention ?? DEFAULT_RETENTION);
      validateLabels(params.labels ?? {});

      const now = nowISO();
      let nextRunAt: string | undefined;
      if (check.type !== "command" || check.mode === "poll") {
        if (schedule.start_at) nextRunAt = schedule.start_at;
        else if (typeof schedule.delay_ms === "number") nextRunAt = new Date(Date.now() + schedule.delay_ms).toISOString();
        else if (typeof schedule.interval_ms === "number") nextRunAt = v2 ? now : new Date(Date.now() + schedule.interval_ms).toISOString();
        else nextRunAt = now;
      }

      const record: MonitorRecord = {
        monitor_id: monitorId,
        version: 1,
        owner: { actor_id: ctx?.actor_id ?? "system", actor_type: "system", session_id: identity.session_id ?? "", root_session_id: identity.root_session_id, workspace_id: identity.workspace_id },
        scope: params.scope ?? "session",
        name: params.name,
        description: params.description,
        state: "running",
        check,
        schedule,
        condition,
        attention,
        retention: { ...DEFAULT_RETENTION, ...(params.retention ?? {}) },
        labels: params.labels ?? {},
        metadata: { ...metadata, ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}) },
        created_at: now,
        updated_at: now,
        next_run_at: nextRunAt,
        failure_count: 0,
        consecutive_failure_count: 0,
        run_count: 0,
      };

      await store.create(record);
      let streamState: any;
      if (check.type === "command" && check.mode !== "poll") {
        if (!streams) throw new Error("Stream monitors are not available");
        const wake = (params.wake ?? (params.kind ? "on_failure" : undefined)) as WakeMode | undefined;
        streamState = streams.start({ command: check.command, description: params.description ?? params.name ?? monitorId, cwd: check.cwd, timeout_ms: check.timeout_ms, notify: record.attention.notify, wake_agent: !params.kind && record.attention.wake_agent, wake_on_line: params.kind ? wake === "on_event" : undefined, wake_on_completion: params.kind ? wake === "on_terminal" : undefined, wake_on_failure: params.kind ? wake === "on_failure" : undefined, event_throttle_ms: check.event_throttle_ms, max_lines_per_turn: check.max_lines_per_turn, shell: check.shell, stream_id: monitorId, monitor_id: monitorId, output_file: check.output_path, store }, ctx);
      }
      await status?.refresh(ctx);

      return {
        content: [{ type: "text" as const, text: startMessage(monitorId, record, nextRunAt, outputPath ?? streamState?.output_file, warnings) }],
        details: { ok: true, monitor_id: monitorId, state: record.state, kind: params.kind ?? (check as any).type, name: record.name, output_path: outputPath ?? streamState?.output_file, wake: (metadata as any).wake, next_action: nextRunAt ? "wait" : "inspect_output", next_run_at: nextRunAt, idempotent: false },
      };
    },
  };
}

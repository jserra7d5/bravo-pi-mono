import type { MonitorRecord, MonitorState, CheckSpec, ScheduleSpec, ConditionSpec, AttentionSpec, RetentionSpec, MonitorOwner } from "./schema/types.js";
import { ValidationError } from "./errors.js";

export function validateCheck(check: CheckSpec): void {
  if (!check || typeof check !== "object") throw new ValidationError("Check must be an object");
  switch (check.type) {
    case "file": {
      if (!check.path || typeof check.path !== "string") throw new ValidationError("File check requires path");
      const allowedModes = new Set(["exists", "missing", "modified_since_start", "contains"]);
      if (!allowedModes.has(check.mode)) throw new ValidationError(`Invalid file check mode: ${check.mode}`);
      if (check.mode === "contains" && (!check.pattern || typeof check.pattern !== "string")) {
        throw new ValidationError("File check mode 'contains' requires pattern");
      }
      return;
    }
    case "command": {
      const c = check as any;
      if (!c.command || typeof c.command !== "string" || c.command.trim().length === 0) throw new ValidationError("Command check requires non-empty command");
      if (c.mode !== undefined && c.mode !== "stream" && c.mode !== "exit" && c.mode !== "poll") throw new ValidationError(`Invalid command mode: ${c.mode}`);
      if (c.emit !== undefined && !["line", "state_change", "terminal"].includes(c.emit)) throw new ValidationError(`Invalid command emit: ${c.emit}`);
      for (const key of ["timeout_ms", "event_throttle_ms", "tail_bytes"] as const) {
        if (c[key] !== undefined && (!Number.isFinite(c[key]) || c[key] < 0 || c[key] > 24 * 60 * 60 * 1000)) throw new ValidationError(`${key} is out of bounds`);
      }
      if (c.max_lines_per_turn !== undefined && (!Number.isInteger(c.max_lines_per_turn) || c.max_lines_per_turn < 1 || c.max_lines_per_turn > 1000)) throw new ValidationError("max_lines_per_turn is out of bounds");
      if (c.shell !== undefined && typeof c.shell !== "boolean") throw new ValidationError("shell must be boolean");
      return;
    }
    default:
      throw new ValidationError(`Unsupported check type: ${(check as any).type}`);
  }
}

export function validateSchedule(schedule: ScheduleSpec): void {
  if (!schedule || typeof schedule !== "object") throw new ValidationError("Schedule must be an object");
  if (typeof schedule.interval_ms === "number") {
    if (!Number.isFinite(schedule.interval_ms) || schedule.interval_ms < 1000) {
      throw new ValidationError("interval_ms must be at least 1000ms");
    }
  }
  if (typeof schedule.deadline_at === "string") {
    const d = Date.parse(schedule.deadline_at);
    if (!Number.isFinite(d)) throw new ValidationError("Invalid deadline_at date");
  }
}

export function validateCondition(condition?: ConditionSpec): void {
  if (!condition) return;
  const recurse = (c: ConditionSpec) => {
    switch (c.type) {
      case "always":
        return;
      case "observation_status": {
        const vals = new Set(["matched", "not_matched", "error", "timeout"]);
        if (!vals.has(c.equals)) throw new ValidationError(`Invalid observation_status equals: ${c.equals}`);
        return;
      }
      case "text_contains": {
        if (!c.path || typeof c.path !== "string") throw new ValidationError("text_contains requires path");
        if (!c.text || typeof c.text !== "string") throw new ValidationError("text_contains requires text");
        return;
      }
      case "and":
      case "or": {
        if (!Array.isArray(c.conditions) || c.conditions.length === 0) {
          throw new ValidationError(`${c.type} requires non-empty conditions array`);
        }
        for (const child of c.conditions) recurse(child);
        return;
      }
      case "not": {
        recurse(c.condition);
        return;
      }
      default:
        throw new ValidationError(`Unsupported condition type: ${(c as any).type}`);
    }
  };
  recurse(condition);
}

export function validateAttention(attention: AttentionSpec): void {
  if (!attention || typeof attention !== "object") throw new ValidationError("Attention must be an object");
}

export function validateRetention(retention: RetentionSpec): void {
  if (!retention || typeof retention !== "object") throw new ValidationError("Retention must be an object");
}

export function validateLabels(labels: Record<string, string>): void {
  if (!labels || typeof labels !== "object") throw new ValidationError("Labels must be an object");
}

export function validateOwner(owner: MonitorOwner): void {
  if (!owner || typeof owner !== "object") throw new ValidationError("Owner must be an object");
  if (!owner.actor_id || typeof owner.actor_id !== "string") throw new ValidationError("Owner actor_id required");
  const allowed = new Set(["agent", "user", "system", "tool"]);
  if (!allowed.has(owner.actor_type)) throw new ValidationError(`Invalid actor_type: ${owner.actor_type}`);
}

export function validateStateTransition(from: MonitorState, to: MonitorState): void {
  const terminal = new Set(["completed", "stopped", "canceled", "expired", "archived", "succeeded", "failed", "triggered"]);
  if (terminal.has(from) && from !== to) {
    throw new ValidationError(`Cannot transition from terminal state ${from} to ${to}`);
  }
}

export function validateRecord(record: MonitorRecord): void {
  validateCheck(record.check);
  validateSchedule(record.schedule);
  validateCondition(record.condition);
  validateAttention(record.attention);
  validateRetention(record.retention);
  validateLabels(record.labels);
  validateOwner(record.owner);
}

import type { MonitorRecord, MonitorState, CheckSpec, ScheduleSpec, ConditionSpec, AttentionSpec, RetentionSpec, MonitorOwner } from "./schema/types.js";
import { ValidationError } from "./errors.js";

export function validateCheck(check: CheckSpec): void {
  if (!check || typeof check !== "object") throw new ValidationError("Check must be an object");
  switch (check.type) {
    case "timer":
      return;
    case "file": {
      if (!check.path || typeof check.path !== "string") throw new ValidationError("File check requires path");
      const allowedModes = new Set(["exists", "missing", "modified_since_start", "contains"]);
      if (!allowedModes.has(check.mode)) throw new ValidationError(`Invalid file check mode: ${check.mode}`);
      if (check.mode === "contains" && (!check.pattern || typeof check.pattern !== "string")) {
        throw new ValidationError("File check mode 'contains' requires pattern");
      }
      return;
    }
    default:
      throw new ValidationError(`Unsupported check type: ${(check as any).type}`);
  }
}

export function validateSchedule(schedule: ScheduleSpec): void {
  if (!schedule || typeof schedule !== "object") throw new ValidationError("Schedule must be an object");
  // Empty schedules are valid and mean "run immediately once, then use the default interval if not terminal".
  if (typeof schedule.delay_ms === "number") {
    if (!Number.isFinite(schedule.delay_ms) || schedule.delay_ms < 1000) {
      throw new ValidationError("delay_ms must be at least 1000ms");
    }
  }
  if (typeof schedule.interval_ms === "number") {
    if (!Number.isFinite(schedule.interval_ms) || schedule.interval_ms < 1000) {
      throw new ValidationError("interval_ms must be at least 1000ms");
    }
  }
  if (typeof schedule.start_at === "string") {
    const d = Date.parse(schedule.start_at);
    if (!Number.isFinite(d)) throw new ValidationError("Invalid start_at date");
  }
  if (typeof schedule.max_runs === "number") {
    if (!Number.isInteger(schedule.max_runs) || schedule.max_runs < 1) {
      throw new ValidationError("max_runs must be a positive integer");
    }
  }
  if (typeof schedule.timeout_ms === "number") {
    if (!Number.isFinite(schedule.timeout_ms) || schedule.timeout_ms < 1000) {
      throw new ValidationError("timeout_ms must be at least 1000ms");
    }
  }
  if (schedule.backoff) {
    const strategies = new Set(["none", "linear", "exponential"]);
    if (!strategies.has(schedule.backoff.strategy)) {
      throw new ValidationError(`Invalid backoff strategy: ${schedule.backoff.strategy}`);
    }
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
  const terminal = new Set(["stopped", "canceled", "expired", "archived"]);
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

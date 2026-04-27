import type { ConditionSpec, MonitorResult, MonitorResultStatus } from "../schema/types.js";

export function evaluateCondition(condition: ConditionSpec | undefined, result: MonitorResult): boolean {
  if (!condition) {
    return result.status === "matched";
  }
  switch (condition.type) {
    case "always":
      return true;
    case "observation_status":
      return result.status === condition.equals;
    case "text_contains": {
      const value = extractPath(result.observation, condition.path);
      const text = String(value ?? "");
      if (condition.case_sensitive === false) {
        return text.toLowerCase().includes(condition.text.toLowerCase());
      }
      return text.includes(condition.text);
    }
    case "and":
      return condition.conditions.every((c) => evaluateCondition(c, result));
    case "or":
      return condition.conditions.some((c) => evaluateCondition(c, result));
    case "not":
      return !evaluateCondition(condition.condition, result);
    default:
      return false;
  }
}

function extractPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

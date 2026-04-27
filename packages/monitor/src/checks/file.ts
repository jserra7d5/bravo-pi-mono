import { existsSync, readFileSync, statSync } from "node:fs";
import type { MonitorRecord, MonitorResult, FileCheckSpec } from "../schema/types.js";
import { generateResultId } from "../ids.js";
import { nowISO } from "../time.js";

export async function runFileCheck(record: MonitorRecord, _signal?: AbortSignal): Promise<MonitorResult> {
  const check = record.check as FileCheckSpec;
  const resultBase = {
    result_id: generateResultId(),
    monitor_id: record.monitor_id,
    created_at: nowISO(),
  };

  try {
    const path = check.path;
    const exists = existsSync(path);

    switch (check.mode) {
      case "exists": {
        const matched = exists;
        return {
          ...resultBase,
          status: matched ? "matched" : "not_matched",
          observation: { exists, path },
          condition_matched: matched,
          triggered: matched,
        };
      }
      case "missing": {
        const matched = !exists;
        return {
          ...resultBase,
          status: matched ? "matched" : "not_matched",
          observation: { exists, path },
          condition_matched: matched,
          triggered: matched,
        };
      }
      case "modified_since_start": {
        if (!exists) {
          return {
            ...resultBase,
            status: "not_matched",
            observation: { exists: false, path },
            condition_matched: false,
            triggered: false,
          };
        }
        const stat = statSync(path);
        const start = Date.parse(record.created_at);
        const modified = stat.mtimeMs > start;
        return {
          ...resultBase,
          status: modified ? "matched" : "not_matched",
          observation: { mtime: stat.mtimeMs, created_at: record.created_at, path },
          condition_matched: modified,
          triggered: modified,
        };
      }
      case "contains": {
        if (!exists) {
          return {
            ...resultBase,
            status: "not_matched",
            observation: { exists: false, path },
            condition_matched: false,
            triggered: false,
          };
        }
        const content = readFileSync(path, check.encoding ?? "utf8");
        const pattern = check.pattern ?? "";
        const found = content.includes(pattern);
        return {
          ...resultBase,
          status: found ? "matched" : "not_matched",
          observation: { found, path, pattern },
          condition_matched: found,
          triggered: found,
        };
      }
      default:
        return {
          ...resultBase,
          status: "error",
          observation: { error: `Unknown file check mode: ${(check as any).mode}` },
          condition_matched: false,
          triggered: false,
          error_message: `Unknown file check mode: ${(check as any).mode}`,
        };
    }
  } catch (err: any) {
    return {
      ...resultBase,
      status: "error",
      observation: { error: err?.message ?? String(err) },
      condition_matched: false,
      triggered: false,
      error_message: err?.message ?? String(err),
    };
  }
}

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isTerminalRunState } from "./schemas.js";
import { RunStore } from "./runStore.js";
import type { RunStatus } from "./types.js";

export type RetentionSkipReason = "active" | "unhandled-wakeup" | "too-recent";

function deliveryStatePath(store: RunStore, parentRunId: string): string {
  return join(resolve(store.runRoot, ".."), "delivery", `${parentRunId}.json`);
}

export function hasUnhandledWakeup(store: RunStore, parentRunId: string, runId: string): boolean {
  const path = deliveryStatePath(store, parentRunId);
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { delivered?: Record<string, string>; handled?: Record<string, string> };
    for (const key of Object.keys(state.delivered ?? {})) {
      if (key.includes(`:${runId}:`) && !state.handled?.[key]) return true;
    }
  } catch {
    return true;
  }
  return false;
}

export function retentionSkipReason(store: RunStore, status: RunStatus, olderThanMs: number, nowMs = Date.now()): RetentionSkipReason | undefined {
  if (!isTerminalRunState(status.state)) return "active";
  if (status.resultReady || hasUnhandledWakeup(store, status.parentRunId, status.runId)) return "unhandled-wakeup";
  const updatedAt = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedAt) || nowMs - updatedAt < olderThanMs) return "too-recent";
  return undefined;
}

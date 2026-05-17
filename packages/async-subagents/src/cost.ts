import { existsSync, readFileSync } from "node:fs";
import { RunStore } from "./runStore.js";

interface AssistantUsageCost {
  total?: unknown;
}

interface AssistantUsage {
  cost?: AssistantUsageCost;
}

interface AssistantMessage {
  role?: unknown;
  usage?: AssistantUsage;
}

interface SessionEntry {
  type?: unknown;
  message?: AssistantMessage;
}

function parseJsonl(buffer: Buffer): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let lineStart = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    let lineEnd = i;
    if (lineEnd > lineStart && buffer[lineEnd - 1] === 0x0d) lineEnd--;
    const raw = buffer.subarray(lineStart, lineEnd).toString("utf8");
    lineStart = i + 1;
    if (!raw.trim()) continue;
    try {
      entries.push(JSON.parse(raw) as SessionEntry);
    } catch {
      // Skip corrupt or partially-written lines. Child sessions can leave
      // trailing fragments and we never want to throw on cost extraction.
    }
  }
  return entries;
}

function sumAssistantCost(entries: SessionEntry[]): number | undefined {
  let total = 0;
  let found = false;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    const cost = message.usage?.cost?.total;
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
    total += cost;
    found = true;
  }
  return found ? total : undefined;
}

/**
 * Synchronous core used by the async public surface and by
 * `finalizeTerminalRun`, which is itself synchronous.
 */
export function extractCostFromSessionLogSync(piSessionPath: string | undefined): number | undefined {
  if (!piSessionPath) return undefined;
  if (!existsSync(piSessionPath)) return undefined;
  let buffer: Buffer;
  try {
    buffer = readFileSync(piSessionPath);
  } catch {
    return undefined;
  }
  if (buffer.length === 0) return undefined;
  const entries = parseJsonl(buffer);
  return sumAssistantCost(entries);
}

/**
 * Sum assistant message costs from a pi session JSONL file. Mirrors the
 * traversal pi core uses in its interactive footer:
 * `entry.type === "message" && entry.message.role === "assistant"` and reads
 * `entry.message.usage.cost.total` per assistant turn.
 *
 * Never throws. Returns undefined if the path is missing, unreadable, or
 * contains no assistant cost entries.
 */
export async function extractCostFromSessionLog(piSessionPath: string | undefined): Promise<number | undefined> {
  return extractCostFromSessionLogSync(piSessionPath);
}

/**
 * Sum cost across a run and all its descendants by walking parent/child links
 * in the run index. Reads the persisted `result.json` for each run and totals
 * `metrics.cost.total` where present.
 *
 * Never throws. Returns undefined if no descendant (or the root itself) has a
 * recorded cost.
 */
export async function aggregateCostForSubtree(store: RunStore, rootRunId: string): Promise<number | undefined> {
  let total = 0;
  let found = false;
  const visited = new Set<string>();
  const stack: string[] = [rootRunId];
  while (stack.length > 0) {
    const runId = stack.pop();
    if (!runId || visited.has(runId)) continue;
    visited.add(runId);

    const result = store.readResult(runId);
    const cost = result?.metrics?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total += cost;
      found = true;
    }

    let children: { runId: string }[] = [];
    try {
      children = store.listDirectChildren(runId);
    } catch {
      children = [];
    }
    for (const child of children) {
      if (!visited.has(child.runId)) stack.push(child.runId);
    }
  }
  return found ? total : undefined;
}

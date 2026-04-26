import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMetricsSnapshot } from "./types.js";

export function metricsPath(runDir: string): string { return join(runDir, "metrics.json"); }

export function readMetrics(runDir: string): AgentMetricsSnapshot | undefined {
  const path = metricsPath(runDir);
  if (!existsSync(path)) return undefined;
  try {
    return normalizeMetrics(JSON.parse(readFileSync(path, "utf8")), runDir);
  } catch {
    return undefined;
  }
}

export function writeMetrics(runDir: string, payload: unknown): AgentMetricsSnapshot {
  const snapshot = normalizeMetrics(payload, runDir);
  mkdirSync(runDir, { recursive: true });
  const path = metricsPath(runDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return snapshot;
}

function normalizeMetrics(payload: unknown, runDir: string): AgentMetricsSnapshot {
  if (!payload || typeof payload !== "object") throw new Error("Metrics payload must be an object");
  const input = payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const snapshot: AgentMetricsSnapshot = {
    schemaVersion: 1,
    runDir,
    agent: stringValue(input.agent) ?? process.env.TANGO_AGENT_NAME ?? "unknown",
    startedAt: stringValue(input.startedAt) ?? now,
    updatedAt: stringValue(input.updatedAt) ?? now,
    toolCalls: numberValue(input.toolCalls) ?? 0,
    toolResults: numberValue(input.toolResults) ?? 0,
    activeToolCalls: numberValue(input.activeToolCalls) ?? 0,
  };
  const toolErrors = numberValue(input.toolErrors);
  if (toolErrors !== undefined) snapshot.toolErrors = toolErrors;
  const lastTool = stringValue(input.lastTool);
  if (lastTool) snapshot.lastTool = lastTool;
  const tokens = objectValue(input.tokens);
  if (tokens) {
    snapshot.tokens = {
      input: numberValue(tokens.input) ?? 0,
      output: numberValue(tokens.output) ?? 0,
      cacheRead: numberValue(tokens.cacheRead) ?? 0,
      cacheWrite: numberValue(tokens.cacheWrite) ?? 0,
      total: numberValue(tokens.total) ?? ((numberValue(tokens.input) ?? 0) + (numberValue(tokens.output) ?? 0) + (numberValue(tokens.cacheRead) ?? 0) + (numberValue(tokens.cacheWrite) ?? 0)),
    };
  }
  const context = objectValue(input.context);
  if (context) {
    snapshot.context = {
      tokens: nullableNumber(context.tokens),
      contextWindow: nullableNumber(context.contextWindow),
      percent: nullableNumber(context.percent),
    };
  }
  const cost = objectValue(input.cost);
  if (cost) {
    snapshot.cost = {
      total: numberValue(cost.total) ?? 0,
      input: numberValue(cost.input),
      output: numberValue(cost.output),
      cacheRead: numberValue(cost.cacheRead),
      cacheWrite: numberValue(cost.cacheWrite),
    };
  } else if (typeof input.cost === "number") {
    snapshot.cost = { total: input.cost };
  }
  return snapshot;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return numberValue(value) ?? null;
}

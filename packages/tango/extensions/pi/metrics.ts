import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const distCli = join(packageRoot, "dist", "cli.js");
const startedAt = new Date().toISOString();

let toolCalls = 0;
let toolResults = 0;
let activeToolCalls = 0;
let toolErrors = 0;
let lastTool: string | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let lastFlush = 0;
let currentCtx: any;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function formatTokens(total: number | undefined): string | undefined {
  if (total === undefined) return undefined;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}m tok`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}k tok`;
  return `${total} tok`;
}

function collectUsage(ctx: any) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let costTotal = 0;
  try {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      const message = entry?.type === "message" ? entry.message : entry?.message ?? entry;
      if (message?.role !== "assistant" || !message.usage) continue;
      const usage = message.usage;
      totals.input += numberValue(usage.input);
      totals.output += numberValue(usage.output);
      totals.cacheRead += numberValue(usage.cacheRead);
      totals.cacheWrite += numberValue(usage.cacheWrite);
      costTotal += numberValue(usage.cost?.total);
    }
  } catch {}
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return { tokens: totals.total > 0 ? totals : undefined, cost: costTotal > 0 ? { total: costTotal } : undefined };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function snapshot(ctx: any) {
  const usage = collectUsage(ctx);
  const context = ctx?.getContextUsage?.();
  return {
    schemaVersion: 1,
    runDir: process.env.TANGO_RUN_DIR ?? "",
    agent: process.env.TANGO_AGENT_NAME ?? "unknown",
    startedAt,
    updatedAt: new Date().toISOString(),
    toolCalls,
    toolResults,
    activeToolCalls,
    toolErrors,
    lastTool,
    tokens: usage.tokens,
    context: context ? {
      tokens: context.tokens ?? null,
      contextWindow: context.contextWindow ?? null,
      percent: context.percent ?? null,
    } : undefined,
    cost: usage.cost,
  };
}

function updateStatus(ctx: any) {
  if (!ctx?.hasUI) return;
  const snap = snapshot(ctx);
  const parts = [process.env.TANGO_AGENT_NAME ?? "agent", `${snap.toolCalls} tools`];
  const tok = formatTokens(snap.tokens?.total);
  if (tok) parts.push(tok);
  if (snap.context?.percent !== null && snap.context?.percent !== undefined) parts.push(`ctx ${Math.round(snap.context.percent)}%`);
  parts.push(formatDuration(Date.now() - Date.parse(startedAt)));
  try { ctx.ui.setStatus("tango-metrics", ctx.ui.theme.fg("dim", `Tango: ${parts.join(" · ")}`)); } catch {}
}

function scheduleFlush(ctx: any, immediate = false) {
  currentCtx = ctx ?? currentCtx;
  updateStatus(currentCtx);
  if (!process.env.TANGO_RUN_DIR) return;
  const now = Date.now();
  const delay = immediate || now - lastFlush > 2000 ? 0 : 2000 - (now - lastFlush);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushMetrics(currentCtx);
  }, delay);
}

async function flushMetrics(ctx: any) {
  if (!process.env.TANGO_RUN_DIR) return;
  lastFlush = Date.now();
  const payload = JSON.stringify(snapshot(ctx));
  await runTango(["metrics", "update", "--run-dir", process.env.TANGO_RUN_DIR, "--payload", payload, "--json"], 1500);
}

function runTango(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [distCli, ...args], { cwd: process.cwd(), env: process.env as Record<string, string>, stdio: "ignore" });
    const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {}; resolve(); }, timeoutMs);
    proc.on("error", () => { clearTimeout(timer); resolve(); });
    proc.on("close", () => { clearTimeout(timer); resolve(); });
  });
}

function safe(fn: () => void) {
  try { fn(); } catch {}
}

export default function(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => safe(() => {
    currentCtx = ctx;
    scheduleFlush(ctx, true);
  }));

  pi.on("tool_call", async (event, ctx) => {
    safe(() => {
      toolCalls++;
      activeToolCalls++;
      lastTool = event.toolName;
      scheduleFlush(ctx);
    });
    return {};
  });

  pi.on("tool_result", async (event, ctx) => safe(() => {
    toolResults++;
    activeToolCalls = Math.max(0, activeToolCalls - 1);
    if (event.isError) toolErrors++;
    lastTool = event.toolName;
    scheduleFlush(ctx);
  }));

  pi.on("message_end", async (event, ctx) => safe(() => {
    if ((event as any).message?.role === "assistant") scheduleFlush(ctx);
  }));

  pi.on("turn_end", async (_event, ctx) => safe(() => scheduleFlush(ctx)));

  pi.on("session_shutdown", async () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    await flushMetrics(currentCtx).catch(() => {});
  });
}

import { readFile } from "node:fs/promises";
import { configFromContext } from "./config.js";
import { TaskRegistry } from "./task-registry.js";
import { BackgroundRunner } from "./background-runner.js";
import { renderTaskList, renderTaskCard, renderTail } from "./ui.js";

function cwdOf(ctx: unknown): string { return typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd(); }
function sessionIdOf(ctx: unknown): string | undefined { const v = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager?.getSessionId?.(); return typeof v === "string" ? v : undefined; }
function notify(ctx: unknown, lines: string[]) { (ctx as { ui?: { notify?: (msg: string, level?: string) => void } })?.ui?.notify?.(lines.join("\n"), "info"); }
function sessionOwned<T extends { ownerSessionId?: string }>(records: T[], sessionId?: string): T[] { return records.filter((record) => sessionId ? record.ownerSessionId === sessionId : !record.ownerSessionId); }
function resolveId(registry: TaskRegistry, raw: string | undefined, sessionId?: string) { if (!raw) return undefined; const needle = raw.replace(/^bg…/, ""); return sessionOwned(registry.list(true), sessionId).find(t => t.taskId === raw || t.taskId.endsWith(needle)); }
async function tail(path: string, n: number) { const text = await readFile(path, "utf8").catch(() => ""); return text.split(/\r?\n/).slice(-Math.max(1, Math.min(200, n))).join("\n"); }

type BackgroundRefresh = (ctx: unknown) => void;

export function registerTaskCommands(pi: { registerCommand?: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => unknown }) => void }, refreshBackgroundBashWidget?: BackgroundRefresh) {
  pi.registerCommand?.("bash-tasks", { description: "List, show, tail, stop, or cleanup background bash tasks", handler: async (args: string, ctx: unknown) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? "list";
    const cfg = configFromContext(ctx, cwdOf(ctx));
    const registry = new TaskRegistry(cfg.dataDir);
    const sessionId = sessionIdOf(ctx);
    if (sub === "list" || sub === "all" || !sub) {
      new BackgroundRunner(registry, cfg).reconcile(sessionId);
      refreshBackgroundBashWidget?.(ctx);
      notify(ctx, renderTaskList(sessionOwned(registry.list(sub === "all"), sessionId)).render(80)); return;
    }
    if (sub === "show") {
      const task = resolveId(registry, parts[1], sessionId); notify(ctx, task ? renderTaskCard(task, true).render(80) : ["Task not found in this session"]); return;
    }
    if (sub === "tail") {
      const task = resolveId(registry, parts[1], sessionId); const n = Number(parts[2] ?? 40); notify(ctx, task ? renderTail(task, await tail(task.outputPath, n), n).render(80) : ["Task not found in this session"]); return;
    }
    if (sub === "stop") {
      const task = resolveId(registry, parts[1], sessionId); if (!task) { notify(ctx, ["Task not found in this session"]); return; }
      const stopped = await new BackgroundRunner(registry, cfg).stop(task.taskId);
      refreshBackgroundBashWidget?.(ctx);
      notify(ctx, stopped ? renderTaskCard(stopped, false).render(80) : ["Task not found"]); return;
    }
    if (sub === "cleanup") {
      const tasks = sessionOwned(registry.list(true), sessionId); let removed = 0;
      for (const t of tasks) if (["exited", "failed", "timed_out", "killed"].includes(t.status) && registry.remove(t.taskId)) removed++;
      refreshBackgroundBashWidget?.(ctx);
      notify(ctx, [`Cleaned up ${removed} completed background task${removed === 1 ? "" : "s"} for this session.`]); return;
    }
    notify(ctx, ["Usage: /bash-tasks [list|all|show <id>|tail <id> [lines]|stop <id>|cleanup]"]);
  } });
}

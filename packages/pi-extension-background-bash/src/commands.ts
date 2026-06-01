import { readFile } from "node:fs/promises";
import { configFromContext } from "./config.js";
import { TaskRegistry } from "./task-registry.js";
import { BackgroundRunner } from "./background-runner.js";
import { renderTaskList, renderTaskCard, renderTail } from "./ui.js";

function cwdOf(ctx: unknown): string { return typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd(); }
function notify(ctx: unknown, lines: string[]) { (ctx as { ui?: { notify?: (msg: string, level?: string) => void } })?.ui?.notify?.(lines.join("\n"), "info"); }
function resolveId(registry: TaskRegistry, raw: string | undefined) { if (!raw) return undefined; const needle = raw.replace(/^bg…/, ""); return registry.list(true).find(t => t.taskId === raw || t.taskId.endsWith(needle)); }
async function tail(path: string, n: number) { const text = await readFile(path, "utf8").catch(() => ""); return text.split(/\r?\n/).slice(-Math.max(1, Math.min(200, n))).join("\n"); }

export function registerTaskCommands(pi: { registerCommand?: (name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => unknown }) => void }) {
  pi.registerCommand?.("tasks", { description: "List, show, tail, stop, or cleanup background bash tasks", handler: async (args: string, ctx: unknown) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? "list";
    const cfg = configFromContext(ctx, cwdOf(ctx));
    const registry = new TaskRegistry(cfg.dataDir);
    if (sub === "list" || sub === "all" || !sub) {
      notify(ctx, renderTaskList(registry.list(sub === "all")).render(80)); return;
    }
    if (sub === "show") {
      const task = resolveId(registry, parts[1]); notify(ctx, task ? renderTaskCard(task, true).render(80) : ["Task not found"]); return;
    }
    if (sub === "tail") {
      const task = resolveId(registry, parts[1]); const n = Number(parts[2] ?? 40); notify(ctx, task ? renderTail(task, await tail(task.outputPath, n), n).render(80) : ["Task not found"]); return;
    }
    if (sub === "stop") {
      const task = resolveId(registry, parts[1]); if (!task) { notify(ctx, ["Task not found"]); return; }
      const stopped = await new BackgroundRunner(registry, cfg).stop(task.taskId);
      notify(ctx, stopped ? renderTaskCard(stopped, false).render(80) : ["Task not found"]); return;
    }
    if (sub === "cleanup") {
      const tasks = registry.list(true); let removed = 0;
      for (const t of tasks) if (!["starting", "running", "blocked"].includes(t.status)) { registry.remove(t.taskId); removed++; }
      notify(ctx, [`Cleaned up ${removed} completed background task${removed === 1 ? "" : "s"}.`]); return;
    }
    notify(ctx, ["Usage: /tasks [list|all|show <id>|tail <id> [lines]|stop <id>|cleanup]"]);
  } });
}

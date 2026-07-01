import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { configFromContext } from "./config.js";
import { BackgroundRunner, runtimeId } from "./background-runner.js";
import { TaskRegistry } from "./task-registry.js";
import { executeForeground } from "./foreground.js";
import type { ToolResponse } from "./task-types.js";
import { renderTaskCard, renderTaskList, truncAnsi, type TextRenderable } from "./ui.js";

const maxSeconds = 24 * 60 * 60;
const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: maxSeconds, description: "Foreground command timeout, or background process maximum runtime in seconds. With run_in_background:true, this is not a client wait timeout; timeout:1 kills the background task after 1s." })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Start a managed background task and return immediately." })),
  wake_on_completion: Type.Optional(Type.Boolean({ description: "Opt in to model notification on completion; off by default." })),
});

function text(summary: string, details: Record<string, unknown>, isError = false): ToolResponse { return { content: [{ type: "text", text: summary }], details, isError: isError || undefined }; }
function fallbackTextResult(result: ToolResponse): TextRenderable {
  const body = result?.content?.find(c => c.type === "text" && typeof c.text === "string")?.text ?? "No background task details returned.";
  return { invalidate() {}, render(width = 80) { return body.split(/\r?\n/).map(line => truncAnsi(line, Math.max(1, width))); } };
}
function cwdOf(ctx: unknown): string { return typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd(); }
function sessionIdOf(ctx: unknown): string | undefined { const v = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager?.getSessionId?.(); return typeof v === "string" ? v : undefined; }
function sessionFileOf(ctx: unknown): string | undefined { const v = (ctx as { sessionManager?: { getSessionFile?: () => unknown } } | undefined)?.sessionManager?.getSessionFile?.(); return typeof v === "string" ? v : undefined; }
function positiveSeconds(v: unknown, name: string): number | undefined { if (v === undefined) return undefined; if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0 || v > maxSeconds) throw new Error(`${name} must be a positive integer seconds value <= ${maxSeconds}`); return v; }
function positiveMs(v: unknown, name: string, max = 60_000): number | undefined { if (v === undefined) return undefined; if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) throw new Error(`${name} must be a positive finite millisecond value <= ${max}`); return v; }
function sessionOwned<T extends { ownerSessionId?: string }>(records: T[], sessionId?: string): T[] { return records.filter((record) => sessionId ? record.ownerSessionId === sessionId : !record.ownerSessionId); }
function sessionOwns(record: { ownerSessionId?: string }, sessionId?: string): boolean { return sessionId ? record.ownerSessionId === sessionId : !record.ownerSessionId; }

type PiSender = { sendMessage?: (message: unknown, options?: unknown) => unknown | Promise<unknown> };
function wakeNotifierFor(pi: PiSender | undefined, ctx: unknown, ownerSessionId: string | undefined, ownerSessionFile: string | undefined) {
  if (!pi?.sendMessage || !ownerSessionId) return undefined;
  return {
    ownerSessionId,
    ownerRuntimeId: runtimeId,
    ownerSessionFile,
    currentSessionId: () => sessionIdOf(ctx),
    currentSessionFile: () => sessionFileOf(ctx),
    async send(message: { options?: unknown } & Record<string, unknown>) {
      const { options, ...body } = message;
      const result = pi.sendMessage!(body, options);
      await Promise.resolve(result);
      return { acceptedAt: new Date().toISOString(), deliverySemantics: "accepted" as const };
    },
  };
}

type BackgroundRefresh = (ctx: unknown) => void;

export function buildBackgroundBashTools(pi?: PiSender, refreshBackgroundBashWidget?: BackgroundRefresh) {
  return [
    {
      name: "bash", label: "Bash", description: "Execute shell commands. Use run_in_background for long-running work. For background calls, timeout is the process max runtime, not a return timeout.", parameters: bashSchema,
      async execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
        if (typeof params.command !== "string" || !params.command.trim()) return text("command is required", { code: "INVALID_INPUT" }, true);
        if (!params.run_in_background) return executeForeground(id, params, signal, onUpdate, ctx);
        let timeoutSeconds: number | undefined;
        try { timeoutSeconds = positiveSeconds(params.timeout, "timeout"); } catch (err) { return text(err instanceof Error ? err.message : String(err), { code: "INVALID_INPUT" }, true); }
        if (timeoutSeconds !== undefined && timeoutSeconds < 30) return text("timeout with run_in_background=true is the background process maximum runtime, not a client wait timeout; use >=30s or omit it instead of using a tiny value to return quickly", { code: "INVALID_INPUT" }, true);
        const cfg = configFromContext(ctx, cwdOf(ctx));
        const ownerSessionId = sessionIdOf(ctx);
        const ownerSessionFile = sessionFileOf(ctx);
        const wakeOnCompletion = params.wake_on_completion === true;
        const task = await new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).start({ command: params.command, timeout: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000, wakeOnCompletion, cwd: cwdOf(ctx), ownerSessionId, ownerSessionFile, wakeNotifier: wakeNotifierFor(pi, ctx, ownerSessionId, ownerSessionFile) });
        refreshBackgroundBashWidget?.(ctx);
        const wakeLine = wakeOnCompletion ? "Wake on completion: enabled" : "Wake on completion: disabled\nCompletion will be recorded in task metadata/UI only; use background_task_status or read the output path when you need results.";
        const summary = task.status === "failed" ? `Background command failed to start.\nTask: ${task.taskId}\nOutput: ${task.outputPath}` : `Background command started.\nTask: ${task.taskId}\nStatus: ${task.status}\nOutput: ${task.outputPath}\n${wakeLine}\n\nUse read on the output path or background_task_status/list/stop for lifecycle control.`;
        return text(summary, { task }, task.status === "failed");
      },
    },
    { name: "background_task_list", label: "Background Tasks", description: "List managed background bash tasks for this Pi session.", parameters: Type.Object({ includeCompleted: Type.Optional(Type.Boolean()) }), renderResult: (result: ToolResponse) => Array.isArray(result?.details?.tasks) ? renderTaskList(result.details.tasks as never) : fallbackTextResult(result), renderShell: "self", execute: async (_id: string, params: Record<string, unknown>, _s: unknown, _u: unknown, ctx: unknown) => { const cfg = configFromContext(ctx, cwdOf(ctx)); const sessionId = sessionIdOf(ctx); const registry = new TaskRegistry(cfg.dataDir); new BackgroundRunner(registry, cfg).reconcile(sessionId); refreshBackgroundBashWidget?.(ctx); const tasks = sessionOwned(registry.list(params.includeCompleted === true), sessionId); return text(tasks.length ? `Found ${tasks.length} background task${tasks.length === 1 ? "" : "s"} for this session. Use background_task_status or /bash-tasks show for details.` : "No background tasks for this session.", { tasks, sessionId }); } },
    { name: "background_task_status", label: "Background Task Status", description: "Inspect one managed background bash task from this Pi session.", parameters: Type.Object({ taskId: Type.String() }), renderResult: (result: ToolResponse) => { const task = result?.details?.task; return task && typeof task === "object" ? renderTaskCard(task as never, true) : fallbackTextResult(result); }, renderShell: "self", execute: async (_id: string, params: Record<string, unknown>, _s: unknown, _u: unknown, ctx: unknown) => { const cfg = configFromContext(ctx, cwdOf(ctx)); const sessionId = sessionIdOf(ctx); const task = typeof params.taskId === "string" ? new TaskRegistry(cfg.dataDir).get(params.taskId) : undefined; return task && sessionOwns(task, sessionId) ? text(`${task.taskId}: ${task.status}\nOutput: ${task.outputPath}`, { task, sessionId }) : text("Task not found in this session", { code: "TASK_NOT_FOUND", taskId: params.taskId, sessionId }, true); } },
    { name: "background_task_stop", label: "Stop Background Task", description: "Stop one managed background bash task from this Pi session.", parameters: Type.Object({ taskId: Type.String(), signal: Type.Optional(StringEnum(["SIGTERM", "SIGKILL"])), killAfterMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000 })) }), renderResult: (result: ToolResponse) => { const task = result?.details?.task; return task && typeof task === "object" ? renderTaskCard(task as never, false) : fallbackTextResult(result); }, renderShell: "self", execute: async (_id: string, params: Record<string, unknown>, _s: unknown, _u: unknown, ctx: unknown) => { let killAfterMs: number | undefined; try { killAfterMs = positiveMs(params.killAfterMs, "killAfterMs"); } catch (err) { return text(err instanceof Error ? err.message : String(err), { code: "INVALID_INPUT" }, true); } const cfg = configFromContext(ctx, cwdOf(ctx)); const sessionId = sessionIdOf(ctx); const registry = new TaskRegistry(cfg.dataDir); const existing = registry.get(String(params.taskId)); if (!existing || !sessionOwns(existing, sessionId)) return text("Task not found in this session", { code: "TASK_NOT_FOUND", taskId: params.taskId, sessionId }, true); const task = await new BackgroundRunner(registry, cfg).stop(String(params.taskId), params.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM", killAfterMs); refreshBackgroundBashWidget?.(ctx); return task ? text(`${task.taskId}: ${task.status === "orphaned" ? "not stopped; PID ownership unverified" : "stop requested"}`, { task, sessionId }, task.status === "orphaned") : text("Task not found", { code: "TASK_NOT_FOUND", sessionId }, true); } },
  ];
}

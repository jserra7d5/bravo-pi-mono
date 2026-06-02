import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildBackgroundBashTools } from "./bash-tool.js";
import { BackgroundRunner } from "./background-runner.js";
import { configFromContext, readConfig } from "./config.js";
import { TaskRegistry } from "./task-registry.js";
import { registerTaskCommands } from "./commands.js";
import { renderFooter } from "./ui.js";

function cwdOf(ctx: unknown): string { return typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd(); }
function sessionIdOf(ctx: unknown): string | undefined { const v = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager?.getSessionId?.(); return typeof v === "string" ? v : undefined; }
function runnerFor(ctx: unknown) { const cfg = configFromContext(ctx, cwdOf(ctx)); return new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg); }
function updateFooter(ctx: unknown) {
  const ui = (ctx as { ui?: { setWidget?: (key: string, value: unknown, options?: Record<string, unknown>) => void } } | undefined)?.ui;
  if (!ui?.setWidget) return;
  const cfg = configFromContext(ctx, cwdOf(ctx));
  const tasks = new TaskRegistry(cfg.dataDir).list(false);
  const counts = { running: tasks.filter(t => t.status === "running" || t.status === "starting").length, blocked: tasks.filter(t => t.status === "blocked").length, failed: tasks.filter(t => t.status === "failed" || t.status === "timed_out" || t.status === "orphaned").length };
  if (!counts.running && !counts.blocked && !counts.failed) { ui.setWidget("background-bash", undefined, { placement: "belowEditor" }); return; }
  ui.setWidget("background-bash", () => renderFooter(counts), { placement: "belowEditor" });
}

type ToolLike = { name?: unknown; extensionId?: unknown; source?: unknown; sourceInfo?: { packageId?: unknown; extensionId?: unknown; source?: unknown; path?: unknown } } | string;
function toolName(t: ToolLike): string | undefined { return typeof t === "string" ? t : typeof t.name === "string" ? t.name : undefined; }
function isBackgroundBashTool(t: ToolLike): boolean {
  if (typeof t === "string") return false;
  const ids = [t.extensionId, t.source, t.sourceInfo?.packageId, t.sourceInfo?.extensionId, t.sourceInfo?.source, t.sourceInfo?.path];
  return ids.some(v => typeof v === "string" && (v === "@bravo/pi-extension-background-bash" || v === "pi-extension-background-bash" || v.includes("/pi-extension-background-bash/")));
}
async function verifiedBashOverride(pi: ExtensionAPI): Promise<boolean> {
  const api = pi as ExtensionAPI & { getActiveTools?: () => unknown; getAllTools?: () => unknown; notify?: (message: string) => unknown; showNotification?: (message: string) => unknown };
  if (typeof api.getActiveTools !== "function" || typeof api.getAllTools !== "function") return false;
  const active = await api.getActiveTools() as ToolLike[];
  const all = await api.getAllTools() as ToolLike[];
  const activeBash = Array.isArray(active) ? active.filter(t => toolName(t) === "bash") : [];
  const allBash = Array.isArray(all) ? all.filter(t => toolName(t) === "bash") : [];
  // Pi currently documents getActiveTools() as names only, so provenance comes from
  // getAllTools(). Pass only when exactly one active bash name exists and exactly one
  // registered bash tool has this extension's source metadata.
  const ok = activeBash.length === 1 && allBash.length === 1 && isBackgroundBashTool(allBash[0]!);
  if (!ok) {
    const message = "Background bash registered, but active bash override could not be verified; prompt guidance withheld.";
    api.notify?.(message) ?? api.showNotification?.(message);
    console.warn(message);
  }
  return ok;
}

export default async function backgroundBashExtension(pi: ExtensionAPI): Promise<void> {
  // Tool registration happens at extension load, before per-session context is available.
  // Fail closed: only env/load-time config can enable registration and prompt guidance.
  const loadCfg = readConfig(undefined);
  const registered = loadCfg.enabled && typeof pi.registerTool === "function";
  if (registered) for (const tool of buildBackgroundBashTools()) pi.registerTool(tool as never);
  if (registered) registerTaskCommands(pi as never);

  pi.on?.("before_agent_start", async (event: { systemPrompt: string }) => {
    // getActiveTools/getAllTools are action methods; Pi forbids calling them during
    // extension loading, so verify lazily from the event hook before advertising.
    const promptGuidanceVerified = registered ? await verifiedBashOverride(pi) : false;
    if (!registered || !promptGuidanceVerified) return { systemPrompt: event.systemPrompt };
    return { systemPrompt: `${event.systemPrompt}\n\nBackground bash is available: use bash({ command, run_in_background: true }) for long-running commands you intentionally run, such as servers, builds, tests, and other workloads; do not append shell &. Use Monitor only to observe external evidence/state, not to run workloads. Read the returned output path or use background_task_* tools. Stop tasks when done. Model wake-up notification delivery is not implemented; do not rely on background bash to wake the model.` };
  });

  const onAny = pi.on as unknown as ((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => unknown) | undefined;
  onAny?.("session_start", async (_event: unknown, ctx: ExtensionContext) => { if (registered) { runnerFor(ctx).reconcile(sessionIdOf(ctx)); updateFooter(ctx); } });
  onAny?.("reload", async (_event: unknown, ctx: ExtensionContext) => { if (registered) { runnerFor(ctx).reconcile(sessionIdOf(ctx)); updateFooter(ctx); } });
  onAny?.("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => { if (registered) await runnerFor(ctx).shutdown(sessionIdOf(ctx)); });
}

export { buildBackgroundBashTools } from "./bash-tool.js";
export { BackgroundRunner } from "./background-runner.js";
export { TaskRegistry } from "./task-registry.js";

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { readFastTrackState, writeFastTrackState } from "../../src/fastTrack.js";
import { acquireRootSessionLease } from "../../src/leases.js";
import { NAME_PACKS, readNamePackSelection, writeNamePackSelection, type NamePackId } from "../../src/namePacks.js";
import { createRootSession, readRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import type { RootSessionIdentity, RunIndexRecord } from "../../src/types.js";
import { buildCompactionReminder, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE } from "./compactionReminder.js";
import { clearLiveWidget, updateLiveWidget } from "./liveWidget.js";
import { renderDiscoveredAgentCatalog } from "./agentCatalog.js";
import { appendAsyncSubagentsPrompt } from "./promptModule.js";
import { renderSubagentWakeMessageComponent, type WakeupMessage } from "./renderers.js";
import { registerSubagentTools, type ToolRuntime } from "./tools.js";
import { isWakeupKeyHandled, markDeliveredWakeupHandled, pollWakeups } from "./wakeups.js";
import { TaskStore } from "../../src/taskStore.js";

const OWNER_ID = `pi-${process.pid}-${Date.now().toString(36)}`;
const roots = new Map<string, RootSessionIdentity>();

let piTimer: ReturnType<typeof setInterval> | undefined;
let leaseTimer: ReturnType<typeof setInterval> | undefined;
let currentCtx: ExtensionContext | undefined;
let compactionInProgress = false;
let manualCompactionWakeupCooldownUntil = 0;

const MANUAL_COMPACTION_WAKEUP_COOLDOWN_MS = 5_000;

function cwdOf(ctx: unknown): string {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" ? cwd : process.cwd();
}

function piSessionIdOf(ctx: unknown): string | undefined {
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
  const sessionId = sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

function isChildContext(): boolean {
  return Boolean(process.env.ASYNC_SUBAGENTS_RUN_ID || process.env.ASYNC_SUBAGENT_RUN_ID);
}

function inheritedRootSessionId(): string | undefined {
  // Only child Pi sessions should honor the inherited async root. A lead Pi
  // session may inherit this environment accidentally (tests, tmux shells,
  // nested launches), and using it there collapses distinct Pi sessions in the
  // same workspace back onto one root.
  return isChildContext() ? process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID : undefined;
}

function rootCacheKey(cwd: string, piSessionId?: string): string {
  return `${resolve(cwd)}\0${inheritedRootSessionId() ?? piSessionId ?? ""}`;
}

function ensureRoot(cwd: string, piSessionId?: string): RootSessionIdentity {
  const rootSessionId = inheritedRootSessionId();
  const effectivePiSessionId = rootSessionId ? undefined : piSessionId;
  const key = rootCacheKey(cwd, effectivePiSessionId);
  const existing = roots.get(key);
  if (existing) return existing;
  const identity = readRootSession({ cwd, rootSessionId, piSessionId: effectivePiSessionId }) ?? createRootSession({ cwd, rootSessionId, piSessionId: effectivePiSessionId });
  roots.set(key, identity);
  return identity;
}

function acquireLease(cwd: string, identity: RootSessionIdentity): void {
  acquireRootSessionLease({
    cwd,
    rootSessionId: identity.rootSessionId,
    ownerId: OWNER_ID,
    ttlMs: 10_000,
  });
}

function refreshUi(ctx: ExtensionContext): void {
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  const store = new RunStore({ cwd });
  // The widget is the canonical async-subagents surface; the old setStatus
  // segment was redundant alongside the codex footer and has been removed.
  if (ctx.hasUI) updateLiveWidget(ctx, { store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
}

function wakeupEnvelope(wakeup: WakeupMessage): string {
  if (wakeup.kind === "task_wakeup") {
    const task = wakeup.task;
    const taskId = task?.taskId ?? wakeup.taskEvent?.taskId;
    const header = wakeup.state === "task.ready"
      ? "[TASK READY — NOT USER INPUT]"
      : wakeup.state === "task.result_submitted"
        ? "[TASK RESULT READY — NOT USER INPUT]"
        : wakeup.state === "task.failed"
          ? "[TASK FAILED — NOT USER INPUT]"
          : wakeup.state === "task.needs_input"
            ? "[TASK NEEDS INPUT — NOT USER INPUT]"
            : "[TASK ATTENTION — NOT USER INPUT]";
    const lines = [header, ""];
    if (task) lines.push(`Task: ${task.taskId}${task.title ? ` ${task.title}` : ""}`);
    if (task?.owner) lines.push(`Owner: ${task.owner.displayName ? `@${task.owner.displayName}` : task.owner.agent ?? "unknown"}${task.owner.runId ? ` / ${task.owner.runId}` : ""}`);
    if (wakeup.summary) lines.push(`Summary: ${wakeup.summary}`);
    if (task?.receiptPath) lines.push(`Receipt: ${task.receiptPath}`);
    lines.push("");
    if (wakeup.state === "task.ready") {
      lines.push(`This task's dependencies are satisfied and it has no owner. Start it now: subagent_start({ taskId: "${taskId}", agent: "<agent>" }). Choose the agent from the catalog by role fit. Do not wait for a further wakeup to begin a ready task.`);
    } else if (wakeup.state === "task.result_submitted") {
      lines.push(`The owner submitted a result. Review the receipt first: task_get({ taskId: "${taskId}", view: "receipt" }). Then call task_accept_result({ taskId: "${taskId}" }) to mark the task complete and unblock dependents, or task_reopen if the work is insufficient.`);
    } else {
      lines.push(`Next: task_get({ taskId: "${taskId}" })`);
    }
    return lines.join("\n");
  }
  const attention = wakeup.state === "paused" || wakeup.state === "blocked" || wakeup.state === "waiting_for_input" || wakeup.state === "failed";
  const lines = [attention ? "[ASYNC SUBAGENT ATTENTION — NOT USER INPUT]" : "[ASYNC SUBAGENT RESULT READY — NOT USER INPUT]", "", `Run ID: ${wakeup.runId}`];
  if (wakeup.status?.displayName) lines.push(`Subagent: @${wakeup.status.displayName}${wakeup.status.agentName ? ` (${wakeup.status.agentName})` : ""}`);
  else if (wakeup.status?.agentName) lines.push(`Subagent: ${wakeup.status.agentName}`);
  if (wakeup.state) lines.push(`State: ${wakeup.state}`);
  if (wakeup.summary) lines.push(`Summary: ${wakeup.summary}`);
  const terminalResultWakeup = Boolean(wakeup.result);
  if (wakeup.body !== undefined) {
    lines.push("", terminalResultWakeup ? "Result body:" : "Event body:", wakeup.body);
    if (wakeup.bodyTruncation?.truncated === true && terminalResultWakeup) {
      lines.push("", `This wakeup includes a truncated result body; call subagent_result({ runId: "${wakeup.runId}" }) to recover the full result, artifacts, metadata, or for a reread.`);
    } else if (wakeup.bodyTruncation?.truncated === true) {
      lines.push("", "This wakeup includes a truncated event body; use subagent_message if you need the child to provide more detail.");
    } else if (terminalResultWakeup) {
      lines.push("", "This wakeup includes the terminal result body. Use subagent_result only if you need artifacts, metadata, recovery, or a reread.");
    } else {
      lines.push("", "This wakeup includes the child event body.");
    }
  } else {
    lines.push("", wakeup.bodyAvailable ? "The child body is available in the wakeup details but was not rendered inline." : "Full child output is not included in this wakeup.");
  }
  if (wakeup.state === "waiting_for_input" || wakeup.event?.type === "question" || wakeup.state === "blocked" || wakeup.event?.type === "blocked") {
    lines.push(`Reply with subagent_message({ runId: "${wakeup.runId}", type: "answer", ... }) when you have the requested input. Do not call subagent_result for this non-terminal wakeup.`);
  } else if (wakeup.state === "paused") {
    lines.push(`If this result is still needed, choose a bounded extension and call subagent_continue({ runId: "${wakeup.runId}", additionalRunSeconds: 900 }) to resume. Adjust additionalRunSeconds to the smallest reasonable budget for the remaining work, or call subagent_interrupt({ runId: "${wakeup.runId}", action: "cancel" }) if it is no longer needed.`);
  } else if (wakeup.bodyTruncation?.truncated === true && terminalResultWakeup) {
    lines.push(`Call subagent_result({ runId: "${wakeup.runId}" }) if you need the overflow/full canonical result before continuing.`);
  } else if (terminalResultWakeup) {
    lines.push(`You may continue from the inline result if it is sufficient; call subagent_result({ runId: "${wakeup.runId}" }) only for recovery, artifacts, metadata, overflow, or reread.`);
  }
  return lines.join("\n");
}

function sendWakeup(pi: ExtensionAPI, wakeup: WakeupMessage, options: { triggerTurn?: boolean } = {}): void {
  const message = {
    customType: "async-subagent-message",
    content: wakeupEnvelope(wakeup),
    display: true,
    details: wakeup,
  };
  // Terminal results normally wake the parent even when it is idle; autonomous
  // subagent flows depend on the parent receiving each result exactly once.
  // Once-only delivery is enforced by durable delivery keys/claims in wakeups.ts.
  pi.sendMessage(message, { triggerTurn: options.triggerTurn ?? true, deliverAs: "steer" });
}

function pollAndSendWakeups(pi: ExtensionAPI, store: RunStore, identity: RootSessionIdentity, records?: RunIndexRecord[], options: { triggerTurn?: boolean } = {}): void {
  if (compactionInProgress) return;
  for (const delivery of pollWakeups({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, ownerId: OWNER_ID, modelFollowUpOnly: true, records })) {
    if (isWakeupKeyHandled(store, identity.parentRunId, delivery.deliveryKey)) continue;
    sendWakeup(pi, delivery.message, { triggerTurn: options.triggerTurn });
    markDeliveredWakeupHandled(store, identity.parentRunId, delivery);
  }
}

function reconcileTaskOwnedRuns(store: RunStore, rootSessionId: string | undefined): void {
  if (!rootSessionId) return;
  // A task-owned child can die or exit without calling task_submit_result. The
  // reconcile pass detects a terminal owner run and transitions the task off
  // `running` (emitting a wake event). Run it every tick — including headless,
  // where the widget update is skipped — so a dead owner does not strand a task
  // in `running` until the parent happens to inspect the list.
  try { new TaskStore(store).listTasks(rootSessionId, { reconcile: "nonblocking" }); } catch { /* best effort */ }
}

function tickPi(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (compactionInProgress) return;
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  const store = new RunStore({ cwd });
  const records = store.listRecentRuns({ parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
  reconcileTaskOwnedRuns(store, identity.rootSessionId);
  if (Date.now() >= manualCompactionWakeupCooldownUntil) {
    pollAndSendWakeups(pi, store, identity, records, { triggerTurn: true });
  }
  if (ctx.hasUI) updateLiveWidget(ctx, { store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, records });
}

function isNamePackId(value: string): value is NamePackId {
  return Object.hasOwn(NAME_PACKS, value);
}

function namePackSummary(cwd: string): string {
  const store = new RunStore({ cwd });
  const selection = readNamePackSelection(store.runRoot);
  const packs = selection.availablePacks.map((pack) => pack.id).join(", ");
  return `Current subagent name pack: ${selection.activePack}\nAvailable: ${packs}`;
}

function fastTrackSummary(cwd: string, rootSessionId: string): string {
  const state = readFastTrackState(new RunStore({ cwd }).runRoot, rootSessionId);
  return `async-subagents fast-track is ${state.enabled ? "on" : "off"}`;
}

function registerFastTrackCommand(pi: ExtensionAPI): void {
  pi.registerCommand("fast-track", {
    description: "Inspect or change async subagent fast-track policy for this root session.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = cwdOf(ctx);
      const identity = ensureRoot(cwd, piSessionIdOf(ctx));
      const arg = args.trim();
      if (!arg || arg === "status") {
        ctx.ui.notify(fastTrackSummary(cwd, identity.rootSessionId), "info");
        return;
      }
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /fast-track [on|off|status]", "error");
        return;
      }
      writeFastTrackState(new RunStore({ cwd }).runRoot, identity.rootSessionId, arg === "on");
      ctx.ui.notify(`async-subagents fast-track ${arg}`, "info");
      if (currentCtx) refreshUi(currentCtx);
    },
  });
}

function isManualCompactionEvent(event: unknown): boolean {
  const fields = event as { fromExtension?: unknown; fromHook?: unknown } | undefined;
  if (typeof fields?.fromExtension === "boolean") return !fields.fromExtension;
  if (typeof fields?.fromHook === "boolean") return fields.fromHook;
  // Pi compaction events are not guaranteed to expose an origin field in all
  // versions. When origin is unknown, use the manual-compatible policy so a
  // post-compaction async wakeup cannot immediately start another parent turn.
  return true;
}

function registerNamePackCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagent-names", {
    description: "Inspect or change the display-name pack used for future async subagents.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = cwdOf(ctx);
      const pack = args.trim();
      if (!pack || pack === "status" || pack === "list") {
        ctx.ui.notify(namePackSummary(cwd), "info");
        return;
      }
      if (!isNamePackId(pack)) {
        ctx.ui.notify(`Unknown subagent name pack: ${pack}\n${namePackSummary(cwd)}`, "error");
        return;
      }
      const store = new RunStore({ cwd });
      writeNamePackSelection(store.runRoot, pack);
      ctx.ui.notify(`Subagent name pack set to: ${pack}`, "info");
      if (currentCtx) refreshUi(currentCtx);
    },
  });
}

function startTimers(pi: ExtensionAPI, ctx: ExtensionContext): void {
  currentCtx = ctx;
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  acquireLease(cwd, identity);
  tickPi(pi, ctx);

  leaseTimer = setInterval(() => {
    const active = currentCtx;
    if (!active) return;
    const activeCwd = cwdOf(active);
    acquireLease(activeCwd, ensureRoot(activeCwd, piSessionIdOf(active)));
  }, 5_000);
  piTimer = setInterval(() => {
    if (currentCtx) tickPi(pi, currentCtx);
  }, 2_000);
  leaseTimer.unref?.();
  piTimer.unref?.();
}

function stopTimers(ctx?: ExtensionContext): void {
  if (leaseTimer) clearInterval(leaseTimer);
  if (piTimer) clearInterval(piTimer);
  leaseTimer = undefined;
  piTimer = undefined;
  if (ctx) {
    clearLiveWidget(ctx);
  }
  currentCtx = undefined;
}

export default function asyncSubagentsPiExtension(pi: ExtensionAPI) {
  const runtime: ToolRuntime = {
    getRootIdentity(cwd, piSessionId) {
      return roots.get(rootCacheKey(cwd, piSessionId));
    },
    setRootIdentity(identity) {
      roots.set(rootCacheKey(identity.cwd, identity.piSessionId), identity);
    },
    afterMutation(ctx) {
      if (ctx) refreshUi(ctx as ExtensionContext);
    },
  };

  pi.registerMessageRenderer("async-subagent-message", (message: unknown, options: unknown, theme: unknown): Component => {
    const details = (message as { details?: WakeupMessage })?.details;
    if (!details) return new Text("", 0, 0);
    return renderSubagentWakeMessageComponent(details, options as { expanded?: boolean }, theme as { fg?: (name: string, value: string) => string });
  });

  pi.registerMessageRenderer(ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE, (message: unknown) => {
    const content = (message as { content?: unknown })?.content;
    return new Text(typeof content === "string" ? content : "", 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    stopTimers();
    ensureRoot(cwdOf(ctx), piSessionIdOf(ctx));
    startTimers(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    stopTimers(currentCtx);
  });

  pi.on("session_compact", async (event, ctx) => {
    compactionInProgress = true;
    try {
      const cwd = cwdOf(ctx);
      const identity = ensureRoot(cwd, piSessionIdOf(ctx));
      const message = buildCompactionReminder({
        store: new RunStore({ cwd }),
        parentRunId: identity.parentRunId,
        rootSessionId: identity.rootSessionId,
      });
      manualCompactionWakeupCooldownUntil = isManualCompactionEvent(event) ? Date.now() + MANUAL_COMPACTION_WAKEUP_COOLDOWN_MS : 0;
      if (!message) return;
      pi.sendMessage(message, { deliverAs: "steer" });
    } finally {
      compactionInProgress = false;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = cwdOf(ctx);
    const identity = ensureRoot(cwd, piSessionIdOf(ctx));
    const fastTrackArmed = readFastTrackState(new RunStore({ cwd }).runRoot, identity.rootSessionId).enabled;
    const catalog = renderDiscoveredAgentCatalog({ cwd, env: process.env });
    return { systemPrompt: appendAsyncSubagentsPrompt(event.systemPrompt, catalog, { fastTrackArmed }) };
  });

  registerSubagentTools(pi, runtime);
  registerFastTrackCommand(pi);
  registerNamePackCommand(pi);
}

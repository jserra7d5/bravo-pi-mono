import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { renderClock } from "@bravo/render-clock";
import { readFastTrackState, writeFastTrackState } from "../../src/fastTrack.js";
import { findActiveTaskRuntimeBlockers, readTaskRuntimeState, writeTaskRuntimeState } from "../../src/taskRuntime.js";
import { acquireRootSessionLease } from "../../src/leases.js";
import { NAME_PACKS, readNamePackSelection, writeNamePackSelection, type NamePackId } from "../../src/namePacks.js";
import { createRootSession, readRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import type { RootSessionIdentity, RunIndexRecord } from "../../src/types.js";
import { buildCompactionReminder, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE } from "./compactionReminder.js";
import { clearLiveWidget, hasTimeDependentLiveWidgetItem, readAsyncSubagentsActivityState, readRunningSubagentCount, updateLiveWidget, type AsyncSubagentsActivityState } from "./liveWidget.js";
import { BrowserWorkspaceStatusReporter, defaultBrowserWorkspaceStatusSocketPath, resolveBrowserWorkspaceIdentity } from "./browserWorkspaceStatus.js";
import { reportHerdrAsyncSubagentsMetadata } from "./herdrMetadata.js";
import { renderDiscoveredAgentCatalog } from "./agentCatalog.js";
import { appendAsyncSubagentsPrompt } from "./promptModule.js";
import { renderSubagentWakeMessageComponent, type WakeupMessage } from "./renderers.js";
import { ASYNC_SUBAGENT_TOOL_NAMES, TASK_TOOL_NAMES, registerSubagentTools, type ToolRuntime } from "./tools.js";
import { isWakeupKeyHandled, markWakeupKeyHandled, pollWakeups, resultDeliveryKey } from "./wakeups.js";
import { createBudgetAutoSwarmController, renderBudgetAutoSwarmStatus } from "./budgetAutoSwarm.js";
import { validateBudgetLaunchPolicy } from "../../src/budgetLaunchPolicy.js";

const OWNER_ID = `pi-${process.pid}-${Date.now().toString(36)}`;
const TASK_RUNTIME_STATE_ENTRY_TYPE = "bravo-async-subagents-task-runtime-state";
const roots = new Map<string, RootSessionIdentity>();

let pollClockUnsubscribe: (() => void) | undefined;
let visualClockUnsubscribe: (() => void) | undefined;
let leaseTimer: (() => void) | undefined;
let currentCtx: ExtensionContext | undefined;
let compactionInProgress = false;
let manualCompactionWakeupCooldownUntil = 0;
let lastHerdrMetadataSignature: string | undefined;
let herdrMetadataReportInFlight = false;
let pendingHerdrMetadataReport: { state: AsyncSubagentsActivityState; signature: string } | undefined;
let herdrMetadataReporter: (state: AsyncSubagentsActivityState) => Promise<boolean> = reportHerdrAsyncSubagentsMetadata;
let browserWorkspaceReporter: BrowserWorkspaceStatusReporter | undefined;
let browserWorkspaceReportInFlight = false;
let pendingBrowserWorkspaceCount: number | undefined;

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
  const enabled = readTaskRuntimeState(store.runRoot, identity.rootSessionId).enabled;
  setTasksStatusBadge(ctx, enabled);
  if (ctx.hasUI) updateLiveWidget(ctx, { store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, tasksEnabled: enabled });
}

function refreshHerdrPresentation(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  const store = new RunStore({ cwd });
  reportCurrentAsyncSubagentsPresentation({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
}

function wakeupEnvelope(wakeup: WakeupMessage): string {
  const attentionStates = new Set(["paused", "blocked", "waiting_for_input", "failed", "ack_pending", "rate_limited", "comatose", "stale_transport", "orphaned_process"]);
  const attention = attentionStates.has(String(wakeup.state ?? ""));
  const lines = [attention ? "[ASYNC SUBAGENT ATTENTION — NOT USER INPUT]" : "[ASYNC SUBAGENT RESULT READY — NOT USER INPUT]", "", `Run ID: ${wakeup.runId}`];
  const harness = wakeup.result?.harness ?? wakeup.status?.harness;
  const agentName = wakeup.result?.agentName ?? wakeup.status?.agentName;
  const displayName = wakeup.result?.displayName ?? wakeup.status?.displayName;
  if (displayName) lines.push(`Subagent: @${displayName}${agentName ? ` (${harness === "claude" ? `${agentName}/claude` : agentName})` : ""}`);
  else if (agentName) lines.push(`Subagent: ${harness === "claude" ? `${agentName}/claude` : agentName}`);
  if (harness) lines.push(`Harness: ${harness}`);
  const liveness = wakeup.result?.livenessState ?? wakeup.status?.livenessState;
  if (wakeup.state) lines.push(`State: ${wakeup.state}${liveness && liveness !== wakeup.state ? ` (${liveness})` : ""}`);
  const reason = wakeup.result?.livenessReason ?? wakeup.status?.livenessReason;
  if (reason) lines.push(`Liveness: ${reason}`);
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
  const livenessActionState = ["ack_pending", "rate_limited", "comatose", "stale_transport", "orphaned_process"].includes(String(wakeup.state ?? ""));
  if (wakeup.state === "waiting_for_input" || wakeup.event?.type === "question" || wakeup.state === "blocked" || wakeup.event?.type === "blocked") {
    lines.push(`Reply with subagent_message({ runId: "${wakeup.runId}", type: "answer", ... }) when you have the requested input. Do not call subagent_result for this non-terminal wakeup.`);
  } else if (wakeup.state === "paused") {
    lines.push(`If this result is still needed, choose a bounded extension and call subagent_continue({ runId: "${wakeup.runId}", additionalRunSeconds: 900 }) to resume. Adjust additionalRunSeconds to the smallest reasonable budget for the remaining work, or call subagent_interrupt({ runId: "${wakeup.runId}", action: "cancel" }) if it is no longer needed.`);
  } else if (livenessActionState) {
    const inspect = `Inspect current transport state with subagent_status({ runIds: ["${wakeup.runId}"], includeEvents: true, maxEvents: 10 })`;
    if (wakeup.state === "rate_limited") lines.push(`${inspect}; wait until the reported rate-limit window clears before continuing or messaging the child.`);
    else if (wakeup.state === "ack_pending") lines.push(`${inspect}; avoid duplicate instructions until the pending message acknowledgement is understood.`);
    else lines.push(`${inspect}; if the Claude transport is unrecoverable, cancel it with subagent_interrupt({ runId: "${wakeup.runId}", action: "cancel" }).`);
  } else if (wakeup.bodyTruncation?.truncated === true && terminalResultWakeup) {
    lines.push(`Call subagent_result({ runId: "${wakeup.runId}" }) if you need the overflow/full canonical result before continuing.`);
  } else if (terminalResultWakeup) {
    lines.push(`You may continue from the inline result if it is sufficient; call subagent_result({ runId: "${wakeup.runId}" }) only for recovery, artifacts, metadata, overflow, or reread.`);
  }
  return lines.join("\n");
}

function sendWakeup(pi: ExtensionAPI, deliveryKey: string, wakeup: WakeupMessage, options: { triggerTurn?: boolean } = {}): void {
  const message = {
    customType: "async-subagent-message",
    content: wakeupEnvelope(wakeup),
    display: true,
    details: { ...wakeup, deliveryKey },
  };
  // Terminal results normally wake the parent even when it is idle. Full-inline
  // results retry until message_start acknowledges this exact delivery key.
  pi.sendMessage(message, { triggerTurn: options.triggerTurn ?? true, deliverAs: "steer" });
}

function pollAndSendWakeups(pi: ExtensionAPI, store: RunStore, identity: RootSessionIdentity, records?: RunIndexRecord[], options: { triggerTurn?: boolean; tasksEnabled?: boolean } = {}): void {
  if (compactionInProgress) return;
  for (const delivery of pollWakeups({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, ownerId: OWNER_ID, modelFollowUpOnly: true, records })) {
    if (isWakeupKeyHandled(store, identity.parentRunId, delivery.deliveryKey)) continue;
    sendWakeup(pi, delivery.deliveryKey, delivery.message, { triggerTurn: options.triggerTurn });
  }
}


function tickAsyncTasksPoll(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (compactionInProgress) return;
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  const store = new RunStore({ cwd });
  const records = store.listActiveOrRecentRuns({ parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
  const enabled = readTaskRuntimeState(store.runRoot, identity.rootSessionId).enabled;
  setTasksStatusBadge(ctx, enabled);
  reportCurrentAsyncSubagentsPresentation({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId }, records);
  reportBrowserWorkspaceCount(readRunningSubagentCount({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, records }));
  if (Date.now() >= manualCompactionWakeupCooldownUntil) {
    pollAndSendWakeups(pi, store, identity, records, { triggerTurn: true, tasksEnabled: enabled });
  }
  maintainVisualClock(ctx, { store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, records, tasksEnabled: enabled });
}

function tickAsyncLiveWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    setVisualClockSubscribed(false);
    return;
  }
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  const store = new RunStore({ cwd });
  const enabled = readTaskRuntimeState(store.runRoot, identity.rootSessionId).enabled;
  const keepSubscribed = updateLiveWidget(ctx, { store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, tasksEnabled: enabled });
  setVisualClockSubscribed(keepSubscribed);
}

function setVisualClockSubscribed(subscribed: boolean): void {
  if (subscribed) {
    if (visualClockUnsubscribe || !currentCtx?.hasUI) return;
    visualClockUnsubscribe = renderClock.subscribe({
      id: "async-live-widget",
      intervalMs: 1_000,
      reconcile: () => {
        if (currentCtx) tickAsyncLiveWidget(currentCtx);
      },
    });
    return;
  }
  visualClockUnsubscribe?.();
  visualClockUnsubscribe = undefined;
}

function maintainVisualClock(ctx: ExtensionContext, input: Parameters<typeof hasTimeDependentLiveWidgetItem>[0]): void {
  setVisualClockSubscribed(ctx.hasUI && hasTimeDependentLiveWidgetItem(input));
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

function tasksEnabled(cwd: string, rootSessionId: string): boolean {
  return readTaskRuntimeState(new RunStore({ cwd }).runRoot, rootSessionId).enabled;
}

type TaskRuntimeStateEntry = { enabled: boolean };

function isTaskRuntimeStateEntry(value: unknown): value is TaskRuntimeStateEntry {
  return Boolean(value && typeof value === "object" && typeof (value as { enabled?: unknown }).enabled === "boolean");
}

function restoreStickyTaskRuntimeState(ctx: ExtensionContext, store: RunStore, rootSessionId: string): boolean {
  let enabled = readTaskRuntimeState(store.runRoot, rootSessionId).enabled;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== TASK_RUNTIME_STATE_ENTRY_TYPE) continue;
    if (!isTaskRuntimeStateEntry(entry.data)) continue;
    enabled = entry.data.enabled;
  }
  writeTaskRuntimeState(store.runRoot, rootSessionId, enabled);
  return enabled;
}

function appendStickyTaskRuntimeState(pi: ExtensionAPI, enabled: boolean): void {
  pi.appendEntry(TASK_RUNTIME_STATE_ENTRY_TYPE, { enabled });
}

type StatusUi = { setStatus?: (key: string, value: string | undefined) => void };

const lastStatusByUi = new WeakMap<StatusUi, Map<string, string | undefined>>();

function setStatusIfChanged(ui: StatusUi | undefined, key: string, value: string | undefined): void {
  if (!ui?.setStatus) return;
  let lastStatus = lastStatusByUi.get(ui);
  if (!lastStatus) {
    lastStatus = new Map();
    lastStatusByUi.set(ui, lastStatus);
  }
  if (lastStatus.has(key) && lastStatus.get(key) === value) return;
  lastStatus.set(key, value);
  ui.setStatus(key, value);
}

function setTasksStatusBadge(ctx: ExtensionContext | ExtensionCommandContext, enabled: boolean): void {
  const ui = (ctx as { ui?: StatusUi }).ui;
  setStatusIfChanged(ui, "tasks", `tasks:${enabled ? "on" : "off"}`);
}

function drainHerdrMetadataReports(): void {
  if (herdrMetadataReportInFlight || !pendingHerdrMetadataReport) return;
  const report = pendingHerdrMetadataReport;
  pendingHerdrMetadataReport = undefined;
  herdrMetadataReportInFlight = true;
  let drainAgain = false;
  void herdrMetadataReporter(report.state)
    .then((delivered) => {
      if (delivered) {
        lastHerdrMetadataSignature = report.signature;
        drainAgain = pendingHerdrMetadataReport !== undefined;
      } else if (pendingHerdrMetadataReport) {
        drainAgain = true;
      } else {
        pendingHerdrMetadataReport = report;
      }
    })
    .finally(() => {
      herdrMetadataReportInFlight = false;
      if (drainAgain) drainHerdrMetadataReports();
    });
}

function reportHerdrMetadataState(state: AsyncSubagentsActivityState, options: { force?: boolean } = {}): void {
  const signature = JSON.stringify(state);
  // Active metadata is a lease and must be refreshed on the poll cadence so its
  // TTL stays alive. Inactive clears can be de-duped after one successful send.
  if (!options.force && signature === lastHerdrMetadataSignature) return;
  pendingHerdrMetadataReport = { state, signature };
  drainHerdrMetadataReports();
}

function reportCurrentAsyncSubagentsPresentation(input: { store: RunStore; parentRunId?: string; rootSessionId?: string }, records?: RunIndexRecord[]): void {
  const state = readAsyncSubagentsActivityState({ ...input, records });
  reportHerdrMetadataState(state, { force: state.active });
}

function reportInactiveAsyncSubagentsPresentation(): void {
  reportHerdrMetadataState({ active: false, blocked: false, activeCount: 0 }, { force: true });
}

function reportBrowserWorkspaceCount(count: number): void {
  if (!browserWorkspaceReporter) return;
  pendingBrowserWorkspaceCount = count;
  if (browserWorkspaceReportInFlight) return;
  const drain = () => {
    if (!browserWorkspaceReporter || pendingBrowserWorkspaceCount === undefined) return;
    const next = pendingBrowserWorkspaceCount; pendingBrowserWorkspaceCount = undefined; browserWorkspaceReportInFlight = true;
    void browserWorkspaceReporter.report(next).finally(() => { browserWorkspaceReportInFlight = false; if (pendingBrowserWorkspaceCount !== undefined) drain(); });
  };
  drain();
}

async function initializeBrowserWorkspaceReporter(ctx: ExtensionContext): Promise<void> {
  browserWorkspaceReporter = undefined; pendingBrowserWorkspaceCount = undefined;
  const piSessionId = piSessionIdOf(ctx), socketPath = defaultBrowserWorkspaceStatusSocketPath();
  if (!piSessionId || !socketPath || isChildContext()) return;
  const workspace = await resolveBrowserWorkspaceIdentity();
  if (!workspace) return;
  const cwd = cwdOf(ctx), identity = ensureRoot(cwd, piSessionId);
  browserWorkspaceReporter = new BrowserWorkspaceStatusReporter({ workspace, lead: { piSessionId, rootSessionId: identity.rootSessionId } }, socketPath);
}

export function __setHerdrMetadataReporterForTest(reporter: (state: AsyncSubagentsActivityState) => Promise<boolean>): () => void {
  const previous = herdrMetadataReporter;
  herdrMetadataReporter = reporter;
  return () => {
    herdrMetadataReporter = previous;
  };
}

export function __resetHerdrMetadataSchedulerForTest(): void {
  lastHerdrMetadataSignature = undefined;
  herdrMetadataReportInFlight = false;
  pendingHerdrMetadataReport = undefined;
  herdrMetadataReporter = reportHerdrAsyncSubagentsMetadata;
}

export function __reportHerdrMetadataStateForTest(state: AsyncSubagentsActivityState, options: { force?: boolean } = {}): void {
  reportHerdrMetadataState(state, options);
}

// Test-only seam export for the status badge value-gating invariant.
export function __setTasksStatusBadgeForTest(ctx: { ui?: StatusUi }, enabled: boolean): void {
  setTasksStatusBadge(ctx as ExtensionContext | ExtensionCommandContext, enabled);
}

export async function applyActiveTaskTools(pi: ExtensionAPI, enabled: boolean, options: { requireTaskTools?: boolean } = {}): Promise<void> {
  const api = pi as ExtensionAPI & { getActiveTools?: () => unknown | Promise<unknown>; setActiveTools?: (names: string[]) => unknown | Promise<unknown> };
  if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") {
    if (options.requireTaskTools) throw new Error("Pi active-tool APIs are unavailable; required task tools could not be activated");
    return;
  }
  const raw = await api.getActiveTools();
  if (!Array.isArray(raw)) {
    if (options.requireTaskTools) throw new Error("Pi returned an invalid active-tool set; required task tools could not be activated");
    return;
  }
  const active = raw.filter((name): name is string => typeof name === "string");
  const asyncSet = new Set<string>(ASYNC_SUBAGENT_TOOL_NAMES);
  const hasAsyncTool = active.some((name) => asyncSet.has(name));
  if (!hasAsyncTool && !options.requireTaskTools) return;
  const nonAsync = active.filter((name) => !asyncSet.has(name));
  const taskSet = new Set<string>(TASK_TOOL_NAMES);
  const directNames = ASYNC_SUBAGENT_TOOL_NAMES.filter((name) => !taskSet.has(name));
  const next = [...new Set([...nonAsync, ...directNames, ...(enabled ? TASK_TOOL_NAMES : [])])];
  await api.setActiveTools(next);
  if (options.requireTaskTools) {
    const appliedRaw = await api.getActiveTools();
    const applied = Array.isArray(appliedRaw) ? new Set(appliedRaw.filter((name): name is string => typeof name === "string")) : new Set<string>();
    const missing = TASK_TOOL_NAMES.filter((name) => !applied.has(name));
    if (missing.length) throw new Error(`Pi did not activate required task tools: ${missing.join(", ")}`);
  }
}

function blockerSummary(blockers: ReturnType<typeof findActiveTaskRuntimeBlockers>): string {
  const rows = blockers.slice(0, 5).map((blocker) => blocker.kind === "task"
    ? `${blocker.taskId} status=${blocker.status}${blocker.runId ? ` run=${blocker.runId}` : ""}`
    : `${blocker.taskId} run=${blocker.runId} state=${blocker.runState}`);
  const suffix = blockers.length > rows.length ? `\n...and ${blockers.length - rows.length} more` : "";
  return `Cannot turn tasks off while active task runtime state exists:\n${rows.map((row) => `- ${row}`).join("\n")}${suffix}\nAccept, cancel, clear, or wait for task-owned runs before retrying.`;
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

function registerTasksCommand(pi: ExtensionAPI, budgetEnabled: () => boolean): void {
  pi.registerCommand("tasks", {
    description: "Inspect or change async-subagents task orchestration for this root session.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = cwdOf(ctx);
      const identity = ensureRoot(cwd, piSessionIdOf(ctx));
      const store = new RunStore({ cwd });
      const arg = args.trim();
      if (!arg || arg === "status") {
        const enabled = readTaskRuntimeState(store.runRoot, identity.rootSessionId).enabled;
        setTasksStatusBadge(ctx, enabled);
        ctx.ui.notify(`async-subagents tasks: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /tasks [on|off|status]", "error");
        return;
      }
      if (arg === "off") {
        if (budgetEnabled()) {
          ctx.ui.notify("Task orchestration is required by budget-auto-swarm. Disable /budget-auto-swarm first.", "error");
          return;
        }
        const blockers = findActiveTaskRuntimeBlockers(store, identity.rootSessionId);
        if (blockers.length) {
          ctx.ui.notify(blockerSummary(blockers), "error");
          return;
        }
      }
      const enabled = arg === "on";
      writeTaskRuntimeState(store.runRoot, identity.rootSessionId, enabled);
      appendStickyTaskRuntimeState(pi, enabled);
      await applyActiveTaskTools(pi, enabled);
      setTasksStatusBadge(ctx, enabled);
      ctx.ui.notify(`async-subagents tasks ${arg}`, "info");
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

type SubscribeOnlyClock = Pick<typeof renderClock, "subscribe">;

function subscribeAsyncLease(clock: SubscribeOnlyClock, leaseBody: () => void | Promise<void>): () => void {
  return clock.subscribe({
    id: "async-lease",
    intervalMs: 5_000,
    reconcile: async () => leaseBody(),
  });
}

// Test-only seam for the non-render async lease subscriber. The production
// render clock owns cadence, in-flight suppression, and rejection capture.
export function __subscribeAsyncLeaseForTest(clock: SubscribeOnlyClock, leaseBody: () => void | Promise<void>): () => void {
  return subscribeAsyncLease(clock, leaseBody);
}

function startTimers(pi: ExtensionAPI, ctx: ExtensionContext): void {
  currentCtx = ctx;
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd, piSessionIdOf(ctx));
  acquireLease(cwd, identity);
  tickAsyncTasksPoll(pi, ctx);
  if (ctx.hasUI) tickAsyncLiveWidget(ctx);

  leaseTimer = subscribeAsyncLease(renderClock, async () => {
    const active = currentCtx;
    if (!active) return;
    const activeCwd = cwdOf(active);
    acquireLease(activeCwd, ensureRoot(activeCwd, piSessionIdOf(active)));
  });
  pollClockUnsubscribe = renderClock.subscribe({
    id: "async-tasks-poll",
    intervalMs: 2_000,
    reconcile: () => {
      if (currentCtx) tickAsyncTasksPoll(pi, currentCtx);
    },
  });
}

function stopTimers(pi?: ExtensionAPI, ctx?: ExtensionContext): void {
  leaseTimer?.();
  pollClockUnsubscribe?.();
  visualClockUnsubscribe?.();
  leaseTimer = undefined;
  pollClockUnsubscribe = undefined;
  visualClockUnsubscribe = undefined;
  if (ctx) {
    clearLiveWidget(ctx);
  }
  currentCtx = undefined;
  if (pi) reportInactiveAsyncSubagentsPresentation();
  lastHerdrMetadataSignature = undefined;
}

export default function asyncSubagentsPiExtension(pi: ExtensionAPI) {
  let budgetController: ReturnType<typeof createBudgetAutoSwarmController>;
  const ensureTasksEnabled = async (ctx: ExtensionContext | ExtensionCommandContext) => {
    const cwd = cwdOf(ctx), identity = ensureRoot(cwd, piSessionIdOf(ctx)), store = new RunStore({ cwd });
    const wasEnabled = readTaskRuntimeState(store.runRoot, identity.rootSessionId).enabled;
    if (!wasEnabled) writeTaskRuntimeState(store.runRoot, identity.rootSessionId, true);
    try {
      await applyActiveTaskTools(pi, true, { requireTaskTools: true });
    } catch (error) {
      if (!wasEnabled) writeTaskRuntimeState(store.runRoot, identity.rootSessionId, false);
      throw error;
    }
    if (!wasEnabled) appendStickyTaskRuntimeState(pi, true);
    setTasksStatusBadge(ctx, true);
  };
  budgetController = createBudgetAutoSwarmController(pi, { reconcileTasks: ensureTasksEnabled, refreshTasks: (ctx) => {
    const cwd = cwdOf(ctx), identity = ensureRoot(cwd, piSessionIdOf(ctx));
    setTasksStatusBadge(ctx, readTaskRuntimeState(new RunStore({ cwd }).runRoot, identity.rootSessionId).enabled);
  }});
  const runtime: ToolRuntime = {
    getRootIdentity(cwd, piSessionId) {
      return roots.get(rootCacheKey(cwd, piSessionId));
    },
    setRootIdentity(identity) {
      roots.set(rootCacheKey(identity.cwd, identity.piSessionId), identity);
    },
    isTaskRuntimeEnabled(cwd, rootSessionId) {
      return tasksEnabled(cwd, rootSessionId);
    },
    launchPolicy(launch) {
      if (budgetController.enabled()) validateBudgetLaunchPolicy(launch);
    },
    afterMutation(ctx) {
      if (ctx) {
        refreshUi(ctx as ExtensionContext);
        refreshHerdrPresentation(pi, ctx as ExtensionContext);
        const cwd = cwdOf(ctx), identity = ensureRoot(cwd, piSessionIdOf(ctx)), store = new RunStore({ cwd });
        reportBrowserWorkspaceCount(readRunningSubagentCount({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId }));
      }
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

  const restoreTaskRuntimeMode = async (ctx: ExtensionContext) => {
    budgetController.publish(ctx, false);
    try {
      const cwd = cwdOf(ctx);
      const identity = ensureRoot(cwd, piSessionIdOf(ctx));
      const store = new RunStore({ cwd });
      const enabled = restoreStickyTaskRuntimeState(ctx, store, identity.rootSessionId);
      await applyActiveTaskTools(pi, enabled);
      setTasksStatusBadge(ctx, enabled);
      await budgetController.restore(ctx);
    } catch (error) {
      budgetController.publish(ctx, false);
      renderBudgetAutoSwarmStatus(ctx, false);
      ctx.ui.notify(`Budget auto swarm restore failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    stopTimers(pi);
    await restoreTaskRuntimeMode(ctx);
    await initializeBrowserWorkspaceReporter(ctx);
    startTimers(pi, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => restoreTaskRuntimeMode(ctx));

  pi.on("message_start", async (event, ctx) => {
    const message = event.message as { role?: unknown; customType?: unknown; details?: unknown };
    if (message.role !== "custom" || message.customType !== "async-subagent-message") return;
    const details = message.details as (WakeupMessage & { deliveryKey?: unknown }) | undefined;
    if (!details?.result || details.bodyTruncation?.truncated === true || typeof details.deliveryKey !== "string") return;
    if (details.result.runId !== details.runId || details.deliveryKey !== resultDeliveryKey(details.runId, details.result)) return;
    const cwd = cwdOf(ctx);
    const identity = ensureRoot(cwd, piSessionIdOf(ctx));
    markWakeupKeyHandled(new RunStore({ cwd }), identity.parentRunId, details.deliveryKey, details.runId);
  });

  pi.on("session_shutdown", async () => {
    const reporter = browserWorkspaceReporter;
    stopTimers(pi, currentCtx);
    browserWorkspaceReporter = undefined; pendingBrowserWorkspaceCount = undefined;
    if (reporter) await reporter.report(0).catch(() => false);
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
        budgetAutoSwarmEnabled: budgetController.enabled(),
      });
      manualCompactionWakeupCooldownUntil = isManualCompactionEvent(event) ? Date.now() + MANUAL_COMPACTION_WAKEUP_COOLDOWN_MS : 0;
      if (!message) return;
      pi.sendMessage(message, { deliverAs: "steer" });
    } finally {
      compactionInProgress = false;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try { await budgetController.sync(ctx); }
    catch (error) { ctx.ui.notify(`Budget auto swarm global sync failed closed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    const cwd = cwdOf(ctx);
    const identity = ensureRoot(cwd, piSessionIdOf(ctx));
    const store = new RunStore({ cwd });
    const fastTrackArmed = readFastTrackState(store.runRoot, identity.rootSessionId).enabled;
    const enabled = readTaskRuntimeState(store.runRoot, identity.rootSessionId).enabled;
    const catalog = renderDiscoveredAgentCatalog({ cwd, env: process.env });
    return { systemPrompt: appendAsyncSubagentsPrompt(event.systemPrompt, catalog, { fastTrackArmed, tasksEnabled: enabled, budgetAutoSwarmEnabled: budgetController.enabled() }) };
  });

  registerSubagentTools(pi, runtime);
  registerFastTrackCommand(pi);
  registerTasksCommand(pi, budgetController.enabled);
  registerNamePackCommand(pi);
}

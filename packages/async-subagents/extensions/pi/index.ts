import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { acquireRootSessionLease } from "../../src/leases.js";
import { NAME_PACKS, readNamePackSelection, writeNamePackSelection, type NamePackId } from "../../src/namePacks.js";
import { createRootSession } from "../../src/rootSession.js";
import { RunStore } from "../../src/runStore.js";
import type { RootSessionIdentity } from "../../src/types.js";
import { buildCompactionReminder, ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE } from "./compactionReminder.js";
import { clearLiveWidget, updateLiveWidget } from "./liveWidget.js";
import { renderDiscoveredAgentCatalog } from "./agentCatalog.js";
import { appendAsyncSubagentsPrompt } from "./promptModule.js";
import { renderSubagentWakeMessageComponent, type WakeupMessage } from "./renderers.js";
import { registerSubagentTools, type ToolRuntime } from "./tools.js";
import { isResultWakeupCurrent, isWakeupKeyHandled, pollWakeups } from "./wakeups.js";

const OWNER_ID = `pi-${process.pid}-${Date.now().toString(36)}`;
const roots = new Map<string, RootSessionIdentity>();

let uiTimer: ReturnType<typeof setInterval> | undefined;
let wakeupTimer: ReturnType<typeof setInterval> | undefined;
let leaseTimer: ReturnType<typeof setInterval> | undefined;
let currentCtx: ExtensionContext | undefined;

function cwdOf(ctx: unknown): string {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" ? cwd : process.cwd();
}

function ensureRoot(cwd: string): RootSessionIdentity {
  const existing = roots.get(cwd);
  if (existing) return existing;
  const identity = createRootSession({ cwd });
  roots.set(cwd, identity);
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
  const identity = ensureRoot(cwd);
  const store = new RunStore({ cwd });
  // The widget is the canonical async-subagents surface; the old setStatus
  // segment was redundant alongside the codex footer and has been removed.
  if (ctx.hasUI) updateLiveWidget(ctx, { store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId });
}

function sendWakeup(pi: ExtensionAPI, wakeup: WakeupMessage): void {
  pi.sendMessage(
    {
      customType: "async-subagent-message",
      content: wakeup.summary ?? wakeup.title,
      display: true,
      details: wakeup,
    },
    // Steering wakes an idle parent like follow-up does, but if the parent is
    // already running tools it is delivered before the next model step instead
    // of being queued as a new post-summary turn.
    { triggerTurn: true, deliverAs: "steer" },
  );
}

function pollAndSendWakeups(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const cwd = cwdOf(ctx);
  const identity = ensureRoot(cwd);
  const store = new RunStore({ cwd });
  for (const delivery of pollWakeups({ store, parentRunId: identity.parentRunId, rootSessionId: identity.rootSessionId, ownerId: OWNER_ID, modelFollowUpOnly: true })) {
    if (isWakeupKeyHandled(store, identity.parentRunId, delivery.deliveryKey)) continue;
    sendWakeup(pi, delivery.message);
  }
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
  const identity = ensureRoot(cwd);
  acquireLease(cwd, identity);
  refreshUi(ctx);
  pollAndSendWakeups(pi, ctx);

  leaseTimer = setInterval(() => {
    const active = currentCtx;
    if (!active) return;
    const activeCwd = cwdOf(active);
    acquireLease(activeCwd, ensureRoot(activeCwd));
  }, 5_000);
  uiTimer = setInterval(() => {
    if (currentCtx) refreshUi(currentCtx);
  }, 2_000);
  wakeupTimer = setInterval(() => {
    if (currentCtx) pollAndSendWakeups(pi, currentCtx);
  }, 2_000);
  leaseTimer.unref?.();
  uiTimer.unref?.();
  wakeupTimer.unref?.();
}

function stopTimers(ctx?: ExtensionContext): void {
  if (leaseTimer) clearInterval(leaseTimer);
  if (uiTimer) clearInterval(uiTimer);
  if (wakeupTimer) clearInterval(wakeupTimer);
  leaseTimer = undefined;
  uiTimer = undefined;
  wakeupTimer = undefined;
  if (ctx) {
    clearLiveWidget(ctx);
  }
  currentCtx = undefined;
}

export default function asyncSubagentsPiExtension(pi: ExtensionAPI) {
  const runtime: ToolRuntime = {
    getRootIdentity(cwd) {
      return roots.get(cwd);
    },
    setRootIdentity(identity) {
      roots.set(identity.cwd, identity);
    },
    afterMutation(ctx) {
      if (ctx) refreshUi(ctx as ExtensionContext);
    },
  };

  pi.registerMessageRenderer("async-subagent-message", (message: unknown, options: unknown, theme: unknown): Component => {
    const details = (message as { details?: WakeupMessage })?.details;
    if (!details) return new Text("", 0, 0);
    if (details.result && currentCtx) {
      const store = new RunStore({ cwd: cwdOf(currentCtx) });
      const parentRunId = details.result.parentRunId;
      if (!isResultWakeupCurrent(store, parentRunId, details.runId, details.result)) return new Text("", 0, 0);
    }
    return renderSubagentWakeMessageComponent(details, options as { expanded?: boolean }, theme as { fg?: (name: string, value: string) => string });
  });

  pi.registerMessageRenderer(ASYNC_SUBAGENT_COMPACTION_MESSAGE_TYPE, (message: unknown) => {
    const content = (message as { content?: unknown })?.content;
    return new Text(typeof content === "string" ? content : "", 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    stopTimers();
    ensureRoot(cwdOf(ctx));
    startTimers(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    stopTimers(currentCtx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    const cwd = cwdOf(ctx);
    const identity = ensureRoot(cwd);
    const message = buildCompactionReminder({
      store: new RunStore({ cwd }),
      parentRunId: identity.parentRunId,
      rootSessionId: identity.rootSessionId,
    });
    if (!message) return;
    pi.sendMessage(message, { deliverAs: "steer" });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const catalog = renderDiscoveredAgentCatalog({ cwd: cwdOf(ctx), env: process.env });
    return { systemPrompt: appendAsyncSubagentsPrompt(event.systemPrompt, catalog) };
  });

  registerSubagentTools(pi, runtime);
  registerNamePackCommand(pi);
}

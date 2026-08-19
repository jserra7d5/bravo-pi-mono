import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BUDGET_AUTO_SWARM_STATE_ENTRY_TYPE = "bravo-budget-auto-swarm-state";
export const BUDGET_AUTO_SWARM_STATUS_KEY = "budget-auto-swarm";
export type BudgetAutoSwarmStateEntry = { version: 1; enabled: boolean };

type SessionEntry = { type?: unknown; customType?: unknown; data?: unknown };
type StatusUi = { setStatus?: (key: string, value: string | undefined) => void; notify?: (message: string, level?: "info" | "error") => void };
const BUDGET_AUTO_SWARM_BADGE = "\x1b[38;2;213;163;233mSWARM:auto\x1b[0m";
const lastStatus = new WeakMap<object, string | undefined>();

export function isBudgetAutoSwarmStateEntry(value: unknown): value is BudgetAutoSwarmStateEntry {
  const state = value as Partial<BudgetAutoSwarmStateEntry> | undefined;
  return state?.version === 1 && typeof state.enabled === "boolean";
}

export function replayBudgetAutoSwarmState(entries: SessionEntry[]): boolean {
  let enabled = false;
  for (const entry of entries) if (entry.type === "custom" && entry.customType === BUDGET_AUTO_SWARM_STATE_ENTRY_TYPE && isBudgetAutoSwarmStateEntry(entry.data)) enabled = entry.data.enabled;
  return enabled;
}

export function parseBudgetAutoSwarmCommand(value: string): "on" | "off" | "status" | undefined {
  const arg = value.trim();
  if (!arg || arg === "on") return "on";
  if (arg === "off" || arg === "status") return arg;
  return undefined;
}

export function renderBudgetAutoSwarmStatus(ctx: ExtensionContext | ExtensionCommandContext, enabled: boolean): void {
  const ui = (ctx as { ui?: StatusUi }).ui;
  if (!ui?.setStatus) return;
  try {
    const value = enabled ? BUDGET_AUTO_SWARM_BADGE : undefined;
    if (lastStatus.has(ui as object) && lastStatus.get(ui as object) === value) return;
    ui.setStatus(BUDGET_AUTO_SWARM_STATUS_KEY, value);
    lastStatus.set(ui as object, value);
  } catch {
    // Presentation is best-effort. A later render retries because failed values are not cached.
  }
}

export interface BudgetAutoSwarmControllerOptions {
  reconcileTasks: (ctx: ExtensionContext | ExtensionCommandContext) => Promise<void>;
  refreshTasks: (ctx: ExtensionContext | ExtensionCommandContext) => void;
}

export function createBudgetAutoSwarmController(pi: ExtensionAPI, options: BudgetAutoSwarmControllerOptions) {
  let published = false;
  let desired = false;
  const publish = (ctx: ExtensionContext | ExtensionCommandContext, enabled: boolean) => {
    published = enabled;
    renderBudgetAutoSwarmStatus(ctx, enabled);
    try { options.refreshTasks(ctx); } catch { /* Presentation must not affect policy state. */ }
  };
  const reconcileDesired = async (ctx: ExtensionContext | ExtensionCommandContext, target: boolean) => {
    if (target) await options.reconcileTasks(ctx);
  };
  const restore = async (ctx: ExtensionContext) => {
    desired = replayBudgetAutoSwarmState(ctx.sessionManager.getBranch() as SessionEntry[]);
    try { await reconcileDesired(ctx, desired); publish(ctx, desired); }
    catch (error) { publish(ctx, false); throw error; }
  };
  pi.registerCommand("budget-auto-swarm", {
    description: "Enable, disable, or inspect budget auto swarm orchestration policy.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parseBudgetAutoSwarmCommand(args);
      if (!command) { ctx.ui.notify("Usage: /budget-auto-swarm [on|off|status]", "error"); return; }
      if (command === "status") {
        renderBudgetAutoSwarmStatus(ctx, published);
        ctx.ui.notify(`Budget auto swarm: ${published ? "enabled" : "disabled"}. Task orchestration is required; allowed routes are Luna high/xhigh/max or Sol low/medium at normal priority.`, "info");
        return;
      }
      const target = command === "on";
      if (target === desired && target === published) { renderBudgetAutoSwarmStatus(ctx, published); ctx.ui.notify(`Budget auto swarm already ${target ? "enabled" : "disabled"}.`, "info"); return; }
      try {
        const stateChanged = target !== desired;
        await reconcileDesired(ctx, target);
        if (stateChanged) pi.appendEntry(BUDGET_AUTO_SWARM_STATE_ENTRY_TYPE, { version: 1, enabled: target });
        desired = target;
        publish(ctx, target);
        ctx.ui.notify(target ? "Budget auto swarm enabled. The Pi lead model is unchanged; new launches are budget-policy guarded." : "Budget auto swarm disabled. Task orchestration remains unchanged.", "info");
      } catch (error) {
        publish(ctx, desired);
        ctx.ui.notify(`Budget auto swarm could not be ${target ? "enabled" : "disabled"}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  return { enabled: () => published, restore, publish };
}

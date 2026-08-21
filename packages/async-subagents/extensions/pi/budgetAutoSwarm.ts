import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetAutoSwarmStatePath, readBudgetAutoSwarmGlobalState, writeBudgetAutoSwarmGlobalState } from "../../src/budgetAutoSwarmState.js";

export const BUDGET_AUTO_SWARM_STATUS_KEY = "budget-auto-swarm";
type StatusUi = { setStatus?: (key: string, value: string | undefined) => void; notify?: (message: string, level?: "info" | "error") => void };
const BUDGET_AUTO_SWARM_BADGE = "\x1b[38;2;213;163;233mSWARM:auto\x1b[0m";
const lastStatus = new WeakMap<object, string | undefined>();

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
  stateEnv?: NodeJS.ProcessEnv;
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
  const stateEnv = options.stateEnv ?? process.env;
  const restore = async (ctx: ExtensionContext) => {
    desired = readBudgetAutoSwarmGlobalState(stateEnv).enabled;
    try { await reconcileDesired(ctx, desired); publish(ctx, desired); }
    catch (error) { publish(ctx, false); throw error; }
  };
  const sync = async (ctx: ExtensionContext) => {
    const persisted = readBudgetAutoSwarmGlobalState(stateEnv).enabled;
    if (persisted === desired && persisted === published) return;
    desired = persisted;
    try { await reconcileDesired(ctx, desired); publish(ctx, desired); }
    catch (error) { publish(ctx, false); throw error; }
  };
  pi.registerCommand("budget-auto-swarm", {
    description: "Enable, disable, or inspect budget auto swarm orchestration policy.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parseBudgetAutoSwarmCommand(args);
      if (!command) { ctx.ui.notify("Usage: /budget-auto-swarm [on|off|status]", "error"); return; }
      if (command === "status") {
        try {
          desired = readBudgetAutoSwarmGlobalState(stateEnv).enabled;
          if (desired !== published) { await reconcileDesired(ctx, desired); publish(ctx, desired); }
          else renderBudgetAutoSwarmStatus(ctx, published);
          ctx.ui.notify(`Budget auto swarm: ${published ? "enabled" : "disabled"} globally (${budgetAutoSwarmStatePath(stateEnv)}). Task orchestration is required; Luna high supports bounded work, Luna xhigh/max executes substantive work, and Sol medium owns intelligence-critical judgment or step-constrained critical paths at normal priority.`, "info");
        } catch (error) {
          desired = false;
          publish(ctx, false);
          ctx.ui.notify(`Budget auto swarm status failed closed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      const target = command === "on";
      try {
        const persisted = readBudgetAutoSwarmGlobalState(stateEnv).enabled;
        if (target === persisted && target === published) { renderBudgetAutoSwarmStatus(ctx, published); ctx.ui.notify(`Budget auto swarm already ${target ? "enabled" : "disabled"} globally.`, "info"); return; }
        await reconcileDesired(ctx, target);
        if (target !== persisted) writeBudgetAutoSwarmGlobalState(target, stateEnv);
        desired = target;
        publish(ctx, target);
        ctx.ui.notify(target ? "Budget auto swarm enabled globally. New Pi sessions and processes inherit it; the lead model is unchanged and new launches are budget-policy guarded." : "Budget auto swarm disabled globally. Task orchestration remains unchanged.", "info");
      } catch (error) {
        try { desired = readBudgetAutoSwarmGlobalState(stateEnv).enabled; } catch { desired = false; }
        publish(ctx, desired);
        ctx.ui.notify(`Budget auto swarm could not be ${target ? "enabled" : "disabled"}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  return { enabled: () => published, restore, sync, publish };
}

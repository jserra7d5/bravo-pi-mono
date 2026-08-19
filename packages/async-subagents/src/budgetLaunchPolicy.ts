import { SubagentError } from "./errors.js";

export const BUDGET_LUNA_MODEL = "bravo-codex-balanced/gpt-5.6-luna";
export const BUDGET_SOL_MODEL = "bravo-codex-balanced/gpt-5.6-sol";
export const BUDGET_ALLOWED = {
  luna: ["high", "xhigh", "max"],
  sol: ["low", "medium"],
  fastTrack: false,
} as const;

export interface ResolvedBudgetLaunch {
  modeEnabled: boolean;
  variant?: string;
  resolvedHarness: "pi" | "claude";
  resolvedProvider: string;
  resolvedModel: string;
  effectiveThinkingLevel?: string;
  fastTrackRequested: boolean;
}

export type BudgetLaunchPolicyCode =
  | "BUDGET_SWARM_VARIANT_REQUIRED"
  | "BUDGET_SWARM_HARNESS_NOT_ALLOWED"
  | "BUDGET_SWARM_MODEL_NOT_ALLOWED"
  | "BUDGET_SWARM_THINKING_NOT_ALLOWED"
  | "BUDGET_SWARM_FAST_TRACK_FORBIDDEN";

function reject(code: BudgetLaunchPolicyCode, message: string): never {
  throw new SubagentError(code, message, { code, allowed: BUDGET_ALLOWED });
}

export function validateBudgetLaunchPolicy(input: ResolvedBudgetLaunch): void {
  if (!input.modeEnabled) return;
  if (input.variant !== "luna" && input.variant !== "sol") {
    reject("BUDGET_SWARM_VARIANT_REQUIRED", 'Budget auto swarm requires variant "luna" or "sol".');
  }
  if (input.resolvedHarness !== "pi") {
    reject("BUDGET_SWARM_HARNESS_NOT_ALLOWED", "Budget auto swarm supports Pi-harness children only.");
  }
  const expected = input.variant === "luna" ? BUDGET_LUNA_MODEL : BUDGET_SOL_MODEL;
  if (`${input.resolvedProvider}/${input.resolvedModel}` !== expected) {
    reject("BUDGET_SWARM_MODEL_NOT_ALLOWED", `Variant ${input.variant} must resolve exactly to ${expected}.`);
  }
  const levels: readonly string[] = BUDGET_ALLOWED[input.variant];
  if (!input.effectiveThinkingLevel || !levels.includes(input.effectiveThinkingLevel)) {
    reject("BUDGET_SWARM_THINKING_NOT_ALLOWED", `${input.variant} thinkingLevel must be one of: ${levels.join(", ")}.`);
  }
  if (input.fastTrackRequested) {
    reject("BUDGET_SWARM_FAST_TRACK_FORBIDDEN", "Budget auto swarm requires normal service priority; omit fastTrack or set it to false.");
  }
}

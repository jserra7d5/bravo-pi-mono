import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asyncSubagentsHome } from "./config.js";
import { SubagentError } from "./errors.js";
import { atomicWriteJson } from "./jsonl.js";

export interface BudgetAutoSwarmGlobalState {
  schemaVersion: 1;
  enabled: boolean;
  updatedAt: string;
}

export function budgetAutoSwarmStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(asyncSubagentsHome(env), "budget-auto-swarm.json");
}

export function readBudgetAutoSwarmGlobalState(env: NodeJS.ProcessEnv = process.env): BudgetAutoSwarmGlobalState {
  const path = budgetAutoSwarmStatePath(env);
  if (!existsSync(path)) return { schemaVersion: 1, enabled: false, updatedAt: new Date(0).toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetAutoSwarmGlobalState>;
    if (parsed.schemaVersion !== 1 || typeof parsed.enabled !== "boolean" || typeof parsed.updatedAt !== "string") throw new Error("invalid state shape");
    return { schemaVersion: 1, enabled: parsed.enabled, updatedAt: parsed.updatedAt };
  } catch (error) {
    throw new SubagentError("INVALID_CONFIG", `failed to read budget auto swarm global state: ${path}`, {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeBudgetAutoSwarmGlobalState(enabled: boolean, env: NodeJS.ProcessEnv = process.env): BudgetAutoSwarmGlobalState {
  const state: BudgetAutoSwarmGlobalState = { schemaVersion: 1, enabled, updatedAt: new Date().toISOString() };
  atomicWriteJson(budgetAutoSwarmStatePath(env), state);
  return state;
}

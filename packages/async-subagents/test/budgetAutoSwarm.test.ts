import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBudgetLaunchPolicy, BUDGET_LUNA_MODEL, BUDGET_SOL_MODEL } from "../src/budgetLaunchPolicy.js";
import { readBudgetAutoSwarmGlobalState, writeBudgetAutoSwarmGlobalState } from "../src/budgetAutoSwarmState.js";
import { BUDGET_AUTO_SWARM_PROMPT } from "../extensions/pi/budgetPrompt.js";
import { appendAsyncSubagentsPrompt, appendBudgetAutoSwarmPrompt } from "../extensions/pi/promptModule.js";
import { createBudgetAutoSwarmController, parseBudgetAutoSwarmCommand, renderBudgetAutoSwarmStatus } from "../extensions/pi/budgetAutoSwarm.js";

function route(variant: "luna" | "sol", thinking: string) {
  const full = variant === "luna" ? BUDGET_LUNA_MODEL : BUDGET_SOL_MODEL;
  const [provider, ...model] = full.split("/");
  return { modeEnabled: true, variant, resolvedHarness: "pi" as const, resolvedProvider: provider!, resolvedModel: model.join("/"), effectiveThinkingLevel: thinking, fastTrackRequested: false };
}

test("budget launch matrix accepts only canonical routes", () => {
  for (const level of ["high", "xhigh", "max"]) assert.doesNotThrow(() => validateBudgetLaunchPolicy(route("luna", level)));
  for (const level of ["low", "medium"]) assert.doesNotThrow(() => validateBudgetLaunchPolicy(route("sol", level)));
  for (const input of [route("luna", "low"), route("sol", "high"), { ...route("luna", "high"), fastTrackRequested: true }, { ...route("sol", "medium"), resolvedHarness: "claude" as const }, { ...route("luna", "high"), resolvedModel: "spoof" }]) assert.throws(() => validateBudgetLaunchPolicy(input), /Budget auto swarm|thinkingLevel|normal service|resolve exactly/);
});

test("budget prompt is exact, idempotent, removable, and before live state", () => {
  const once = appendAsyncSubagentsPrompt("root", undefined, { tasksEnabled: true, fastTrackArmed: true, budgetAutoSwarmEnabled: true });
  assert.equal(once.split("<!-- budget-auto-swarm:start -->").length - 1, 1);
  assert.ok(once.includes(BUDGET_AUTO_SWARM_PROMPT));
  assert.ok(once.indexOf("## Budget Auto Swarm") < once.indexOf("## Async Subagents Session State"));
  assert.doesNotMatch(once, /You may set `fastTrack: true`/);
  assert.ok(once.includes("- Fast-track policy is currently **armed/on**, but budget auto swarm requires normal service priority. Do not request `fastTrack` while this mode is enabled."));
  const twice = appendBudgetAutoSwarmPrompt(once, true);
  assert.equal(twice.split("<!-- budget-auto-swarm:start -->").length - 1, 1);
  assert.doesNotMatch(appendBudgetAutoSwarmPrompt(twice, false), /Budget Auto Swarm/);
});

test("global state and command parser obey sticky contract", () => {
  const root = mkdtempSync(join(tmpdir(), "budget-global-state-"));
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: root };
  try {
    assert.equal(parseBudgetAutoSwarmCommand(""), "on");
    assert.equal(parseBudgetAutoSwarmCommand("nope"), undefined);
    assert.equal(readBudgetAutoSwarmGlobalState(env).enabled, false);
    writeBudgetAutoSwarmGlobalState(true, env);
    assert.equal(readBudgetAutoSwarmGlobalState(env).enabled, true);
    writeBudgetAutoSwarmGlobalState(false, env);
    assert.equal(readBudgetAutoSwarmGlobalState(env).enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an independent process reads the same user-global setting", () => {
  const root = mkdtempSync(join(tmpdir(), "budget-global-process-"));
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: root };
  try {
    writeBudgetAutoSwarmGlobalState(true, env);
    const moduleUrl = new URL("../src/budgetAutoSwarmState.js", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `import { readBudgetAutoSwarmGlobalState } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(readBudgetAutoSwarmGlobalState().enabled));`], { env, encoding: "utf8" });
    assert.equal(output, "true");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second controller restores the user-global setting without session entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-global-controller-"));
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: root };
  let firstHandler!: (args: string, ctx: any) => Promise<void>;
  const first = createBudgetAutoSwarmController({ registerCommand: (_name: string, command: any) => { firstHandler = command.handler; } } as any, { reconcileTasks: async () => undefined, refreshTasks: () => undefined, stateEnv: env });
  const ctx = { sessionManager: { getBranch: () => [] }, ui: { setStatus() {}, notify() {} } } as any;
  try {
    await firstHandler("on", ctx);
    assert.equal(first.enabled(), true);
    const second = createBudgetAutoSwarmController({ registerCommand() {} } as any, { reconcileTasks: async () => undefined, refreshTasks: () => undefined, stateEnv: env });
    await second.restore(ctx);
    assert.equal(second.enabled(), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an existing controller synchronizes a change written by another process", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-global-sync-"));
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: root };
  const controller = createBudgetAutoSwarmController({ registerCommand() {} } as any, { reconcileTasks: async () => undefined, refreshTasks: () => undefined, stateEnv: env });
  const ctx = { ui: { setStatus() {}, notify() {} } } as any;
  try {
    await controller.restore(ctx);
    assert.equal(controller.enabled(), false);
    writeBudgetAutoSwarmGlobalState(true, env);
    await controller.sync(ctx);
    assert.equal(controller.enabled(), true);
    writeBudgetAutoSwarmGlobalState(false, env);
    await controller.sync(ctx);
    assert.equal(controller.enabled(), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("desired-on unpublished state retries after task reconciliation recovers", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-global-retry-"));
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: root };
  writeBudgetAutoSwarmGlobalState(true, env);
  let handler!: (args: string, ctx: any) => Promise<void>; let fail = true;
  const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
  const ctx = { ui: { setStatus() {}, notify() {} } } as any;
  const controller = createBudgetAutoSwarmController(pi, { reconcileTasks: async () => { if (fail) throw new Error("tools unavailable"); }, refreshTasks: () => undefined, stateEnv: env });
  try {
    await assert.rejects(controller.restore(ctx), /tools unavailable/);
    fail = false; await handler("on", ctx);
    assert.equal(controller.enabled(), true);
    assert.equal(readBudgetAutoSwarmGlobalState(env).enabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("throwing status UI cannot block global activation and a later render retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-global-ui-"));
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: root };
  let handler!: (args: string, ctx: any) => Promise<void>; let throwStatus = true; let successfulRenders = 0; let themeCalls = 0;
  const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any;
  const ctx = { ui: { theme: { fg: () => { themeCalls++; throw new Error("unknown theme token"); } }, setStatus: () => { if (throwStatus) throw new Error("headless UI"); successfulRenders++; }, notify() {} } } as any;
  const controller = createBudgetAutoSwarmController(pi, { reconcileTasks: async () => undefined, refreshTasks: () => undefined, stateEnv: env });
  try {
    await handler("on", ctx);
    assert.equal(controller.enabled(), true);
    assert.equal(readBudgetAutoSwarmGlobalState(env).enabled, true);
    throwStatus = false; renderBudgetAutoSwarmStatus(ctx, true);
    assert.equal(successfulRenders, 1);
    assert.equal(themeCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("budget badge uses exact ANSI lavender bytes and gates unchanged writes", () => {
  const calls: unknown[][] = []; let themeCalls = 0;
  const ctx = { ui: { theme: { fg: () => { themeCalls++; throw new Error("unknown theme token"); } }, setStatus: (...args: unknown[]) => calls.push(args) } } as any;
  renderBudgetAutoSwarmStatus(ctx, true); renderBudgetAutoSwarmStatus(ctx, true); renderBudgetAutoSwarmStatus(ctx, false);
  assert.deepEqual(calls, [["budget-auto-swarm", "\x1b[38;2;213;163;233mSWARM:auto\x1b[0m"], ["budget-auto-swarm", undefined]]);
  assert.equal(themeCalls, 0);
});

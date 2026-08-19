import test from "node:test";
import assert from "node:assert/strict";
import { validateBudgetLaunchPolicy, BUDGET_LUNA_MODEL, BUDGET_SOL_MODEL } from "../src/budgetLaunchPolicy.js";
import { BUDGET_AUTO_SWARM_PROMPT } from "../extensions/pi/budgetPrompt.js";
import { appendAsyncSubagentsPrompt, appendBudgetAutoSwarmPrompt } from "../extensions/pi/promptModule.js";
import { createBudgetAutoSwarmController, parseBudgetAutoSwarmCommand, replayBudgetAutoSwarmState, renderBudgetAutoSwarmStatus } from "../extensions/pi/budgetAutoSwarm.js";

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

test("state replay and command parser obey sticky contract", () => {
  assert.equal(parseBudgetAutoSwarmCommand(""), "on");
  assert.equal(parseBudgetAutoSwarmCommand("nope"), undefined);
  assert.equal(replayBudgetAutoSwarmState([
    { type: "custom", customType: "bravo-budget-auto-swarm-state", data: { version: 1, enabled: true } },
    { type: "custom", customType: "bravo-budget-auto-swarm-state", data: { version: 2, enabled: false } },
  ]), true);
});

test("desired-on unpublished state retries without appending a duplicate marker", async () => {
  const entries: unknown[] = []; let handler!: (args: string, ctx: any) => Promise<void>; let fail = true;
  const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; }, appendEntry: (_type: string, data: unknown) => entries.push(data) } as any;
  const ctx = { sessionManager: { getBranch: () => [{ type: "custom", customType: "bravo-budget-auto-swarm-state", data: { version: 1, enabled: true } }] }, ui: { setStatus() {}, notify() {} } } as any;
  const controller = createBudgetAutoSwarmController(pi, { reconcileTasks: async () => { if (fail) throw new Error("tools unavailable"); }, refreshTasks: () => undefined });
  await assert.rejects(controller.restore(ctx), /tools unavailable/);
  fail = false; await handler("on", ctx);
  assert.equal(controller.enabled(), true);
  assert.deepEqual(entries, []);
});

test("append failure leaves a new activation unpublished and retry persists once", async () => {
  const entries: unknown[] = [], statuses: unknown[] = []; let handler!: (args: string, ctx: any) => Promise<void>; let failAppend = true;
  const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; }, appendEntry: (_type: string, data: unknown) => { if (failAppend) throw new Error("disk full"); entries.push(data); } } as any;
  const ctx = { ui: { setStatus: (_key: string, value: unknown) => statuses.push(value), notify() {} } } as any;
  const controller = createBudgetAutoSwarmController(pi, { reconcileTasks: async () => undefined, refreshTasks: () => undefined });
  await handler("on", ctx);
  assert.equal(controller.enabled(), false);
  assert.equal(statuses.includes("\x1b[38;2;213;163;233mSWARM:auto\x1b[0m"), false);
  assert.deepEqual(entries, []);
  failAppend = false; await handler("on", ctx);
  assert.equal(controller.enabled(), true);
  assert.deepEqual(entries, [{ version: 1, enabled: true }]);
});

test("throwing status UI cannot block activation and a later render retries", async () => {
  const entries: unknown[] = []; let handler!: (args: string, ctx: any) => Promise<void>; let throwStatus = true; let successfulRenders = 0; let themeCalls = 0;
  const pi = { registerCommand: (_name: string, command: any) => { handler = command.handler; }, appendEntry: (_type: string, data: unknown) => entries.push(data) } as any;
  const ctx = { ui: { theme: { fg: () => { themeCalls++; throw new Error("unknown theme token"); } }, setStatus: () => { if (throwStatus) throw new Error("headless UI"); successfulRenders++; }, notify() {} } } as any;
  const controller = createBudgetAutoSwarmController(pi, { reconcileTasks: async () => undefined, refreshTasks: () => undefined });
  await handler("on", ctx);
  assert.equal(controller.enabled(), true);
  assert.deepEqual(entries, [{ version: 1, enabled: true }]);
  throwStatus = false; renderBudgetAutoSwarmStatus(ctx, true);
  assert.equal(successfulRenders, 1);
  assert.equal(themeCalls, 0);
});

test("budget badge uses exact ANSI lavender bytes and gates unchanged writes", () => {
  const calls: unknown[][] = []; let themeCalls = 0;
  const ctx = { ui: { theme: { fg: () => { themeCalls++; throw new Error("unknown theme token"); } }, setStatus: (...args: unknown[]) => calls.push(args) } } as any;
  renderBudgetAutoSwarmStatus(ctx, true); renderBudgetAutoSwarmStatus(ctx, true); renderBudgetAutoSwarmStatus(ctx, false);
  assert.deepEqual(calls, [["budget-auto-swarm", "\x1b[38;2;213;163;233mSWARM:auto\x1b[0m"], ["budget-auto-swarm", undefined]]);
  assert.equal(themeCalls, 0);
});

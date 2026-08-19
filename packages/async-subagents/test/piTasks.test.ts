import test from "node:test";
import assert from "node:assert/strict";
import { applyActiveTaskTools } from "../extensions/pi/index.js";
import { DIRECT_SUBAGENT_TOOL_NAMES, TASK_TOOL_NAMES } from "../extensions/pi/tools.js";

function fakePi(active: string[]) {
  const calls: string[][] = [];
  return {
    calls,
    pi: {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { calls.push(names); },
    } as any,
  };
}

test("applyActiveTaskTools removes and restores task tools while preserving non-async tools", async () => {
  const initial = ["read", ...DIRECT_SUBAGENT_TOOL_NAMES, ...TASK_TOOL_NAMES, "grep"];
  const off = fakePi(initial);
  await applyActiveTaskTools(off.pi, false);
  assert.deepEqual(off.calls, [["read", "grep", ...DIRECT_SUBAGENT_TOOL_NAMES]]);

  const on = fakePi(off.calls[0]);
  await applyActiveTaskTools(on.pi, true);
  assert.deepEqual(on.calls, [["read", "grep", ...DIRECT_SUBAGENT_TOOL_NAMES, ...TASK_TOOL_NAMES]]);
});

test("required task activation works from a non-async active set and verifies the applied set", async () => {
  let active = ["read", "grep"];
  const calls: string[][] = [];
  const pi = { getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; calls.push(names); } } as any;
  await applyActiveTaskTools(pi, true, { requireTaskTools: true });
  assert.deepEqual(calls, [["read", "grep", ...DIRECT_SUBAGENT_TOOL_NAMES, ...TASK_TOOL_NAMES]]);
  assert.ok(TASK_TOOL_NAMES.every((name) => active.includes(name)));
});

test("required task activation fails closed when host does not apply the requested set", async () => {
  const pi = { getActiveTools: () => ["read"], setActiveTools: () => undefined } as any;
  await assert.rejects(applyActiveTaskTools(pi, true, { requireTaskTools: true }), /did not activate required task tools/);
});

test("applyActiveTaskTools leaves active tools unchanged when no async-subagents tools are active", async () => {
  const active = ["read", "grep"];
  const off = fakePi(active);
  await applyActiveTaskTools(off.pi, false);
  assert.deepEqual(off.calls, []);

  const on = fakePi(active);
  await applyActiveTaskTools(on.pi, true);
  assert.deepEqual(on.calls, []);
});

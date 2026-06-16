import test from "node:test";
import assert from "node:assert/strict";
import { __setTasksStatusBadgeForTest } from "../extensions/pi/index.js";

type StatusCall = { key: string; value: string | undefined };

function fakeCtx() {
  const calls: StatusCall[] = [];
  return {
    calls,
    ctx: {
      ui: {
        setStatus(key: string, value: string | undefined) {
          calls.push({ key, value });
        },
      },
    },
  };
}

function taskCalls(calls: StatusCall[]): StatusCall[] {
  return calls.filter((call) => call.key === "tasks");
}

test("tasks status badge suppresses repeated unchanged values", () => {
  const { ctx, calls } = fakeCtx();

  __setTasksStatusBadgeForTest(ctx, true);
  assert.deepEqual(taskCalls(calls), [{ key: "tasks", value: "tasks:on" }]);

  calls.length = 0;
  __setTasksStatusBadgeForTest(ctx, true);
  __setTasksStatusBadgeForTest(ctx, true);
  assert.deepEqual(taskCalls(calls), []);
});

test("tasks status badge emits once per enabled transition", () => {
  const { ctx, calls } = fakeCtx();

  __setTasksStatusBadgeForTest(ctx, true);
  __setTasksStatusBadgeForTest(ctx, false);
  __setTasksStatusBadgeForTest(ctx, true);

  assert.deepEqual(taskCalls(calls), [
    { key: "tasks", value: "tasks:on" },
    { key: "tasks", value: "tasks:off" },
    { key: "tasks", value: "tasks:on" },
  ]);
});

test("tasks status badge cache is isolated per ui instance", () => {
  const first = fakeCtx();
  const second = fakeCtx();

  __setTasksStatusBadgeForTest(first.ctx, true);
  __setTasksStatusBadgeForTest(second.ctx, true);

  assert.deepEqual(taskCalls(first.calls), [{ key: "tasks", value: "tasks:on" }]);
  assert.deepEqual(taskCalls(second.calls), [{ key: "tasks", value: "tasks:on" }]);
});

test("tasks status badge does not write the legacy async-subagents-tasks key on repeat", () => {
  const { ctx, calls } = fakeCtx();

  __setTasksStatusBadgeForTest(ctx, true);
  calls.length = 0;
  __setTasksStatusBadgeForTest(ctx, true);

  assert.equal(calls.some((call) => call.key === "async-subagents-tasks"), false);
});

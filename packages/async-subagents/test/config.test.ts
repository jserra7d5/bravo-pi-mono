import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { defaultRunRoot } from "../src/config.js";

test("defaultRunRoot uses harness-owned async subagents home by default", () => {
  const runRoot = defaultRunRoot("/tmp/project", undefined, { HOME: "/tmp/home" } as NodeJS.ProcessEnv);
  assert.match(runRoot, /^\/tmp\/home\/\.async-subagents\/projects\/[^/]+\/runs$/);
});

test("defaultRunRoot respects explicit configured root", () => {
  assert.equal(defaultRunRoot("/tmp/project", "./state/runs"), resolve("./state/runs"));
});

test("defaultRunRoot respects ASYNC_SUBAGENTS_HOME", () => {
  const runRoot = defaultRunRoot("/tmp/project", undefined, { ASYNC_SUBAGENTS_HOME: "/tmp/async-home", HOME: "/tmp/home" } as NodeJS.ProcessEnv);
  assert.match(runRoot, /^\/tmp\/async-home\/projects\/[^/]+\/runs$/);
});

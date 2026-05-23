import test from "node:test";
import assert from "node:assert/strict";
import { composeAbortSignal } from "../src/signals.js";

test("composeAbortSignal propagates user aborts", () => {
  const controller = new AbortController();
  const signal = composeAbortSignal(10_000, controller.signal);
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true);
});

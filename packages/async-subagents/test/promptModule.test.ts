import test from "node:test";
import assert from "node:assert/strict";
import { ASYNC_SUBAGENTS_PROMPT_MODULE, appendAsyncSubagentsPrompt } from "../extensions/pi/promptModule.js";

test("async subagents prompt module establishes neutral lifecycle rules", () => {
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /first-party interface/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /thinking override/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /source-of-truth artifacts/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /async wakeups/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /subagent_status/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /one-shot inspection/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /go idle/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /subagent_result/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /timeout wakeups/);
  assert.doesNotMatch(ASYNC_SUBAGENTS_PROMPT_MODULE, /subagent_wait/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /validation boundary/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /@DisplayName/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /Do not hard-code or assume particular subagent types/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /Async Subagent Catalog/);
  assert.doesNotMatch(ASYNC_SUBAGENTS_PROMPT_MODULE, /\b(worker|reviewer|fast-worker)\b/);
  assert.match(ASYNC_SUBAGENTS_PROMPT_MODULE, /critical-path implementation\/planning\/review/);
});

test("appendAsyncSubagentsPrompt appends once", () => {
  const prompt = appendAsyncSubagentsPrompt("Base prompt", "- `scout` — Finds evidence");
  assert.match(prompt, /^Base prompt\n\n## Async Subagents/);
  assert.match(prompt, /## Async Subagent Catalog/);
  assert.match(prompt, /`scout`/);
  assert.equal(appendAsyncSubagentsPrompt(prompt, "- `worker` — Implements"), prompt);
});

test("taskless prompt omits task orchestration guidance", () => {
  const prompt = appendAsyncSubagentsPrompt("Base prompt", "- `scout` — Finds evidence", { tasksEnabled: false });
  assert.match(prompt, /Task orchestration is off/);
  assert.doesNotMatch(prompt, /### Task orchestration/);
  assert.doesNotMatch(prompt, /task_create/);
  assert.doesNotMatch(prompt, /task_accept_result/);
  assert.doesNotMatch(prompt, /subagent_start\(\{ taskId/);
  assert.match(prompt, /direct `subagent_start` without `taskId`/);
  assert.match(prompt, /Use the async subagent tools/);
});

test("taskless prompt can be restored to taskful guidance", () => {
  const taskless = appendAsyncSubagentsPrompt("Base prompt", "- `scout` — Finds evidence", { tasksEnabled: false });
  const taskful = appendAsyncSubagentsPrompt(taskless, "- `scout` — Finds evidence", { tasksEnabled: true });
  assert.match(taskful, /### Task orchestration/);
  assert.match(taskful, /task_create/);
  assert.match(taskful, /task_accept_result/);
  assert.match(taskful, /Task orchestration is on/);
  assert.doesNotMatch(taskful, /Task orchestration is off/);
  assert.equal((taskful.match(/^## Async Subagents$/gm) ?? []).length, 1);
  assert.equal((taskful.match(/^## Async Subagent Catalog$/gm) ?? []).length, 1);
});

test("appendAsyncSubagentsPrompt overlays current fast-track session state", () => {
  const prompt = appendAsyncSubagentsPrompt("Base prompt", "- `worker` — Implements", { fastTrackArmed: true });
  assert.match(prompt, /## Async Subagents Session State/);
  assert.match(prompt, /Fast-track policy is currently \*\*armed\/on\*\*/);
  assert.match(prompt, /`fastTrack: true`/);

  const updated = appendAsyncSubagentsPrompt(prompt, "- `worker` — Implements", { fastTrackArmed: false });
  assert.match(updated, /Fast-track policy is currently \*\*off\*\*/);
  assert.doesNotMatch(updated, /armed\/on/);
  assert.equal((updated.match(/## Async Subagents Session State/g) ?? []).length, 1);
});

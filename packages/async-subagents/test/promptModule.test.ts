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
  assert.doesNotMatch(ASYNC_SUBAGENTS_PROMPT_MODULE, /\b(worker|reviewer|scout|fast-worker)\b/);
});

test("appendAsyncSubagentsPrompt appends once", () => {
  const prompt = appendAsyncSubagentsPrompt("Base prompt", "- `scout` — Finds evidence");
  assert.match(prompt, /^Base prompt\n\n## Async Subagents/);
  assert.match(prompt, /## Async Subagent Catalog/);
  assert.match(prompt, /`scout`/);
  assert.equal(appendAsyncSubagentsPrompt(prompt, "- `worker` — Implements"), prompt);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { QuestionSchema } from "../extensions/pi/schema.js";
import { harness } from "./harness.js";
const params = { questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }], delivery: "non_blocking", urgency: "high" };

test("real extension registers exact tools, command, shortcut, and prompt", async () => { const h = harness(); assert.deepEqual([...h.tools.keys()], ["ask_user_question", "wait_for_user_question", "withdraw_user_question"]); assert.ok(h.commands.has("questions")); assert.equal(h.shortcuts.length, 1); const hook = h.hooks.get("before_agent_start")![0]; const value = await hook({ systemPrompt: "base" }, h.ctx); assert.match(value.systemPrompt, /continue useful independent work/); });
test("non-blocking creation appends before returning and duplicate execution reuses request", async () => { const h = harness(); const first = await h.execute("ask_user_question", params, "same"); const second = await h.execute("ask_user_question", params, "same"); assert.equal(h.entries.filter((e) => e.data.type === "question.created").length, 1); assert.equal(first.details.request_id, second.details.request_id); assert.equal(h.order[0], "append"); });
test("blocking creation persists before UI; Escape withdraws and releases the tool", async () => {
  const h = harness();
  const waiting = h.execute("ask_user_question", { ...params, delivery: "blocking" }, "block");
  await Promise.resolve();
  assert.deepEqual(h.order.slice(0, 2), ["append", "ui"]);
  assert.equal(h.customOptions.at(-1), undefined, "picker uses the original editor-area surface");
  assert.ok(h.component().render(80).some((line: string) => line.includes("Esc cancel")));
  h.component().handleInput("\x1b");
  const result = await waiting;
  assert.equal(result.details.state, "withdrawn");
  assert.equal(result.details.delivery, "blocking");
  assert.deepEqual(h.entries.map((entry) => entry.data.type), ["question.created", "question.withdrawn", "question.answer_delivered"]);
  assert.equal(h.statuses.at(-1)?.[1], undefined, "withdrawn request clears the footer badge");
  await h.commands.get("questions").handler("", h.ctx);
  assert.equal(h.customOptions.length, 1, "withdrawn request is absent from the inbox");
});
test("inbox stays lower while every picker uses the original editor-area surface", async () => {
  const h = harness();
  const created = await h.execute("ask_user_question", params, "positioned");
  await h.commands.get("questions").handler("", h.ctx);
  const lowerOverlay = {
    overlay: true,
    overlayOptions: { anchor: "bottom-center", width: "80%", maxHeight: "70%", margin: { right: 2, bottom: 3, left: 2 } },
  };
  assert.deepEqual(h.customOptions.at(-1), lowerOverlay);
  h.done(created.details.request_id);
  await Promise.resolve();
  assert.equal(h.customOptions.at(-1), undefined);
  h.component().handleInput("\x1b");
  await Promise.resolve();
  assert.deepEqual(h.customOptions.at(-1), lowerOverlay, "Escape from selected picker returns to inbox");
  assert.deepEqual(h.entries.map((entry) => entry.data.type), ["question.created"], "inbox-selected Escape has no domain effect");
});
test("wait_for Escape withdraws the escalated request and releases the tool", async () => {
  const h = harness();
  const created = await h.execute("ask_user_question", params, "escalated-cancel");
  const waiting = h.execute("wait_for_user_question", { request_id: created.details.request_id });
  await Promise.resolve();
  assert.ok(h.component().render(80).some((line: string) => line.includes("Esc cancel")));
  h.component().handleInput("\x1b");
  const result = await waiting;
  assert.equal(result.details.state, "withdrawn");
  assert.deepEqual(h.entries.map((entry) => entry.data.type), ["question.created", "question.escalated", "question.withdrawn", "question.answer_delivered"]);
});
test("question headers allow 20 characters but reject 21", () => {
  const candidate = { question: "Choose?", options: [{ label: "A" }, { label: "B" }], multiSelect: false };
  assert.equal(Value.Check(QuestionSchema, { ...candidate, header: "x".repeat(20) }), true);
  assert.equal(Value.Check(QuestionSchema, { ...candidate, header: "x".repeat(21) }), false);
});
test("non-interactive invocation creates no state and disables all question tools and prompt", async () => { const h = harness(false); await h.execute("ask_user_question", params); assert.equal(h.entries.length, 0); assert.ok(!h.active().some((name) => name.includes("user_question"))); const value = await h.hooks.get("before_agent_start")![0]({ systemPrompt: "base" }, h.ctx); assert.equal(value, undefined); });
test("invalid duplicate input creates no event", async () => { const h = harness(); await h.execute("ask_user_question", { ...params, questions: [params.questions[0], params.questions[0]] }); assert.equal(h.entries.length, 0); });
test("status uses maximum-urgency theme styling and gates unchanged styled values", async () => {
  const h = harness();
  await h.execute("ask_user_question", { ...params, urgency: "low" }, "low");
  assert.equal(h.statuses.at(-1)?.[1], "<dim>[1 user-questions]</dim>");
  const calls = h.statuses.length;
  await h.execute("ask_user_question", { ...params, urgency: "low" }, "low");
  assert.equal(h.statuses.length, calls);
  await h.execute("ask_user_question", { ...params, urgency: "normal" }, "normal");
  assert.equal(h.statuses.at(-1)?.[1], "<warning>[2 user-questions]</warning>");
  await h.execute("ask_user_question", { ...params, urgency: "high" }, "high");
  assert.equal(h.statuses.at(-1)?.[1], "<error>[3 user-questions]</error>");
});
test("multi-question answers render every answer on width-bounded lines", () => {
  const h = harness(); const tool = h.tools.get("ask_user_question");
  const answers = [
    { question: "First decision with detail?", selected_option_ids: ["a"], selected_labels: ["A very long first answer"] },
    { question: "Second decision with detail?", selected_option_ids: ["b"], selected_labels: ["A very long second answer"] },
  ];
  const rendered = tool.renderResult({ content: [{ type: "text", text: answers.map((a) => `${a.question}: ${a.selected_labels[0]}`).join("\n") }], details: { request_id: "id", state: "answered", delivery: "blocking", urgency: "normal", resolution: { answers } } }, {}, { fg: (_name: string, value: string) => value });
  const lines = rendered.render(20);
  assert.ok(lines.length > 2); assert.ok(lines.some((line: string) => line.includes("First"))); assert.ok(lines.some((line: string) => line.includes("Second"))); assert.ok(lines.every((line: string) => line.length <= 20));
});

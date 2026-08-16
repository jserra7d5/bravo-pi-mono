import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionService, requestIdFor } from "../extensions/pi/question-service.js";
const input = (delivery: "blocking" | "non_blocking" = "non_blocking", urgency: "low" | "normal" | "high" = "normal") => ({ questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }], delivery, urgency });

test("create is deterministic, normalized, and idempotent", () => { const s = new QuestionService(); const event = s.create("call-1", input())!; s.apply(event); assert.equal(event.requestId, requestIdFor("call-1")); assert.equal(s.create("call-1", input()), undefined); assert.equal(s.get(event.requestId)!.questions[0].options[0].id, s.get(event.requestId)!.questions[0].options[0].id); });
test("first terminal transition wins and duplicate IDs are no-ops", () => { const s = new QuestionService(); const created = s.create("call-2", input())!; s.apply(created); const withdrawn = s.withdraw(created.requestId, "obsolete")!; assert.equal(s.apply(withdrawn), true); assert.equal(s.apply(withdrawn), false); assert.equal(s.answer(created.requestId, []), undefined); assert.equal(s.get(created.requestId)?.state, "withdrawn"); });
test("projection rejects malformed, unknown-version, and answer-after-terminal", () => { const s = new QuestionService(); const created = s.create("call-3", input())!; const answered = (() => { s.apply(created); const option = s.get(created.requestId)!.questions[0].options[0]; return s.answer(created.requestId, [{ question: "Choose?", selected_option_ids: [option.id], selected_labels: [option.label] }])!; })(); const invalid = { ...answered, eventId: "different", type: "question.withdrawn", payload: {} }; s.project([{}, { ...created, version: 2 }, created, answered, invalid]); assert.equal(s.get(created.requestId)?.state, "answered"); assert.ok(s.diagnostics.length >= 2); });
test("v1 decoding requires canonical IDs, timestamps, and exact nested keys", () => {
  const source = new QuestionService(); const created = source.create("strict", input())!;
  for (const malformed of [
    { ...created, eventId: "arbitrary" },
    { ...created, occurredAt: "not-a-date" },
    { ...created, extra: true },
    { ...created, payload: { ...created.payload, extra: true } },
    { ...created, payload: { ...created.payload, questions: [{ ...created.payload.questions[0], extra: true }] } },
    { ...created, payload: { ...created.payload, questions: [{ ...created.payload.questions[0], options: [{ ...created.payload.questions[0].options[0], extra: true }, created.payload.questions[0].options[1]] }] } },
  ]) { const projected = new QuestionService(); projected.project([malformed]); assert.equal(projected.all().length, 0); }
  const projected = new QuestionService(); projected.project([created]); assert.equal(projected.get(created.requestId)?.state, "pending");
});
test("v1 transition decoding rejects noncanonical identities and loose empty payloads", () => {
  const source = new QuestionService(); const created = source.create("strict-transition", input())!; source.apply(created); const escalated = source.escalate(created.requestId)!;
  for (const malformed of [{ ...escalated, eventId: "arbitrary" }, { ...escalated, payload: { extra: true } }]) {
    const projected = new QuestionService(); projected.project([created, malformed]); assert.equal(projected.get(created.requestId)?.delivery, "non_blocking");
  }
  const projected = new QuestionService(); projected.project([created, escalated]); assert.equal(projected.get(created.requestId)?.delivery, "blocking");
});

test("pending order is blocking, urgency, then oldest",  () => { const s = new QuestionService(); const a = s.create("a", input("non_blocking", "high"))!; const b = s.create("b", input("blocking", "low"))!; const c = s.create("c", input("blocking", "high"))!; s.apply(a); s.apply(b); s.apply(c); assert.deepEqual(s.pending().map((r) => r.requestId), [c.requestId, b.requestId, a.requestId]); });
test("escalation is idempotent and preserves urgency", () => { const s = new QuestionService(); const created = s.create("e", input("non_blocking", "low"))!; s.apply(created); s.apply(s.escalate(created.requestId)!); assert.equal(s.escalate(created.requestId), undefined); assert.equal(s.get(created.requestId)?.urgency, "low"); assert.equal(s.get(created.requestId)?.delivery, "blocking"); });
test("rejected transitions do not poison their event IDs", () => { const s = new QuestionService(); const created = s.create("poison", input())!; const premature = { version: 1 as const, type: "question.declined" as const, eventId: created.eventId, requestId: created.requestId, occurredAt: created.occurredAt, payload: {} }; assert.equal(s.apply(premature), false); assert.equal(s.apply(created), true); assert.equal(s.get(created.requestId)?.state, "pending"); });
test("answers require one answer per question and a non-empty valid selection", () => {
  const s = new QuestionService(); const created = s.create("malformed", input())!; s.apply(created); const request = s.get(created.requestId)!; const [a, b] = request.questions[0].options;
  for (const answers of [
    [],
    [{ question: "Choose?", selected_option_ids: [], selected_labels: [] }],
    [{ question: "Choose?", selected_option_ids: [], selected_labels: [], free_text: "   " }],
    [{ question: "Choose?", selected_option_ids: [a.id, b.id], selected_labels: [a.label, b.label] }],
    [{ question: "Choose?", selected_option_ids: [a.id], selected_labels: [a.label], free_text: "mixed" }],
  ]) {
    const event = s.answer(created.requestId, answers)!;
    assert.equal(s.apply({ ...event, eventId: `${event.eventId}:${s.diagnostics.length}` }), false);
    assert.equal(s.get(created.requestId)?.state, "pending");
  }
  const valid = s.answer(created.requestId, [{ question: "Choose?", selected_option_ids: [], selected_labels: [], free_text: "Custom" }])!;
  assert.equal(s.apply(valid), true); assert.equal(s.get(created.requestId)?.state, "answered");
});

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import { badge, QuestionInboxComponent } from "../extensions/pi/inbox.js";
import { QuestionService } from "../extensions/pi/question-service.js";
import type { QuestionRequest } from "../extensions/pi/schema.js";

const input = (delivery: "blocking" | "non_blocking", urgency: "low" | "normal" | "high") => ({ questions: [{ question: "A very long topic that needs truncation?", header: "LongTopic", options: [{ label: "A" }, { label: "B" }], multiSelect: false }], delivery, urgency });
const theme = { fg: (token: string, value: string) => `\x1b[3${token === "warning" ? "3" : "6"}m${value}\x1b[0m` } as unknown as Theme;

function pendingRequest(header = "LongTopic"): QuestionRequest {
  const service = new QuestionService();
  service.apply(service.create("a", input("blocking", "normal"))!);
  const request = service.pending()[0];
  return { ...request, questions: request.questions.map((question) => ({ ...question, header })) };
}

test("badge derives count, blocking marker, and maximum urgency", () => {
  const service = new QuestionService();
  for (const [id, delivery, urgency] of [["a", "non_blocking", "low"], ["b", "blocking", "high"]] as const) service.apply(service.create(id, input(delivery, urgency))!);
  assert.deepEqual(badge(service.all()), { text: "[2 ? user-questions]", urgency: "high" });
  service.apply(service.withdraw(service.pending()[0].requestId)!);
  assert.deepEqual(badge(service.all()), { text: "[1 user-questions]", urgency: "low" });
});

test("inbox uses full rounded container chrome and attention title", () => {
  const lines = new QuestionInboxComponent([pendingRequest()], theme, () => {}, () => {}).render(48);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].replace(/\x1b\[[0-9;]*m/g, "").startsWith("╭─ ? User questions"));
  assert.match(lines[0], /\x1b\[33m\? User questions\x1b\[0m/);
  assert.match(lines[1].replace(/\x1b\[[0-9;]*m/g, ""), /^▌ .* │$/);
  assert.match(lines[2].replace(/\x1b\[[0-9;]*m/g, ""), /^▌ .* │$/);
  assert.match(lines[3].replace(/\x1b\[[0-9;]*m/g, ""), /^╰─+╯$/);
  assert.ok(lines[1].includes("?"), "blocking question glyph remains visible without color");
});

test("inbox chrome holds Pi-provided width with ANSI and long CJK topic", () => {
  const request = pendingRequest("非常に長い質問トピック日本語とEnglishSuffix");
  for (const width of [5, 8, 12, 20, 40, 72]) {
    const lines = new QuestionInboxComponent([request], theme, () => {}, () => {}).render(width);
    for (const line of lines) assert.equal(visibleWidth(line), width, `line should exactly fill width ${width}: ${line}`);
  }
});

test("inbox never overflows at extremely narrow widths", () => {
  for (const width of [0, 1, 2, 3, 4]) {
    const lines = new QuestionInboxComponent([pendingRequest()], theme, () => {}, () => {}).render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

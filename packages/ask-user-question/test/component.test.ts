import type { Theme } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AskUserQuestionComponent } from "../extensions/pi/component.js";
import type { PickerOutcome, Question } from "../extensions/pi/schema.js";

const question: Question = { question: "Which DB?", header: "Database", options: [{ id: "pg", label: "Postgres" }, { id: "sq", label: "SQLite" }], multiSelect: false };
const tui = { requestRender() {} };
const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const multi: Question = { question: "Which features?", header: "Features", options: [{ id: "auth", label: "Auth" }, { id: "search", label: "Search" }, { id: "export", label: "Export" }], multiSelect: true };
const input = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", escape: "\x1b", tab: "\t", space: " " } as const;
const make = (questions: Question[], done: (outcome: PickerOutcome) => void = () => {}) => new AskUserQuestionComponent(questions, tui, theme, done);
test("single-question selection records a draft and requires explicit Submit", () => {
  const outcomes: PickerOutcome[] = []; const component = new AskUserQuestionComponent([question], tui, theme, (outcome) => outcomes.push(outcome));
  component.handleInput("\r");
  assert.deepEqual(outcomes, []);
  assert.ok(component.render(80).some((line) => line.includes("Ready to submit")));
  component.handleInput("\r"); component.handleInput("\r"); component.handleInput("\x1b");
  assert.deepEqual(outcomes, [{ kind: "submitted", answers: [{ question: "Which DB?", selected_option_ids: ["pg"], selected_labels: ["Postgres"] }] }]);
});
test("picker Escape closes without answering and help says close", () => {
  let outcome: PickerOutcome | undefined; const component = new AskUserQuestionComponent([question], tui, theme, (value) => { outcome = value; });
  assert.ok(component.render(80).some((line) => line.includes("Esc close")));
  component.handleInput("\x1b"); assert.deepEqual(outcome, { kind: "closed" });
});
test("picker free-text Escape returns to choices", () => {
  let called = false; const component = make([question], () => { called = true; });
  component.handleInput(input.down); component.handleInput(input.down); component.handleInput(input.space); component.handleInput("x"); component.handleInput(input.escape);
  assert.equal(called, false); assert.ok(!component.render(40).some((line) => line.includes("✎")));
});

test("supported upstream render structure, descriptions, and cache remain intact", () => {
  const described = { ...question, options: [{ ...question.options[0], description: "Battle-tested relational DB" }, question.options[1]] };
  const component = make([described]); const first = component.render(40);
  assert.ok(first[0].includes("─") && first.at(-1)?.includes("─"));
  for (const text of ["Which DB?", "Postgres", "SQLite", "Type your own answer", "Battle-tested"]) assert.ok(first.some((line) => line.includes(text)));
  assert.strictEqual(component.render(40), first);
  component.invalidate(); assert.notStrictEqual(component.render(40), first);
  assert.ok(component.render(20).every((line) => visibleWidth(line) <= 20));
});

test("cursor navigation clamps at both ends", () => {
  const component = make([question]); component.handleInput(input.up);
  assert.ok(component.render(80).some((line) => /^>\s+.*Postgres/.test(line)));
  for (let i = 0; i < 10; i++) component.handleInput(input.down);
  assert.ok(component.render(80).some((line) => /^>.*Type your own answer/.test(line)));
  component.handleInput(input.up);
  assert.ok(component.render(80).some((line) => /^>\s+.*SQLite/.test(line)));
});

test("multi-select toggles choices and submits all selected stable IDs", () => {
  const outcomes: PickerOutcome[] = []; const component = make([multi], (outcome) => outcomes.push(outcome));
  component.handleInput(input.space); component.handleInput(input.down); component.handleInput(input.space);
  let lines = component.render(80); assert.ok(lines.some((line) => line.includes("[✓]") && line.includes("Auth"))); assert.ok(lines.some((line) => line.includes("[✓]") && line.includes("Search")));
  component.handleInput(input.enter); assert.equal(outcomes.length, 0); component.handleInput(input.enter);
  assert.deepEqual(outcomes, [{ kind: "submitted", answers: [{ question: "Which features?", selected_option_ids: ["auth", "search"], selected_labels: ["Auth", "Search"] }] }]);
});

test("multi-question tabs preserve selections and block incomplete Submit", () => {
  const outcomes: PickerOutcome[] = []; const component = make([question, multi], (outcome) => outcomes.push(outcome));
  assert.ok(component.render(80).some((line) => line.includes("Database") && line.includes("Features") && line.includes("Submit")));
  component.handleInput(input.right); component.handleInput(input.right); component.handleInput(input.enter);
  assert.equal(outcomes.length, 0); assert.ok(component.render(80).some((line) => line.includes("Still needed")));
  component.handleInput(input.right); component.handleInput(input.enter); component.handleInput(input.space); component.handleInput(input.enter); component.handleInput(input.enter);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].kind, "submitted");
});

test("single free text is trimmed, reviewed, and explicitly submitted", () => {
  const outcomes: PickerOutcome[] = []; const component = make([question], (outcome) => outcomes.push(outcome));
  component.handleInput(input.down); component.handleInput(input.down); component.handleInput(input.space);
  for (const char of "  custom choice  ") component.handleInput(char);
  component.handleInput(input.enter); assert.equal(outcomes.length, 0); assert.ok(component.render(80).some((line) => line.includes("custom choice")));
  component.handleInput(input.enter);
  assert.deepEqual(outcomes, [{ kind: "submitted", answers: [{ question: "Which DB?", selected_option_ids: [], selected_labels: [], free_text: "custom choice" }] }]);
});

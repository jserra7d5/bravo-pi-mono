import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET_AUTO_SWARM_PROMPT } from "../extensions/pi/budgetPrompt.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const spec = readFileSync(resolve(repo, "docs/specs/budget-auto-swarm/prompting.md"), "utf8");
function block(after: string, before: string): string {
  const anchor = spec.indexOf(after); assert.notEqual(anchor, -1);
  const start = spec.indexOf("```md\n", anchor) + 6;
  const end = spec.indexOf(before, start); assert.notEqual(end, -1);
  return spec.slice(start, end);
}

test("production Pi overlay bytes equal the protected prompt block", () => {
  assert.equal(BUDGET_AUTO_SWARM_PROMPT, block("## Pi lead overlay — exact model-visible text", "\n```"));
});

test("production Claude skill bytes equal the protected complete skill block", () => {
  const expected = block("## Claude skill — exact `SKILL.md`", "\n```\n\n## Claude task argument behavior");
  assert.equal(readFileSync(resolve(repo, "packages/async-subagents/skills/budget-auto-swarm/SKILL.md"), "utf8"), `${expected}\n`);
});

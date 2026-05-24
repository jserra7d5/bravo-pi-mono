import test from "node:test";
import assert from "node:assert/strict";
import { appendWebEvidencePrompt, WEB_EVIDENCE_PROMPT_MODULE } from "../extensions/pi/promptModule.js";

test("appendWebEvidencePrompt appends the compact web evidence module once", () => {
  const base = "Base prompt\n";
  const once = appendWebEvidencePrompt(base);
  const twice = appendWebEvidencePrompt(once);

  assert.equal(twice, once);
  assert.ok(once.startsWith("Base prompt\n\n## Web Evidence"));
  assert.ok(once.includes("Use web evidence tools as a three-step workflow:"));
  assert.ok(once.includes("`web_search` discovers candidate public web pages only."));
  assert.ok(once.includes("Normally call it with only `{ refs }`"));
  assert.ok(once.includes("Default `match_mode: \"any\"` is recall, not verification"));
  assert.ok(once.includes("Do not cite search snippets, lookup snippets, or orientation previews"));
});

test("web evidence prompt module stays compact and selection-prior focused", () => {
  assert.ok(WEB_EVIDENCE_PROMPT_MODULE.length < 900);
  assert.equal(WEB_EVIDENCE_PROMPT_MODULE.includes("## Web Evidence Hard Rules"), false);
});

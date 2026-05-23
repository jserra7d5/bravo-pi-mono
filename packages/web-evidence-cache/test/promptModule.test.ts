import test from "node:test";
import assert from "node:assert/strict";
import { appendWebEvidencePrompt, WEB_EVIDENCE_PROMPT_MODULE } from "../extensions/pi/promptModule.js";

test("appendWebEvidencePrompt appends the compact web evidence module once", () => {
  const base = "Base prompt\n";
  const once = appendWebEvidencePrompt(base);
  const twice = appendWebEvidencePrompt(once);

  assert.equal(twice, once);
  assert.ok(once.startsWith("Base prompt\n\n## Web Evidence"));
  assert.ok(once.includes("Use `web_search` when you need candidate pages from the public web."));
  assert.ok(once.includes("Use `web_fetch` when a result or URL is worth reading, citing, or searching."));
  assert.ok(once.includes("Use `web_lookup` to search within pages already fetched in this session"));
  assert.ok(once.includes("Do not cite claims from search snippets alone"));
});

test("web evidence prompt module stays compact and selection-prior focused", () => {
  assert.ok(WEB_EVIDENCE_PROMPT_MODULE.length < 900);
  assert.equal(WEB_EVIDENCE_PROMPT_MODULE.includes("## Web Evidence Hard Rules"), false);
});

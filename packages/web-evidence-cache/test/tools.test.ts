import test from "node:test";
import assert from "node:assert/strict";
import { buildWebEvidenceTools } from "../extensions/pi/index.js";

test("all web evidence tools use self-rendering shell and prompt guidance", () => {
  const tools = buildWebEvidenceTools() as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((t) => t.name), ["web_search", "web_fetch", "web_lookup"]);
  for (const tool of tools) {
    assert.equal(tool.renderShell, "self");
    assert.equal(typeof tool.promptSnippet, "string");
    assert.ok(Array.isArray(tool.promptGuidelines));
    assert.ok((tool.promptGuidelines as unknown[]).length >= 3);
  }
});

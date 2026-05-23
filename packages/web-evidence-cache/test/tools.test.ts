import test from "node:test";
import assert from "node:assert/strict";
import webEvidenceCacheExtension, { buildWebEvidenceTools } from "../extensions/pi/index.js";

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

test("web evidence extension appends the extension-wide prompt section before agent start", async () => {
  const tools: unknown[] = [];
  const handlers: Record<string, Function> = {};
  webEvidenceCacheExtension({
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
  } as never);

  assert.equal(tools.length, 3);
  assert.equal(typeof handlers.before_agent_start, "function");
  const result = await handlers.before_agent_start({ systemPrompt: "Base prompt" });
  assert.ok(result.systemPrompt.includes("## Web Evidence"));
  assert.equal(result.systemPrompt.indexOf("## Web Evidence"), result.systemPrompt.lastIndexOf("## Web Evidence"));
});

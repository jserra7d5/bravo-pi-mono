import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/frontmatter.js";

test("frontmatter parser supports strings, booleans, numbers, inline arrays, block arrays, and body", () => {
  const parsed = parseFrontmatter(`---
name: scout
description: Read-only scout
enabled: true
maxRunMs: 600000
tools: [read, grep, ls]
includes:
  - safety
  - repo
---

Body prompt.
`);
  assert.equal(parsed.data.name, "scout");
  assert.equal(parsed.data.enabled, true);
  assert.equal(parsed.data.maxRunMs, 600000);
  assert.deepEqual(parsed.data.tools, ["read", "grep", "ls"]);
  assert.deepEqual(parsed.data.includes, ["safety", "repo"]);
  assert.equal(parsed.body, "Body prompt.");
});

test("frontmatter parser rejects unsupported nested maps", () => {
  assert.throws(
    () =>
      parseFrontmatter(`---
name: bad
settings: { nested: true }
---

Body
`),
    /nested maps/,
  );
});

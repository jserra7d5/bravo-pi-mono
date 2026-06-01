import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { discoverAgentDefinitions, parseAgentDefinitionFile } from "../src/agentDefinitions.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-agents-"));
  const userHome = join(root, "home");
  mkdirSync(join(userHome, "agents"), { recursive: true });
  mkdirSync(join(root, ".agents", "subagents"), { recursive: true });
  return { root, userHome };
}

test("agent parser falls back to filename for missing name", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "reviewer.md");
  writeFileSync(path, `---
description: Review code
---

Reviewer body.
`);
  const definition = parseAgentDefinitionFile(path, "user");
  assert.equal(definition.name, "reviewer");
  assert.equal(definition.mode, "oneshot");
  assert.equal(definition.resultFormat, "text");
});

test("agent parser accepts default thinking levels", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "thinker.md");
  writeFileSync(path, `---
description: Think deeply
model: openai-codex/gpt-5.5
thinkingLevel: high
---

Thinker body.
`);
  const definition = parseAgentDefinitionFile(path, "user");
  assert.equal(definition.model, "openai-codex/gpt-5.5");
  assert.equal(definition.thinkingLevel, "high");
});

test("agent parser accepts snake-case thinking_level alias", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "snake.md");
  writeFileSync(path, `---
description: Think with snake case
thinking_level: medium
---

Snake body.
`);
  const definition = parseAgentDefinitionFile(path, "user");
  assert.equal(definition.thinkingLevel, "medium");
});

test("agent parser accepts nested variants", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "scout.md");
  writeFileSync(path, `---
description: Scout with variants
model: openai-codex/gpt-5.4-mini
thinkingLevel: medium
tools: [read]
variants:
  gemini:
    model: antigravity-code-assist/gemini-3.5-flash
    thinkingLevel: high
    tools: [read, bash]
  cheap:
    thinking_level: low
---

Scout body.
`);
  const definition = parseAgentDefinitionFile(path, "user");
  assert.equal(definition.variants.gemini?.model, "antigravity-code-assist/gemini-3.5-flash");
  assert.equal(definition.variants.gemini?.thinkingLevel, "high");
  assert.deepEqual(definition.variants.gemini?.tools, ["read", "bash"]);
  assert.equal(definition.variants.cheap?.thinkingLevel, "low");
});

test("discovery uses project over user over builtin precedence", () => {
  const w = workspace();
  writeFileSync(join(w.userHome, "agents", "scout.md"), `---
description: User scout
---

User scout body.
`);
  writeFileSync(join(w.root, ".agents", "subagents", "scout.md"), `---
description: Project scout
tools:
  - read
---

Project scout body.
`);
  const definitions = discoverAgentDefinitions({ cwd: w.root, userHome: w.userHome, env: { ...process.env, ASYNC_SUBAGENTS_HOME: w.userHome } });
  const scout = definitions.get("scout");
  assert.equal(scout?.source, "project");
  assert.equal(scout?.description, "Project scout");
  assert.deepEqual(scout?.tools, ["read"]);
});

test("packaged scout prompt teaches direct evidence handoff boundaries", () => {
  const body = readFileSync(join(process.cwd(), "agents", "scout.md"), "utf8");
  assert.match(body, /Use scout only for context retrieval/);
  assert.match(body, /Separate direct evidence from any minimal orientation notes/);
  assert.match(body, /List relevant files, symbols, commands, and observations/);
  assert.doesNotMatch(body, /context_map_/);
});

test("missing description fails clearly", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "bad.md");
  writeFileSync(path, `---
name: bad
---

Bad body.
`);
  assert.throws(() => parseAgentDefinitionFile(path, "user"), /description is required/);
});

test("project path-based skills and extensions require explicit approval", () => {
  const w = workspace();
  const path = join(w.root, ".agents", "subagents", "worker.md");
  writeFileSync(path, `---
description: Worker
skills: [./local-skill]
extensions: [/tmp/local-extension]
---

Worker body.
`);
  assert.throws(() => parseAgentDefinitionFile(path, "project"), /explicit approval/);
  assert.equal(parseAgentDefinitionFile(path, "project", { allowProjectPathCapabilities: true }).skills[0], "./local-skill");
});

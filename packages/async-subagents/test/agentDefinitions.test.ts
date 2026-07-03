import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { applyAgentVariant, discoverAgentDefinitions, parseAgentDefinitionFile } from "../src/agentDefinitions.js";

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

test("built-in worker, reviewer, and scout expose Claude variants", () => {
  const w = workspace();
  const definitions = discoverAgentDefinitions({ cwd: w.root, userHome: w.userHome, env: { ...process.env, ASYNC_SUBAGENTS_HOME: w.userHome } });
  for (const name of ["worker", "reviewer", "scout"]) {
    const definition = definitions.get(name);
    assert.ok(definition, `missing built-in ${name}`);
    const claude = applyAgentVariant(definition, "claude");
    assert.equal(claude.harness, "claude", name);
    assert.equal(claude.mode, "interactive", name);
    assert.equal(claude.model, "claude-sonnet-5", name);
    assert.deepEqual(claude.tools, [], name);
    assert.deepEqual(claude.extensions, [], name);
    assert.equal(claude.thinkingLevel, undefined, name);
  }
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

test("Claude variant does not inherit Pi-only execution fields across harness boundary", async () => {
  const { applyAgentVariant } = await import("../src/agentDefinitions.js");
  const w = workspace();
  const path = join(w.userHome, "agents", "worker.md");
  writeFileSync(path, `---
description: Worker
harnessNeutral: true
tools: [read, bash]
extensions: [pi-ext]
thinkingLevel: high
includes: [pi-runtime]
variants:
  claude:
    harness: claude
    model: claude-sonnet-5
    effort: high
    mode: interactive
---

Worker body.
`);
  const base = parseAgentDefinitionFile(path, "user");
  const claude = applyAgentVariant(base, "claude");
  assert.equal(claude.harness, "claude");
  assert.deepEqual(claude.tools, []);
  assert.deepEqual(claude.extensions, []);
  assert.equal(claude.thinkingLevel, undefined);
  assert.deepEqual(claude.includes, []);
  assert.equal(claude.mode, "interactive");
  assert.match(JSON.stringify(claude.notInheritedAcrossHarness), /thinkingLevel/);
  assert.match(JSON.stringify(claude.excludedAcrossHarness), /includes/);
  assert.match(JSON.stringify(claude.inheritedAcrossHarness), /body/);
});

test("Claude variant fails closed when crossing from non-neutral Pi base body", async () => {
  const { applyAgentVariant } = await import("../src/agentDefinitions.js");
  const w = workspace();
  const path = join(w.userHome, "agents", "worker.md");
  writeFileSync(path, `---
description: Worker
variants:
  claude:
    harness: claude
---

Pi-only body.
`);
  const base = parseAgentDefinitionFile(path, "user");
  assert.throws(() => applyAgentVariant(base, "claude"), /harnessNeutral/);
});

test("Claude variant rejects explicit Pi-only fields", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "bad-claude.md");
  writeFileSync(path, `---
description: Bad
variants:
  claude:
    harness: claude
    tools: []
---

Bad body.
`);
  assert.throws(() => parseAgentDefinitionFile(path, "user"), /tools is Pi-only/);
});

test("agent parser rejects unknown top-level fields", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "unknown.md");
  writeFileSync(path, `---
description: Bad
surprise: true
---

Bad body.
`);
  assert.throws(() => parseAgentDefinitionFile(path, "user"), /unknown top-level field surprise/);
});

test("agent parser rejects unsupported extra MCP frontmatter fields", () => {
  const w = workspace();
  const top = join(w.userHome, "agents", "bad-mcp-top.md");
  writeFileSync(top, `---
description: Bad
extraMcpServers: [local]
---

Bad body.
`);
  assert.throws(() => parseAgentDefinitionFile(top, "user"), (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "EXTRA_MCP_UNSUPPORTED");

  const variant = join(w.userHome, "agents", "bad-mcp-variant.md");
  writeFileSync(variant, `---
description: Bad
variants:
  claude:
    harness: claude
    mcpServers: [local]
---

Bad body.
`);
  assert.throws(() => parseAgentDefinitionFile(variant, "user"), (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "EXTRA_MCP_UNSUPPORTED");

  const nested = join(w.userHome, "agents", "bad-mcp-claude.md");
  writeFileSync(nested, `---
description: Bad
claude:
  mcpConfig: [local]
---

Bad body.
`);
  assert.throws(() => parseAgentDefinitionFile(nested, "user"), (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "EXTRA_MCP_UNSUPPORTED");
});

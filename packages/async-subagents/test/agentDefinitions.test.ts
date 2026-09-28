import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("built-in templates are discoverable and declare a Pi harness with a model", () => {
  // Asserts the shipped catalog loads and is well-formed. It deliberately does NOT assert which
  // variants a template offers: variant CONTENT is template authoring, and pinning it here made
  // editing a shipped template fail unrelated harness-boundary tests. The harness-boundary rules
  // themselves are covered below against purpose-built fixtures.
  const w = workspace();
  const definitions = discoverAgentDefinitions({ cwd: w.root, userHome: w.userHome, env: { ...process.env, ASYNC_SUBAGENTS_HOME: w.userHome } });
  for (const name of ["scout", "planner", "worker", "reviewer"]) {
    const definition = definitions.get(name);
    assert.ok(definition, `missing built-in ${name}`);
    assert.equal(definition.source, "builtin", name);
    assert.equal(definition.harness, "pi", name);
    assert.ok(definition.model, `built-in ${name} should pin a model`);
    assert.ok(definition.description.length > 0, name);
    // Every extension a shipped template names must already be a loadable absolute path: the
    // child receives these verbatim as `-e <value>` and cannot resolve a package specifier.
    for (const extension of definition.extensions) {
      assert.ok(extension.startsWith("/"), `built-in ${name} extension should resolve to an absolute path, got ${extension}`);
      assert.ok(existsSync(extension), `built-in ${name} extension should exist on disk: ${extension}`);
    }
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

test("agent parser rejects non-Pi harness values in definitions and variants", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "unsupported.md");
  writeFileSync(path, `---
description: Unsupported harness
harness: claude
---
Body.
`);
  assert.throws(() => parseAgentDefinitionFile(path, "user"), /harness must be one of pi/);
  writeFileSync(path, `---
description: Unsupported variant harness
variants:
  alternate:
    harness: claude
---
Body.
`);
  assert.throws(() => parseAgentDefinitionFile(path, "user"), /unknown variant field harness/);
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


});

test("agent parser resolves package-specifier Pi extensions to loadable absolute paths", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "specifier.md");
  writeFileSync(path, `---
description: Uses a workspace extension by package specifier
extensions: [@bravo/web-evidence-cache/extensions/pi]
variants:
  gemini:
    extensions: [@bravo/gemini-code-assist/extensions/pi]
---

Specifier body.
`);
  const definition = parseAgentDefinitionFile(path, "user");
  // Built-in templates ship inside the package and must not name a machine-specific checkout.
  // The child gets these verbatim as `-e <value>`, so resolution has to happen here.
  assert.equal(definition.extensions.length, 1);
  assert.ok(definition.extensions[0]!.startsWith("/"), `expected an absolute path, got ${definition.extensions[0]}`);
  assert.ok(existsSync(definition.extensions[0]!), `resolved extension should exist on disk: ${definition.extensions[0]}`);
  assert.ok(definition.extensions[0]!.endsWith("/packages/web-evidence-cache/extensions/pi/index.ts"));

  const gemini = applyAgentVariant(definition, "gemini");
  assert.equal(gemini.extensions.length, 1);
  assert.ok(existsSync(gemini.extensions[0]!), `resolved variant extension should exist on disk: ${gemini.extensions[0]}`);
  assert.ok(gemini.extensions[0]!.endsWith("/packages/gemini-code-assist/extensions/pi/index.ts"));
});

test("agent parser passes absolute Pi extension paths through untouched", () => {
  const w = workspace();
  const absolute = join(w.root, "some", "extension", "index.ts");
  const path = join(w.userHome, "agents", "absolute.md");
  writeFileSync(path, `---
description: Uses an absolute extension path
extensions: [${absolute}]
---

Absolute body.
`);
  assert.deepEqual(parseAgentDefinitionFile(path, "user").extensions, [absolute]);
});

test("agent parser fails loudly on an unresolvable extension specifier", () => {
  const w = workspace();
  const path = join(w.userHome, "agents", "missing.md");
  writeFileSync(path, `---
description: Names an extension that does not exist
extensions: [@bravo/definitely-not-a-real-package/extensions/pi]
---

Missing body.
`);
  assert.throws(
    () => parseAgentDefinitionFile(path, "user"),
    (err: unknown) => err instanceof Error
      && (err as { code?: unknown }).code === "INVALID_AGENT_DEFINITION"
      && /definitely-not-a-real-package/.test(err.message),
  );
});

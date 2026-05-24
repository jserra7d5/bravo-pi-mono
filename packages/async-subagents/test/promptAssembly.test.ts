import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAgentDefinitionFile } from "../src/agentDefinitions.js";
import { RunStore } from "../src/runStore.js";
import { assemblePrompt } from "../src/promptAssembly.js";

test("assemblePrompt writes isolated system and task prompts with explicit includes only", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-prompt-"));
  mkdirSync(join(root, ".agents", "includes"), { recursive: true });
  mkdirSync(join(root, ".agents", "subagents"), { recursive: true });
  writeFileSync(join(root, ".agents", "includes", "safety.md"), "Use safe edits only.\n");
  const definitionPath = join(root, ".agents", "subagents", "scout.md");
  writeFileSync(definitionPath, `---
description: Scout
includes: [safety]
skills: [repo-reader]
extensions: [audit-extension]
model: openai-codex/gpt-5.5
thinkingLevel: high
resultFormat: json
---

Scout system body.
`);
  const definition = parseAgentDefinitionFile(definitionPath, "project");
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  const { paths } = store.createRunDirectory({ cwd: root, parentRunId: "root_a", rootSessionId: "root_a" });
  const assembled = assemblePrompt({
    definition,
    runPaths: paths,
    task: "Inspect API files.",
    cwd: root,
    parentRunId: "root_a",
    rootRunId: "root_a",
    depth: 0,
    files: ["src/api.ts"],
    skills: ["tui-design", "repo-reader"],
  });

  const system = readFileSync(assembled.systemPath, "utf8");
  assert.match(system, /Scout system body/);
  assert.match(system, /Use safe edits only/);
  assert.match(system, /Runtime Contract/);
  assert.doesNotMatch(system, /global Pi system prompt/i);

  const task = readFileSync(assembled.taskPath, "utf8");
  assert.match(task, /Inspect API files/);
  assert.match(task, /parentRunId: root_a/);
  assert.match(task, /src\/api.ts/);
  assert.deepEqual(assembled.skills, ["repo-reader", "tui-design"]);
  assert.deepEqual(assembled.extensions, ["audit-extension"]);
  assert.equal(assembled.model, "openai-codex/gpt-5.5");
  assert.equal(assembled.thinkingLevel, "high");
});

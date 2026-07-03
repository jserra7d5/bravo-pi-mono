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

test("assemblePrompt writes Claude runtime contract without Pi child-control wording", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-prompt-"));
  mkdirSync(join(root, ".agents", "includes"), { recursive: true });
  mkdirSync(join(root, ".agents", "subagents"), { recursive: true });
  writeFileSync(join(root, ".agents", "includes", "neutral.md"), "Neutral guidance.\n");
  const definitionPath = join(root, ".agents", "subagents", "claude-worker.md");
  writeFileSync(definitionPath, `---
description: Claude worker
harness: claude
includes: [neutral]
model: claude-sonnet-5
effort: high
---

Claude worker system body.
`);
  const definition = parseAgentDefinitionFile(definitionPath, "project");
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  const { paths } = store.createRunDirectory({ cwd: root, parentRunId: "root_c", rootSessionId: "root_c" });
  const assembled = assemblePrompt({
    definition,
    runPaths: paths,
    task: "Implement the change.",
    cwd: root,
    parentRunId: "root_c",
    rootRunId: "root_c",
    depth: 0,
  });

  const system = readFileSync(assembled.systemPath, "utf8");
  assert.match(system, /Claude Code child/);
  assert.match(system, /subagent_read_inbox/);
  assert.match(system, /subagent_ack_inbox/);
  assert.match(system, /subagent_complete/);
  assert.match(system, /Do not use Claude's native Task tool/);
  assert.match(system, /# Assigned Task\n\nImplement the change\./);
  assert.match(system, new RegExp(`The assigned task is also mirrored at this absolute artifact path for durable evidence: ${assembled.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(system, /argv intentionally contains only a constant launcher prompt/);
  assert.doesNotMatch(system, /call the subagent_event tool with type question or blocked/);
  const task = readFileSync(assembled.taskPath, "utf8");
  assert.match(task, /Implement the change/);
  assert.match(task, /durable MCP inbox/);
  assert.equal(assembled.thinkingLevel, undefined);
  assert.equal(assembled.effort, "high");
  assert.deepEqual(assembled.extensions, []);
});

test("assemblePrompt tells task-assigned Claude to complete through subagent_complete", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-task-assignment-"));
  mkdirSync(join(root, ".agents", "subagents"), { recursive: true });
  const definitionPath = join(root, ".agents", "subagents", "claude-worker.md");
  writeFileSync(definitionPath, `---
description: Claude worker
harness: claude
---

Claude worker system body.
`);
  const definition = parseAgentDefinitionFile(definitionPath, "project");
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  const { paths } = store.createRunDirectory({ cwd: root, parentRunId: "root_t", rootSessionId: "root_t" });
  const assembled = assemblePrompt({
    definition,
    runPaths: paths,
    task: "Implement the assigned milestone.",
    cwd: root,
    parentRunId: "root_t",
    rootRunId: "root_t",
    depth: 0,
    taskAssignment: { task: { schemaVersion: 1, id: "T-1", title: "Milestone", description: "Do it", status: "open", dependsOn: [], createdBy: "test", parentRunId: "root_t", createdAt: "now", updatedAt: "now" } },
  });
  const system = readFileSync(assembled.systemPath, "utf8");
  const task = readFileSync(assembled.taskPath, "utf8");
  assert.match(system, /report completion through subagent_complete/);
  assert.doesNotMatch(system, /normal final answer/);
  assert.match(task, /subagent_complete/);
  assert.doesNotMatch(task, /normal result/);
});

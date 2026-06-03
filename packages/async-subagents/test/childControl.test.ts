import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childControlExtension from "../extensions/child-control/index.js";
import { createInboxMessage } from "../src/message.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { startSubagent } from "../src/start.js";
import { SCHEMA_VERSION, type TaskRecord } from "../src/types.js";

function withEnv(values: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-child-control-"));
  const agentsDir = join(root, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "scout.md"),
    `---
description: Test scout.
tools: []
mode: oneshot
---

Test scout body.
`,
    "utf8",
  );
  return { root, runRoot: join(root, ".subagents", "runs") };
}

function taskRecord(id = "task_test"): TaskRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: "Task tool exposure",
    description: "Verify task-owned child tools are allowed.",
    status: "running",
    dependsOn: [],
    attempts: [],
    createdBy: "root_test",
    parentRunId: "root_test",
    createdAt: now,
    updatedAt: now,
  };
}

function launchTools(runDir: string): string[] {
  const launch = JSON.parse(readFileSync(join(runDir, "logs", "launch.json"), "utf8"));
  const toolsIndex = launch.args.indexOf("--tools");
  assert.notEqual(toolsIndex, -1);
  return String(launch.args[toolsIndex + 1]).split(",").filter(Boolean);
}

test("child-control delivers inbox messages and emits structured events", async () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-child-control-"));
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  const { runId, paths } = store.createRunDirectory({ cwd: root, parentRunId: "root_test", rootSessionId: "root_test" });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "scout",
      agentSource: "builtin",
      definitionPath: "/builtin/scout.md",
      mode: "interactive",
      cwd: root,
      state: "running",
    }),
  );
  store.appendInboxMessage(
    runId,
    createInboxMessage({
      toRunId: runId,
      fromRunId: "root_test",
      body: "Please inspect the retry path.",
      thinkingLevel: "high",
    }),
  );

  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const thinkingLevels: string[] = [];
  let registeredTool: any;
  const pi = {
    registerTool(tool: any) {
      registeredTool = tool;
    },
    on(event: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    sendUserMessage(content: unknown, options: unknown) {
      sentUserMessages.push({ content, options });
    },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  };

  await withEnv(
    {
      ASYNC_SUBAGENTS_RUN_ID: runId,
      ASYNC_SUBAGENTS_RUN_DIR: paths.runDir,
      ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
    },
    async () => {
      childControlExtension(pi as never);
      await handlers.get("session_start")?.();

      assert.equal(sentUserMessages.length, 1);
      assert.match(String(sentUserMessages[0]?.content), /Please inspect the retry path/);
      assert.deepEqual(thinkingLevels, ["high"]);
      assert.equal(store.readEvents(runId).records[0]?.type, "message.received");
      assert.equal(store.readEvents(runId).records[0]?.data?.thinkingLevel, "high");

      const result = await registeredTool.execute("call", { type: "question", summary: "Need file scope", body: "Which files should I inspect?" });
      assert.match(result.content[0].text, /Event/);
      const events = store.readEvents(runId).records;
      assert.equal(events.at(-1)?.type, "question");
      assert.equal(store.readStatus(runId).state, "waiting_for_input");

      await handlers.get("session_shutdown")?.();
    },
  );
});

test("task-owned child launches allowlist task tools", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "Use task tools",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    rootSessionId: "root_test",
    taskAssignment: { task: taskRecord(), token: "token_test" },
    fake: { mode: "immediate", body: "done" },
  });

  const tools = launchTools(started.runDir);
  assert.ok(tools.includes("subagent_event"));
  assert.ok(tools.includes("task_submit_result"));
  assert.ok(tools.includes("task_update_progress"));
  assert.ok(tools.includes("task_report_blocked"));
});

test("non-task child launches do not allowlist task tools", async () => {
  const w = workspace();
  const started = await startSubagent({
    agent: "scout",
    task: "No task tools",
    cwd: w.root,
    runRoot: w.runRoot,
    parentRunId: "root_test",
    rootSessionId: "root_test",
    fake: { mode: "immediate", body: "done" },
  });

  const tools = launchTools(started.runDir);
  assert.ok(tools.includes("subagent_event"));
  assert.equal(tools.includes("task_submit_result"), false);
  assert.equal(tools.includes("task_update_progress"), false);
  assert.equal(tools.includes("task_report_blocked"), false);
});

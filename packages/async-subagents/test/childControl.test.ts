import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childControlExtension from "../extensions/child-control/index.js";
import { createInboxMessage } from "../src/message.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";

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

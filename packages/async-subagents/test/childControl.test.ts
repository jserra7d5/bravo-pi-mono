import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRenderClock, type RenderClock, type RenderClockScheduler } from "@bravo/render-clock";
import childControlExtension from "../extensions/child-control/index.js";
import { createInboxMessage } from "../src/message.js";
import { finalizeTerminalRun } from "../src/lifecycle.js";
import { withRunMutationLock } from "../src/runLock.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { startSubagent } from "../src/start.js";
import { SCHEMA_VERSION } from "../src/types.js";

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

function makeScheduler(start = 0): RenderClockScheduler & { advance(ms: number): void; fire(): void; activeIntervals(): number } {
  let now = start;
  const intervals = new Set<() => void>();
  return {
    now: () => now,
    setInterval(cb: () => void) {
      intervals.add(cb);
      return { cb };
    },
    clearInterval(handle: { cb?: () => void }) {
      if (handle.cb) intervals.delete(handle.cb);
    },
    advance(ms: number) {
      now += ms;
    },
    fire() {
      for (const cb of Array.from(intervals)) cb();
    },
    activeIntervals() {
      return intervals.size;
    },
  } as RenderClockScheduler & { advance(ms: number): void; fire(): void; activeIntervals(): number };
}

type ChildControlFixture = {
  root: string;
  store: RunStore;
  runId: string;
  paths: ReturnType<RunStore["createRunDirectory"]>["paths"];
  handlers: Map<string, (...args: any[]) => Promise<void> | void>;
  sentUserMessages: Array<{ content: unknown; options: unknown }>;
  thinkingLevels: string[];
  pi: {
    registerTool(tool: any): void;
    on(event: string, handler: (...args: any[]) => Promise<void> | void): void;
    sendUserMessage(content: unknown, options: unknown): void;
    setThinkingLevel(level: string): void;
  };
  setSendUserMessage(fn: (content: unknown, options: unknown) => void): void;
};

function childControlFixture(): ChildControlFixture {
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
  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const thinkingLevels: string[] = [];
  let sendUserMessage = (content: unknown, options: unknown) => {
    sentUserMessages.push({ content, options });
  };
  const pi = {
    registerTool(_tool: any) {},
    on(event: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    sendUserMessage(content: unknown, options: unknown) {
      sendUserMessage(content, options);
    },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  };
  return {
    root,
    store,
    runId,
    paths,
    handlers,
    sentUserMessages,
    thinkingLevels,
    pi,
    setSendUserMessage(fn) {
      sendUserMessage = fn;
    },
  };
}

function messageReceivedCount(store: RunStore, runId: string): number {
  return store.readEvents(runId).records.filter((event) => event.type === "message.received").length;
}

async function startChild(fixture: ChildControlFixture, clock: RenderClock): Promise<void> {
  childControlExtension(fixture.pi as never, { clock });
  await fixture.handlers.get("session_start")?.();
}

async function tick(clock: RenderClock): Promise<void> {
  clock.tick("manual");
  await new Promise((resolve) => setTimeout(resolve, 0));
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

function launchTools(runDir: string): string[] {
  const launch = JSON.parse(readFileSync(join(runDir, "logs", "launch.json"), "utf8"));
  const toolsIndex = launch.args.indexOf("--tools");
  assert.notEqual(toolsIndex, -1);
  return String(launch.args[toolsIndex + 1]).split(",").filter(Boolean);
}

test("child-control delivers inbox messages and records received-message events", async () => {
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
  const registeredTools: string[] = [];
  const pi = {
    registerTool(tool: { name?: string }) {
      registeredTools.push(String(tool.name));
      if (String(tool.name).startsWith("task_")) throw new Error("child-control should not register task-owned child tools");
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
      assert.deepEqual(registeredTools, ["subagent_event"]);
      assert.equal(store.readEvents(runId).records[0]?.type, "message.received");
      assert.equal(store.readEvents(runId).records[0]?.data?.thinkingLevel, "high");

      await handlers.get("session_shutdown")?.();
    },
  );
});

test("child-control recurring poll delivers post-start inbox messages on due clock ticks", async () => {
  const fixture = childControlFixture();
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });

  await withEnv(
    {
      ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
      ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
      ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
    },
    async () => {
      await startChild(fixture, clock);
      await tick(clock);
      assert.equal(fixture.sentUserMessages.length, 0);
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 0);

      fixture.store.appendInboxMessage(
        fixture.runId,
        createInboxMessage({
          toRunId: fixture.runId,
          fromRunId: "root_test",
          body: "Post-start delivery",
        }),
      );

      scheduler.advance(999);
      await tick(clock);
      assert.equal(fixture.sentUserMessages.length, 0, "poll must not run before its 1s interval is due");
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 0);

      scheduler.advance(1);
      await tick(clock);
      assert.equal(fixture.sentUserMessages.length, 1);
      assert.match(String(fixture.sentUserMessages[0]?.content), /Post-start delivery/);
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 1);

      scheduler.advance(1000);
      await tick(clock);
      assert.equal(fixture.sentUserMessages.length, 1, "idle ticks must not duplicate delivered messages");
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 1);

      await fixture.handlers.get("session_shutdown")?.();
    },
  );
});

test("child-control shutdown stops polling and is idempotent", async () => {
  const fixture = childControlFixture();
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });

  await withEnv(
    {
      ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
      ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
      ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
    },
    async () => {
      await startChild(fixture, clock);
      assert.equal(clock.subscriberCount(), 1);
      await fixture.handlers.get("session_shutdown")?.();
      await fixture.handlers.get("session_shutdown")?.();
      assert.equal(clock.subscriberCount(), 0);
      assert.equal(scheduler.activeIntervals(), 0);

      fixture.store.appendInboxMessage(
        fixture.runId,
        createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", body: "After shutdown" }),
      );
      scheduler.advance(1000);
      await tick(clock);
      assert.equal(fixture.sentUserMessages.length, 0);
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 0);
    },
  );
});

test("child-control double session_start preserves cursor and does not replay", async () => {
  const fixture = childControlFixture();
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  fixture.store.appendInboxMessage(
    fixture.runId,
    createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", body: "Already consumed" }),
  );

  await withEnv(
    {
      ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
      ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
      ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
    },
    async () => {
      await startChild(fixture, clock);
      assert.equal(fixture.sentUserMessages.length, 1);
      assert.match(String(fixture.sentUserMessages[0]?.content), /Already consumed/);
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 1);
      assert.equal(clock.subscriberCount(), 1);

      await fixture.handlers.get("session_start")?.();
      assert.equal(clock.subscriberCount(), 1);
      assert.equal(fixture.sentUserMessages.length, 1, "second start must not replay the consumed inbox message");
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 1);

      fixture.store.appendInboxMessage(
        fixture.runId,
        createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", body: "New after restart" }),
      );
      scheduler.advance(1000);
      await tick(clock);
      assert.equal(fixture.sentUserMessages.length, 2);
      assert.match(String(fixture.sentUserMessages.at(-1)?.content), /New after restart/);
      assert.equal(messageReceivedCount(fixture.store, fixture.runId), 2);

      await fixture.handlers.get("session_shutdown")?.();
    },
  );
});

test("child-control establishes poll when pre-existing inbox is malformed", async () => {
  const fixture = childControlFixture();
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  writeFileSync(fixture.paths.inboxPath, "{not json}\n", "utf8");
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await withEnv(
      {
        ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
        ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
        ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
      },
      async () => {
        await assert.doesNotReject(async () => startChild(fixture, clock));
        assert.equal(clock.subscriberCount(), 1);
        assert.equal(fixture.sentUserMessages.length, 0);
        assert.equal(errors.length, 1);

        writeFileSync(fixture.paths.inboxPath, "", "utf8");
        fixture.store.appendInboxMessage(
          fixture.runId,
          createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", body: "Recovered delivery" }),
        );
        await tick(clock);
        assert.equal(fixture.sentUserMessages.length, 1);
        assert.match(String(fixture.sentUserMessages[0]?.content), /Recovered delivery/);
        assert.equal(messageReceivedCount(fixture.store, fixture.runId), 1);

        await fixture.handlers.get("session_shutdown")?.();
      },
    );
  } finally {
    console.error = originalError;
  }
});

test("child-control does not resend when bookkeeping event append fails after delivery", async () => {
  const fixture = childControlFixture();
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await withEnv(
      {
        ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
        ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
        ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
      },
      async () => {
        await startChild(fixture, clock);
        await tick(clock);
        rmSync(fixture.paths.eventsPath, { force: true });
        mkdirSync(fixture.paths.eventsPath);
        fixture.store.appendInboxMessage(
          fixture.runId,
          createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", body: "Bookkeeping may fail" }),
        );

        scheduler.advance(1000);
        await tick(clock);
        assert.equal(fixture.sentUserMessages.length, 1);
        assert.match(String(fixture.sentUserMessages[0]?.content), /Bookkeeping may fail/);
        assert.equal(errors.length, 1);

        scheduler.advance(1000);
        await tick(clock);
        assert.equal(fixture.sentUserMessages.length, 1, "post-send event append failure must not cause a resend");
        assert.equal(errors.length, 1);

        await fixture.handlers.get("session_shutdown")?.();
      },
    );
  } finally {
    console.error = originalError;
  }
});

test("child-control retries inbox message after transient send failure", async () => {
  const fixture = childControlFixture();
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  let failNextSend = true;
  fixture.setSendUserMessage((content, options) => {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("transient send failure");
    }
    fixture.sentUserMessages.push({ content, options });
  });
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await withEnv(
      {
        ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
        ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
        ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
      },
      async () => {
        await startChild(fixture, clock);
        await tick(clock);
        fixture.store.appendInboxMessage(
          fixture.runId,
          createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", body: "Retry me" }),
        );

        scheduler.advance(1000);
        await tick(clock);
        assert.equal(errors.length, 1);
        assert.equal(fixture.sentUserMessages.length, 0);
        assert.equal(messageReceivedCount(fixture.store, fixture.runId), 0);

        scheduler.advance(1000);
        await tick(clock);
        assert.equal(fixture.sentUserMessages.length, 1);
        assert.match(String(fixture.sentUserMessages[0]?.content), /Retry me/);
        assert.equal(messageReceivedCount(fixture.store, fixture.runId), 1);

        await fixture.handlers.get("session_shutdown")?.();
      },
    );
  } finally {
    console.error = originalError;
  }
});

test("child launches do not allowlist removed task-owned child tools", async () => {
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

test("child-control restores running state when an answer unsticks a blocked child", async () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-child-control-"));
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  const { runId, paths } = store.createRunDirectory({ cwd: root, parentRunId: "root_test", rootSessionId: "root_test" });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "worker",
      agentSource: "builtin",
      definitionPath: "/builtin/worker.md",
      mode: "oneshot",
      cwd: root,
      state: "blocked",
    }),
  );
  store.appendInboxMessage(
    runId,
    createInboxMessage({
      toRunId: runId,
      fromRunId: "root_test",
      type: "answer",
      body: "Scope approved; proceed.",
    }),
  );
  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  const pi = {
    registerTool(_tool: unknown) {},
    on(event: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    sendUserMessage(_content: unknown, _options: unknown) {},
    setThinkingLevel(_level: string) {},
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
      const status = store.readStatus(runId);
      assert.equal(status.state, "running");
      assert.equal(status.needs, null);
      await handlers.get("session_shutdown")?.();
    },
  );
});

test("child-control restore racing terminal finalization never resurrects the run", async () => {
  const fixture = childControlFixture();
  fixture.store.writeStatus({ ...fixture.store.readStatus(fixture.runId), state: "blocked" });
  fixture.store.appendInboxMessage(fixture.runId, createInboxMessage({ toRunId: fixture.runId, fromRunId: "root_test", type: "answer", body: "Proceed" }));
  const scheduler = makeScheduler();
  const clock = createRenderClock({ baseIntervalMs: 1000, scheduler });
  let release!: () => void;
  let locked!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const holder = withRunMutationLock(fixture.paths.runDir, async () => {
    finalizeTerminalRun(fixture.store, { runId: fixture.runId, parentRunId: "root_test", agentName: "scout", state: "completed", writerRole: "child-runtime", summary: "Finished" });
    locked();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await entered;

  await withEnv(
    {
      ASYNC_SUBAGENTS_RUN_ID: fixture.runId,
      ASYNC_SUBAGENTS_RUN_DIR: fixture.paths.runDir,
      ASYNC_SUBAGENTS_PARENT_RUN_ID: "root_test",
    },
    async () => {
      childControlExtension(fixture.pi as never, { clock });
      const starting = fixture.handlers.get("session_start")?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await holder;
      await starting;
      assert.equal(fixture.store.readStatus(fixture.runId).state, "completed");
      await fixture.handlers.get("session_shutdown")?.();
    },
  );
});

test("child-control leaves running state untouched for context messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-child-control-"));
  const store = new RunStore({ cwd: root, runRoot: join(root, ".subagents", "runs") });
  const { runId, paths } = store.createRunDirectory({ cwd: root, parentRunId: "root_test", rootSessionId: "root_test" });
  store.writeStatus(
    createInitialStatus({
      runId,
      parentRunId: "root_test",
      rootSessionId: "root_test",
      agentName: "worker",
      agentSource: "builtin",
      definitionPath: "/builtin/worker.md",
      mode: "oneshot",
      cwd: root,
      state: "blocked",
    }),
  );
  store.appendInboxMessage(
    runId,
    createInboxMessage({
      toRunId: runId,
      fromRunId: "root_test",
      type: "context",
      body: "FYI only.",
    }),
  );
  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  const pi = {
    registerTool(_tool: unknown) {},
    on(event: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    sendUserMessage(_content: unknown, _options: unknown) {},
    setThinkingLevel(_level: string) {},
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
      assert.equal(store.readStatus(runId).state, "blocked");
      await handlers.get("session_shutdown")?.();
    },
  );
});

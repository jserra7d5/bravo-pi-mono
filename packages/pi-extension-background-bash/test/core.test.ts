import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pkg from "../package.json" with { type: "json" };
import extension, { BackgroundRunner, buildBackgroundBashTools, clearBackgroundBashWidget, TaskRegistry, updateBackgroundBashWidget } from "../src/index.js";
import { readConfig } from "../src/config.js";
import { visWidth } from "../src/ui.js";
import type { BackgroundTaskRecord } from "../src/task-types.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "bb-core-")); }

test("package pi entrypoint points at loadable source", () => {
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.ok(existsSync(path.join(import.meta.dirname, "..", "..", "src", "index.ts")));
});

test("registration and prompt guidance are consistently disabled unless load config enables", async () => {
  const old = process.env.PI_BACKGROUND_BASH_ENABLED;
  delete process.env.PI_BACKGROUND_BASH_ENABLED;
  const tools: unknown[] = [];
  const handlers: Record<string, Function> = {};
  await extension({ registerTool: (t: never) => tools.push(t), on: (n: string, h: Function) => { handlers[n] = h; } } as never);
  assert.equal(tools.length, 0);
  assert.equal((await handlers.before_agent_start({ systemPrompt: "base" })).systemPrompt, "base");
  if (old === undefined) delete process.env.PI_BACKGROUND_BASH_ENABLED; else process.env.PI_BACKGROUND_BASH_ENABLED = old;
});

test("registry registers tools when env opt-in is enabled", async () => {
  const old = process.env.PI_BACKGROUND_BASH_ENABLED;
  process.env.PI_BACKGROUND_BASH_ENABLED = "1";
  const tools: Array<{ name: string; renderShell?: unknown; renderCall?: unknown; renderResult?: unknown }> = [];
  await extension({ registerTool: (t: never) => tools.push(t as never), on: () => undefined, registerCommand: () => undefined } as never);
  assert.deepEqual(tools.map(t => t.name), ["bash", "background_task_list", "background_task_status", "background_task_stop"]);
  assert.equal(tools.find(t => t.name === "bash")?.renderShell, undefined);
  assert.equal(tools.find(t => t.name === "bash")?.renderCall, undefined);
  assert.equal(tools.find(t => t.name === "bash")?.renderResult, undefined);
  for (const t of tools.filter(t => t.name !== "bash")) {
    assert.equal(t.renderShell, "self");
    assert.equal(typeof t.renderResult, "function");
  }
  if (old === undefined) delete process.env.PI_BACKGROUND_BASH_ENABLED; else process.env.PI_BACKGROUND_BASH_ENABLED = old;
});

test("output cap limits persisted bytes and stops appending", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data"), defaultMaxOutputBytes: 32, defaultMaxRuntimeMs: 10_000 }, root);
    const runner = new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg);
    const task = await runner.start({ command: "node -e \"process.stdout.write('x'.repeat(100000))\"", cwd: root });
    await new Promise(r => setTimeout(r, 500));
    const rec = new TaskRegistry(cfg.dataDir).get(task.taskId)!;
    assert.equal(rec.outputBytes, 32);
    assert.equal(rec.status, "killed");
    assert.equal(readFileSync(rec.outputPath, "utf8").includes("output cap"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background runner uses Pi bash shell resolution", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data"), defaultMaxRuntimeMs: 10_000 }, root);
    const runner = new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg);
    const task = await runner.start({ command: "[[ ${BASH_VERSION:-} ]] && echo bash-ok", cwd: root });
    await new Promise(r => setTimeout(r, 300));
    const rec = new TaskRegistry(cfg.dataDir).get(task.taskId)!;
    assert.equal(rec.status, "exited");
    assert.match(readFileSync(rec.outputPath, "utf8"), /bash-ok/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stop refuses unverified persisted pid", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    const rec: BackgroundTaskRecord = { schemaVersion: 1, taskId: "t1", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, pid: process.pid, outputPath: path.join(root, "out.log"), metadataPath: path.join(root, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
    registry.upsert(rec);
    const stopped = await new BackgroundRunner(registry, cfg).stop("t1");
    assert.equal(stopped?.status, "orphaned");
    assert.equal(stopped?.blockedReason, "unverified_pid_ownership");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("watchdog marks interactive prompt blocked without input", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data"), defaultMaxRuntimeMs: 10_000 }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const runner = new BackgroundRunner(registry, cfg);
    const task = await runner.start({ command: "node -e \"console.log('Password:'); setTimeout(()=>{}, 5000)\"", cwd: root });
    await new Promise(r => setTimeout(r, 400));
    const rec = new TaskRegistry(cfg.dataDir).get(task.taskId)!;
    assert.equal(rec.status, "blocked");
    assert.equal(rec.blockedReason, "interactive_prompt");
    await runner.stop(task.taskId);
    await new Promise(r => setTimeout(r, 100));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid cwd spawn failure returns failed task", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const task = await new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).start({ command: "echo nope", cwd: path.join(root, "missing") });
    assert.equal(task.status, "failed");
    assert.equal(new TaskRegistry(cfg.dataDir).get(task.taskId)?.status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("blocked process exit becomes terminal with blocked reason retained", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data"), defaultMaxRuntimeMs: 10_000 }, root);
    const task = await new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).start({ command: "node -e \"console.log('Password:'); setTimeout(()=>process.exit(2), 50)\"", cwd: root });
    await new Promise(r => setTimeout(r, 500));
    const rec = new TaskRegistry(cfg.dataDir).get(task.taskId)!;
    assert.equal(rec.status, "failed");
    assert.equal(rec.exitCode, 2);
    assert.equal(rec.blockedReason, "interactive_prompt");
    assert.ok(rec.endedAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function promptAfterActivation(activeTools: unknown[], allTools: unknown[]) {
  const old = process.env.PI_BACKGROUND_BASH_ENABLED;
  process.env.PI_BACKGROUND_BASH_ENABLED = "1";
  try {
    const handlers: Record<string, Function> = {};
    const warnings: string[] = [];
    await extension({ registerTool: () => undefined, on: (n: string, h: Function) => { handlers[n] = h; }, getActiveTools: async () => activeTools, getAllTools: async () => allTools, notify: (m: string) => warnings.push(m) } as never);
    return { prompt: (await handlers.before_agent_start({ systemPrompt: "base" })).systemPrompt as string, warnings };
  } finally {
    if (old === undefined) delete process.env.PI_BACKGROUND_BASH_ENABLED; else process.env.PI_BACKGROUND_BASH_ENABLED = old;
  }
}

test("activation guidance withheld when active bash override verification fails", async () => {
  const result = await promptAfterActivation([], []);
  assert.equal(result.prompt, "base");
  assert.equal(result.warnings.length, 1);
});

test("activation guidance withheld when extension bash exists but active bash is ambiguous", async () => {
  const result = await promptAfterActivation(["bash"], [{ name: "bash", source: "built-in" }, { name: "bash", extensionId: "@bravo/pi-extension-background-bash" }]);
  assert.equal(result.prompt, "base");
  assert.equal(result.warnings.length, 1);
});

test("activation guidance withheld for single bash without provenance", async () => {
  const result = await promptAfterActivation(["bash"], [{ name: "bash" }]);
  assert.equal(result.prompt, "base");
  assert.equal(result.warnings.length, 1);
});

test("activation guidance shown when active bash name maps to one extension-provenance bash", async () => {
  const result = await promptAfterActivation(["bash"], [{ name: "bash", sourceInfo: { packageId: "@bravo/pi-extension-background-bash" } }]);
  assert.match(result.prompt, /Background bash is available/);
  assert.equal(result.warnings.length, 0);
});

test("activation guidance withheld for duplicate active bash entries even when allTools has extension provenance", async () => {
  const result = await promptAfterActivation(["bash", "bash"], [{ name: "bash", sourceInfo: { packageId: "@bravo/pi-extension-background-bash" } }]);
  assert.equal(result.prompt, "base");
  assert.equal(result.warnings.length, 1);
});

test("registered renderers produce bounded background task cards", () => {
  const tools = buildBackgroundBashTools();
  const bash = tools[0] as { renderCall?: Function; renderResult?: Function };
  assert.equal(bash.renderCall, undefined);
  assert.equal(bash.renderResult, undefined);
  const now = new Date().toISOString();
  const task: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_20260531_abcdef", command: "npm run dev -- --host 0.0.0.0", cwd: "/tmp", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: ".pi/background-bash/bg_20260531_abcdef/output.log", metadataPath: "/tmp/meta.json", outputBytes: 12_288, maxOutputBytes: 10_000_000, maxRuntimeMs: 300_000, wakeOnCompletion: false };
  const lines = (tools[1] as { renderResult?: Function }).renderResult?.({ content: [], details: { tasks: [task] } })?.render(56) ?? [];
  const list = lines.join("\n");
  assert.match(list, /tasks/);
  assert.match(list, /running/);
  for (const line of lines) assert.equal(visWidth(line), 56);
});

test("self-shell background task renderers return fallback components on error details", () => {
  const tools = buildBackgroundBashTools() as Array<{ name: string; renderResult?: Function }>;
  for (const tool of tools.filter(t => t.name.startsWith("background_task_"))) {
    const component = tool.renderResult?.({ content: [{ type: "text", text: "Task not found" }], details: { code: "TASK_NOT_FOUND" }, isError: true });
    assert.ok(component, `${tool.name} should not return undefined`);
    assert.deepEqual(component.render(56), ["Task not found"]);
  }
});

test("registered renderers normalize embedded newlines before chrome rendering", () => {
  const tools = buildBackgroundBashTools();
  const now = new Date().toISOString();
  const task: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_20260531_abcdef", command: "npm run dev\n-- --host 0.0.0.0", cwd: "/tmp", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: ".pi/background-bash/bg_20260531_abcdef/output.log", metadataPath: "/tmp/meta.json", outputBytes: 12_288, maxOutputBytes: 10_000_000, maxRuntimeMs: 300_000, wakeOnCompletion: false };
  const lines = (tools[1] as { renderResult?: Function }).renderResult?.({ content: [], details: { tasks: [task] } })?.render(56) ?? [];
  for (const line of lines) {
    assert.ok(!/[\r\n]/.test(line), `line contains embedded newline: ${JSON.stringify(line.replace(/\x1b\[[0-9;]*m/g, ""))}`);
    assert.equal(visWidth(line), 56);
  }
});

test("background bash widget suppresses render requests for unchanged polling counts", async () => {
  clearBackgroundBashWidget({ ui: { setWidget() {} } });
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    registry.upsert({ schemaVersion: 1, taskId: "bg_one", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "out.log"), metadataPath: path.join(root, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void; update?: (counts: unknown) => void };
    let captured: WidgetFactory | undefined;
    let setWidgetCalls = 0;
    const ctx = {
      cwd: root,
      config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } },
      ui: { setWidget(_key: string, value: unknown) { setWidgetCalls += 1; if (typeof value === "function") captured = value as WidgetFactory; } },
    };

    updateBackgroundBashWidget(ctx);
    assert.equal(setWidgetCalls, 1);
    assert.ok(captured, "expected widget factory to be mounted");

    let renderRequests = 0;
    const component = captured!({ requestRender() { renderRequests += 1; } }, undefined);
    updateBackgroundBashWidget(ctx);

    assert.equal(setWidgetCalls, 1, "unchanged polling must not remount widget");
    assert.equal(renderRequests, 0, "unchanged polling must not request render");
    assert.match(component.render(40).join("\n"), /1 running/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background bash widget does not remount while setWidget factory is still pending", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    registry.upsert({ schemaVersion: 1, taskId: "bg_one", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "out.log"), metadataPath: path.join(root, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    let setWidgetCalls = 0;
    const ctx = {
      cwd: root,
      config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } },
      ui: { setWidget() { setWidgetCalls += 1; } },
    };

    updateBackgroundBashWidget(ctx);
    updateBackgroundBashWidget(ctx);

    assert.equal(setWidgetCalls, 1, "unchanged polling before factory invocation must not remount widget");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background bash widget state is isolated by ui object", async () => {
  const rootA = await tmp();
  const rootB = await tmp();
  try {
    const cfgA = readConfig({ enabled: true, dataDir: path.join(rootA, "data") }, rootA);
    const cfgB = readConfig({ enabled: true, dataDir: path.join(rootB, "data") }, rootB);
    const now = new Date().toISOString();
    new TaskRegistry(cfgA.dataDir).upsert({ schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: rootA, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(rootA, "out.log"), metadataPath: path.join(rootA, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    new TaskRegistry(cfgB.dataDir).upsert({ schemaVersion: 1, taskId: "bg_b", command: "sleep 20", cwd: rootB, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(rootB, "out.log"), metadataPath: path.join(rootB, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    const callsA: unknown[] = [];
    const callsB: unknown[] = [];
    const ctxA = { cwd: rootA, config: { backgroundBash: { enabled: true, dataDir: cfgA.dataDir } }, ui: { setWidget(_key: string, value: unknown) { callsA.push(value); } } };
    const ctxB = { cwd: rootB, config: { backgroundBash: { enabled: true, dataDir: cfgB.dataDir } }, ui: { setWidget(_key: string, value: unknown) { callsB.push(value); } } };

    updateBackgroundBashWidget(ctxA);
    updateBackgroundBashWidget(ctxB);
    assert.equal(callsA.length, 1, "session A should mount its own widget");
    assert.equal(callsB.length, 1, "session B should mount its own widget");

    new TaskRegistry(cfgB.dataDir).upsert({ ...new TaskRegistry(cfgB.dataDir).get("bg_b")!, status: "exited", endedAt: now });
    updateBackgroundBashWidget(ctxB);
    assert.equal(callsA.length, 1, "clearing B must not touch A's ui");
    assert.equal(callsB.length, 2, "B should clear its own widget");
    assert.equal(callsB[1], undefined);
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("background bash widget requests render when counts change and clears when empty", async () => {
  clearBackgroundBashWidget({ ui: { setWidget() {} } });
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    registry.upsert({ schemaVersion: 1, taskId: "bg_one", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "out.log"), metadataPath: path.join(root, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void; update?: (counts: unknown) => void };
    let captured: WidgetFactory | undefined;
    const calls: unknown[] = [];
    const ctx = {
      cwd: root,
      config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } },
      ui: { setWidget(_key: string, value: unknown) { calls.push(value); if (typeof value === "function") captured = value as WidgetFactory; } },
    };

    updateBackgroundBashWidget(ctx);
    assert.ok(captured, "expected widget factory to be mounted");
    let renderRequests = 0;
    captured!({ requestRender() { renderRequests += 1; } }, undefined);

    registry.upsert({ schemaVersion: 1, taskId: "bg_two", command: "sleep 20", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "out2.log"), metadataPath: path.join(root, "meta2.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    updateBackgroundBashWidget(ctx);
    assert.equal(calls.length, 1, "count changes update mounted component instead of remounting");
    assert.equal(renderRequests, 1, "count changes request one render");

    registry.upsert({ ...registry.get("bg_one")!, status: "exited", endedAt: now });
    registry.upsert({ ...registry.get("bg_two")!, status: "exited", endedAt: now });
    updateBackgroundBashWidget(ctx);
    assert.equal(calls.length, 2, "empty counts clear the mounted widget");
    assert.equal(calls[1], undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bash background timeout is validated as process max runtime seconds", async () => {
  const root = await tmp();
  try {
    const tools = buildBackgroundBashTools();
    const bash = tools[0];
    const tiny = await bash.execute("id", { command: "echo x", run_in_background: true, timeout: 1 }, undefined, undefined, { cwd: root });
    assert.equal((tiny as { isError?: boolean }).isError, true);
    assert.match(String((tiny.content[0] as { text?: string }).text), /maximum runtime/);
    const response = await bash.execute("id", { command: "echo ok", run_in_background: true, timeout: 30 }, undefined, undefined, { cwd: root, config: { backgroundBash: { enabled: true, dataDir: path.join(root, "data") } } });
    const task = (response.details as { task: BackgroundTaskRecord }).task;
    assert.equal(task.maxRuntimeMs, 30_000);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(new TaskRegistry(path.join(root, "data")).get(task.taskId)?.status, "exited");
    const bad = await bash.execute("id", { command: "echo x", run_in_background: true, timeout: 24 * 60 * 60 + 1 }, undefined, undefined, { cwd: root });
    assert.equal((bad as { isError?: boolean }).isError, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

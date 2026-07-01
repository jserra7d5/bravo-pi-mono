import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import pkg from "../package.json" with { type: "json" };
import { __resetRenderClockForTest } from "@bravo/render-clock";
import extension, { BackgroundRunner, buildBackgroundBashTools, clearBackgroundBashWidget, TaskRegistry, updateBackgroundBashWidget } from "../src/index.js";
import { readConfig } from "../src/config.js";
import { runtimeId } from "../src/background-runner.js";
import { buildWakeMessage, type BackgroundBashWakeMessage } from "../src/notifications.js";
import { renderFooter, visWidth } from "../src/ui.js";
import type { BackgroundTaskRecord } from "../src/task-types.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "bb-core-")); }
async function waitFor(predicate: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(predicate(), true, "timed out waiting for condition");
}

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

test("default data directory is Pi-global, not cwd-local", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true }, root);
    assert.equal(cfg.dataDir, path.join(os.homedir(), ".pi", "background-bash"));
    assert.equal(cfg.dataDir.startsWith(root), false);

    const local = readConfig({ enabled: true, dataDir: ".custom/background-bash" }, root);
    assert.equal(local.dataDir, path.join(root, ".custom", "background-bash"));
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("separate process registry writers preserve distinct running tasks", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const registryModule = path.join(import.meta.dirname, "..", "src", "task-registry.js");
    const script = `
      import { mkdirSync, writeFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      import { TaskRegistry } from ${JSON.stringify(pathToFileURL(registryModule).href)};
      const [dataDir, root, taskId] = process.argv.slice(1);
      const taskDir = join(dataDir, taskId);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(dataDir, taskId + ".ready"), "ready");
      const deadline = Date.now() + 5000;
      while (!(existsSync(join(dataDir, "bg_a.ready")) && existsSync(join(dataDir, "bg_b.ready")))) {
        if (Date.now() > deadline) throw new Error("timed out waiting at registry race barrier");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      const now = new Date().toISOString();
      new TaskRegistry(dataDir).upsert({ schemaVersion: 1, taskId, command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: join(taskDir, "output.log"), metadataPath: join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    `;
    async function run(taskId: string) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir, root, taskId], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child ${taskId} timed out; stdout=${stdout}; stderr=${stderr}`)); }, 8000);
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`child ${taskId} failed code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
        });
      });
    }

    await Promise.all([run("bg_a"), run("bg_b")]);

    const fresh = new TaskRegistry(dataDir);
    assert.deepEqual(fresh.list(false).map((t) => t.taskId).sort(), ["bg_a", "bg_b"]);
    const registryRaw = JSON.parse(readFileSync(path.join(dataDir, "registry.json"), "utf8")) as BackgroundTaskRecord[];
    assert.deepEqual(registryRaw.map((t) => t.taskId).sort(), ["bg_a", "bg_b"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry lock removes dead and stale owners before mutating", async () => {
  const root = await tmp();
  try {
    for (const mode of ["dead", "stale"] as const) {
      const dataDir = path.join(root, mode);
      const taskDir = path.join(dataDir, "bg_a");
      const lockDir = path.join(dataDir, ".registry.lock");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: mode === "dead" ? 9_999_999 : process.pid, hostname: os.hostname(), token: `old-${mode}`, acquiredAt: mode === "stale" ? Date.now() - 31_000 : Date.now() }));
      mkdirSync(taskDir, { recursive: true });
      const now = new Date().toISOString();
      new TaskRegistry(dataDir).upsert({ schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
      assert.equal(new TaskRegistry(dataDir).get("bg_a")?.status, "running");
      assert.equal(existsSync(lockDir), false, `${mode} lock should be removed after mutation`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry lock times out on fresh live-looking owner with clear error", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const taskDir = path.join(dataDir, "bg_a");
    const lockDir = path.join(dataDir, ".registry.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "live", acquiredAt: Date.now() }));
    mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    const started = Date.now();
    assert.throws(() => new TaskRegistry(dataDir).upsert({ schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false }), /Timed out after 5000ms acquiring background bash task registry lock/);
    assert.ok(Date.now() - started < 6500, "lock timeout should be bounded");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active-active registry writers merge distinct task updates", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const taskADir = path.join(dataDir, "bg_a");
    const taskBDir = path.join(dataDir, "bg_b");
    mkdirSync(taskADir, { recursive: true });
    mkdirSync(taskBDir, { recursive: true });
    const now = new Date().toISOString();
    const a: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskADir, "output.log"), metadataPath: path.join(taskADir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
    const b: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_b", command: "sleep 20", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskBDir, "output.log"), metadataPath: path.join(taskBDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };

    const r1 = new TaskRegistry(dataDir);
    const r2 = new TaskRegistry(dataDir);
    r1.upsert(a);
    r2.upsert(b);

    const fresh = new TaskRegistry(dataDir);
    assert.deepEqual(fresh.list(false).map((t) => t.taskId), ["bg_a", "bg_b"]);
    const registryRaw = JSON.parse(readFileSync(path.join(dataDir, "registry.json"), "utf8")) as BackgroundTaskRecord[];
    assert.deepEqual(registryRaw.map((t) => t.taskId), ["bg_a", "bg_b"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry prefers terminal metadata over stale concurrent active index", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const taskADir = path.join(dataDir, "bg_a");
    const taskBDir = path.join(dataDir, "bg_b");
    mkdirSync(taskADir, { recursive: true });
    mkdirSync(taskBDir, { recursive: true });
    const now = new Date().toISOString();
    const a: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_a", command: "true", cwd: root, status: "starting", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskADir, "output.log"), metadataPath: path.join(taskADir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
    const b: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_b", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskBDir, "output.log"), metadataPath: path.join(taskBDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };

    const r1 = new TaskRegistry(dataDir);
    r1.upsert(a);
    const r2 = new TaskRegistry(dataDir);
    r1.upsert({ ...a, status: "exited", exitCode: 0, endedAt: new Date().toISOString() });
    r2.upsert(b);

    const fresh = new TaskRegistry(dataDir);
    assert.equal(fresh.get("bg_a")?.status, "exited", "metadata terminal state must beat stale active index");
    assert.deepEqual(fresh.list(false).map((t) => t.taskId), ["bg_b"], "stale terminal task must not appear in active list");
    assert.equal(fresh.get("bg_b")?.status, "running", "real active task must remain visible");
    const registryRaw = JSON.parse(readFileSync(path.join(dataDir, "registry.json"), "utf8")) as BackgroundTaskRecord[];
    assert.deepEqual(registryRaw.map((t) => t.taskId), ["bg_b"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale same-task active upsert cannot overwrite terminal metadata", async () => {
  const root = await tmp();
  try {
    for (const status of ["exited", "failed", "timed_out"] as const) {
      const dataDir = path.join(root, `data_${status}`);
      const taskDir = path.join(dataDir, "bg_a");
      mkdirSync(taskDir, { recursive: true });
      const now = new Date().toISOString();
      const active: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_a", command: "true", cwd: root, status: "starting", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
      const terminal: BackgroundTaskRecord = { ...active, status, endedAt: new Date().toISOString(), exitCode: status === "exited" ? 0 : status === "failed" ? 1 : null, signal: status === "timed_out" ? "SIGTERM" : null, stopReason: status === "timed_out" ? "timeout" : undefined };
      const r1 = new TaskRegistry(dataDir);
      r1.upsert(active);
      const r2 = new TaskRegistry(dataDir);
      r1.upsert(terminal);

      r2.upsert(active);

      const fresh = new TaskRegistry(dataDir);
      assert.equal(fresh.get("bg_a")?.status, status, `stale same-task active upsert must not overwrite ${status} metadata`);
      assert.deepEqual(fresh.list(false).map((t) => t.taskId), []);
      assert.deepEqual(fresh.list(true).map((t) => t.taskId), ["bg_a"]);
      const metadata = JSON.parse(readFileSync(path.join(taskDir, "metadata.json"), "utf8")) as BackgroundTaskRecord;
      assert.equal(metadata.status, status);
      if (status === "exited") assert.equal(metadata.exitCode, 0);
      if (status === "failed") assert.equal(metadata.exitCode, 1);
      if (status === "timed_out") assert.equal(metadata.stopReason, "timeout");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale same-task active upsert cannot overwrite newer higher-rank active metadata", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const taskDir = path.join(dataDir, "bg_a");
    mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    const active: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
    const r1 = new TaskRegistry(dataDir);
    r1.upsert(active);
    const r2 = new TaskRegistry(dataDir);
    r1.upsert({ ...active, status: "blocked", blockedReason: "interactive_prompt" });

    r2.upsert(active);

    const fresh = new TaskRegistry(dataDir);
    assert.equal(fresh.get("bg_a")?.status, "blocked", "newer higher-rank active metadata must beat stale active upsert");
    assert.equal(fresh.list(false)[0]?.status, "blocked");
    const metadata = JSON.parse(readFileSync(path.join(taskDir, "metadata.json"), "utf8")) as BackgroundTaskRecord;
    assert.equal(metadata.status, "blocked");
    assert.equal(metadata.blockedReason, "interactive_prompt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry keeps failed and timed-out terminal tasks out of active index", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const now = new Date().toISOString();
    const registry = new TaskRegistry(dataDir);
    for (const status of ["failed", "timed_out"] as const) {
      const taskDir = path.join(dataDir, `bg_${status}`);
      mkdirSync(taskDir, { recursive: true });
      registry.upsert({ schemaVersion: 1, taskId: `bg_${status}`, command: "false", cwd: root, status, createdAt: now, updatedAt: now, startedAt: now, endedAt: now, exitCode: status === "failed" ? 1 : null, signal: status === "timed_out" ? "SIGTERM" : null, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false, stopReason: status === "timed_out" ? "timeout" : undefined });
    }

    const fresh = new TaskRegistry(dataDir);
    assert.deepEqual(fresh.list(false).map((t) => t.taskId), [], "failed/timed_out are terminal metadata, not active index rows");
    assert.deepEqual(fresh.list(true).map((t) => t.taskId), ["bg_failed", "bg_timed_out"]);
    assert.equal(fresh.get("bg_failed")?.status, "failed");
    assert.equal(fresh.get("bg_timed_out")?.status, "timed_out");
    const registryRaw = JSON.parse(readFileSync(path.join(dataDir, "registry.json"), "utf8")) as BackgroundTaskRecord[];
    assert.deepEqual(registryRaw.map((t) => t.taskId), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry remove deletes metadata-only terminal task artifacts", async () => {
  const root = await tmp();
  try {
    const dataDir = path.join(root, "data");
    const taskDir = path.join(dataDir, "bg_done");
    mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    const registry = new TaskRegistry(dataDir);
    const rec: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_done", command: "true", cwd: root, status: "exited", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
    registry.upsert(rec);
    writeFileSync(rec.outputPath, "done");

    const reloaded = new TaskRegistry(dataDir);
    assert.equal(reloaded.list(false).length, 0, "terminal task must not be in active registry");
    assert.equal(reloaded.get("bg_done")?.status, "exited", "metadata-only terminal task should remain inspectable before removal");
    assert.equal(reloaded.remove("bg_done"), true);
    assert.equal(existsSync(taskDir), false, "remove should delete terminal metadata/output artifact directory");
    assert.equal(new TaskRegistry(dataDir).get("bg_done"), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stop leaves metadata-only terminal task terminal instead of resurrecting orphaned", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const taskDir = path.join(cfg.dataDir, "bg_done");
    mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    const rec: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_done", command: "true", cwd: root, status: "exited", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, pid: process.pid, outputPath: path.join(taskDir, "output.log"), metadataPath: path.join(taskDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false };
    const registry = new TaskRegistry(cfg.dataDir);
    registry.upsert(rec);

    const stopped = await new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).stop("bg_done");
    assert.equal(stopped?.status, "exited");
    assert.equal(new TaskRegistry(cfg.dataDir).get("bg_done")?.status, "exited");
    assert.equal(new TaskRegistry(cfg.dataDir).list(false).length, 0, "terminal stop target must not be re-added as active orphaned");
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
  const task: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_20260531_abcdef", command: "npm run dev -- --host 0.0.0.0", cwd: "/tmp", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(os.homedir(), ".pi/background-bash/bg_20260531_abcdef/output.log"), metadataPath: "/tmp/meta.json", outputBytes: 12_288, maxOutputBytes: 10_000_000, maxRuntimeMs: 300_000, wakeOnCompletion: false };
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
  const task: BackgroundTaskRecord = { schemaVersion: 1, taskId: "bg_20260531_abcdef", command: "npm run dev\n-- --host 0.0.0.0", cwd: "/tmp", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(os.homedir(), ".pi/background-bash/bg_20260531_abcdef/output.log"), metadataPath: "/tmp/meta.json", outputBytes: 12_288, maxOutputBytes: 10_000_000, maxRuntimeMs: 300_000, wakeOnCompletion: false };
  const lines = (tools[1] as { renderResult?: Function }).renderResult?.({ content: [], details: { tasks: [task] } })?.render(56) ?? [];
  for (const line of lines) {
    assert.ok(!/[\r\n]/.test(line), `line contains embedded newline: ${JSON.stringify(line.replace(/\x1b\[[0-9;]*m/g, ""))}`);
    assert.equal(visWidth(line), 56);
  }
});

test("renderFooter only surfaces active background work", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const full = strip(renderFooter({ running: 2, blocked: 1 }).render(80).join("\n"));
  assert.match(full, /2 running/);
  assert.match(full, /1 blocked/);
  assert.doesNotMatch(full, /failed|timed out|orphaned/);

  const runningOnly = strip(renderFooter({ running: 1, blocked: 0 }).render(80).join("\n"));
  assert.match(runningOnly, /1 running/);
  assert.doesNotMatch(runningOnly, /blocked|failed|timed out|orphaned/);

  const blockedOnly = strip(renderFooter({ running: 0, blocked: 1 }).render(80).join("\n"));
  assert.match(blockedOnly, /1 blocked/);
  assert.doesNotMatch(blockedOnly, /0 running|failed|timed out|orphaned/);
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

test("background bash widget only counts tasks owned by the current session", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    registry.upsert({ schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: root, ownerSessionId: "session-a", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "a.log"), metadataPath: path.join(root, "a.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    registry.upsert({ schemaVersion: 1, taskId: "bg_b", command: "sleep 20", cwd: root, ownerSessionId: "session-b", status: "failed", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, outputPath: path.join(root, "b.log"), metadataPath: path.join(root, "b.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    let captured: ((tui: unknown) => { render(width: number): string[] }) | undefined;
    const calls: unknown[] = [];
    const ctxA = {
      cwd: root,
      config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } },
      sessionManager: { getSessionId: () => "session-a" },
      ui: { setWidget(_key: string, value: unknown) { calls.push(value); if (typeof value === "function") captured = value as typeof captured; } },
    };

    updateBackgroundBashWidget(ctxA);
    assert.equal(calls.length, 1);
    assert.match(captured!({ requestRender() {} }).render(40).join("\n"), /1 running/);
    assert.doesNotMatch(captured!({ requestRender() {} }).render(40).join("\n"), /failed/);

    const previousCalls = calls.length;
    const ctxC = { ...ctxA, sessionManager: { getSessionId: () => "session-c" }, ui: { setWidget(_key: string, value: unknown) { calls.push(value); } } };
    updateBackgroundBashWidget(ctxC);
    assert.equal(calls.length, previousCalls, "sessions with no owned tasks should not mount a widget");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background task tools are session scoped", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    registry.upsert({ schemaVersion: 1, taskId: "bg_a", command: "sleep 10", cwd: root, ownerSessionId: "session-a", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "a.log"), metadataPath: path.join(root, "a.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    registry.upsert({ schemaVersion: 1, taskId: "bg_b", command: "sleep 20", cwd: root, ownerSessionId: "session-b", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "b.log"), metadataPath: path.join(root, "b.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    const tools = buildBackgroundBashTools();
    const list = tools.find((t) => t.name === "background_task_list")!;
    const status = tools.find((t) => t.name === "background_task_status")!;
    const stop = tools.find((t) => t.name === "background_task_stop")!;
    const ctx = { cwd: root, config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } }, sessionManager: { getSessionId: () => "session-a" } };

    const listed = await list.execute("call", {}, undefined, undefined, ctx) as { details: { tasks: BackgroundTaskRecord[] } };
    assert.deepEqual(listed.details.tasks.map((t) => t.taskId), ["bg_a"]);

    const otherStatus = await status.execute("call", { taskId: "bg_b" }, undefined, undefined, ctx) as { isError?: boolean; details: { code?: string } };
    assert.equal(otherStatus.isError, true);
    assert.equal(otherStatus.details.code, "TASK_NOT_FOUND");

    const otherStop = await stop.execute("call", { taskId: "bg_b" }, undefined, undefined, ctx) as { isError?: boolean; details: { code?: string } };
    assert.equal(otherStop.isError, true);
    assert.equal(otherStop.details.code, "TASK_NOT_FOUND");
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

test("background bash widget refreshes active-work counts from render-clock", async () => {
  let nowMs = 0;
  let tickTimer: (() => void) | undefined;
  const clock = __resetRenderClockForTest({
    now: () => nowMs,
    setInterval: (cb: () => void) => { tickTimer = cb; return {}; },
    clearInterval: () => { tickTimer = undefined; },
  });
  const old = process.env.PI_BACKGROUND_BASH_ENABLED;
  process.env.PI_BACKGROUND_BASH_ENABLED = "1";
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    mkdirSync(path.join(cfg.dataDir, "bg_failed"), { recursive: true });
    registry.upsert({ schemaVersion: 1, taskId: "bg_failed", command: "false", cwd: root, status: "failed", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, outputPath: path.join(cfg.dataDir, "bg_failed", "output.log"), metadataPath: path.join(cfg.dataDir, "bg_failed", "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });

    type WidgetFactory = (tui: unknown) => { render(width: number): string[] };
    let captured: WidgetFactory | undefined;
    const calls: unknown[] = [];
    const ctx = {
      cwd: root,
      config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } },
      ui: { setWidget(_key: string, value: unknown) { calls.push(value); if (typeof value === "function") captured = value as WidgetFactory; } },
    };
    const handlers: Record<string, Function> = {};
    await extension({ registerTool: () => undefined, registerCommand: () => undefined, on: (n: string, h: Function) => { handlers[n] = h; } } as never);
    await handlers.session_start?.({}, ctx);
    assert.equal(clock.subscriberCount(), 1);
    assert.ok(tickTimer, "render-clock should own the single timer");
    assert.equal(calls.length, 0, "terminal-only history must not mount the persistent footer");

    const runningDir = path.join(cfg.dataDir, "bg_running");
    mkdirSync(runningDir, { recursive: true });
    registry.upsert({ schemaVersion: 1, taskId: "bg_running", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(runningDir, "output.log"), metadataPath: path.join(runningDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.length, 1);
    assert.ok(captured, "expected widget factory to mount for active work");

    let renderRequests = 0;
    const component = captured!({ requestRender() { renderRequests += 1; } });
    assert.match(component.render(80).join("\n"), /1 running/);
    assert.doesNotMatch(component.render(80).join("\n"), /failed|timed out|orphaned/);
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.length, 1, "unchanged clock poll must not remount");
    assert.equal(renderRequests, 0, "unchanged clock poll must not request render");

    const timeoutDir = path.join(cfg.dataDir, "bg_timeout");
    mkdirSync(timeoutDir, { recursive: true });
    registry.upsert({ schemaVersion: 1, taskId: "bg_timeout", command: "sleep 1", cwd: root, status: "timed_out", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, outputPath: path.join(timeoutDir, "output.log"), metadataPath: path.join(timeoutDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.length, 1, "terminal metadata must not remount the active-work footer");
    assert.equal(renderRequests, 0, "terminal metadata must not request footer render");

    const blockedDir = path.join(cfg.dataDir, "bg_blocked");
    mkdirSync(blockedDir, { recursive: true });
    registry.upsert({ schemaVersion: 1, taskId: "bg_blocked", command: "cat", cwd: root, status: "blocked", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(blockedDir, "output.log"), metadataPath: path.join(blockedDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.length, 1, "changed active counts update mounted component instead of remounting");
    assert.equal(renderRequests, 1, "changed active counts request render");
    assert.match(component.render(80).join("\n"), /1 running/);
    assert.match(component.render(80).join("\n"), /1 blocked/);

    registry.upsert({ ...registry.get("bg_running")!, status: "exited", endedAt: now });
    registry.upsert({ ...registry.get("bg_blocked")!, status: "failed", endedAt: now, exitCode: 1 });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.length, 2, "zero active counts clear once");
    assert.equal(calls[1], undefined);
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.length, 2, "repeated zero active counts do not clear again");

    await handlers.session_shutdown?.({}, ctx);
    assert.equal(clock.subscriberCount(), 0);
  } finally {
    if (old === undefined) delete process.env.PI_BACKGROUND_BASH_ENABLED; else process.env.PI_BACKGROUND_BASH_ENABLED = old;
    __resetRenderClockForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test("background bash widget dispose during clear keeps clock alive and later remounts", async () => {
  let nowMs = 0;
  const clock = __resetRenderClockForTest({
    now: () => nowMs,
    setInterval: () => ({}),
    clearInterval: () => undefined,
  });
  const old = process.env.PI_BACKGROUND_BASH_ENABLED;
  process.env.PI_BACKGROUND_BASH_ENABLED = "1";
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();

    type WidgetComponent = { dispose?: () => void; render(width: number): string[]; invalidate(): void };
    type WidgetFactory = (tui: unknown) => WidgetComponent;
    let mountedComponent: WidgetComponent | undefined;
    let factoryMounts = 0;
    const calls: unknown[] = [];
    const ctx = {
      cwd: root,
      config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } },
      ui: {
        setWidget(_key: string, value: unknown) {
          calls.push(value);
          if (value === undefined) {
            const previous = mountedComponent;
            mountedComponent = undefined;
            previous?.dispose?.();
          } else if (typeof value === "function") {
            factoryMounts += 1;
            mountedComponent = (value as WidgetFactory)({ requestRender() {} });
          }
        },
      },
    };
    const handlers: Record<string, Function> = {};
    await extension({ registerTool: () => undefined, registerCommand: () => undefined, on: (n: string, h: Function) => { handlers[n] = h; } } as never);
    await handlers.session_start?.({}, ctx);
    assert.equal(clock.subscriberCount(), 1);
    assert.equal(factoryMounts, 0, "terminal/orphaned history must not mount the footer at session start");

    const initialDir = path.join(cfg.dataDir, "bg_initial");
    mkdirSync(initialDir, { recursive: true });
    registry.upsert({ schemaVersion: 1, taskId: "bg_initial", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(initialDir, "output.log"), metadataPath: path.join(initialDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(factoryMounts, 1, "clock tick should mount for newly active work");

    registry.upsert({ ...registry.get("bg_initial")!, status: "exited", endedAt: now, exitCode: 0 });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(calls.at(-1), undefined, "zero active counts should clear the mounted widget");
    assert.equal(clock.subscriberCount(), 1, "component disposal during clear must not unsubscribe session clock");

    const runningDir = path.join(cfg.dataDir, "bg_running");
    mkdirSync(runningDir, { recursive: true });
    registry.upsert({ schemaVersion: 1, taskId: "bg_running", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(runningDir, "output.log"), metadataPath: path.join(runningDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    nowMs += 1000;
    clock.tick("manual");
    assert.equal(factoryMounts, 2, "later clock tick should remount for new running task");
    assert.match(mountedComponent?.render(40).join("\n") ?? "", /1 running/);

    await handlers.session_shutdown?.({}, ctx);
    assert.equal(clock.subscriberCount(), 0);
  } finally {
    if (old === undefined) delete process.env.PI_BACKGROUND_BASH_ENABLED; else process.env.PI_BACKGROUND_BASH_ENABLED = old;
    __resetRenderClockForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test("background task tools invoke immediate widget refresh callbacks", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    let refreshes = 0;
    const tools = buildBackgroundBashTools(undefined, () => { refreshes += 1; });
    const bash = tools[0];
    const stop = tools.find((t) => t.name === "background_task_stop")!;
    const ctx = { cwd: root, config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } } };

    const started = await bash.execute("id", { command: "sleep 10", run_in_background: true }, undefined, undefined, ctx) as { details: { task: BackgroundTaskRecord } };
    assert.equal(refreshes, 1, "starting a background task should refresh immediately");
    await stop.execute("id", { taskId: started.details.task.taskId, killAfterMs: 1000 }, undefined, undefined, ctx);
    assert.equal(refreshes, 2, "stopping a background task should refresh immediately");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background_task_list self-heals before refreshing widget", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const registry = new TaskRegistry(cfg.dataDir);
    const now = new Date().toISOString();
    registry.upsert({ schemaVersion: 1, taskId: "bg_stale", command: "sleep 10", cwd: root, status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(root, "out.log"), metadataPath: path.join(root, "meta.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: false });
    let refreshes = 0;
    const list = buildBackgroundBashTools(undefined, () => { refreshes += 1; }).find((t) => t.name === "background_task_list")!;
    const result = await list.execute("id", {}, undefined, undefined, { cwd: root, config: { backgroundBash: { enabled: true, dataDir: cfg.dataDir } } }) as { details: { tasks: BackgroundTaskRecord[] } };
    assert.equal(refreshes, 1);
    assert.equal(result.details.tasks[0]?.status, "orphaned");
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

test("wake opt-in sends one bounded accepted completion message", async () => {
  const root = await tmp();
  try {
    const sent: Array<{ message: BackgroundBashWakeMessage; options: unknown }> = [];
    const tools = buildBackgroundBashTools({ sendMessage: (message: unknown, options: unknown) => sent.push({ message: message as BackgroundBashWakeMessage, options }) });
    const bash = tools[0];
    const ctx = { cwd: root, config: { backgroundBash: { enabled: true, dataDir: path.join(root, "data") } }, sessionManager: { getSessionId: () => "s1", getSessionFile: () => path.join(root, "session.json") } };
    const res = await bash.execute("id", { command: "printf 'hello <wake> & done'", run_in_background: true, wake_on_completion: true }, undefined, undefined, ctx);
    const task = (res.details as { task: BackgroundTaskRecord }).task;
    await waitFor(() => new TaskRegistry(path.join(root, "data")).get(task.taskId)?.modelWakeState === "accepted");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(sent[0]!.message.customType, "background-bash-notification");
    assert.match(sent[0]!.message.content, /NOT USER INPUT|not_user_input/);
    assert.match(sent[0]!.message.content, /hello &lt;wake&gt; &amp; done/);
    const rec = new TaskRegistry(path.join(root, "data")).get(task.taskId)!;
    assert.equal(rec.wakePolicyVersion, 1);
    assert.equal(rec.wakePolicySource, "tool_arg_v1");
    assert.equal(rec.modelWakeDeliverySemantics, "accepted");
    assert.ok(rec.modelWakeAcceptedAt);
    assert.equal(rec.modelWakeCanonicalTerminal?.status, "exited");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tool wake notifier awaits async sendMessage resolution and records async rejection", async () => {
  const root = await tmp();
  try {
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { resolveSend = resolve; });
    const sent: unknown[] = [];
    const tools = buildBackgroundBashTools({ sendMessage: async (message: unknown) => { sent.push(message); await sendGate; } });
    const ctx = { cwd: root, config: { backgroundBash: { enabled: true, dataDir: path.join(root, "data") } }, sessionManager: { getSessionId: () => "s1" } };
    const res = await tools[0].execute("id", { command: "true", run_in_background: true, wake_on_completion: true }, undefined, undefined, ctx);
    const task = (res.details as { task: BackgroundTaskRecord }).task;
    await waitFor(() => new TaskRegistry(path.join(root, "data")).get(task.taskId)?.modelWakeState === "send_attempted");
    assert.equal(sent.length, 1);
    assert.equal(new TaskRegistry(path.join(root, "data")).get(task.taskId)?.modelWakeAcceptedAt, undefined);
    resolveSend();
    await waitFor(() => new TaskRegistry(path.join(root, "data")).get(task.taskId)?.modelWakeState === "accepted");

    const rejectingTools = buildBackgroundBashTools({ sendMessage: async () => { await new Promise(r => setTimeout(r, 10)); throw new Error("async send rejected"); } });
    const rejectCtx = { cwd: root, config: { backgroundBash: { enabled: true, dataDir: path.join(root, "data2") } }, sessionManager: { getSessionId: () => "s1" } };
    const rejectRes = await rejectingTools[0].execute("id", { command: "true", run_in_background: true, wake_on_completion: true }, undefined, undefined, rejectCtx);
    const rejectTask = (rejectRes.details as { task: BackgroundTaskRecord }).task;
    await waitFor(() => new TaskRegistry(path.join(root, "data2")).get(rejectTask.taskId)?.modelWakeState === "send_failed");
    assert.equal(new TaskRegistry(path.join(root, "data2")).get(rejectTask.taskId)?.modelWakeErrorCode, "SEND_FAILED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wake opt-in reports failure, timeout, send rejection, and duplicate suppression", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data"), defaultMaxRuntimeMs: 200 }, root);
    const sends: BackgroundBashWakeMessage[] = [];
    const notifier = { ownerSessionId: "s1", ownerRuntimeId: runtimeId, currentSessionId: () => "s1", currentSessionFile: () => undefined, send: async (m: BackgroundBashWakeMessage) => { sends.push(m); return { acceptedAt: new Date().toISOString(), deliverySemantics: "accepted" as const }; } };
    const runner = new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg);
    const fail = await runner.start({ command: "exit 7", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: notifier });
    const timeout = await runner.start({ command: "sleep 2", cwd: root, timeout: 100, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: notifier });
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(fail.taskId)?.modelWakeState === "accepted");
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(timeout.taskId)?.modelWakeState === "accepted");
    assert.equal(new TaskRegistry(cfg.dataDir).get(fail.taskId)?.modelWakeCanonicalTerminal?.status, "failed");
    assert.match(sends.find(m => m.details.taskId === fail.taskId)!.content, /exit code 7/);
    assert.equal(new TaskRegistry(cfg.dataDir).get(timeout.taskId)?.modelWakeCanonicalTerminal?.status, "timed_out");
    assert.match(sends.find(m => m.details.taskId === timeout.taskId)!.content, /timed out/);

    const rejecting = { ...notifier, send: async () => { throw new Error("boom"); } };
    const rejected = await runner.start({ command: "true", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: rejecting });
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(rejected.taskId)?.modelWakeState === "send_failed");
    assert.equal(new TaskRegistry(cfg.dataDir).get(rejected.taskId)?.modelWakeErrorCode, "SEND_FAILED");

    const staleThrowing = { ...notifier, send: async () => { throw new Error("stale extension context for replaced session"); } };
    const stale = await runner.start({ command: "true", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: staleThrowing });
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(stale.taskId)?.modelWakeState === "routing_failed");
    assert.equal(new TaskRegistry(cfg.dataDir).get(stale.taskId)?.modelWakeErrorCode, "STALE_SESSION_HANDLE");
    assert.equal(sends.filter(m => m.details.taskId === fail.taskId).length, 1, "duplicate finalizers must not resend claimed task");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wake disabled, legacy config/metadata, missing notifier, stale and cross-session routing stay quiet", async () => {
  const root = await tmp();
  try {
    const sent: unknown[] = [];
    const tools = buildBackgroundBashTools({ sendMessage: (m: unknown) => sent.push(m) });
    const ctx = { cwd: root, config: { backgroundBash: { enabled: true, dataDir: path.join(root, "data"), notifyModelOnCompletion: true } }, sessionManager: { getSessionId: () => "s1" } };
    const quiet = await tools[0].execute("id", { command: "true", run_in_background: true }, undefined, undefined, ctx);
    const quietTask = (quiet.details as { task: BackgroundTaskRecord }).task;
    await waitFor(() => new TaskRegistry(path.join(root, "data")).get(quietTask.taskId)?.status === "exited");
    assert.equal(sent.length, 0);
    assert.equal(new TaskRegistry(path.join(root, "data")).get(quietTask.taskId)?.wakePolicyVersion, undefined);

    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const noNotifier = await new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).start({ command: "true", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1" });
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(noNotifier.taskId)?.modelWakeState === "routing_failed");
    assert.equal(new TaskRegistry(cfg.dataDir).get(noNotifier.taskId)?.modelWakeErrorCode, "NO_NOTIFIER");

    const staleNotifier = { ownerSessionId: "s1", ownerRuntimeId: runtimeId, currentSessionId: () => "s2", currentSessionFile: () => undefined, send: async () => { throw new Error("must not send"); } };
    const stale = await new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).start({ command: "true", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: staleNotifier });
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(stale.taskId)?.modelWakeState === "routing_failed");
    assert.equal(new TaskRegistry(cfg.dataDir).get(stale.taskId)?.modelWakeErrorCode, "SESSION_MISMATCH");

    const now = new Date().toISOString();
    const legacyDir = path.join(cfg.dataDir, "legacy"); mkdirSync(legacyDir, { recursive: true });
    new TaskRegistry(cfg.dataDir).upsert({ schemaVersion: 1, taskId: "legacy", command: "true", cwd: root, ownerSessionId: "s1", status: "exited", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, outputPath: path.join(legacyDir, "output.log"), metadataPath: path.join(legacyDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: true });
    writeFileSync(path.join(legacyDir, "output.log"), "legacy");
    assert.equal(buildWakeMessage(new TaskRegistry(cfg.dataDir).get("legacy")!).details.taskId, "legacy");
    assert.equal(new TaskRegistry(cfg.dataDir).get("legacy")?.modelWakeState, undefined, "legacy true without v1 marker is not auto-claimed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown stop suppresses wake for wake-enabled owned task", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const sent: BackgroundBashWakeMessage[] = [];
    const notifier = { ownerSessionId: "s1", ownerRuntimeId: runtimeId, currentSessionId: () => "s1", currentSessionFile: () => undefined, send: async (m: BackgroundBashWakeMessage) => { sent.push(m); return { acceptedAt: new Date().toISOString(), deliverySemantics: "accepted" as const }; } };
    const registry = new TaskRegistry(cfg.dataDir);
    const runner = new BackgroundRunner(registry, cfg);
    const task = await runner.start({ command: "sleep 10", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: notifier });
    await new Promise(r => setTimeout(r, 100));
    await runner.shutdown("s1");
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(task.taskId)?.modelWakeErrorCode === "SHUTDOWN_SUPPRESSED");
    const rec = new TaskRegistry(cfg.dataDir).get(task.taskId)!;
    assert.equal(sent.length, 0);
    assert.equal(rec.status, "killed");
    assert.equal(rec.stopReason, "shutdown");
    assert.equal(rec.modelWakeState, "routing_failed");
    const log = readFileSync(rec.outputPath, "utf8");
    assert.match(log, /session shutdown; stopping task without model wake/);
    assert.match(log, /model wake suppressed for session shutdown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual stop wake, reload lost wake, timeout validation, and tail escaping bounds", async () => {
  const root = await tmp();
  try {
    const cfg = readConfig({ enabled: true, dataDir: path.join(root, "data") }, root);
    const sent: BackgroundBashWakeMessage[] = [];
    const notifier = { ownerSessionId: "s1", ownerRuntimeId: runtimeId, currentSessionId: () => "s1", currentSessionFile: () => undefined, send: async (m: BackgroundBashWakeMessage) => { sent.push(m); return { acceptedAt: new Date().toISOString(), deliverySemantics: "accepted" as const }; } };
    const runner = new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg);
    const task = await runner.start({ command: "sleep 10", cwd: root, wakeOnCompletion: true, ownerSessionId: "s1", wakeNotifier: notifier });
    await new Promise(r => setTimeout(r, 100));
    await runner.stop(task.taskId, "SIGTERM", 1000);
    await waitFor(() => new TaskRegistry(cfg.dataDir).get(task.taskId)?.modelWakeState === "accepted");
    assert.equal(new TaskRegistry(cfg.dataDir).get(task.taskId)?.modelWakeCanonicalTerminal?.stopReason, "user");
    assert.match(sent[0]!.content, /stopped by request/);

    const runningDir = path.join(cfg.dataDir, "running"); mkdirSync(runningDir, { recursive: true });
    const now = new Date().toISOString();
    new TaskRegistry(cfg.dataDir).upsert({ schemaVersion: 1, taskId: "running", command: "sleep 10", cwd: root, ownerSessionId: "s1", ownerRuntimeId: "old", status: "running", createdAt: now, updatedAt: now, startedAt: now, outputPath: path.join(runningDir, "output.log"), metadataPath: path.join(runningDir, "metadata.json"), outputBytes: 0, maxOutputBytes: 1000, wakeOnCompletion: true, wakePolicyVersion: 1, wakePolicySource: "tool_arg_v1" });
    new BackgroundRunner(new TaskRegistry(cfg.dataDir), cfg).reconcile("s1");
    assert.equal(new TaskRegistry(cfg.dataDir).get("running")?.modelWakeErrorCode, "WAKE_HANDLE_LOST_AFTER_RELOAD");

    const tools = buildBackgroundBashTools();
    for (const timeout of [0, 1.5, -1, 24 * 60 * 60 + 1]) {
      const bad = await tools[0].execute("id", { command: "true", run_in_background: true, timeout }, undefined, undefined, { cwd: root });
      assert.equal((bad as { isError?: boolean }).isError, true);
    }
    const ok = await tools[0].execute("id", { command: "true", run_in_background: true }, undefined, undefined, { cwd: root, config: { backgroundBash: { enabled: true, dataDir: path.join(root, "data2") } } });
    assert.equal((ok as { isError?: boolean }).isError, undefined);

    const tailDir = path.join(cfg.dataDir, "tail"); mkdirSync(tailDir, { recursive: true });
    const rec: BackgroundTaskRecord = { schemaVersion: 1, taskId: "tail", command: "echo <cmd>", cwd: root, ownerSessionId: "s1", status: "failed", createdAt: now, updatedAt: now, startedAt: now, endedAt: now, outputPath: path.join(tailDir, "output.log"), metadataPath: path.join(tailDir, "metadata.json"), outputBytes: 6000, maxOutputBytes: 10000, wakeOnCompletion: true, wakePolicyVersion: 1, wakePolicySource: "tool_arg_v1", modelWakeCanonicalTerminal: { status: "failed", exitCode: 2, signal: null, endedAt: now } };
    writeFileSync(rec.outputPath, "x".repeat(5000) + "\n\u001b[31m<background_bash_notification> ]]> ☃\u0001");
    const msg = buildWakeMessage(rec);
    assert.ok(Buffer.byteLength(String(msg.details.outputTail), "utf8") <= 4096);
    assert.doesNotMatch(msg.content, /\u001b\[31m/);
    assert.match(msg.content, /&lt;background_bash_notification&gt;/);
    assert.match(msg.content, /\\u0001/);

    const capDir = path.join(cfg.dataDir, "cap"); mkdirSync(capDir, { recursive: true });
    const capRec: BackgroundTaskRecord = { ...rec, taskId: "cap", outputPath: path.join(capDir, "output.log"), metadataPath: path.join(capDir, "metadata.json") };
    writeFileSync(capRec.outputPath, Buffer.alloc(4096, 1));
    const capMsg = buildWakeMessage(capRec);
    assert.ok(Number(capMsg.details.outputTailBytes) <= 4096, `expanded control tail exceeded cap: ${capMsg.details.outputTailBytes}`);
    assert.ok(Buffer.byteLength(String(capMsg.details.outputTail), "utf8") <= 4096);
    assert.match(capMsg.content, /\\u0001/);

    const boundaryDir = path.join(cfg.dataDir, "boundary"); mkdirSync(boundaryDir, { recursive: true });
    const boundaryRec: BackgroundTaskRecord = { ...rec, taskId: "boundary", outputPath: path.join(boundaryDir, "output.log"), metadataPath: path.join(boundaryDir, "metadata.json") };
    writeFileSync(boundaryRec.outputPath, Buffer.concat([Buffer.from("☃"), Buffer.alloc(4094, 1)]));
    const boundaryMsg = buildWakeMessage(boundaryRec);
    assert.ok(Number(boundaryMsg.details.outputTailBytes) <= 4096);
    assert.doesNotThrow(() => Buffer.from(String(boundaryMsg.details.outputTail), "utf8").toString("utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

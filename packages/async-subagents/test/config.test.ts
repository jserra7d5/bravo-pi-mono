import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultRunRoot, loadAsyncSubagentsConfig } from "../src/config.js";
import { startSubagent } from "../src/start.js";

test("defaultRunRoot uses harness-owned async subagents home by default", () => {
  const runRoot = defaultRunRoot("/tmp/project", undefined, { HOME: "/tmp/home" } as NodeJS.ProcessEnv);
  assert.match(runRoot, /^\/tmp\/home\/\.async-subagents\/projects\/[^/]+\/runs$/);
});

test("defaultRunRoot respects explicit configured root", () => {
  assert.equal(defaultRunRoot("/tmp/project", "./state/runs"), resolve("./state/runs"));
});

test("defaultRunRoot respects ASYNC_SUBAGENTS_HOME", () => {
  const runRoot = defaultRunRoot("/tmp/project", undefined, { ASYNC_SUBAGENTS_HOME: "/tmp/async-home", HOME: "/tmp/home" } as NodeJS.ProcessEnv);
  assert.match(runRoot, /^\/tmp\/async-home\/projects\/[^/]+\/runs$/);
});

test("loadAsyncSubagentsConfig validates codexAuthBalancer", () => {
  const home = mkdtempSync(join(tmpdir(), "async-config-"));
  const stateDir = join(home, "balancer");
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, provider: "bravo", stateDir, mode: "process-env", timeoutMs: 1000, failClosed: true, onlyForProviders: ["openai-codex"] } }));
  const config = loadAsyncSubagentsConfig({ env: { ASYNC_SUBAGENTS_HOME: home, HOME: home } as NodeJS.ProcessEnv });
  assert.equal(config.codexAuthBalancer.enabled, true);
  assert.equal(config.codexAuthBalancer.stateDir, stateDir);
});

test("loadAsyncSubagentsConfig rejects unknown codexAuthBalancer keys", () => {
  const home = mkdtempSync(join(tmpdir(), "async-config-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, unexpected: true } }));
  assert.throws(() => loadAsyncSubagentsConfig({ env: { ASYNC_SUBAGENTS_HOME: home, HOME: home } as NodeJS.ProcessEnv }), /unknown key unexpected/);
});

test("loadAsyncSubagentsConfig requires defaultMaxRunSeconds to be a positive integer JSON number", () => {
  for (const value of ["1", true, 0, -1, 1.5, null]) {
    const home = mkdtempSync(join(tmpdir(), "async-config-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, defaultMaxRunSeconds: value }));
    assert.throws(() => loadAsyncSubagentsConfig({ env: { ASYNC_SUBAGENTS_HOME: home, HOME: home } as NodeJS.ProcessEnv }), /defaultMaxRunSeconds must be a positive integer JSON number/);
  }
});

function authWorkspace(mode: "success" | "conflict" | "prepare-fail", failClosed = true) {
  const root = mkdtempSync(join(tmpdir(), "async-balancer-"));
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "codex.md"), `---
description: Codex.
tools: []
mode: oneshot
model: openai-codex/test
---
Codex agent.
`, "utf8");
  const stateDir = join(root, "balancer-state");
  if (mode !== "prepare-fail") {
    mkdirSync(join(stateDir, "accounts", "slot-a"), { recursive: true });
    writeFileSync(join(stateDir, "accounts", "slot-a", "auth.json"), JSON.stringify({ access_token: "abcdefghijklmnopqrstuvwxyz123456" }) + "\n");
  }
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, provider: "bravo", stateDir, timeoutMs: 1000, failClosed } }));
  return { root, runRoot: join(root, ".runs"), stateDir };
}

test("codex auth balancer merges prepare env and cleans up after sync-back success", async () => {
  const w = authWorkspace("success");
  const started = await startSubagent({ agent: "codex", task: "ok", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  assert.equal(started.state, "completed");
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(typeof launch.env.CODEX_HOME, "string");
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer")), false);
});

test("codex auth balancer fail-closed fails and warn fallback continues", async () => {
  const closed = authWorkspace("prepare-fail", true);
  const failed = await startSubagent({ agent: "codex", task: "fail", cwd: closed.root, runRoot: closed.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: closed.root }, fake: { mode: "immediate" } });
  assert.equal(failed.state, "failed");
  const open = authWorkspace("prepare-fail", false);
  const continued = await startSubagent({ agent: "codex", task: "warn", cwd: open.root, runRoot: open.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: open.root }, fake: { mode: "immediate" } });
  assert.equal(continued.state, "completed");
});

test("codex auth balancer retains isolated dir with marker on sync-back conflict", async () => {
  const w = authWorkspace("conflict");
  setTimeout(() => {
    writeFileSync(join(w.stateDir, "accounts", "slot-a", "auth.json"), JSON.stringify({ access_token: "changed-concurrently" }) + "\n");
  }, 25);
  const started = await startSubagent({ agent: "codex", task: "conflict", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate", delayMs: 200 } });
  const dir = join(started.runDir, "auth", "codex-balancer");
  assert.equal(existsSync(dir), true);
  const marker = JSON.parse(readFileSync(join(dir, "ASYNC_SUBAGENTS_RETAINED.json"), "utf8"));
  assert.equal(marker.classification, "conflict");
  assert.equal(marker.retainUntil, "manual-cleanup-after-sync-back");
});

test("preflight failure after prepare-launch syncs back and cleans isolated auth dir before failing", async () => {
  const w = authWorkspace("success");
  const pi = join(w.root, "pi-fake.cjs");
  writeFileSync(pi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  chmodSync(pi, 0o755);
  const started = await startSubagent({ agent: "codex", task: "preflight", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, piBin: pi });
  assert.equal(started.state, "failed");
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer")), false);
});

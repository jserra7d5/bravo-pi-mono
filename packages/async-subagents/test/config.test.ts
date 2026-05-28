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
  const bin = join(home, "authswap");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, provider: "authswap", authswapPath: bin, mode: "process-env", timeoutMs: 1000, failClosed: true, onlyForProviders: ["openai-codex"] } }));
  const config = loadAsyncSubagentsConfig({ env: { ASYNC_SUBAGENTS_HOME: home, HOME: home } as NodeJS.ProcessEnv });
  assert.equal(config.codexAuthBalancer.enabled, true);
  assert.equal(config.codexAuthBalancer.authswapPath, bin);
});

test("loadAsyncSubagentsConfig rejects unknown codexAuthBalancer keys", () => {
  const home = mkdtempSync(join(tmpdir(), "async-config-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, unexpected: true } }));
  assert.throws(() => loadAsyncSubagentsConfig({ env: { ASYNC_SUBAGENTS_HOME: home, HOME: home } as NodeJS.ProcessEnv }), /unknown key unexpected/);
});

function authWorkspace(mode: "success" | "conflict" | "timeout" | "prepare-fail", failClosed = true) {
  const root = mkdtempSync(join(tmpdir(), "async-authswap-"));
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "codex.md"), `---
description: Codex.
tools: []
mode: oneshot
model: openai-codex/test
---
Codex agent.
`, "utf8");
  const authswap = join(root, "authswap.cjs");
  writeFileSync(authswap, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const mode = ${JSON.stringify(mode)};
if (process.argv.includes("--version")) {
  console.log(JSON.stringify({ schema_version: 1, name: "authswap", version: "0.4.0", capabilities: { codex_usage_json: 1, codex_refresh_usage_json: 1, codex_prepare_launch_json: 1, codex_sync_back_json: 1 } }));
  process.exit(0);
}
const isolated = process.argv[process.argv.indexOf("--isolated-dir") + 1];
if (process.argv.includes("--prepare-launch")) {
  if (mode === "prepare-fail") { console.error("prepare failed"); process.exit(2); }
  const pi = path.join(isolated, "pi");
  const codex = path.join(isolated, "codex");
  fs.mkdirSync(pi, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(pi, "auth.json"), JSON.stringify({}) + "\\n");
  fs.writeFileSync(path.join(codex, "auth.json"), JSON.stringify({}) + "\\n");
  console.log(JSON.stringify({ schema_version: 1, selected_slot: "slot-a", reason: "test", status: "ok", isolated_dir: isolated, pi_agent_dir: pi, codex_home: codex, env: { PI_CODING_AGENT_DIR: pi, CODEX_HOME: codex, EXTRA_BALANCER_ENV: "merged" }, metadata: { metadata_path: path.join(isolated, "meta.json"), expected_generation: "gen", auth_hash: "hash" } }));
  process.exit(0);
}
if (process.argv.includes("--sync-back")) {
  fs.appendFileSync(path.join(${JSON.stringify(root)}, "sync-back-attempts"), "1\\n");
  if (mode === "timeout") setTimeout(() => {}, 5000);
  else if (mode === "conflict") { console.error("generation conflict token abcdefghijklmnopqrstuvwxyz123456"); process.exit(65); }
  else { console.log(JSON.stringify({ ok: true })); process.exit(0); }
}
`, "utf8");
  chmodSync(authswap, 0o755);
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, authswapPath: authswap, timeoutMs: 1000, failClosed } }));
  return { root, authswap, runRoot: join(root, ".runs") };
}

test("codex auth balancer merges prepare env and cleans up after sync-back success", async () => {
  const w = authWorkspace("success");
  const started = await startSubagent({ agent: "codex", task: "ok", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  assert.equal(started.state, "completed");
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(launch.env.EXTRA_BALANCER_ENV, "merged");
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
  const started = await startSubagent({ agent: "codex", task: "conflict", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  const dir = join(started.runDir, "auth", "codex-balancer");
  assert.equal(existsSync(dir), true);
  const marker = JSON.parse(readFileSync(join(dir, "ASYNC_SUBAGENTS_RETAINED.json"), "utf8"));
  assert.equal(marker.classification, "conflict");
  assert.equal(readFileSync(join(w.root, "sync-back-attempts"), "utf8").trim().split("\n").length, 1);
  assert.equal(marker.retainUntil, "manual-cleanup-after-sync-back");
  assert.match(marker.message, /<redacted>/);
});

test("codex auth balancer retains isolated dir with marker on sync-back timeout", async () => {
  const w = authWorkspace("timeout");
  const started = await startSubagent({ agent: "codex", task: "timeout", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  const marker = JSON.parse(readFileSync(join(started.runDir, "auth", "codex-balancer", "ASYNC_SUBAGENTS_RETAINED.json"), "utf8"));
  assert.equal(marker.classification, "timeout");
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

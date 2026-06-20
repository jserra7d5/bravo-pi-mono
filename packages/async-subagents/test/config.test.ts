import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRunRoot, loadAsyncSubagentsConfig } from "../src/config.js";
import { balancedModelId, startSubagent } from "../src/start.js";
import { codexBalancerSyncBackAndCleanup } from "../src/supervisor.js";

// Resolve the codex-auth-balancer provider extension the same robust way start.ts
// does, so reachability assertions compare against the real on-disk module path.
function expectedBalancedProviderExtensionPath(): string {
  return fileURLToPath(import.meta.resolve("@bravo/codex-auth-balancer/extensions/pi"));
}

// Extract the -e / --extension values from a recorded child pi command's args.
function extensionArgsOf(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-e" || args[i] === "--extension") && args[i + 1]) { values.push(args[i + 1]); i++; }
  }
  return values;
}

// Extract the --model value from a recorded child pi command's args (the LAUNCHED model).
function launchedModelOf(args: string[]): string | undefined {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

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

function authWorkspace(mode: "success" | "conflict" | "prepare-fail", failClosed = true, opts: { copiedCredentialsLegacy?: boolean } = {}) {
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
  const balancer: Record<string, unknown> = { enabled: true, provider: "bravo", stateDir, timeoutMs: 1000, failClosed };
  if (opts.copiedCredentialsLegacy) balancer.copiedCredentialsLegacy = true;
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: balancer }));
  return { root, runRoot: join(root, ".runs"), stateDir };
}

// ── Pure remap helper ────────────────────────────────────────────────────────

test("balancedModelId remaps codex providers and leaves others unchanged", () => {
  assert.equal(balancedModelId("openai-codex/gpt-5-codex"), "bravo-codex-balanced/gpt-5-codex");
  assert.equal(balancedModelId("openai-codex-responses/o3"), "bravo-codex-balanced/o3");
  assert.equal(balancedModelId("bravo-codex-balanced/gpt-5-codex"), "bravo-codex-balanced/gpt-5-codex");
  assert.equal(balancedModelId("anthropic/claude-opus"), "anthropic/claude-opus");
  assert.equal(balancedModelId("gpt-5"), "gpt-5");
  assert.equal(balancedModelId(undefined), undefined);
});

// ── Default (lease) path: openai-codex/* launches as bravo-codex-balanced/* ───

// (Test 6) An openai-codex/* subagent launches as bravo-codex-balanced/* with NO
// copied-credential isolated dir; the balanced provider state dir is propagated as
// env and the supervisor receives no copied-credential handle.
test("openai-codex subagent launches via the balanced lease path (no copied creds)", async () => {
  const w = authWorkspace("success");
  const started = await startSubagent({ agent: "codex", task: "ok", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  assert.equal(started.state, "completed");
  // User-facing provenance preserved: the originally requested model is recorded.
  assert.equal(started.model, "openai-codex/test");
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.equal(launch.model, "openai-codex/test");
  // The LAUNCHED/exec model is the remapped balanced provider model.
  assert.equal(launch.launchedModel, "bravo-codex-balanced/test");
  assert.equal(launchedModelOf(launch.args), "bravo-codex-balanced/test");
  // No copied-credential isolated dir was ever created under the run dir.
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer")), false);
  // The copy path injects CODEX_HOME; the lease path must not.
  assert.equal(launch.env.CODEX_HOME, undefined);
  // Balanced provider routing env is present in launch.json (redacted there because
  // the key matches AUTH); the unredacted value lives in supervisor-input.json.
  assert.equal(launch.env.CODEX_AUTH_BALANCER_HOME, "<redacted>");
  const supervisorInput = JSON.parse(readFileSync(join(started.runDir, "logs", "supervisor-input.json"), "utf8"));
  assert.equal(supervisorInput.command.env.CODEX_AUTH_BALANCER_HOME, w.stateDir);
  // No copied-credential handle is handed to the supervisor.
  assert.equal(supervisorInput.codexAuthBalancer, undefined);
  // The balancer lease ledger is untouched: no sqlite/leases written under stateDir.
  assert.equal(existsSync(join(w.stateDir, "balancer.sqlite3")), false);
  assert.equal(existsSync(join(w.stateDir, "leases")), false);
});

// (Test 9) Extension reachability: the codex-auth-balancer provider extension is
// on the child pi -e list for a balanced launch (it cannot resolve otherwise under
// --no-extensions).
test("balanced launch puts the codex-auth-balancer provider extension on the child -e list", async () => {
  const w = authWorkspace("success");
  const started = await startSubagent({ agent: "codex", task: "ext", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  assert.equal(started.state, "completed");
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  const extensions = extensionArgsOf(launch.args);
  const expected = expectedBalancedProviderExtensionPath();
  assert.equal(existsSync(expected), true);
  assert.ok(extensions.includes(expected), `expected ${expected} in child -e list, got ${JSON.stringify(extensions)}`);
  // It is also recorded in launch metadata extensions for auditability.
  assert.ok((launch.extensions as string[]).includes(expected));
});

// (Test 7) prepareCodexBalancer is dormant for a balanced/remapped model: no copy,
// no isolated dir, and no reservation row written to the balancer sqlite under stateDir.
test("bravo-codex-balanced provider does no copy and writes no reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "async-balanced-provider-"));
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "balanced.md"), `---
description: Balanced.
tools: []
mode: oneshot
model: bravo-codex-balanced/gpt-5-codex
---
Balanced agent.
`, "utf8");
  const stateDir = join(root, "balancer-state");
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, codexAuthBalancer: { enabled: true, provider: "bravo", stateDir, timeoutMs: 1000, failClosed: true, onlyForProviders: ["openai-codex", "bravo-codex-balanced"] } }));
  const started = await startSubagent({ agent: "balanced", task: "ok", cwd: root, runRoot: join(root, ".runs"), parentRunId: "root_balanced", env: { ASYNC_SUBAGENTS_HOME: root }, fake: { mode: "immediate" } });
  assert.equal(started.state, "completed");
  const supervisorInput = JSON.parse(readFileSync(join(started.runDir, "logs", "supervisor-input.json"), "utf8"));
  assert.equal(supervisorInput.command.env.CODEX_AUTH_BALANCER_HOME, stateDir);
  assert.equal(supervisorInput.codexAuthBalancer, undefined);
  // No isolated copy dir, and no reservation/lease ledger written under stateDir.
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer")), false);
  assert.equal(existsSync(join(stateDir, "balancer.sqlite3")), false);
  assert.equal(existsSync(join(stateDir, "leases")), false);
  // Provider extension reachable on the child -e list for this explicitly-balanced agent too.
  const launch = JSON.parse(readFileSync(join(started.runDir, "logs", "launch.json"), "utf8"));
  assert.ok(extensionArgsOf(launch.args).includes(expectedBalancedProviderExtensionPath()));
});

// (Test 8a) Supervisor cleanup is a no-op when codexAuthBalancer is undefined.
test("codexBalancerSyncBackAndCleanup is a no-op without a balancer handle", async () => {
  const probe = mkdtempSync(join(tmpdir(), "async-noop-probe-"));
  const before = existsSync(probe) ? readdirNames(probe) : [];
  await assert.doesNotReject(codexBalancerSyncBackAndCleanup({ codexAuthBalancer: undefined }));
  const after = readdirNames(probe);
  assert.deepEqual(after, before, "no filesystem writes expected from a no-op cleanup");
});

// (Test 8b) A full immediate run via the lease path leaves no retention marker and
// no copied-credential isolated dir behind.
test("immediate balanced run leaves no retention marker and no isolated auth dir", async () => {
  const w = authWorkspace("success");
  const started = await startSubagent({ agent: "codex", task: "ok", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate" } });
  assert.equal(started.state, "completed");
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer")), false);
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer", "ASYNC_SUBAGENTS_RETAINED.json")), false);
});

// (Test 10, repointed) Preflight failure no longer leaves a copied-credential dir,
// because the balanced lease path never creates one.
test("preflight failure on a balanced launch leaves no isolated auth dir", async () => {
  const w = authWorkspace("success");
  const pi = join(w.root, "pi-fake.cjs");
  writeFileSync(pi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  chmodSync(pi, 0o755);
  const started = await startSubagent({ agent: "codex", task: "preflight", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, piBin: pi });
  assert.equal(started.state, "failed");
  assert.equal(existsSync(join(started.runDir, "auth", "codex-balancer")), false);
});

// ── Legacy opt-in (dormant copied-credential infra stays covered) ─────────────

// (Test 10, kept legacy) With copiedCredentialsLegacy:true the copy branch is
// exercised end to end: prepare-launch copies an isolated child, sync-back detects
// the concurrent conflict, and the isolated dir is retained with a marker.
test("legacy copied-credential path retains isolated dir with marker on conflict", async () => {
  const w = authWorkspace("conflict", true, { copiedCredentialsLegacy: true });
  let conflictWriter: ReturnType<typeof setInterval> | undefined;
  const startConflictWriter = setTimeout(() => {
    conflictWriter = setInterval(() => {
      writeFileSync(join(w.stateDir, "accounts", "slot-a", "auth.json"), JSON.stringify({ access_token: "changed-concurrently" }) + "\n");
    }, 10);
  }, 150);
  const started = await startSubagent({ agent: "codex", task: "conflict", cwd: w.root, runRoot: w.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: w.root }, fake: { mode: "immediate", delayMs: 500 } });
  clearTimeout(startConflictWriter);
  if (conflictWriter) clearInterval(conflictWriter);
  // The copy path runs even though the requested model is openai-codex/*: the legacy
  // flag overrides the remap short-circuit. The isolated dir proves the copy happened.
  const dir = join(started.runDir, "auth", "codex-balancer");
  assert.equal(existsSync(dir), true);
  const marker = JSON.parse(readFileSync(join(dir, "ASYNC_SUBAGENTS_RETAINED.json"), "utf8"));
  assert.equal(marker.classification, "conflict");
  assert.equal(marker.retainUntil, "manual-cleanup-after-sync-back");
});

// (Test 10, kept legacy) fail-closed still aborts when the legacy copy path's
// prepare-launch fails, and warn-mode continues.
test("legacy copied-credential fail-closed aborts; warn fallback continues", async () => {
  const closed = authWorkspace("prepare-fail", true, { copiedCredentialsLegacy: true });
  const failed = await startSubagent({ agent: "codex", task: "fail", cwd: closed.root, runRoot: closed.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: closed.root }, fake: { mode: "immediate" } });
  assert.equal(failed.state, "failed");
  const open = authWorkspace("prepare-fail", false, { copiedCredentialsLegacy: true });
  const continued = await startSubagent({ agent: "codex", task: "warn", cwd: open.root, runRoot: open.runRoot, parentRunId: "root_auth", env: { ASYNC_SUBAGENTS_HOME: open.root }, fake: { mode: "immediate" } });
  assert.equal(continued.state, "completed");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { archiveRuns } from "../src/archive.js";
import { RunStore } from "../src/runStore.js";
import { createInitialStatus } from "../src/status.js";
import { probeProcessIdentity } from "../src/runLock.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-archive-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "package.json"), "{}\n");
  const env = { ...process.env, ASYNC_SUBAGENTS_HOME: home };
  const store = new RunStore({ cwd, env });
  return { root, home, cwd, env, store };
}

function addRun(store: RunStore, cwd: string, state: "completed" | "running", updatedAt: string, runId?: string) {
  const created = store.createRunDirectory({ cwd, parentRunId: "root_test", runId });
  store.writeStatus({
    ...createInitialStatus({ runId: created.runId, parentRunId: "root_test", agentName: "scout", agentSource: "builtin", definitionPath: "/scout.md", mode: "oneshot", cwd, state }),
    updatedAt,
  });
  writeFileSync(created.paths.piSessionPath, "session bytes\n");
  return created;
}

const old = "2026-01-01T00:00:00.000Z";
const nowMs = Date.parse("2026-01-10T00:00:00.000Z");

test("archive round-trips a real run and compacts indexes while preserving live cache resolution", async () => {
  const w = fixture();
  const archived = addRun(w.store, w.cwd, "completed", old);
  const statusBytes = readFileSync(archived.paths.statusPath);
  const sessionBytes = readFileSync(archived.paths.piSessionPath);
  const live = addRun(w.store, w.cwd, "running", old);
  const identity = probeProcessIdentity(process.pid).identity;
  assert.ok(identity);
  w.store.writeStatus({ ...w.store.readStatus(live.runId), supervisorPid: process.pid, supervisorHost: hostname(), supervisorStartedAtToken: identity, updatedAt: old });
  assert.equal(w.store.resolveRunDir(live.runId), live.paths.runDir); // warm cache

  const result = await archiveRuns(w.store, { olderThanDays: 7, nowMs });
  assert.deepEqual(result.archived, [archived.runId]);
  assert.ok(result.skipped.some((entry) => entry.runId === live.runId && entry.reason === "active"));
  assert.equal(existsSync(archived.paths.runDir), false);
  assert.equal(w.store.resolveRunDir(live.runId), live.paths.runDir);
  const compactedProjectIndex = readFileSync(w.store.indexPath(), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { runId: string });
  assert.deepEqual(compactedProjectIndex.map((record) => record.runId), [live.runId]);

  const archivePath = join(w.home, "archive", "2026-01", `${archived.runId}.tar.zst`);
  const extracted = join(w.root, "extracted");
  mkdirSync(extracted);
  const extraction = spawnSync("tar", ["--zstd", "-xf", archivePath, "-C", extracted]);
  assert.equal(extraction.status, 0, extraction.stderr.toString());
  assert.deepEqual(readFileSync(join(extracted, archived.runId, "status.json")), statusBytes);
  assert.deepEqual(readFileSync(join(extracted, archived.runId, "pi-session", "session.jsonl")), sessionBytes);
  const index = JSON.parse(readFileSync(join(w.home, "archive", "archive-index.jsonl"), "utf8").trim());
  assert.equal(index.runId, archived.runId);
  assert.equal(index.agentName, "scout");
});

test("archive preserves runs on tar failure and skips recent and unhandled-wakeup runs", async () => {
  const w = fixture();
  const failed = addRun(w.store, w.cwd, "completed", old);
  const recent = addRun(w.store, w.cwd, "completed", new Date(nowMs - 1000).toISOString());
  const wakeup = addRun(w.store, w.cwd, "completed", old);
  w.store.writeStatus({ ...w.store.readStatus(wakeup.runId), resultReady: true, updatedAt: old });

  const result = await archiveRuns(w.store, { olderThanDays: 7, nowMs, tarCommand: join(w.root, "missing-tar") });
  assert.equal(existsSync(failed.paths.runDir), true);
  assert.ok(result.errors.some((entry) => entry.runId === failed.runId));
  assert.ok(result.skipped.some((entry) => entry.runId === recent.runId && entry.reason === "too-recent"));
  assert.ok(result.skipped.some((entry) => entry.runId === wakeup.runId && entry.reason === "unhandled-wakeup"));
});

test("archive dry-run reports eligible runs while retaining active and unhandled runs", async () => {
  const w = fixture();
  const eligible = addRun(w.store, w.cwd, "completed", old);
  const active = addRun(w.store, w.cwd, "running", old);
  const unhandled = addRun(w.store, w.cwd, "completed", old);
  w.store.writeStatus({ ...w.store.readStatus(unhandled.runId), resultReady: true, updatedAt: old });
  const identity = probeProcessIdentity(process.pid).identity;
  assert.ok(identity);
  w.store.writeStatus({ ...w.store.readStatus(active.runId), supervisorPid: process.pid, supervisorHost: hostname(), supervisorStartedAtToken: identity });

  const result = await archiveRuns(w.store, { olderThanDays: 7, nowMs, dryRun: true });

  assert.deepEqual(result.archived, [eligible.runId]);
  assert.ok(result.skipped.some((entry) => entry.runId === active.runId && entry.reason === "active"));
  assert.ok(result.skipped.some((entry) => entry.runId === unhandled.runId && entry.reason === "unhandled-wakeup"));
  assert.equal(existsSync(eligible.paths.runDir), true);
});

test("archive preserves run when archive destination cannot be created", async () => {
  const w = fixture();
  const candidate = addRun(w.store, w.cwd, "completed", old);
  mkdirSync(w.home, { recursive: true });
  writeFileSync(join(w.home, "archive"), "not a directory");
  const result = await archiveRuns(w.store, { olderThanDays: 7, nowMs });
  assert.equal(existsSync(candidate.paths.runDir), true);
  assert.ok(result.errors.some((entry) => entry.runId === candidate.runId));
});

test("capped archive discovery stops before parsing the remainder of a large index", async () => {
  const w = fixture();
  mkdirSync(w.home, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    lines.push(JSON.stringify({ schemaVersion: 1, runId: `run_cap_${i}`, runDir: join(w.home, "missing", `run_cap_${i}`), projectRoot: w.cwd, parentRunId: "root_cap", createdAt: old }));
  }
  writeFileSync(w.store.globalIndexPath(), `${lines.join("\n")}\n{not-json-after-cap}\n`, "utf8");

  await assert.doesNotReject(() => archiveRuns(w.store, { cap: 25, dryRun: true, nowMs }));
  class NoCompactionStore extends RunStore {
    override compactRunIndexes(): number {
      throw new Error("capped automatic sweep must not compact the full index");
    }
  }
  const cappedStore = new NoCompactionStore({ cwd: w.cwd, env: w.env });
  await assert.doesNotReject(() => archiveRuns(cappedStore, { cap: 25, nowMs }));
});

test("archive includes legacy top-level runs", async () => {
  const w = fixture();
  const legacyStore = new RunStore({ cwd: w.cwd, runRoot: join(w.home, "runs"), env: w.env });
  const legacy = addRun(legacyStore, w.cwd, "completed", old, "run_legacy");
  const result = await archiveRuns(w.store, { olderThanDays: 7, nowMs });
  assert.ok(result.archived.includes(legacy.runId));
  assert.equal(existsSync(legacy.paths.runDir), false);
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectSlug } from "./paths.js";
import type { AgentMetadata } from "./types.js";
import type { RootSessionRecord, ArtifactManifest } from "./server.js";
import { appendEvent } from "./events.js";
import {
  buildDashboard,
  buildOperations,
  buildWorkstreams,
  buildWorkstreamDetail,
  buildWorkstreamAgents,
  buildAttention,
  buildArtifacts,
  buildTimeline,
  buildHistory,
} from "./dashboard-api.js";

let tempHome: string;
let runA: string;
let runB: string;
let runC: string;

const baseMeta = (overrides: Partial<AgentMetadata> & { name: string; runDir: string }): AgentMetadata => ({
  status: "running",
  harness: "pi",
  mode: "interactive",
  cwd: "/tmp",
  task: "t",
  homeDir: join(overrides.runDir, "home"),
  tmuxSocket: join(overrides.runDir, "tmux.sock"),
  tmuxSession: "tango",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

function writeRootSession(record: RootSessionRecord) {
  const dir = join(tempHome, "server", "root-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.rootSessionId}.json`), JSON.stringify(record));
}

function writeArtifact(manifest: ArtifactManifest) {
  const dir = join(tempHome, "artifacts", manifest.artifactId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

before(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tango-dash-test-"));
  process.env.TANGO_HOME = tempHome;

  const slug = projectSlug("/tmp");
  const runs = join(tempHome, "runs", slug);
  mkdirSync(runs, { recursive: true });

  runA = join(runs, "agent-a");
  runB = join(runs, "agent-b");
  runC = join(runs, "agent-c");

  for (const d of [runA, runB, runC]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(
    join(runA, "metadata.json"),
    JSON.stringify(baseMeta({ name: "agent-a", runDir: runA, runId: "run_a", rootSessionId: "r1", workstreamId: "w1" }))
  );
  writeFileSync(
    join(runB, "metadata.json"),
    JSON.stringify(baseMeta({ name: "agent-b", runDir: runB, runId: "run_b", rootSessionId: "r1", workstreamId: "w1", status: "blocked", needs: "review" }))
  );
  writeFileSync(
    join(runC, "metadata.json"),
    JSON.stringify(baseMeta({ name: "agent-c", runDir: runC, runId: "run_c", rootSessionId: "r2", workstreamId: "w2" }))
  );

  writeRootSession({ schemaVersion: 1, rootSessionId: "r1", workstreamId: "w1", kind: "pi", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z", lastSeenAt: "2024-01-01T00:00:00Z" });
  writeRootSession({ schemaVersion: 1, rootSessionId: "r2", workstreamId: "w2", kind: "pi", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z", lastSeenAt: "2024-01-01T00:00:00Z" });

  writeArtifact({
    schemaVersion: 1,
    artifactId: "art_1",
    token: "tok_1",
    sourcePath: "/tmp/a",
    storedPath: "/tmp/a",
    entry: "index.html",
    ownerRunDir: runA,
    createdAt: "2024-01-01T00:00:00Z",
  });
  writeArtifact({
    schemaVersion: 1,
    artifactId: "art_2",
    token: "tok_2",
    sourcePath: "/tmp/b",
    storedPath: "/tmp/b",
    entry: "index.html",
    ownerRunDir: runC,
    createdAt: "2024-01-01T00:00:00Z",
  });
  writeArtifact({
    schemaVersion: 1,
    artifactId: "art_3",
    token: "tok_3",
    sourcePath: "/tmp/c",
    storedPath: "/tmp/c",
    entry: "index.html",
    rootSessionId: "r2",
    workstreamId: "w2",
    createdAt: "2024-01-01T00:00:00Z",
  });
  writeArtifact({
    schemaVersion: 1,
    artifactId: "art_4",
    token: "tok_4",
    sourcePath: "/tmp/d",
    storedPath: "/tmp/d",
    entry: "index.html",
    ownerRunDir: runA,
    rootSessionId: "r2",
    workstreamId: "w2",
    createdAt: "2024-01-01T00:00:00Z",
  });
  writeArtifact({
    schemaVersion: 1,
    artifactId: "art_5",
    token: "tok_5",
    sourcePath: "/tmp/e",
    storedPath: "/tmp/e",
    entry: "index.html",
    rootSessionId: "r2",
    workstreamId: "w1",
    createdAt: "2024-01-01T00:00:00Z",
  });

  appendEvent({
    schemaVersion: 1,
    eventId: "e1",
    type: "agent.status",
    time: "2024-01-01T00:00:00Z",
    agent: "agent-a",
    status: "running",
    cwd: "/tmp",
    projectSlug: slug,
    runDir: runA,
    rootSessionId: "r1",
    workstreamId: "w1",
  });
  appendEvent({
    schemaVersion: 1,
    eventId: "e2",
    type: "agent.status",
    time: "2024-01-01T00:01:00Z",
    agent: "agent-c",
    status: "running",
    cwd: "/tmp",
    projectSlug: slug,
    runDir: runC,
    rootSessionId: "r2",
    workstreamId: "w2",
  });
});

after(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  delete process.env.TANGO_HOME;
});

describe("buildDashboard", () => {
  it("returns root session cards with counts", () => {
    const vm = buildDashboard();
    assert.strictEqual(vm.schemaVersion, 1);
    assert.strictEqual(vm.rootSessions.length, 2);
    const r1 = vm.rootSessions.find((r) => r.rootSessionId === "r1");
    assert.ok(r1);
    assert.strictEqual(r1!.counts.attention, 1);
    assert.strictEqual(r1!.counts.active, 1);
    assert.strictEqual(r1!.attentionCount, 1);
  });
});

describe("buildOperations", () => {
  it("returns durable operations projection with commands and sorted slices", () => {
    const vm = buildOperations();
    assert.strictEqual(vm.schemaVersion, 1);
    assert.strictEqual(vm.workstreams.length, 2);
    assert.strictEqual(vm.counts.total, 3);
    assert.strictEqual(vm.attention.length, 1);
    assert.strictEqual(vm.attention[0].name, "agent-b");
    assert.match(vm.attention[0].commands.look, /tango activity --run-id run_b --lines 200/);
    assert.ok(vm.activeAgents.some((a) => a.name === "agent-a" && a.commands.result.includes("run_a")));
    assert.strictEqual(vm.timelineTail.length, 2);
    assert.deepStrictEqual(vm.recentArtifacts.map((a) => a.artifactId).sort(), ["art_1", "art_2", "art_3", "art_4", "art_5"]);
    assert.strictEqual(vm.suggestedRootSessionId, "r1");
  });
});

describe("buildWorkstreams", () => {
  it("returns workstreams list", () => {
    const vm = buildWorkstreams();
    assert.strictEqual(vm.schemaVersion, 1);
    assert.strictEqual(vm.workstreams.length, 2);
  });
});

describe("buildWorkstreamDetail", () => {
  it("returns undefined for unknown root session", () => {
    assert.strictEqual(buildWorkstreamDetail("unknown"), undefined);
  });

  it("returns detail for known root session", () => {
    const vm = buildWorkstreamDetail("r1");
    assert.ok(vm);
    assert.strictEqual(vm!.rootSession.rootSessionId, "r1");
    assert.strictEqual(vm!.agents.length, 2);
    assert.strictEqual(vm!.attention.length, 1);
    assert.strictEqual(vm!.attention[0].name, "agent-b");
  });

  it("scopes artifacts to workstream agents", () => {
    const vm = buildWorkstreamDetail("r1");
    assert.ok(vm);
    const ids = vm!.artifacts.map((a) => a.artifactId).sort();
    assert.deepStrictEqual(ids, ["art_1"]);
    assert.strictEqual(vm!.artifacts[0].url, "/a/art_1/tok_1/index.html");
  });

  it("excludes artifacts with mismatched rootSessionId+workstreamId from both workstreams", () => {
    // art_5 has rootSessionId=r2 but workstreamId=w1 (mismatched); must not appear in r1 or r2
    const r1 = buildWorkstreamDetail("r1");
    assert.ok(r1);
    assert.ok(!r1!.artifacts.some((a) => a.artifactId === "art_5"));
    const r2 = buildWorkstreamDetail("r2");
    assert.ok(r2);
    assert.ok(!r2!.artifacts.some((a) => a.artifactId === "art_5"));
  });

  it("scopes artifacts by manifest rootSessionId / workstreamId when ownerRunDir absent", () => {
    const vm = buildWorkstreamDetail("r2");
    assert.ok(vm);
    const ids = vm!.artifacts.map((a) => a.artifactId).sort();
    assert.deepStrictEqual(ids, ["art_2", "art_3", "art_4"]);
  });

  it("does not leak cross-workstream artifacts when manifest lineage conflicts with ownerRunDir", () => {
    const vm = buildWorkstreamDetail("r1");
    assert.ok(vm);
    const ids = vm!.artifacts.map((a) => a.artifactId).sort();
    // art_4 has ownerRunDir from r1 but explicit r2 lineage; must not appear in r1
    assert.deepStrictEqual(ids, ["art_1"]);
  });
});

describe("buildWorkstreamAgents", () => {
  it("returns undefined for unknown root session", () => {
    assert.strictEqual(buildWorkstreamAgents("unknown"), undefined);
  });

  it("returns scoped agents", () => {
    const vm = buildWorkstreamAgents("r1");
    assert.ok(vm);
    assert.strictEqual(vm!.agents.length, 2);
  });
});

describe("buildAttention", () => {
  it("returns global attention", () => {
    const vm = buildAttention();
    assert.strictEqual(vm.attention.length, 1);
    assert.strictEqual(vm.attention[0].name, "agent-b");
  });

  it("returns scoped attention for root session", () => {
    const vm = buildAttention({ rootSessionId: "r1" });
    assert.strictEqual(vm.attention.length, 1);
    assert.strictEqual(vm.attention[0].name, "agent-b");
  });

  it("returns empty attention for unrelated root session", () => {
    const vm = buildAttention({ rootSessionId: "r2" });
    assert.strictEqual(vm.attention.length, 0);
  });
});

describe("buildArtifacts", () => {
  it("returns all artifacts when no rootSessionId", () => {
    const vm = buildArtifacts();
    assert.ok(vm);
    assert.strictEqual(vm!.artifacts.length, 5);
  });

  it("returns undefined for unknown root session", () => {
    assert.strictEqual(buildArtifacts("unknown"), undefined);
  });

  it("scopes artifacts by workstream", () => {
    const vm = buildArtifacts("r1");
    assert.ok(vm);
    const ids = vm!.artifacts.map((a) => a.artifactId).sort();
    assert.deepStrictEqual(ids, ["art_1"]);
  });

  it("scopes artifacts by manifest lineage", () => {
    const vm = buildArtifacts("r2");
    assert.ok(vm);
    const ids = vm!.artifacts.map((a) => a.artifactId).sort();
    assert.deepStrictEqual(ids, ["art_2", "art_3", "art_4"]);
  });
});

describe("buildTimeline", () => {
  it("returns all events when no rootSessionId", () => {
    const vm = buildTimeline();
    assert.ok(vm);
    assert.strictEqual(vm!.events.length, 2);
  });

  it("returns undefined for unknown root session", () => {
    assert.strictEqual(buildTimeline("unknown"), undefined);
  });

  it("scopes events by root session", () => {
    const vm = buildTimeline("r1");
    assert.ok(vm);
    assert.strictEqual(vm!.events.length, 1);
    assert.strictEqual(vm!.events[0].agent, "agent-a");
  });

  it("limits timeline results from the tail", () => {
    const vm = buildTimeline(undefined, { limit: 1 });
    assert.ok(vm);
    assert.strictEqual(vm!.limit, 1);
    assert.strictEqual(vm!.total, 2);
    assert.strictEqual(vm!.events.length, 1);
    assert.strictEqual(vm!.events[0].agent, "agent-c");
  });
});

describe("buildHistory", () => {
  it("partitions agents into historical and legacy", () => {
    const vm = buildHistory();
    assert.strictEqual(vm.schemaVersion, 1);
    assert.strictEqual(Array.isArray(vm.historical), true);
    assert.strictEqual(Array.isArray(vm.legacy), true);
  });
});

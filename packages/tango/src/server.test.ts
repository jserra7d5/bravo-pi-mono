import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTangoServer, publishArtifact, type RootSessionRecord, type ArtifactManifest } from "./server.js";
import { appendEvent } from "./events.js";
import type { AgentMetadata } from "./types.js";
import type { Server } from "node:http";

let tempHome: string;
let server: Server;
let shutdown: () => void;
let baseUrl: string;
let token: string;

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

before(async () => {
  tempHome = mkdtempSync(join(tmpdir(), "tango-server-test-"));
  process.env.TANGO_HOME = tempHome;

  const slug = "tmp-abc123";
  const runs = join(tempHome, "runs", slug);
  mkdirSync(runs, { recursive: true });

  const runA = join(runs, "agent-a");
  const runB = join(runs, "agent-b");
  for (const d of [runA, runB]) {
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

  writeRootSession({ schemaVersion: 1, rootSessionId: "r1", workstreamId: "w1", kind: "pi", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z", lastSeenAt: "2024-01-01T00:00:00Z" });

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

  token = "test-token-smoke";
  const started = await startTangoServer({ port: 0, token });
  server = started.server;
  shutdown = started.shutdown;
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  shutdown();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  delete process.env.TANGO_HOME;
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}?token=${encodeURIComponent(token)}`);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, body };
}

async function getRaw(path: string): Promise<{ status: number; text: string; contentType: string | null }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") };
}

async function getRawAuthorized(path: string): Promise<{ status: number; text: string; contentType: string | null }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") };
}

describe("server routes", () => {
  it("GET /api/v1/operations returns the operations projection", async () => {
    const { status, body } = await get("/api/v1/operations");
    assert.strictEqual(status, 200);
    assert.strictEqual((body as any).schemaVersion, 1);
    assert.strictEqual((body as any).counts.total, 2);
    assert.strictEqual((body as any).workstreams.length, 1);
    assert.strictEqual((body as any).attention[0].name, "agent-b");
    assert.match((body as any).attention[0].commands.look, /tango look --run-id run_b --lines 200/);
    assert.strictEqual((body as any).activeAgents[0].name, "agent-a");
    assert.strictEqual((body as any).recentArtifacts[0].artifactId, "art_1");
    assert.strictEqual((body as any).suggestedRootSessionId, "r1");
  });

  it("GET /api/v1/workstreams/:rootSessionId/attention returns scoped attention", async () => {
    const { status, body } = await get("/api/v1/workstreams/r1/attention");
    assert.strictEqual(status, 200);
    assert.strictEqual((body as any).schemaVersion, 1);
    assert.strictEqual((body as any).attention.length, 1);
    assert.strictEqual((body as any).attention[0].name, "agent-b");
  });

  it("GET /api/v1/workstreams/:rootSessionId/artifacts returns scoped artifacts", async () => {
    const { status, body } = await get("/api/v1/workstreams/r1/artifacts");
    assert.strictEqual(status, 200);
    assert.strictEqual((body as any).schemaVersion, 1);
    const ids = (body as any).artifacts.map((a: any) => a.artifactId).sort();
    assert.deepStrictEqual(ids, ["art_1"]);
  });

  it("GET /api/v1/workstreams/:rootSessionId/timeline returns scoped timeline", async () => {
    const { status, body } = await get("/api/v1/workstreams/r1/timeline");
    assert.strictEqual(status, 200);
    assert.strictEqual((body as any).schemaVersion, 1);
    assert.strictEqual((body as any).events.length, 1);
    assert.strictEqual((body as any).events[0].agent, "agent-a");
  });

  it("GET /api/v1/workstreams/:rootSessionId/attention returns 404 for unknown root session", async () => {
    const { status, body } = await get("/api/v1/workstreams/unknown/attention");
    assert.strictEqual(status, 404);
    assert.strictEqual((body as any).ok, false);
  });

  it("GET /api/v1/workstreams/:rootSessionId/artifacts returns 404 for unknown root session", async () => {
    const { status, body } = await get("/api/v1/workstreams/unknown/artifacts");
    assert.strictEqual(status, 404);
    assert.strictEqual((body as any).ok, false);
  });

  it("GET /api/v1/workstreams/:rootSessionId/timeline returns 404 for unknown root session", async () => {
    const { status, body } = await get("/api/v1/workstreams/unknown/timeline");
    assert.strictEqual(status, 404);
    assert.strictEqual((body as any).ok, false);
  });

  it("serves only registered artifacts", async () => {
    const { status, body } = await get("/a/missing/tok/index.html");
    assert.strictEqual(status, 404);
    assert.strictEqual((body as any).ok, false);
  });

  it("requires the artifact token", async () => {
    const content = join(tempHome, "artifact-content", "token-test");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "index.html"), "ok");
    writeArtifact({ schemaVersion: 1, artifactId: "art_token", token: "right", sourcePath: content, storedPath: content, entry: "index.html", createdAt: "2024-01-01T00:00:00Z" });
    const { status } = await getRaw("/a/art_token/wrong/index.html");
    assert.strictEqual(status, 404);
  });

  it("returns 410 for revoked artifacts", async () => {
    const content = join(tempHome, "artifact-content", "revoked-test");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "index.html"), "revoked");
    writeArtifact({ schemaVersion: 1, artifactId: "art_revoked", token: "tok", sourcePath: content, storedPath: content, entry: "index.html", createdAt: "2024-01-01T00:00:00Z", revokedAt: "2024-01-02T00:00:00Z" });
    const { status } = await getRaw("/a/art_revoked/tok/index.html");
    assert.strictEqual(status, 410);
  });

  it("serves the entry file for an empty artifact subpath with manifest MIME", async () => {
    const content = join(tempHome, "artifact-content", "entry-test");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "index.html"), "entry");
    writeArtifact({ schemaVersion: 1, artifactId: "art_entry", token: "tok", sourcePath: content, storedPath: content, entry: "index.html", mime: "text/html", createdAt: "2024-01-01T00:00:00Z" });
    const { status, text, contentType } = await getRaw("/a/art_entry/tok");
    assert.strictEqual(status, 200);
    assert.strictEqual(text, "entry");
    assert.match(contentType ?? "", /^text\/html/);
  });

  it("rejects symlink path traversal outside artifact root", async () => {
    const content = join(tempHome, "artifact-content", "symlink-test");
    const outside = join(tempHome, "artifact-content", "outside-secret.txt");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "index.html"), "safe");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(content, "leak.txt"));
    writeArtifact({ schemaVersion: 1, artifactId: "art_symlink", token: "tok", sourcePath: content, storedPath: content, entry: "index.html", createdAt: "2024-01-01T00:00:00Z" });
    const { status } = await getRaw("/a/art_symlink/tok/leak.txt");
    assert.strictEqual(status, 403);
  });

  it("rejects non-local bind unless explicitly allowed", async () => {
    await assert.rejects(() => startTangoServer({ host: "0.0.0.0", port: 0, token: "x" }), /Refusing non-local bind/);
  });

  it("does not require dashboard/API authorization unless a token is explicitly configured", async () => {
    const previousHome = process.env.TANGO_HOME;
    const openHome = mkdtempSync(join(tmpdir(), "tango-open-server-test-"));
    let openShutdown: (() => void) | undefined;
    try {
      process.env.TANGO_HOME = openHome;
      const started = await startTangoServer({ port: 0 });
      openShutdown = started.shutdown;
      const address = started.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const openBase = `http://127.0.0.1:${port}`;

      const dashboard = await fetch(`${openBase}/`);
      assert.strictEqual(dashboard.status, 200);
      assert.match(dashboard.headers.get("content-type") ?? "", /^text\/html/);

      const api = await fetch(`${openBase}/api/v1/dashboard`);
      const body = await api.json();
      assert.strictEqual(api.status, 200);
      assert.strictEqual((body as any).ok, true);

      const discovery = JSON.parse(readFileSync(join(openHome, "server", "server.json"), "utf8"));
      assert.strictEqual(discovery.token, undefined);
    } finally {
      openShutdown?.();
      if (previousHome === undefined) delete process.env.TANGO_HOME; else process.env.TANGO_HOME = previousHome;
      rmSync(openHome, { recursive: true, force: true });
    }
  });

  it("does not serve token-bearing dashboard HTML without authorization", async () => {
    const res = await fetch(`${baseUrl}/`);
    const text = await res.text();
    assert.strictEqual(res.status, 401);
    assert.doesNotMatch(text, new RegExp(token));
  });

  it("does not include the server token in authorized dashboard HTML", async () => {
    const { status, text, contentType } = await getRawAuthorized("/");
    assert.strictEqual(status, 200);
    assert.match(contentType ?? "", /^text\/html/);
    assert.doesNotMatch(text, new RegExp(token));
    assert.doesNotMatch(text, /tango-token/);
  });

  it("does not include an authorized query token in fallback dashboard HTML", async () => {
    const dashboardIndex = join(fileURLToPath(import.meta.url), "..", "..", "dashboard", "dist", "index.html");
    const dashboardIndexBackup = `${dashboardIndex}.test-backup`;
    const movedDashboardIndex = existsSync(dashboardIndex);
    if (movedDashboardIndex) renameSync(dashboardIndex, dashboardIndexBackup);
    try {
      const res = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`);
      const text = await res.text();
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
      assert.doesNotMatch(text, new RegExp(token));
      assert.doesNotMatch(text, new RegExp(encodeURIComponent(token)));
      assert.match(text, /new URLSearchParams\(location\.search\)\.get\('token'\)/);
      assert.match(text, /fetch\('\/api\/v1\/agents' \+ auth\)/);
    } finally {
      if (movedDashboardIndex) renameSync(dashboardIndexBackup, dashboardIndex);
    }
  });

  it("requires authorization for dashboard APIs", async () => {
    const res = await fetch(`${baseUrl}/api/v1/dashboard`);
    const body = await res.json();
    assert.strictEqual(res.status, 401);
    assert.strictEqual((body as any).ok, false);
  });

  it("rejects top-level symlink artifact sources", async () => {
    const dir = join(tempHome, "artifact-content", "symlink-source");
    mkdirSync(dir, { recursive: true });
    const secret = join(dir, ".env");
    const link = join(dir, "report.html");
    writeFileSync(secret, "SECRET=1");
    symlinkSync(secret, link);
    await assert.rejects(() => publishArtifact(link), /Refusing symlink artifact path|Refusing secret-looking artifact path/);
  });

  it("encodes reserved characters in published artifact URLs", async () => {
    const dir = join(tempHome, "artifact-content", "encoded-entry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report#1.html"), "encoded");
    const artifact = await publishArtifact(dir, { entry: "report#1.html" });
    assert.ok(artifact.url);
    assert.match(artifact.url!, /report%231\.html$/);
    const res = await fetch(artifact.url!);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), "encoded");
  });

  it("applies manifest MIME only to the entry file", async () => {
    const content = join(tempHome, "artifact-content", "mime-test");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "index.html"), "html");
    writeFileSync(join(content, "app.js"), "console.log(1);");
    writeArtifact({ schemaVersion: 1, artifactId: "art_mime", token: "tok", sourcePath: content, storedPath: content, entry: "index.html", mime: "text/html", createdAt: "2024-01-01T00:00:00Z" });
    const entry = await getRaw("/a/art_mime/tok/index.html");
    assert.match(entry.contentType ?? "", /^text\/html/);
    const asset = await getRaw("/a/art_mime/tok/app.js");
    assert.match(asset.contentType ?? "", /^text\/javascript/);
  });
});

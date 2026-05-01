import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markActivityItemsInspected, readInboxItems, syncInboxFromAgents } from "./inbox.js";
import { writeMetadata } from "./metadata.js";
import type { AgentMetadata } from "./types.js";

let tempHome: string;

const baseMeta = (overrides: Partial<AgentMetadata> & { name: string; runDir: string }): AgentMetadata => ({
  status: "running",
  harness: "pi",
  mode: "interactive",
  cwd: "/tmp/tango-inbox-test",
  task: "test",
  homeDir: join(overrides.runDir, "home"),
  tmuxSocket: join(overrides.runDir, "tmux.sock"),
  tmuxSession: "tango",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: new Date().toISOString(),
  ...overrides,
});

function runDir(name: string): string {
  return join(tempHome, "runs", "proj", name);
}

function seedMetadata(meta: AgentMetadata): AgentMetadata {
  mkdirSync(meta.runDir, { recursive: true });
  writeFileSync(join(meta.runDir, "metadata.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tango-inbox-test-"));
  process.env.TANGO_HOME = tempHome;
});

afterEach(() => {
  delete process.env.TANGO_HOME;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
});

describe("inbox activity inspection", () => {
  it("marks matching current non-result attention read when activity is inspected", () => {
    const meta = seedMetadata(baseMeta({ name: "blocked-agent", runDir: runDir("blocked-agent"), runId: "run_blocked", status: "blocked", needs: "input" }));

    syncInboxFromAgents([meta]);
    const [created] = readInboxItems();
    assert.strictEqual(created.type, "blocked");
    assert.strictEqual(created.state, "unread");

    const inspected = markActivityItemsInspected(meta);
    assert.strictEqual(inspected.length, 1);
    assert.strictEqual(inspected[0].state, "read");
    assert.ok(inspected[0].readAt);
    assert.strictEqual(readInboxItems()[0].state, "read");
  });

  it("marks stale non-result attention handled when activity is inspected", () => {
    const run = runDir("stale-agent");
    const blocked = seedMetadata(baseMeta({ name: "stale-agent", runDir: run, runId: "run_stale", status: "blocked", needs: "review" }));

    syncInboxFromAgents([blocked]);
    assert.strictEqual(readInboxItems()[0].type, "blocked");

    const running = { ...blocked, status: "running" as const };
    writeMetadata(running);
    const inspected = markActivityItemsInspected(running);

    assert.strictEqual(inspected.length, 1);
    assert.strictEqual(inspected[0].state, "handled");
    assert.ok(inspected[0].handledAt);
  });

  it("keeps current error attention visible/read after activity inspection", () => {
    const meta = seedMetadata(baseMeta({ name: "error-agent", runDir: runDir("error-agent"), runId: "run_error", status: "error", summary: "failed" }));

    syncInboxFromAgents([meta]);
    const [created] = readInboxItems();
    assert.strictEqual(created.type, "error");

    const inspected = markActivityItemsInspected(meta);
    assert.strictEqual(inspected.length, 1);
    assert.strictEqual(inspected[0].state, "read");
    assert.strictEqual(readInboxItems()[0].state, "read");
  });

  it("creates a fresh unread attention item when blocked summary changes after inspection", () => {
    const run = runDir("repeat-blocked-agent");
    const first = seedMetadata(baseMeta({ name: "repeat-blocked-agent", runDir: run, runId: "run_repeat_blocked", status: "blocked", needs: "input", summary: "first block", lastReportAt: "2024-01-01T00:00:01Z" }));

    syncInboxFromAgents([first]);
    markActivityItemsInspected(first);
    assert.strictEqual(readInboxItems()[0].state, "read");

    const second = { ...first, summary: "second block", lastReportAt: "2024-01-01T00:00:02Z", updatedAt: "2024-01-01T00:00:02Z" };
    writeMetadata(second);
    syncInboxFromAgents([second]);

    const items = readInboxItems().filter((item) => item.type === "blocked");
    assert.strictEqual(items.length, 2);
    const unread = items.find((item) => item.summary === "second block");
    const old = items.find((item) => item.summary === "first block");
    assert.ok(unread);
    assert.ok(old);
    assert.strictEqual(unread.state, "unread");
    assert.strictEqual(old.state, "handled");
  });
});

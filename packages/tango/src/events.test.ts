import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventMatchesLineage } from "./events.js";
import { projectSlug } from "./paths.js";
import type { TangoEvent } from "./events.js";

describe("eventMatchesLineage", () => {
  afterEach(() => {
    delete process.env.TANGO_RUN_ID;
    delete process.env.TANGO_RUN_DIR;
    delete process.env.TANGO_ROOT_SESSION_ID;
    delete process.env.TANGO_WORKSTREAM_ID;
  });

  it("matches by runId", () => {
    process.env.TANGO_RUN_ID = "run_1";
    const event = { runId: "run_1" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
  });

  it("matches by parentRunId", () => {
    process.env.TANGO_RUN_ID = "run_1";
    const event = { runId: "run_2", parentRunId: "run_1" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
  });

  it("matches by rootSessionId", () => {
    process.env.TANGO_ROOT_SESSION_ID = "root_1";
    const event = { rootSessionId: "root_1" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
  });

  it("matches by workstreamId", () => {
    process.env.TANGO_WORKSTREAM_ID = "ws_1";
    const event = { workstreamId: "ws_1" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
  });

  it("requires both rootSessionId and workstreamId when both env vars are set", () => {
    process.env.TANGO_ROOT_SESSION_ID = "root_1";
    process.env.TANGO_WORKSTREAM_ID = "ws_1";
    const match = { rootSessionId: "root_1", workstreamId: "ws_1" } as TangoEvent;
    const mismatch = { rootSessionId: "root_1", workstreamId: "ws_2" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(match, "/tmp"), true);
    assert.strictEqual(eventMatchesLineage(mismatch, "/tmp"), false);
  });

  it("does not fall back to cwd when lineage env exists but event mismatches", () => {
    process.env.TANGO_RUN_ID = "run_1";
    const event = { runId: "run_2", projectSlug: projectSlug("/tmp"), cwd: "/tmp" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), false);
  });

  it("does not match unrelated same-cwd event when lineage env is present", () => {
    process.env.TANGO_ROOT_SESSION_ID = "root_1";
    process.env.TANGO_WORKSTREAM_ID = "ws_1";
    const event = { rootSessionId: "root_2", workstreamId: "ws_2", projectSlug: projectSlug("/tmp"), cwd: "/tmp" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), false);
  });

  it("normalizes runDir comparison", () => {
    process.env.TANGO_RUN_DIR = "/tmp/";
    const event = { runDir: "/tmp", projectSlug: "other" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
  });

  it("normalizes parentRunDir comparison", () => {
    process.env.TANGO_RUN_DIR = "/tmp";
    const event = { runDir: "/other", parentRunDir: "/tmp/" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
  });

  it("matches descendant events by walking metadata lineage", () => {
    const oldHome = process.env.TANGO_HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "tango-events-test-"));
    process.env.TANGO_HOME = tempHome;
    process.env.TANGO_RUN_ID = "run_parent";
    try {
      const runs = join(tempHome, "runs", projectSlug("/tmp"));
      const parentDir = join(runs, "parent");
      const childDir = join(runs, "child");
      const grandchildDir = join(runs, "grandchild");
      mkdirSync(parentDir, { recursive: true });
      mkdirSync(childDir, { recursive: true });
      mkdirSync(grandchildDir, { recursive: true });
      writeFileSync(join(parentDir, "metadata.json"), JSON.stringify({ name: "parent", runDir: parentDir, runId: "run_parent", status: "running", cwd: "/tmp", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }));
      writeFileSync(join(childDir, "metadata.json"), JSON.stringify({ name: "child", runDir: childDir, runId: "run_child", parentRunId: "run_parent", parentRunDir: parentDir, status: "running", cwd: "/tmp", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }));
      writeFileSync(join(grandchildDir, "metadata.json"), JSON.stringify({ name: "grandchild", runDir: grandchildDir, runId: "run_grandchild", parentRunId: "run_child", parentRunDir: childDir, status: "running", cwd: "/tmp", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }));
      const event = { runDir: grandchildDir, runId: "run_grandchild", parentRunId: "run_child", projectSlug: projectSlug("/tmp"), cwd: "/tmp" } as TangoEvent;
      assert.strictEqual(eventMatchesLineage(event, "/tmp"), true);
    } finally {
      if (oldHome === undefined) delete process.env.TANGO_HOME;
      else process.env.TANGO_HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("falls back to cwd match", () => {
    const cwd = "/tmp";
    const event = { projectSlug: projectSlug(cwd), cwd } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, cwd), true);
  });

  it("returns false when no lineage match and cwd mismatch", () => {
    const event = { projectSlug: "other-123" } as TangoEvent;
    assert.strictEqual(eventMatchesLineage(event, "/tmp"), false);
  });
});

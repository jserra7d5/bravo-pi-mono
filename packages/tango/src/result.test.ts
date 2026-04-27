import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assessResultDeliverable } from "./result.js";
import { writeMetadata, readMetadata } from "./metadata.js";
import { readEvents } from "./events.js";
import { runOneshot } from "./start.js";
import type { AgentMetadata, CommandSpec } from "./types.js";

let tempHome: string;
let oldHome: string | undefined;

beforeEach(() => {
  oldHome = process.env.TANGO_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "tango-result-test-"));
  process.env.TANGO_HOME = tempHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.TANGO_HOME;
  else process.env.TANGO_HOME = oldHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  const runDir = overrides.runDir ?? join(tempHome, "runs", "proj", overrides.name ?? "agent");
  mkdirSync(runDir, { recursive: true });
  const now = "2024-01-01T00:00:00.000Z";
  return {
    name: "agent",
    harness: "generic",
    mode: "interactive",
    status: "running",
    cwd: tempHome,
    task: "write an analysis report",
    runDir,
    homeDir: join(runDir, "home"),
    tmuxSocket: join(runDir, "tmux.sock"),
    tmuxSession: "tango",
    createdAt: now,
    updatedAt: now,
    runId: "run_test",
    ...overrides,
  };
}

describe("result readiness", () => {
  it("does not treat legacy result.md without resultFinalizedAt as ready", () => {
    const meta = makeMeta({ status: "done" });
    writeFileSync(join(meta.runDir, "result.md"), "legacy deliverable\n", "utf8");
    writeMetadata(meta);

    const assessment = assessResultDeliverable(readMetadata(meta.runDir));

    assert.strictEqual(assessment.resultReady, false);
    assert.match(assessment.resultIssue ?? "", /not been finalized|No finalized/);
    assert.strictEqual(assessment.result, "legacy deliverable\n");
  });

  it("reports suspiciously short finalized reports as warnings, not readiness failures", () => {
    const meta = makeMeta({ status: "done", resultFinalizedAt: "2024-01-01T00:01:00.000Z" });
    writeFileSync(join(meta.runDir, "result.md"), "short\n", "utf8");
    writeMetadata(meta);

    const assessment = assessResultDeliverable(readMetadata(meta.runDir));

    assert.strictEqual(assessment.resultReady, true);
    assert.strictEqual(assessment.resultIssue, undefined);
    assert.match(assessment.resultWarning ?? "", /suspiciously short/);
  });

  it("finalizes --result-file before emitting the done event", () => {
    const meta = makeMeta({ status: "running" });
    writeMetadata(meta);
    const source = join(tempHome, "answer.md");
    writeFileSync(source, "full deliverable\n", "utf8");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

    const proc = spawnSync(process.execPath, [cli, "status", "done", "--run-dir", meta.runDir, "--result-file", source, "finished", "--json"], {
      cwd: tempHome,
      env: { ...process.env, TANGO_HOME: tempHome },
      encoding: "utf8",
    });

    assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
    const updated = readMetadata(meta.runDir);
    assert.strictEqual(updated.status, "done");
    assert.ok(updated.resultFinalizedAt);
    assert.strictEqual(readFileSync(join(meta.runDir, "result.md"), "utf8"), "full deliverable\n");
    const events = readEvents({ offset: 0, carry: "" }).events;
    const done = events.find((e) => e.status === "done");
    assert.ok(done);
    assert.ok(done!.resultFinalizedAt);
    assert.strictEqual(done!.resultReady, true);
    assert.strictEqual(done!.summary, "finished");
  });

  it("persists plain oneshot stdout as result.md", async () => {
    const meta = makeMeta({ mode: "oneshot", status: "running", harness: "generic", task: "plain task" });
    writeMetadata(meta);
    const spec: CommandSpec = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('plain result')"],
      cwd: tempHome,
      env: { ...process.env, TANGO_HOME: tempHome } as Record<string, string>,
      resultParser: "plain",
    };

    await runOneshot(meta, spec);

    const updated = readMetadata(meta.runDir);
    assert.strictEqual(updated.status, "done");
    assert.strictEqual(readFileSync(join(meta.runDir, "result.md"), "utf8"), "plain result");
    assert.ok(updated.resultFinalizedAt);
    assert.strictEqual(updated.resultIssue, undefined);
  });

  it("finalizes a usable result issue when oneshot spawn fails", async () => {
    const meta = makeMeta({ mode: "oneshot", status: "running", harness: "generic" });
    writeMetadata(meta);
    const spec: CommandSpec = {
      command: join(tempHome, "missing-command"),
      args: [],
      cwd: tempHome,
      env: { ...process.env, TANGO_HOME: tempHome } as Record<string, string>,
      resultParser: "plain",
    };

    await runOneshot(meta, spec);

    const updated = readMetadata(meta.runDir);
    assert.strictEqual(updated.status, "error");
    assert.ok(updated.resultFinalizedAt);
    assert.match(updated.resultIssue ?? "", /Failed to start oneshot process/);
    const assessment = assessResultDeliverable(updated);
    assert.strictEqual(assessment.resultReady, false);
    assert.match(assessment.resultIssue ?? "", /Failed to start/);
  });
});

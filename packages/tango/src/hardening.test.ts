import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSlug, runDirFor } from "./paths.js";
import { readServerDiscovery, serverDiscoveryPath } from "./server.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

function tempDir(prefix = "tango-hardening-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function writeMeta(home: string, cwd: string, name: string, extra: Record<string, any> = {}) {
  const runDir = join(home, "runs", projectSlug(cwd), name);
  mkdirSync(runDir, { recursive: true });
  const meta = {
    name,
    harness: "generic",
    mode: "oneshot",
    status: "done",
    cwd,
    task: "simple task",
    runDir,
    homeDir: join(runDir, "home"),
    tmuxSocket: join(runDir, "tmux.sock"),
    tmuxSession: "tango",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    runId: `run_${name}`,
    resultFile: join(runDir, "result.md"),
    resultFinalizedAt: "2024-01-01T00:00:01Z",
    ...extra,
  };
  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(runDir, "result.md"), `result for ${name}\n`);
  return meta;
}

describe("Tango CLI/runtime hardening", () => {
  it("rejects unsafe agent names before deriving run directories", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      for (const name of ["", ".", "..", "../x", "a/b", "%%%", " bad"]) {
        assert.throws(() => runDirFor(cwd, name), /Agent name/);
      }
      const result = runCli(["start", "../x", "--harness", "generic", "--mode", "interactive", "--dry-run", "--json"], { TANGO_HOME: home }, cwd);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stdout, /Agent name/);
      assert.strictEqual(existsSync(join(home, "runs")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps dry-run side-effect-free for a new run", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const result = runCli(["start", "preview", "--harness", "generic", "--mode", "interactive", "--dry-run", "--json", "echo hi"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.agent.name, "preview");
      assert.strictEqual(existsSync(join(home, "runs")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("builds Gemini dry-runs as interactive prompt sessions without side effects", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const result = runCli(["start", "gemini-preview", "--harness", "gemini", "--model", "gemini-3-flash-preview", "--thinking", "medium", "--dry-run", "--json", "inspect repo"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.agent.harness, "gemini");
      assert.strictEqual(body.agent.mode, "interactive");
      assert.strictEqual(body.command.command, "gemini");
      assert.deepStrictEqual(body.command.args.slice(0, 5), ["--model", "gemini-3-flash-preview", "--yolo", "--skip-trust", "--prompt-interactive"]);
      assert.match(body.command.args[5], /Task:\s*inspect repo/);
      assert.strictEqual(body.command.env.HOME, body.agent.homeDir);
      assert.strictEqual(body.command.env.TANGO_AGENT_HOME, body.agent.homeDir);
      assert.strictEqual(existsSync(join(home, "runs")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects unsupported Gemini models", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const result = runCli(["start", "bad-gemini-model", "--harness", "gemini", "--model", "gemini-2.5-pro", "--dry-run", "--json", "task"], { TANGO_HOME: home }, cwd);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stdout, /Expected gemini-3\.1-pro-preview or gemini-3-flash-preview/);
      assert.strictEqual(existsSync(join(home, "runs")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects Gemini roles that declare Pi extensions", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      mkdirSync(join(home, "roles"), { recursive: true });
      writeFileSync(join(home, "roles", "bad-gemini.md"), `---\nname: bad-gemini\nharness: gemini\nextensions: [./x.ts]\n---\n\nBad role\n`);
      const result = runCli(["start", "bad-gemini-run", "--role", "bad-gemini", "--dry-run", "--json", "task"], { TANGO_HOME: home }, cwd);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stdout, /Pi extensions are only supported by harness=pi/);
      assert.strictEqual(existsSync(join(home, "runs")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stops oneshot runs and finalizes an empty stopped result issue when no result exists", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "stop-one");
      mkdirSync(runDir, { recursive: true });
      const meta = {
        name: "stop-one",
        harness: "generic",
        mode: "oneshot",
        status: "running",
        cwd,
        task: "long task",
        runDir,
        homeDir: join(runDir, "home"),
        tmuxSocket: join(runDir, "tmux.sock"),
        tmuxSession: "tango",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        runId: "run_stop_one",
        pid: 99999999,
        supervisorPid: 99999998,
      };
      writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(meta, null, 2)}\n`);

      const result = runCli(["stop", "--run-id", "run_stop_one", "--json"], { TANGO_HOME: home }, cwd);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.agent.status, "stopped");
      assert.match(body.agent.resultIssue, /stopped before producing/);
      assert.strictEqual(readFileSync(join(runDir, "result.md"), "utf8"), "");
      assert.match(readFileSync(join(runDir, "supervisor.log"), "utf8"), /stop:/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stopping oneshot with an unfinalized result marks it as stopped issue without overwriting content", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "stop-partial");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify({
        name: "stop-partial",
        harness: "generic",
        mode: "oneshot",
        status: "running",
        cwd,
        task: "long task",
        runDir,
        homeDir: join(runDir, "home"),
        tmuxSocket: join(runDir, "tmux.sock"),
        tmuxSession: "tango",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        runId: "run_stop_partial",
      }));
      writeFileSync(join(runDir, "result.md"), "partial draft", "utf8");

      const result = runCli(["stop", "--run-id", "run_stop_partial", "--json"], { TANGO_HOME: home }, cwd);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.agent.status, "stopped");
      assert.match(body.agent.resultIssue, /stopped before producing/);
      assert.ok(body.agent.resultFinalizedAt);
      assert.strictEqual(readFileSync(join(runDir, "result.md"), "utf8"), "partial draft");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("result --watch reports timeout assessment without marking ready", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "watching");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify({
        name: "watching",
        harness: "generic",
        mode: "oneshot",
        status: "running",
        cwd,
        task: "simple task",
        runDir,
        homeDir: join(runDir, "home"),
        tmuxSocket: join(runDir, "tmux.sock"),
        tmuxSession: "tango",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runId: "run_watching",
      }));

      const result = runCli(["result", "--run-id", "run_watching", "--watch", "--timeout", "0.01", "--json"], { TANGO_HOME: home }, cwd);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.timeout, true);
      assert.strictEqual(body.resultReady, false);
      assert.match(body.resultIssue, /not ready|no child PID/i);
      assert.strictEqual(body.resultAssessment.resultReady, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows blocked status to update and transition back to running", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const meta = writeMeta(home, cwd, "blocked-agent", { status: "blocked", summary: "waiting", needs: "input", resultFile: undefined, resultFinalizedAt: undefined });
      const update = runCli(["status", "blocked", "still waiting", "--needs", "review", "--run-dir", meta.runDir, "--json"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(update.status, 0, update.stderr || update.stdout);
      assert.strictEqual(JSON.parse(update.stdout).agent.summary, "still waiting");
      assert.strictEqual(JSON.parse(update.stdout).agent.needs, "review");

      const running = runCli(["status", "running", "resumed", "--run-dir", meta.runDir, "--json"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(running.status, 0, running.stderr || running.stdout);
      const body = JSON.parse(running.stdout);
      assert.strictEqual(body.agent.status, "running");
      assert.strictEqual(body.agent.summary, "resumed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects transitions away from final terminal statuses", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const meta = writeMeta(home, cwd, "sticky", { status: "done", summary: "finished" });
      const result = runCli(["status", "running", "--run-dir", meta.runDir, "again", "--json"], { TANGO_HOME: home }, cwd);

      assert.notStrictEqual(result.status, 0);
      assert.match(JSON.parse(result.stdout).error, /terminal agent status from done to running/i);
      assert.strictEqual(JSON.parse(readFileSync(join(meta.runDir, "metadata.json"), "utf8")).status, "done");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects changed duplicate done finalization", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const meta = writeMeta(home, cwd, "done-again", { status: "done", summary: "finished" });
      const source = join(cwd, "new-result.md");
      writeFileSync(source, "new result\n");
      const result = runCli(["status", "done", "--run-dir", meta.runDir, "--result-file", source, "changed", "--json"], { TANGO_HOME: home }, cwd);

      assert.notStrictEqual(result.status, 0);
      assert.match(JSON.parse(result.stdout).error, /already done|immutable/i);
      assert.strictEqual(readFileSync(join(meta.runDir, "result.md"), "utf8"), "result for done-again\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows exact duplicate done status as a no-op", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const meta = writeMeta(home, cwd, "done-noop", { status: "done", summary: "finished" });
      const result = runCli(["status", "done", "--run-dir", meta.runDir, "finished", "--json"], { TANGO_HOME: home }, cwd);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.agent.status, "done");
      assert.strictEqual(body.agent.resultFinalizedAt, "2024-01-01T00:00:01Z");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("wait --json includes per-agent result assessments", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      writeMeta(home, cwd, "waited");
      const result = runCli(["wait", "--run-id", "run_waited", "--json"], { TANGO_HOME: home }, cwd);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.agents[0].resultAssessment.resultReady, true);
      assert.strictEqual(body.agents[0].resultAssessment.result, "result for waited\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts interactive agents with deliverables required by default unless opted out", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const required = runCli(["start", "needs-result", "--harness", "generic", "--mode", "interactive", "--dry-run", "--json", "do work"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(required.status, 0, required.stderr || required.stdout);
      assert.strictEqual(JSON.parse(required.stdout).agent.resultRequired, true);

      const optional = runCli(["start", "no-result", "--harness", "generic", "--mode", "interactive", "--no-result-required", "--dry-run", "--json", "do work"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(optional.status, 0, optional.stderr || optional.stdout);
      assert.strictEqual(JSON.parse(optional.stdout).agent.resultRequired, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("supports generated run-id commands without positional names", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      writeMeta(home, cwd, "alpha");
      const env = { TANGO_HOME: home };
      const look = runCli(["look", "--run-id", "run_alpha", "--json"], env, cwd);
      assert.strictEqual(look.status, 0, look.stderr || look.stdout);
      assert.strictEqual(JSON.parse(look.stdout).agent.name, "alpha");
      const result = runCli(["result", "--run-id", "run_alpha", "--json"], env, cwd);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(JSON.parse(result.stdout).result, "result for alpha\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("list --json emits bounded summaries and scopes to the active root session", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const current = writeMeta(home, cwd, "current", { rootSessionId: "root-current", workstreamId: "ws-current", task: "x".repeat(10_000) });
      writeMeta(home, cwd, "old", { rootSessionId: "root-old", workstreamId: "ws-old", task: "old task" });
      writeMeta(home, cwd, "other-workstream", { rootSessionId: "root-current", workstreamId: "ws-other", task: "other task" });

      const result = runCli(["list", "--json"], { TANGO_HOME: home, TANGO_ROOT_SESSION_ID: "root-current", TANGO_WORKSTREAM_ID: "ws-current" }, cwd);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = JSON.parse(result.stdout);
      assert.deepStrictEqual(body.agents.map((a: any) => a.name), ["current"]);
      assert.strictEqual(body.agents[0].runId, current.runId);
      assert.ok(body.agents[0].task.length < 300);
      assert.strictEqual(body.agents[0].taskTruncated, true);
      assert.strictEqual(body.agents[0].tmuxSocket, undefined);
      assert.strictEqual(body.agents[0].homeDir, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects invalid harness, mode, flags, and numeric ranges", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const env = { TANGO_HOME: home };
      for (const args of [
        ["start", "a", "--harness", "typo", "--dry-run"],
        ["start", "a", "--mode", "typo", "--dry-run"],
        ["list", "--bogus"],
        ["look", "--run-id", "missing", "--lines", "0"],
        ["server", "--port", "70000"],
        ["wait", "a", "--timeout", "nope"],
      ]) {
        const result = runCli(args, env, cwd);
        assert.notStrictEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
        assert.match(`${result.stdout}${result.stderr}`, /Invalid|Unknown flag|Missing value|Agent not found/);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("tails output logs by bounded lines", () => {
    const cwd = tempDir();
    const home = tempDir();
    try {
      const meta = writeMeta(home, cwd, "tailer");
      writeFileSync(join(meta.runDir, "output.log"), Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n"));
      const result = runCli(["look", "--run-id", "run_tailer", "--lines", "3", "--json"], { TANGO_HOME: home }, cwd);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(JSON.parse(result.stdout).output, "line-18\nline-19\nline-20");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores stale file-based server discovery but preserves env override", () => {
    const home = tempDir();
    const previousHome = process.env.TANGO_HOME;
    const previousUrl = process.env.TANGO_SERVER_URL;
    try {
      process.env.TANGO_HOME = home;
      delete process.env.TANGO_SERVER_URL;
      mkdirSync(dirname(serverDiscoveryPath()), { recursive: true });
      writeFileSync(serverDiscoveryPath(), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:1", pid: 99999999, startedAt: "old" }));
      try {
        assert.strictEqual(readServerDiscovery(), undefined);
        process.env.TANGO_SERVER_URL = "http://127.0.0.1:43210";
        assert.strictEqual(readServerDiscovery()?.url, "http://127.0.0.1:43210");
      } finally {
        if (previousHome === undefined) delete process.env.TANGO_HOME; else process.env.TANGO_HOME = previousHome;
        if (previousUrl === undefined) delete process.env.TANGO_SERVER_URL; else process.env.TANGO_SERVER_URL = previousUrl;
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

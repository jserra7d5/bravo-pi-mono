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

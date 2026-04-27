import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectSlug } from "./paths.js";
import { fileURLToPath } from "node:url";
import { publishArtifact, readServerDiscovery, serverDiscoveryPath, startTangoServer } from "./server.js";
import { runOneshot } from "./start.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "tango-rollout-compat-"));
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function makeMeta(options: { name: string; runDir: string; cwd: string; mode: "oneshot" | "interactive"; status?: string; task: string; summary?: string; resultFinalizedAt?: string; resultRequired?: boolean }) {
  return {
    name: options.name,
    harness: "pi",
    mode: options.mode,
    status: options.status ?? "running",
    cwd: options.cwd,
    task: options.task,
    runDir: options.runDir,
    homeDir: join(options.runDir, "home"),
    tmuxSocket: join(options.runDir, "tmux.sock"),
    tmuxSession: "tango",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    summary: options.summary,
    resultFinalizedAt: options.resultFinalizedAt,
    resultRequired: options.resultRequired,
  };
}

describe("rollout compatibility", () => {
  it("runs read-only CLI commands without a Tango server", () => {
    const home = tempHome();
    try {
      const result = runCli(["list", "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.deepStrictEqual(JSON.parse(result.stdout), { ok: true, agents: [] });
      assert.ok(!existsSync(join(home, "server", "server.json")), "list must not create server discovery state");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs tango roles list without a Tango server", () => {
    const home = tempHome();
    try {
      const result = runCli(["roles", "list", "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.roles));
      assert.ok(!existsSync(join(home, "server", "server.json")), "roles list must not create server discovery state");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses package status-protocol even when a stale user include exists", () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, "includes"), { recursive: true });
      mkdirSync(join(home, "roles"), { recursive: true });
      writeFileSync(join(home, "includes", "status-protocol.md"), "STALE STATUS: tango status done \"summary\"\n");
      writeFileSync(join(home, "roles", "stale-check.md"), "---\nname: stale-check\nincludes: [status-protocol]\n---\nRole body\n");
      const result = runCli(["roles", "show", "stale-check", "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.match(body.system, /--result-file <path>/);
      assert.doesNotMatch(body.system, /STALE STATUS/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not auto-start a server from tango start", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const result = runCli([
        "start",
        "dry-run-agent",
        "--harness",
        "generic",
        "--mode",
        "interactive",
        "--dry-run",
        "--json",
        "rollout smoke",
      ], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.agent.name, "dry-run-agent");
      assert.ok(!existsSync(join(home, "server", "server.json")), "tango start must not create server discovery state");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prints discovered dashboard URLs without starting another server", () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, "server"), { recursive: true });
      writeFileSync(join(home, "server", "server.json"), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:43117", pid: process.pid, startedAt: "file" }));
      const open = runCli(["server", "url"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(open.status, 0, open.stderr);
      assert.strictEqual(open.stdout.trim(), "http://127.0.0.1:43117");

      writeFileSync(join(home, "server", "server.json"), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:43118", token: "dev token", pid: process.pid, startedAt: "file" }));
      const authed = runCli(["server", "url"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(authed.status, 0, authed.stderr);
      assert.strictEqual(authed.stdout.trim(), "http://127.0.0.1:43118\ntoken: dev token\nUse the token as a Bearer token, or paste it into the dashboard once prompted.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects result-required interactive done without a result file or summary-only escape", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "interactive-a");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "interactive-a", runDir, cwd, mode: "interactive", task: "write a report", resultRequired: true })));
      const rejected = runCli(["status", "done", "Completed audit", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.notStrictEqual(rejected.status, 0);
      assert.match(JSON.parse(rejected.stdout).error, /Status summary is not a deliverable/);
      assert.strictEqual(existsSync(join(runDir, "result.md")), false);

      const summaryOnly = runCli(["status", "done", "Completed audit", "--summary-only", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.notStrictEqual(summaryOnly.status, 0);
      assert.match(JSON.parse(summaryOnly.stdout).error, /required deliverable/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows explicit summary-only only for runs with no required deliverable", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "interactive-summary-only");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "interactive-summary-only", runDir, cwd, mode: "interactive", task: "quick status", resultRequired: false })));

      const summaryOnly = runCli(["status", "done", "Completed status-only task", "--summary-only", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(summaryOnly.status, 0, summaryOnly.stderr);
      assert.strictEqual(existsSync(join(runDir, "result.md")), false);
      const body = JSON.parse(summaryOnly.stdout);
      assert.strictEqual(body.agent.summary, "Completed status-only task");
      assert.ok(body.agent.resultSummaryOnlyAt);

      const fetched = runCli(["result", "interactive-summary-only", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(fetched.status, 0, fetched.stderr);
      const fetchedBody = JSON.parse(fetched.stdout);
      assert.strictEqual(fetchedBody.result, "");
      assert.strictEqual(fetchedBody.resultReady, false);
      assert.match(fetchedBody.resultIssue, /summary-only/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects placeholder result files for required deliverables", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "interactive-placeholder");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "interactive-placeholder", runDir, cwd, mode: "interactive", task: "deliver audit findings", resultRequired: true })));
      const source = join(cwd, "placeholder.md");
      writeFileSync(source, "Read-only investigation complete; deliverable provided in final response.\n");
      const result = runCli(["status", "done", "Short summary", "--result-file", source, "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.notStrictEqual(result.status, 0);
      assert.match(JSON.parse(result.stdout).error, /placeholder/);
      assert.strictEqual(existsSync(join(runDir, "result.md")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects suspiciously short report-like result files when a deliverable is required", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "interactive-short-report");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "interactive-short-report", runDir, cwd, mode: "interactive", task: "write a retrospective report", resultRequired: true })));
      const source = join(cwd, "short.md");
      writeFileSync(source, "Done.\n");
      const result = runCli(["status", "done", "Short summary", "--result-file", source, "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.notStrictEqual(result.status, 0);
      assert.match(JSON.parse(result.stdout).error, /suspiciously short/);
      assert.strictEqual(existsSync(join(runDir, "result.md")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("copies an explicit status result file into result.md", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "interactive-b");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "interactive-b", runDir, cwd, mode: "interactive", task: "simple task" })));
      const source = join(cwd, "deliverable.md");
      writeFileSync(source, "Full deliverable\nDetails here.\n");
      const result = runCli(["status", "done", "Short summary", "--result-file", source, "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(readFileSync(join(runDir, "result.md"), "utf8"), "Full deliverable\nDetails here.\n");
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.agent.summary, "Short summary");
      assert.ok(body.agent.resultFinalizedAt);

      const fetched = runCli(["result", "interactive-b", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(fetched.status, 0, fetched.stderr);
      assert.strictEqual(JSON.parse(fetched.stdout).resultReady, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not return a summary while a terminal oneshot result is still finalizing", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "oneshot-a");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "oneshot-a", runDir, cwd, mode: "oneshot", status: "done", task: "t", summary: "early summary" })));
      const result = runCli(["result", "oneshot-a", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.resultReady, false);
      assert.match(body.resultIssue, /No finalized deliverable result\.md/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not treat oneshot thinking-only/raw json as a valid deliverable", async () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "oneshot-thinking");
      mkdirSync(runDir, { recursive: true });
      const script = join(cwd, "emit-thinking.mjs");
      writeFileSync(script, "console.log(JSON.stringify({type:'thinking', text:'secret thoughts'}));\n");
      const meta = makeMeta({ name: "oneshot-thinking", runDir, cwd, mode: "oneshot", status: "running", task: "audit findings" });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(meta));
      await runOneshot(meta as any, { command: process.execPath, args: [script], cwd, env: process.env as Record<string, string>, resultParser: "pi-json" });
      assert.strictEqual(readFileSync(join(runDir, "result.md"), "utf8"), "");
      assert.match(JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")).resultIssue, /No final assistant text/);
      assert.match(readFileSync(join(runDir, "output.log"), "utf8"), /thinking/);
      const fetched = runCli(["result", "oneshot-thinking", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(fetched.status, 0, fetched.stderr);
      const body = JSON.parse(fetched.stdout);
      assert.strictEqual(body.result, "");
      assert.strictEqual(body.resultReady, false);
      assert.match(body.resultIssue, /No final assistant text/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("extracts normal oneshot final assistant text", async () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "oneshot-final");
      mkdirSync(runDir, { recursive: true });
      const script = join(cwd, "emit-final.mjs");
      writeFileSync(script, "console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'Final deliverable\\nWith details.'}]}}));\n");
      const meta = makeMeta({ name: "oneshot-final", runDir, cwd, mode: "oneshot", status: "running", task: "simple task" });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(meta));
      await runOneshot(meta as any, { command: process.execPath, args: [script], cwd, env: process.env as Record<string, string>, resultParser: "pi-json" });
      assert.strictEqual(readFileSync(join(runDir, "result.md"), "utf8"), "Final deliverable\nWith details.");
      const fetched = runCli(["result", "oneshot-final", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(fetched.status, 0, fetched.stderr);
      const body = JSON.parse(fetched.stdout);
      assert.strictEqual(body.resultReady, true);
      assert.strictEqual(body.resultIssue, undefined);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("warns when report-like deliverables are suspiciously short", () => {
    const home = tempHome();
    const cwd = tempHome();
    try {
      const runDir = join(home, "runs", projectSlug(cwd), "short-audit");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "metadata.json"), JSON.stringify(makeMeta({ name: "short-audit", runDir, cwd, mode: "interactive", status: "done", task: "produce audit findings", resultFinalizedAt: "2024-01-01T00:01:00.000Z" })));
      writeFileSync(join(runDir, "result.md"), "Done.\n");
      const fetched = runCli(["result", "short-audit", "--run-dir", runDir, "--json"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" }, cwd);
      assert.strictEqual(fetched.status, 0, fetched.stderr);
      const body = JSON.parse(fetched.stdout);
      assert.strictEqual(body.resultReady, true);
      assert.strictEqual(body.resultIssue, undefined);
      assert.match(body.resultWarning, /suspiciously short/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown tango server positional arguments instead of starting another server", () => {
    const home = tempHome();
    try {
      const result = runCli(["server", "wat"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Usage: tango server/);
      assert.ok(!existsSync(join(home, "server", "server.json")), "invalid server command must not create discovery state");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers TANGO_SERVER_URL/TANGO_SERVER_TOKEN over discovery file", () => {
    const previousHome = process.env.TANGO_HOME;
    const previousUrl = process.env.TANGO_SERVER_URL;
    const previousToken = process.env.TANGO_SERVER_TOKEN;
    const home = tempHome();
    try {
      process.env.TANGO_HOME = home;
      mkdirSync(dirname(serverDiscoveryPath()), { recursive: true });
      writeFileSync(serverDiscoveryPath(), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:1", token: "file-token", pid: process.pid, startedAt: "file" }));
      process.env.TANGO_SERVER_URL = "http://127.0.0.1:2";
      process.env.TANGO_SERVER_TOKEN = "env-token";
      assert.deepStrictEqual(readServerDiscovery(), { schemaVersion: 1, url: "http://127.0.0.1:2", token: "env-token", pid: 0, startedAt: "env" });
      delete process.env.TANGO_SERVER_URL;
      delete process.env.TANGO_SERVER_TOKEN;
      assert.strictEqual(readServerDiscovery()?.token, "file-token");
    } finally {
      if (previousHome === undefined) delete process.env.TANGO_HOME; else process.env.TANGO_HOME = previousHome;
      if (previousUrl === undefined) delete process.env.TANGO_SERVER_URL; else process.env.TANGO_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.TANGO_SERVER_TOKEN; else process.env.TANGO_SERVER_TOKEN = previousToken;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes its discovery file on shutdown when env discovery overrides are set", async () => {
    const previousHome = process.env.TANGO_HOME;
    const previousUrl = process.env.TANGO_SERVER_URL;
    const previousToken = process.env.TANGO_SERVER_TOKEN;
    const home = tempHome();
    let shutdown: (() => void) | undefined;
    try {
      process.env.TANGO_HOME = home;
      process.env.TANGO_SERVER_URL = "http://127.0.0.1:1";
      process.env.TANGO_SERVER_TOKEN = "env-token";
      const started = await startTangoServer({ port: 0, token: "file-token" });
      shutdown = started.shutdown;
      assert.ok(existsSync(serverDiscoveryPath()), "server should write a discovery file even with env overrides set");
      shutdown();
      shutdown = undefined;
      assert.ok(!existsSync(serverDiscoveryPath()), "shutdown should remove its own discovery file despite env overrides");
    } finally {
      shutdown?.();
      if (previousHome === undefined) delete process.env.TANGO_HOME; else process.env.TANGO_HOME = previousHome;
      if (previousUrl === undefined) delete process.env.TANGO_SERVER_URL; else process.env.TANGO_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.TANGO_SERVER_TOKEN; else process.env.TANGO_SERVER_TOKEN = previousToken;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns artifact URLs only when server discovery is available", async () => {
    const previousHome = process.env.TANGO_HOME;
    const previousUrl = process.env.TANGO_SERVER_URL;
    const previousToken = process.env.TANGO_SERVER_TOKEN;
    const home = tempHome();
    try {
      process.env.TANGO_HOME = home;
      delete process.env.TANGO_SERVER_URL;
      delete process.env.TANGO_SERVER_TOKEN;
      const artifactRoot = join(home, "artifact-source");
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(join(artifactRoot, "index.html"), "artifact");

      const withoutServer = await publishArtifact(artifactRoot);
      assert.strictEqual(withoutServer.url, undefined);

      process.env.TANGO_SERVER_URL = "http://127.0.0.1:43117";
      process.env.TANGO_SERVER_TOKEN = "token";
      const withServer = await publishArtifact(artifactRoot);
      assert.match(withServer.url ?? "", /^http:\/\/127\.0\.0\.1:43117\/a\/art_/);
      assert.match(withServer.url ?? "", /\/index\.html$/);
    } finally {
      if (previousHome === undefined) delete process.env.TANGO_HOME; else process.env.TANGO_HOME = previousHome;
      if (previousUrl === undefined) delete process.env.TANGO_SERVER_URL; else process.env.TANGO_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.TANGO_SERVER_TOKEN; else process.env.TANGO_SERVER_TOKEN = previousToken;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serves built dashboard static assets", async () => {
    const previousHome = process.env.TANGO_HOME;
    const home = tempHome();
    let shutdown: (() => void) | undefined;
    try {
      process.env.TANGO_HOME = home;
      const started = await startTangoServer({ port: 0, token: "static-token" });
      shutdown = started.shutdown;
      const address = started.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "dist");
      const assetsDir = join(dist, "assets");
      const asset = readdirSync(assetsDir).find((name) => name.endsWith(".js") || name.endsWith(".css"));
      assert.ok(asset, "dashboard build should contain at least one static asset");
      const res = await fetch(`http://127.0.0.1:${port}/assets/${asset}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), readFileSync(join(assetsDir, asset!), "utf8"));
    } finally {
      shutdown?.();
      if (previousHome === undefined) delete process.env.TANGO_HOME; else process.env.TANGO_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

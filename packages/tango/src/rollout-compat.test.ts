import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishArtifact, readServerDiscovery, serverDiscoveryPath, startTangoServer } from "./server.js";

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
      writeFileSync(join(home, "server", "server.json"), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:43117", pid: 123, startedAt: "file" }));
      const open = runCli(["server", "url"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(open.status, 0, open.stderr);
      assert.strictEqual(open.stdout.trim(), "http://127.0.0.1:43117");

      writeFileSync(join(home, "server", "server.json"), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:43118", token: "dev token", pid: 123, startedAt: "file" }));
      const authed = runCli(["server", "url"], { TANGO_HOME: home, TANGO_SERVER_URL: "", TANGO_SERVER_TOKEN: "" });
      assert.strictEqual(authed.status, 0, authed.stderr);
      assert.strictEqual(authed.stdout.trim(), "http://127.0.0.1:43118/?token=dev%20token");
    } finally {
      rmSync(home, { recursive: true, force: true });
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
      writeFileSync(serverDiscoveryPath(), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:1", token: "file-token", pid: 123, startedAt: "file" }));
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

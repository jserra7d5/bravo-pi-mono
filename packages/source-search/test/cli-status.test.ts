import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sourceSearchExtension from "../extensions/pi/index.js";

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runCli(args: string[]) {
  const cli = new URL("../src/cli.js", import.meta.url);
  return JSON.parse(run(process.execPath, [cli.pathname, ...args])) as { ok: boolean; indexedFiles: number; warnings?: string[]; cacheDir?: string };
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "source-search-status-"));
  run("git", ["init"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "dist"), { recursive: true });
  await mkdir(join(repo, ".bravo"), { recursive: true });
  await writeFile(join(repo, "src", "a.ts"), "export const alpha = 1;\n");
  await writeFile(join(repo, "dist", "generated.ts"), "export const generated = true;\n");
  await writeFile(join(repo, ".bravo", "source-search.json"), JSON.stringify({ enabled: true, exclude: ["dist/**"], maxFileBytes: 1048576 }));
  return repo;
}

test("status reports manifest indexed count and keeps cacheDir out of warnings", async () => {
  const repo = await createRepo();

  const indexed = runCli(["index", "--repo", repo, "--force", "--json"]);
  assert.equal(indexed.ok, true);
  assert.equal(indexed.indexedFiles, 2);

  const status = runCli(["status", "--repo", repo, "--json"]);
  assert.equal(status.ok, true);
  assert.equal(status.indexedFiles, indexed.indexedFiles);
  assert.ok(status.cacheDir);
  assert.deepEqual(status.warnings ?? [], []);
});

test("extension injects source-search CLI into bash tool PATH", async () => {
  const repo = await createRepo();
  runCli(["index", "--repo", repo, "--force", "--json"]);

  const tools: Array<{ name: string; execute: Function }> = [];
  await sourceSearchExtension({ registerTool: (tool: never) => { tools.push(tool as never); }, on: () => undefined } as never);
  const bash = tools.find((tool) => tool.name === "bash");
  assert.ok(bash, "extension should register bash wrapper");

  const result = await bash.execute("bash-smoke", { command: `command -v source-search && source-search status --repo ${repo} --json` }, undefined, undefined);
  const text = result.content?.[0]?.text ?? "";
  assert.match(text, /source-search/);
  assert.match(text, /"indexedFiles":2/);
  assert.match(text, /"warnings":\[\]/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sourceSearchExtension from "../extensions/pi/index.js";
import { rankedSearch } from "../src/api.js";

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "source-search-live-"));
  run("git", ["init"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "dist"), { recursive: true });
  await mkdir(join(repo, ".bravo"), { recursive: true });
  await writeFile(join(repo, "src", "a.ts"), "export const alpha = 1;\n");
  await writeFile(join(repo, "dist", "generated.ts"), "export const generated = true;\n");
  await writeFile(join(repo, ".bravo", "source-search.json"), JSON.stringify({ enabled: true, exclude: ["dist/**"] }));
  return repo;
}

test("live query works without source-search config and honors agent ignore files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "source-search-no-config-"));
  run("git", ["init"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "visible.ts"), "export const liveNeedle = true;\n");
  await writeFile(join(repo, "src", "hidden.ts"), "export const ignoredNeedle = true;\n");
  await writeFile(join(repo, ".agentignore"), "src/hidden.ts\n");

  const visible = await rankedSearch({ cwd: repo, query: "liveNeedle", limit: 5 });
  assert.equal(visible.ok, true);
  assert.equal(visible.indexFreshness, "live");
  assert.equal(visible.hits.some((hit) => hit.path === "src/visible.ts"), true);

  const hidden = await rankedSearch({ cwd: repo, query: "ignoredNeedle", limit: 5 });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.hits.some((hit) => hit.path === "src/hidden.ts"), false);
});

test("live query honors directory pi ignores and config excludes", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, ".piignore"), "pi-hidden/\n");
  await mkdir(join(repo, "nested", "pi-hidden"), { recursive: true });
  await writeFile(join(repo, "nested", "pi-hidden", "secret.ts"), "export const hiddenNeedle = true;\n");
  await writeFile(join(repo, "dist", "generated.ts"), "export const generatedNeedle = true;\n");

  const hidden = await rankedSearch({ cwd: repo, query: "hiddenNeedle generatedNeedle", limit: 10 });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.hits.some((hit) => hit.path.includes("pi-hidden")), false);
  assert.equal(hidden.hits.some((hit) => hit.path.startsWith("dist/")), false);
});

test("source-search config cannot disable live search", async () => {
  const repo = await mkdtemp(join(tmpdir(), "source-search-enabled-false-"));
  run("git", ["init"], repo);
  await mkdir(join(repo, ".bravo"), { recursive: true });
  await writeFile(join(repo, ".bravo", "source-search.json"), JSON.stringify({ enabled: false }));
  await writeFile(join(repo, "visible.txt"), "enabled false should not hide this needle\n");

  const result = await rankedSearch({ cwd: repo, query: "needle", limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.hits.some((hit) => hit.path === "visible.txt"), true);
});

test("missing path does not broaden to parent git checkout", async () => {
  const repo = await mkdtemp(join(tmpdir(), "source-search-missing-path-"));
  run("git", ["init"], repo);
  await writeFile(join(repo, "visible.txt"), "missing path should not find this needle\n");

  const result = await rankedSearch({ cwd: repo, path: "missing", query: "needle", limit: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /No searchable directory/);
});

test("live query searches non-git directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "source-search-plain-dir-"));
  await mkdir(join(dir, "notes"), { recursive: true });
  await writeFile(join(dir, "notes", "plain.txt"), "plain directory needle\n");

  const result = await rankedSearch({ cwd: dir, query: "plain directory needle", limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.hits.some((hit) => hit.path === "notes/plain.txt"), true);
});

test("path can search an arbitrary child checkout without workspace configuration", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "source-search-workspace-"));
  await mkdir(join(workspace, ".bravo"), { recursive: true });
  await writeFile(join(workspace, ".bravo", "source-search.json"), JSON.stringify({ workspace: { repos: [{ name: "other", path: "other" }] } }));
  const child = join(workspace, "child-repo");
  await mkdir(child, { recursive: true });
  run("git", ["init"], child);
  await writeFile(join(child, "needle.txt"), "workspace needle\n");

  const result = await rankedSearch({ cwd: workspace, path: "child-repo", query: "workspace needle", limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.hits[0]?.path, "needle.txt");
});

test("query emits structured snippets and matched fields", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "context.ts"), "one\n  two\n    target alpha();\n  four\nfive\nsix\n");
  const result = await rankedSearch({ cwd: repo, query: "target alpha", limit: 5 });
  const hit = result.hits.find((candidate) => candidate.path === "src/context.ts");
  assert.ok(hit);
  assert.equal(hit.line, 3);
  assert.equal(hit.snippet, "target alpha();");
  assert.deepEqual(hit.matchedFields, ["content"]);
  assert.match(hit.snippets?.[0]?.text ?? "", /target alpha/);
});

test("filename matches, boosts rerank, and excludeTerms filter", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "needle-filename.ts"), "export const unrelated = true;\n");
  await writeFile(join(repo, "src", "labor.ts"), "common topic about labor scheduling\n");
  await writeFile(join(repo, "src", "location.ts"), "common topic about location setup\n");
  await writeFile(join(repo, "src", "fixture.ts"), "common topic about labor fixture noise\n");

  const filename = await rankedSearch({ cwd: repo, query: "needle filename", limit: 5 });
  assert.deepEqual(filename.hits.find((hit) => hit.path === "src/needle-filename.ts")?.matchedFields, ["filename", "path"]);

  const result = await rankedSearch({ cwd: repo, query: "common topic", boosts: [{ term: "labor", weight: 2 }, { term: "location", weight: 0.5 }], excludeTerms: ["fixture"], limit: 5 });
  assert.equal(result.hits.some((hit) => hit.path === "src/fixture.ts"), false);
  assert.equal(result.hits[0]?.path, "src/labor.ts");
});

test("query rejects backend syntax and invalid boost weights", async () => {
  const repo = await createRepo();
  const syntax = await rankedSearch({ cwd: repo, query: "path:src OR alpha" });
  assert.equal(syntax.ok, false);
  assert.match(syntax.error ?? "", /QueryError/);
  const badWeight = await rankedSearch({ cwd: repo, query: "alpha", boosts: [{ term: "alpha", weight: 0 }] });
  assert.equal(badWeight.ok, false);
  assert.match(badWeight.error ?? "", /boost weight/);
});

test("extension registers ranked_search only and does not mutate environment", async () => {
  const beforePath = process.env.PATH;
  const beforeCli = process.env.SOURCE_SEARCH_CLI;
  const beforeSidecar = process.env.SOURCE_SEARCH_SIDECAR;
  const tools: Array<{ name: string; execute: Function }> = [];
  await sourceSearchExtension({ registerTool: (tool: never) => { tools.push(tool as never); }, on: () => undefined } as never);
  assert.deepEqual(tools.map((tool) => tool.name), ["ranked_search"]);
  assert.equal(process.env.PATH, beforePath);
  assert.equal(process.env.SOURCE_SEARCH_CLI, beforeCli);
  assert.equal(process.env.SOURCE_SEARCH_SIDECAR, beforeSidecar);
});

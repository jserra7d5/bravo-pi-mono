import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sourceSearchExtension from "../extensions/pi/index.js";
import { rankedSearch } from "../src/api.js";
import { queryRepo } from "../src/live.js";

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
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

test("scoped git path uses git-visible files and omits ignored untracked files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "source-search-scoped-git-"));
  run("git", ["init"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "src/ignored.ts\n");
  await writeFile(join(repo, "src", "visible.ts"), "export const visibleNeedle = true;\n");
  await writeFile(join(repo, "src", "ignored.ts"), "export const ignoredNeedle = true;\n");

  const visible = await rankedSearch({ cwd: repo, path: "src", query: "visibleNeedle", limit: 5 });
  assert.equal(visible.ok, true);
  assert.equal(visible.hits.some((hit) => hit.path === "src/visible.ts"), true);

  const ignored = await rankedSearch({ cwd: repo, path: "src", query: "ignoredNeedle", limit: 5 });
  assert.equal(ignored.ok, true);
  assert.equal(ignored.hits.some((hit) => hit.path === "src/ignored.ts"), false);

  const ignoredExplicitFile = await rankedSearch({ cwd: repo, path: "src/ignored.ts", query: "ignoredNeedle", limit: 5 });
  assert.equal(ignoredExplicitFile.ok, true);
  assert.equal(ignoredExplicitFile.hits.some((hit) => hit.path === "src/ignored.ts"), false);
});

test("git path prefixes are treated as literal pathspecs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "source-search-literal-pathspec-"));
  run("git", ["init"], repo);
  await mkdir(join(repo, ":(glob)**"), { recursive: true });
  await mkdir(join(repo, "*"), { recursive: true });
  await mkdir(join(repo, "sibling"), { recursive: true });
  await writeFile(join(repo, ":(glob)**", "magic.txt"), "literal pathspec magic needle\n");
  await writeFile(join(repo, "*", "star.txt"), "literal pathspec star needle\n");
  await writeFile(join(repo, "sibling", "broad.txt"), "literal pathspec magic needle\nliteral pathspec star needle\n");

  const magic = await rankedSearch({ cwd: repo, path: ":(glob)**", query: "magic needle", limit: 10 });
  assert.equal(magic.ok, true);
  assert.equal(magic.hits.some((hit) => hit.path === ":(glob)**/magic.txt"), true);
  assert.equal(magic.hits.some((hit) => hit.path === "sibling/broad.txt"), false);

  const star = await rankedSearch({ cwd: repo, path: "*", query: "star needle", limit: 10 });
  assert.equal(star.ok, true);
  assert.equal(star.hits.some((hit) => hit.path === "*/star.txt"), true);
  assert.equal(star.hits.some((hit) => hit.path === "sibling/broad.txt"), false);
});

test("git timeout fallback does not duplicate partially emitted candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-git-timeout-"));
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "dup.txt"), "timeout duplicate needle\n");
  const bin = await mkdtemp(join(tmpdir(), "source-search-fake-git-"));
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, "#!/bin/sh\nprintf 'dup.txt\\0'\nexec sleep 5\n");
  await chmod(fakeGit, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await queryRepo(root, "timeout duplicate needle", 10, undefined, undefined, undefined, { budgets: { gitTimeoutMs: 50 } });
    assert.equal(result.ok, true);
    assert.equal(result.warnings?.some((warning) => warning.startsWith("git_timeout")), true);
    assert.deepEqual(result.hits.map((hit) => hit.path), ["dup.txt"]);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("git discovery stops promptly when maxCandidates is reached", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-git-budget-"));
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "first.txt"), "bounded git needle\n");
  const bin = await mkdtemp(join(tmpdir(), "source-search-fake-git-"));
  const marker = join(root, "fake-git-finished");
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, `#!/bin/sh
printf 'first.txt\\0'
sleep 5
printf done > "$SOURCE_SEARCH_FAKE_GIT_MARKER"
`);
  await chmod(fakeGit, 0o755);

  const previousPath = process.env.PATH;
  const previousMarker = process.env.SOURCE_SEARCH_FAKE_GIT_MARKER;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SOURCE_SEARCH_FAKE_GIT_MARKER = marker;
  try {
    const result = await queryRepo(root, "bounded git needle", 10, undefined, undefined, undefined, { budgets: { maxCandidates: 1, gitTimeoutMs: 5_000 } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.hits.map((hit) => hit.path), ["first.txt"]);
    assert.equal(result.warnings?.some((warning) => warning.startsWith("candidate_budget_exceeded")), true);
    assert.equal(await readFile(marker, "utf8").catch(() => null), null);
  } finally {
    process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.SOURCE_SEARCH_FAKE_GIT_MARKER;
    else process.env.SOURCE_SEARCH_FAKE_GIT_MARKER = previousMarker;
  }
});

test("git failure does not fall back to ignored filesystem content", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-git-error-no-fallback-"));
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "private.txt\n");
  await writeFile(join(root, "private.txt"), "fallback leak needle\n");
  const bin = await mkdtemp(join(tmpdir(), "source-search-fake-git-"));
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, "#!/bin/sh\nexit 1\n");
  await chmod(fakeGit, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await queryRepo(root, "fallback leak needle", 10);
    assert.equal(result.ok, true);
    assert.equal(result.warnings?.some((warning) => warning.startsWith("git_error")), true);
    assert.deepEqual(result.hits.map((hit) => hit.path), []);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("git source-search ignores are filtered before consuming candidate budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-git-ignore-budget-"));
  run("git", ["init"], root);
  await mkdir(join(root, "aaa-ignored"), { recursive: true });
  await mkdir(join(root, "zzz"), { recursive: true });
  await writeFile(join(root, ".agentignore"), "aaa-ignored/\n");
  for (let i = 0; i < 10; i += 1) await writeFile(join(root, "aaa-ignored", `${i}.txt`), "hidden needle\n");
  await writeFile(join(root, "zzz", "visible.txt"), "visible needle\n");

  const result = await queryRepo(root, "visible needle", 5, undefined, undefined, undefined, { budgets: { maxCandidates: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.hits.some((hit) => hit.path === "zzz/visible.txt"), true);
});

test("non-git deep tree finds a leaf without recursive traversal overflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-deep-"));
  let dir = root;
  for (let i = 0; i < 350; i += 1) {
    dir = join(dir, "d");
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(dir, "leaf.txt"), "deep robustness needle\n");

  const result = await rankedSearch({ cwd: root, query: "robustness needle", limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.hits.some((hit) => hit.path.endsWith("leaf.txt")), true);
});

test("filesystem ignore directories are pruned before consuming candidate budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-prune-"));
  await mkdir(join(root, "aaa-ignored"), { recursive: true });
  await writeFile(join(root, ".agentignore"), "aaa-ignored/\n");
  for (let i = 0; i < 20; i += 1) await writeFile(join(root, "aaa-ignored", `hidden-${i}.txt`), "hidden budget needle\n");
  await writeFile(join(root, "zzz-visible.txt"), "visible budget needle\n");

  const result = await queryRepo(root, "visible budget needle", 5, undefined, undefined, undefined, { budgets: { maxCandidates: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.hits.some((hit) => hit.path === "zzz-visible.txt"), true);
});

test("candidate and read budgets return warning-coded partial responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-budgets-"));
  for (let i = 0; i < 10; i += 1) await writeFile(join(root, `f-${String(i).padStart(2, "0")}.txt`), `wide needle ${i}\n`);

  const candidateLimited = await queryRepo(root, "wide needle", 5, undefined, undefined, undefined, { budgets: { maxCandidates: 3 } });
  assert.equal(candidateLimited.ok, true);
  assert.equal(candidateLimited.warnings?.some((warning) => warning.startsWith("candidate_budget_exceeded")), true);

  const readLimited = await queryRepo(root, "wide needle", 5, undefined, undefined, undefined, { budgets: { maxFilesRead: 1 } });
  assert.equal(readLimited.ok, true);
  assert.equal(readLimited.warnings?.some((warning) => warning.startsWith("file_read_budget_exceeded")), true);

  const byteLimited = await queryRepo(root, "wide needle", 5, undefined, undefined, undefined, { budgets: { maxBytesRead: 1 } });
  assert.equal(byteLimited.ok, true);
  assert.equal(byteLimited.warnings?.some((warning) => warning.startsWith("byte_read_budget_exceeded")), true);
});

test("large or binary candidates are skipped with diagnostic warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-binary-"));
  await writeFile(join(root, "binary.txt"), Buffer.from("needle\0binary"));

  const result = await rankedSearch({ cwd: root, query: "needle", limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.hits.length, 0);
  assert.equal(result.warnings?.some((warning) => warning.startsWith("large_or_binary_files_skipped")), true);
});

test("top-k retention preserves score and path tie ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-topk-"));
  await writeFile(join(root, "b.txt"), "same tie needle\n");
  await writeFile(join(root, "a.txt"), "same tie needle\n");

  const result = await rankedSearch({ cwd: root, query: "same tie needle", limit: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.hits[0]?.path, "a.txt");
});

test("aborted search returns warning-coded cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-abort-"));
  await writeFile(join(root, "needle.txt"), "abort needle\n");
  const ac = new AbortController();
  ac.abort();

  const result = await rankedSearch({ cwd: root, query: "needle", signal: ac.signal });
  assert.equal(result.ok, false);
  assert.equal(result.warnings?.some((warning) => warning.startsWith("search_aborted")), true);
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

test("extension execute delegates cancellation to rankedSearch and renders warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-search-extension-abort-"));
  await writeFile(join(root, "needle.txt"), "abort needle\n");
  const tools: Array<{ name: string; execute: Function }> = [];
  await sourceSearchExtension({ registerTool: (tool: never) => { tools.push(tool as never); }, on: () => undefined } as never);
  const ac = new AbortController();
  ac.abort();

  const result = await tools[0]!.execute("call", { query: "needle" }, ac.signal, undefined, { cwd: root });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.warnings?.some((warning: string) => warning.startsWith("search_aborted")), true);
  assert.match(result.content[0].text, /search_aborted/);
});

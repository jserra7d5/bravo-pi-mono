import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sourceSearchExtension from "../extensions/pi/index.js";

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runCliRaw(args: string[]) {
  const cli = new URL("../src/cli.js", import.meta.url);
  return spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function runCli(args: string[]) {
  const result = runCliRaw(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string; indexedFiles?: number; warnings?: string[]; cacheDir?: string; hits?: Array<{ path: string; score: number; line?: number | null; snippet?: string; snippets?: Array<{ lineStart: number; lineEnd: number; text: string; truncated: boolean; truncatedBefore?: boolean; truncatedAfter?: boolean }>; lineStart?: number | null; lineEnd?: number | null; matchedFields?: string[] }>; boosts?: Array<{ term: string; weight: number }>; excludeTerms?: string[] };
}

function runCliError(args: string[]) {
  const result = runCliRaw(args);
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string };
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

test("config validate does not report misleading index status", async () => {
  const repo = await createRepo();
  const validation = runCli(["config", "validate", "--repo", repo, "--json"]);
  assert.equal(validation.ok, true);
  assert.equal(Object.hasOwn(validation, "indexedFiles"), false);
  assert.deepEqual(validation.warnings ?? [], []);
});

test("query emits structured snippet windows and legacy snippet fields", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "context.ts"), "one\n  two\n    target alpha();\n  four\nfive\nsix\n");

  const result = runCli(["query", "--repo", repo, "--query", "target alpha", "--limit", "5", "--json"]);
  assert.equal(result.ok, true);
  const hit = result.hits?.find((candidate) => candidate.path === "src/context.ts");
  assert.ok(hit);
  assert.equal(hit.line, 3);
  assert.equal(hit.snippet, "target alpha();");
  assert.equal(hit.lineStart, 1);
  assert.equal(hit.lineEnd, 5);
  assert.deepEqual(hit.matchedFields, ["content"]);
  assert.equal(hit.snippets?.[0]?.lineStart, 1);
  assert.equal(hit.snippets?.[0]?.lineEnd, 5);
  assert.equal(hit.snippets?.[0]?.truncatedBefore, false);
  assert.equal(hit.snippets?.[0]?.truncatedAfter, true);
  assert.match(hit.snippets?.[0]?.text ?? "", /one\n  two\n    target alpha\(\);\n  four\nfive/);
});

test("query reports filename matched field", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "needle-filename.ts"), "export const unrelated = true;\n");

  const result = runCli(["query", "--repo", repo, "--query", "needle filename", "--limit", "5", "--json"]);
  assert.equal(result.ok, true);
  const hit = result.hits?.find((candidate) => candidate.path === "src/needle-filename.ts");
  assert.ok(hit);
  assert.deepEqual(hit.matchedFields, ["filename", "path"]);
});

test("query snippets match analyzer token boundaries for underscored identifiers", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "identifier.ts"), `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\nconst x = ranked_search();\n`);

  const result = runCli(["query", "--repo", repo, "--query", "ranked", "--limit", "5", "--json"]);
  assert.equal(result.ok, true);
  const hit = result.hits?.find((candidate) => candidate.path === "src/identifier.ts");
  assert.ok(hit);
  assert.equal(hit.line, 21);
  assert.deepEqual(hit.matchedFields, ["content"]);
  assert.match(hit.snippets?.[0]?.text ?? "", /ranked_search/);
});

test("query lineEnd reflects text included after character truncation", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "long.ts"), `${"target ".repeat(200)}\nsecond line\nthird line\n`);

  const result = runCli(["query", "--repo", repo, "--query", "target", "--limit", "5", "--json"]);
  assert.equal(result.ok, true);
  const hit = result.hits?.find((candidate) => candidate.path === "src/long.ts");
  assert.ok(hit);
  assert.equal(hit.snippets?.[0]?.lineStart, 1);
  assert.equal(hit.snippets?.[0]?.lineEnd, 1);
  assert.equal(hit.snippets?.[0]?.truncatedAfter, true);
});

test("query truncates long snippet windows around the matched line", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "long-context.ts"), `${"context ".repeat(200)}\nshort context\nconst x = target_value;\n`);

  const result = runCli(["query", "--repo", repo, "--query", "target", "--limit", "5", "--json"]);
  assert.equal(result.ok, true);
  const hit = result.hits?.find((candidate) => candidate.path === "src/long-context.ts");
  assert.ok(hit);
  assert.equal(hit.snippets?.[0]?.lineStart, 3);
  assert.equal(hit.snippets?.[0]?.lineEnd, 3);
  assert.match(hit.snippets?.[0]?.text ?? "", /target_value/);
});

test("query refreshes incrementally for added, modified, deleted, and newly excluded files", async () => {
  const repo = await createRepo();
  runCli(["index", "--repo", repo, "--force", "--json"]);

  await writeFile(join(repo, "src", "added.ts"), "fresh incremental needle\n");
  let result = runCli(["query", "--repo", repo, "--query", "fresh incremental", "--limit", "10", "--json"]);
  assert.equal(result.ok, true);
  assert.equal(result.hits?.some((hit) => hit.path === "src/added.ts"), true);

  await writeFile(join(repo, "src", "a.ts"), "export const alpha = 'modified incremental';\n");
  result = runCli(["query", "--repo", repo, "--query", "modified incremental", "--limit", "10", "--json"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/a.ts"), true);
  result = runCli(["query", "--repo", repo, "--query", "1", "--limit", "10", "--json"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/a.ts"), false);

  await rm(join(repo, "src", "added.ts"));
  result = runCli(["query", "--repo", repo, "--query", "fresh incremental", "--limit", "10", "--json"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/added.ts"), false);

  await writeFile(join(repo, ".bravo", "source-search.json"), JSON.stringify({ enabled: true, exclude: ["dist/**", "src/a.ts"], maxFileBytes: 1048576 }));
  result = runCli(["query", "--repo", repo, "--query", "modified incremental", "--limit", "10", "--json"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/a.ts"), false);

  const status = runCli(["status", "--repo", repo, "--json"]);
  assert.equal(status.ok, true);
  assert.equal(status.indexedFiles, 1);
});

test("config excludes wildcard patterns with embedded stars", async () => {
  const repo = await createRepo();
  await mkdir(join(repo, "foo-bar"), { recursive: true });
  await writeFile(join(repo, ".bravo", "source-search.json"), JSON.stringify({ enabled: true, exclude: ["pi-session-*.html", "foo-*/**"], maxFileBytes: 1048576 }));
  await writeFile(join(repo, "pi-session-demo.html"), "secret needle in session\n");
  await writeFile(join(repo, "foo-bar", "a.txt"), "glob leak needle\n");

  const session = runCli(["query", "--repo", repo, "--query", "secret needle", "--limit", "10", "--json"]);
  assert.equal(session.ok, true);
  assert.equal(session.hits?.some((hit) => hit.path === "pi-session-demo.html"), false);

  const nested = runCli(["query", "--repo", repo, "--query", "glob leak", "--limit", "10", "--json"]);
  assert.equal(nested.ok, true);
  assert.equal(nested.hits?.some((hit) => hit.path === "foo-bar/a.txt"), false);
});

test("query refresh detects same-size edits with preserved mtime", async () => {
  const repo = await createRepo();
  const file = join(repo, "src", "same-size.txt");
  await writeFile(file, "alpha oldxx\n");
  runCli(["index", "--repo", repo, "--force", "--json"]);
  const before = await stat(file);

  await writeFile(file, "alpha newxx\n");
  await utimes(file, before.atime, before.mtime);

  let result = runCli(["query", "--repo", repo, "--query", "oldxx", "--limit", "10", "--json"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/same-size.txt"), false);
  result = runCli(["query", "--repo", repo, "--query", "newxx", "--limit", "10", "--json"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/same-size.txt"), true);
});

test("query boosts rerank and excludeTerms filter without query DSL", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "labor.ts"), "common topic about labor scheduling\n");
  await writeFile(join(repo, "src", "location.ts"), "common topic about location setup\n");
  await writeFile(join(repo, "src", "fixture.ts"), "common topic about labor fixture noise\n");

  const result = runCli([
    "query", "--repo", repo,
    "--query", "common topic",
    "--boosts", JSON.stringify([{ term: "labor", weight: 2 }, { term: "location", weight: 0.5 }]),
    "--exclude-terms", JSON.stringify(["fixture"]),
    "--limit", "5",
    "--json",
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.boosts, [{ term: "labor", weight: 2 }, { term: "location", weight: 0.5 }]);
  assert.deepEqual(result.excludeTerms, ["fixture"]);
  assert.equal(result.hits?.some((hit) => hit.path === "src/fixture.ts"), false);
  assert.equal(result.hits?.[0]?.path, "src/labor.ts");
});

test("query rejects backend syntax and invalid boost weights", async () => {
  const repo = await createRepo();

  const syntax = runCliError(["query", "--repo", repo, "--query", "path:src OR alpha", "--json"]);
  assert.equal(syntax.ok, false);
  assert.match(syntax.error ?? "", /QueryError/);

  const badWeight = runCliError([
    "query", "--repo", repo,
    "--query", "alpha",
    "--boosts", JSON.stringify([{ term: "alpha", weight: 0 }]),
    "--json",
  ]);
  assert.equal(badWeight.ok, false);
  assert.match(badWeight.error ?? "", /boost weight/);
});

test("excludeTerms use word-boundary matching for single terms", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "contest.ts"), "common contest result\n");
  await writeFile(join(repo, "src", "test.ts"), "common test result\n");

  const result = runCli(["query", "--repo", repo, "--query", "common result", "--exclude-terms", JSON.stringify(["test"]), "--limit", "10", "--json"]);

  assert.equal(result.ok, true);
  assert.equal(result.hits?.some((hit) => hit.path === "src/test.ts"), false);
  assert.equal(result.hits?.some((hit) => hit.path === "src/contest.ts"), true);
});

test("short phrase boosts and excludes require phrase matches", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "src", "alpha.ts"), "common alpha only\n");
  await writeFile(join(repo, "src", "beta.ts"), "common beta only\n");
  await writeFile(join(repo, "src", "phrase.ts"), "common alpha beta phrase\n");

  const excluded = runCli(["query", "--repo", repo, "--query", "common", "--exclude-terms", JSON.stringify(["alpha beta"]), "--limit", "10", "--json"]);
  assert.equal(excluded.ok, true);
  assert.equal(excluded.hits?.some((hit) => hit.path === "src/phrase.ts"), false);
  assert.equal(excluded.hits?.some((hit) => hit.path === "src/alpha.ts"), true);
  assert.equal(excluded.hits?.some((hit) => hit.path === "src/beta.ts"), true);

  const boosted = runCli(["query", "--repo", repo, "--query", "common", "--boosts", JSON.stringify([{ term: "alpha beta", weight: 10 }]), "--limit", "10", "--json"]);
  assert.equal(boosted.ok, true);
  assert.equal(boosted.hits?.[0]?.path, "src/phrase.ts");
  assert.match(boosted.warnings?.join("\n") ?? "", /bounded top-/);
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

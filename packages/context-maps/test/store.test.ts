import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMap, loadMap } from "../src/store.js";
import { createContextMap, readContextMap } from "../src/index.js";
import type { ContextMapArtifact } from "../src/types.js";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function artifact(cwd: string): ContextMapArtifact {
  return { schema_version: 1, map_id: "ctx_test", query: "q", workspace_root: cwd, created_at: new Date().toISOString(), package_version: "0.1.0", retrieval_backends: ["ranked_search"], provenance: [], coverage: { searched_roots: ["."], searched_methods: ["ranked_search"], excluded_roots: [], failed_roots: [], confidence: "medium" }, gaps: [], slices: [{ slice_id: 1, ref: { path: "file.ts", start_line: 2, end_line: 3 }, role: "primary", why: "test", confidence: "high", preview: "b" }], load_bearing_slice_ids: [1], read_history: [] };
}

test("stores and loads artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-map-"));
  try { const a = artifact(dir); await saveMap(dir, a); assert.equal((await loadMap(dir, a.map_id)).map_id, a.map_id); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test("materializes selected line ranges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-map-"));
  try {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "file.ts"), "one\ntwo\nthree\nfour\n");
    const a = artifact(dir); await saveMap(dir, a);
    const out = await readContextMap(dir, a.map_id, [1]);
    assert.equal(out.slices[0]?.content, "two\nthree");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects unknown slice ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-map-"));
  try { const a = artifact(dir); await saveMap(dir, a); await assert.rejects(() => readContextMap(dir, a.map_id, [99]), /unknown slice id/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test("reads maps from a stable repo root when called from a subdirectory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-map-repo-"));
  try {
    run("git", ["init"], dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "needle.ts"), "export const contextMapNeedle = true;\n");
    const out = await createContextMap(join(dir, "src"), { query: "contextMapNeedle", max_slices: 3 });
    assert.equal(out.map_id.startsWith("ctx_"), true);
    const read = await readContextMap(dir, out.map_id, [out.orientation.suggested_read_order[0] ?? 1]);
    assert.match(read.slices[0]?.content ?? "", /contextMapNeedle/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("refuses ignored or denied paths during materialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-map-policy-"));
  try {
    await writeFile(join(dir, ".agentignore"), "hidden.ts\n");
    await writeFile(join(dir, "hidden.ts"), "export const hidden = true;\n");
    const a = artifact(dir);
    a.slices[0]!.ref.path = "hidden.ts";
    await saveMap(dir, a);
    await assert.rejects(() => readContextMap(dir, a.map_id, [1]), /ignored|policy|refused/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects artifacts whose workspace root differs from the caller workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ctx-map-root-mismatch-"));
  const repo = join(parent, "repo");
  try {
    await mkdir(repo, { recursive: true });
    run("git", ["init"], repo);
    await writeFile(join(parent, "sibling.txt"), "sibling content\n");
    const a = artifact(repo);
    a.map_id = "ctx_mismatch";
    a.workspace_root = parent;
    a.slices[0]!.ref.path = "sibling.txt";
    await saveMap(repo, a);
    await assert.rejects(() => readContextMap(repo, a.map_id, [1]), /workspace root does not match/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("exclude refs normalize dot-dot paths for seeded refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctx-map-exclude-"));
  try {
    run("git", ["init"], dir);
    await writeFile(join(dir, "file.ts"), "export const seedExcluded = true;\n");
    const out = await createContextMap(dir, {
      query: "seedExcluded",
      seed: [{ path: "src/../file.ts", start_line: 1, end_line: 1 }],
      exclude: [{ path: "file.ts", start_line: 1, end_line: 1 }],
      max_slices: 1,
    });
    assert.equal(out.orientation.load_bearing_refs.some((ref) => ref.ref.path === "src/../file.ts"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rankedSearch, sourceSearchPolicy, type SearchHit } from "@bravo/source-search";
import { loadMap, saveMap } from "./store.js";
import type { ContextMapArtifact, ContextMapCreateArgs, ContextMapCreateResult, ContextMapReadResult, ContextSlice } from "./types.js";

const execFileAsync = promisify(execFile);
const PACKAGE_VERSION = "0.1.0";
const PER_SLICE_LIMIT = 12_000;
const TOTAL_LIMIT = 40_000;

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try { return (await execFileAsync("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim(); } catch { return undefined; }
}

async function workspaceRoot(cwd: string): Promise<string> { return await git(["rev-parse", "--show-toplevel"], cwd) ?? cwd; }
function mapId(): string { return `ctx_${process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID ?? "local"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^A-Za-z0-9_.-]/g, "_"); }
function preview(hit: SearchHit): string { return (hit.snippets?.[0]?.text ?? hit.snippet ?? "").replace(/\s+/g, " ").slice(0, 240); }
function lineRange(hit: SearchHit): { start: number; end: number } { const s = Math.max(1, Math.floor(hit.lineStart ?? hit.line ?? 1)); const e = Math.max(s, Math.floor(hit.lineEnd ?? s + 40)); return { start: s, end: Math.min(e, s + 120) }; }
function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${isAbsolute(normalized) ? "/" : ""}${parts.join("/")}`;
}
function normalizeRef(ref: { path: string; start_line: number; end_line: number }): { path: string; start_line: number; end_line: number } {
  const start = Math.max(1, Math.floor(ref.start_line));
  const end = Math.max(start, Math.floor(ref.end_line));
  return { path: normalizePath(ref.path), start_line: start, end_line: end };
}
function sameRoot(a: string, b: string): boolean {
  const rel = relative(resolve(a), resolve(b));
  return rel === "";
}
function overlaps(a: { path: string; start_line: number; end_line: number }, b: { path: string; start_line: number; end_line: number }): boolean { return normalizePath(a.path) === normalizePath(b.path) && a.start_line <= b.end_line && b.start_line <= a.end_line; }

export async function createContextMap(cwd: string, args: ContextMapCreateArgs): Promise<ContextMapCreateResult> {
  const root = await workspaceRoot(cwd);
  const max = Math.min(20, Math.max(1, Math.floor(args.max_slices ?? 8)));
  const roots = args.roots?.length ? args.roots : [undefined];
  const responses = await Promise.all(roots.map((path) => rankedSearch({ cwd: root, query: args.query, path, limit: max })));
  if (responses.every((r) => !r.ok && !r.hits.length)) throw new Error(`AdapterError: ${responses.map((r) => r.error).filter(Boolean).join("; ") || "source search failed"}`);
  const hits = responses.flatMap((r) => r.hits).sort((a, b) => b.score - a.score).slice(0, max);
  const excluded = (args.exclude ?? []).map(normalizeRef);
  const slices: ContextSlice[] = [];
  const gaps = responses.flatMap((r) => r.warnings ?? []);
  let skippedByPolicy = 0;
  let skippedByExclude = 0;
  for (const rawSeed of args.seed ?? []) {
    const seed = normalizeRef(rawSeed);
    const decision = await sourceSearchPolicy(root, seed.path);
    if (!decision.allowed) { skippedByPolicy += 1; continue; }
    if (excluded.some((item) => overlaps(item, seed))) { skippedByExclude += 1; continue; }
    slices.push({ slice_id: slices.length + 1, ref: seed, role: "supporting", why: "seeded context reference", confidence: "medium", preview: "seeded context reference" });
  }
  for (const hit of hits) {
    const range = lineRange(hit);
    const ref = { path: hit.path, start_line: range.start, end_line: range.end };
    const decision = await sourceSearchPolicy(root, hit.path);
    if (!decision.allowed) { skippedByPolicy += 1; continue; }
    if (excluded.some((item) => overlaps(item, ref))) { skippedByExclude += 1; continue; }
    if (slices.length >= max) break;
    slices.push({ slice_id: slices.length + 1, ref, role: slices.length < 3 ? "primary" : "supporting", why: `ranked_search hit for query with score ${hit.score.toFixed(2)}`, confidence: hit.score > 5 ? "high" : "medium", preview: preview(hit), score: hit.score });
  }
  if (skippedByPolicy) gaps.push(`${skippedByPolicy} candidate hit(s) were omitted by ignore/security policy.`);
  if (skippedByExclude) gaps.push(`${skippedByExclude} candidate hit(s) were omitted by caller exclude refs.`);
  const commit = await git(["rev-parse", "HEAD"], root);
  const dirty = Boolean(await git(["status", "--porcelain"], root));
  const artifact: ContextMapArtifact = { schema_version: 1, map_id: mapId(), query: args.query, workspace_root: root, git_commit: commit, git_dirty: dirty, async_subagents_root_session_id: process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID, async_subagents_parent_run_id: process.env.ASYNC_SUBAGENTS_PARENT_RUN_ID, async_subagents_child_run_id: process.env.ASYNC_SUBAGENTS_RUN_ID ?? process.env.ASYNC_SUBAGENT_RUN_ID, created_at: new Date().toISOString(), package_version: PACKAGE_VERSION, retrieval_backends: ["ranked_search"], provenance: [{ backend: "ranked_search", query_or_command: args.query, result_count: hits.length }], coverage: { searched_roots: roots.map((r) => r ?? "."), searched_methods: ["ranked_search"], excluded_roots: skippedByPolicy ? ["ignore/security policy"] : [], failed_roots: responses.filter((r) => !r.ok).map((r) => r.error ?? "unknown"), confidence: slices.length ? "medium" : "low" }, gaps, slices, load_bearing_slice_ids: slices.slice(0, Math.min(5, slices.length)).map((s) => s.slice_id), read_history: [] };
  await saveMap(root, artifact);
  return { map_id: artifact.map_id, evidence_status: "orientation_only_requires_context_map_read", orientation: { routing_summary: slices.length ? `Found ${slices.length} likely relevant source sections. Materialize selected slices before relying on exact claims.` : "No relevant source sections were found in the searched roots.", load_bearing_refs: slices.filter((s) => artifact.load_bearing_slice_ids.includes(s.slice_id)), suggested_read_order: artifact.load_bearing_slice_ids, gaps: artifact.gaps, coverage: artifact.coverage } };
}

export async function readContextMap(cwd: string, mapIdValue: string, sliceIds: Array<string | number>): Promise<ContextMapReadResult> {
  const root = await workspaceRoot(cwd);
  const artifact = await loadMap(root, mapIdValue);
  const warnings: string[] = [];
  const readRoot = artifact.workspace_root || root;
  if (!sameRoot(root, readRoot)) throw new Error("ToolExecutionError: context map workspace root does not match current workspace");
  const nowCommit = await git(["rev-parse", "HEAD"], readRoot);
  if (artifact.git_commit && nowCommit && artifact.git_commit !== nowCommit) warnings.push("Workspace git commit differs from map creation commit.");
  if (await git(["status", "--porcelain"], readRoot)) warnings.push("Workspace has uncommitted changes; materialized content may differ from map preview.");
  let total = 0; let truncated = false;
  const slices = [];
  for (const rawId of sliceIds) {
    const id = Number(rawId);
    const slice = artifact.slices.find((s) => s.slice_id === id);
    if (!slice) throw new Error(`ToolExecutionError: unknown slice id ${rawId}`);
    const decision = await sourceSearchPolicy(readRoot, slice.ref.path);
    if (!decision.allowed) throw new Error(`ToolExecutionError: refused to read ${slice.ref.path}: ${decision.reason}`);
    const lines = (await readFile(resolve(readRoot, slice.ref.path), "utf8")).split(/\r?\n/).slice(slice.ref.start_line - 1, slice.ref.end_line);
    let content = lines.join("\n");
    let sliceTruncated = false;
    if (content.length > PER_SLICE_LIMIT) { content = content.slice(0, PER_SLICE_LIMIT); sliceTruncated = true; }
    if (total + content.length > TOTAL_LIMIT) { content = content.slice(0, Math.max(0, TOTAL_LIMIT - total)); sliceTruncated = true; truncated = true; }
    total += content.length;
    slices.push({ slice_id: id, ref: slice.ref, content, truncated: sliceTruncated });
    if (truncated) break;
  }
  artifact.read_history.push({ at: new Date().toISOString(), slice_ids: slices.map((s) => s.slice_id) });
  await saveMap(root, artifact);
  return { map_id: mapIdValue, slices, truncated, warnings };
}
export type * from "./types.js";

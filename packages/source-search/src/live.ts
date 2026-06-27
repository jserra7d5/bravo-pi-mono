import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { QueryResponse, TermBoost, SearchHit, SearchSnippetContext, SearchSnippetWindow } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

const QUERY_SYNTAX_RE = /[:^~*()[\]{}"\\]|\b(?:AND|OR|NOT)\b|(?:^|\s)[+-]/;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const SECRET_OR_NOISE_RE = /(^|\/)(\.git(?:\/|$)|\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|id_rsa$|id_dsa$|id_ed25519$|.*secret.*|.*credential.*|.*token.*|dist|build|target|node_modules)(?:\/|$)?/i;
const DENIED_DIR_NAMES = new Set([".git", "node_modules", "dist", "build", "target"]);

const DEFAULT_SEARCH_BUDGET = {
  gitTimeoutMs: 10_000,
  wallClockMs: 20_000,
  maxCandidates: 100_000,
  maxFilesRead: 25_000,
  maxBytesRead: 128 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxDepth: 2048,
  maxReadErrorSamples: 5,
  yieldEveryCandidates: 250,
  yieldEveryMs: 25,
};

type WarningCode =
  | "candidate_budget_exceeded"
  | "file_read_budget_exceeded"
  | "byte_read_budget_exceeded"
  | "depth_budget_exceeded"
  | "large_or_binary_files_skipped"
  | "read_errors_omitted"
  | "git_timeout"
  | "git_error"
  | "search_aborted";

export type SearchBudget = Partial<typeof DEFAULT_SEARCH_BUDGET>;

export interface QueryRepoOptions {
  signal?: AbortSignal;
  budgets?: SearchBudget;
}

interface QueryContext {
  signal?: AbortSignal;
  budgets: typeof DEFAULT_SEARCH_BUDGET;
  warnings: string[];
  warningCodes: Set<string>;
  rootReal: string;
  startedAt: number;
  lastYieldAt: number;
  filesRead: number;
  bytesRead: number;
  readErrorSamples: string[];
}

class SearchAbortError extends Error {
  constructor(message = "Search aborted") {
    super(message);
    this.name = "SearchAbortError";
  }
}

class GitListError extends Error {
  constructor(readonly kind: "timeout" | "error", message: string) {
    super(message);
    this.name = "GitListError";
  }
}

function addWarning(ctx: QueryContext, code: WarningCode, detail?: string): void {
  if (ctx.warningCodes.has(code)) return;
  ctx.warningCodes.add(code);
  ctx.warnings.push(detail ? `${code}: ${detail}` : code);
}

function checkAbort(ctx: QueryContext): void {
  if (ctx.signal?.aborted) throw new SearchAbortError();
}

function checkWallClock(ctx: QueryContext): boolean {
  if (Date.now() - ctx.startedAt <= ctx.budgets.wallClockMs) return false;
  addWarning(ctx, "candidate_budget_exceeded", "wall clock budget exhausted before all candidates were scored");
  return true;
}

async function maybeYield(ctx: QueryContext, candidatesSeen: number): Promise<void> {
  const now = Date.now();
  if (candidatesSeen % ctx.budgets.yieldEveryCandidates === 0 || now - ctx.lastYieldAt >= ctx.budgets.yieldEveryMs) {
    ctx.lastYieldAt = now;
    await yieldImmediate();
    checkAbort(ctx);
  }
}

async function isLikelyGitRoot(root: string): Promise<boolean> {
  return stat(resolve(root, ".git")).then(() => true, () => false);
}

function normalizeCandidatePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function* gitCandidateFiles(root: string, pathPrefix: string | undefined, ctx: QueryContext): AsyncGenerator<string> {
  checkAbort(ctx);
  const args = ["ls-files", "-z", "-co", "--exclude-standard", ...(pathPrefix ? ["--", `:(literal)${pathPrefix}`] : [])];
  const child = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  let timedOut = false;
  let closed = false;
  let closeCode: number | null = null;
  let childError: Error | undefined;
  let stderr = "";
  const closePromise = new Promise<void>((resolveClose) => {
    child.on("close", (code) => {
      closed = true;
      closeCode = code;
      resolveClose();
    });
    child.on("error", (error) => {
      childError = error;
      resolveClose();
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, ctx.budgets.gitTimeoutMs);
  const onAbort = () => {
    child.kill("SIGKILL");
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let remainder = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += Buffer.from(chunk).toString("utf8").slice(0, 4096 - stderr.length);
    });
    for await (const chunk of child.stdout) {
      checkAbort(ctx);
      if (checkWallClock(ctx)) return;
      const text = remainder + Buffer.from(chunk).toString("utf8");
      const parts = text.split("\0");
      remainder = parts.pop() ?? "";
      for (const part of parts) {
        checkAbort(ctx);
        if (checkWallClock(ctx)) return;
        if (part) yield normalizeCandidatePath(part);
      }
    }
    await closePromise;
    if (ctx.signal?.aborted) throw new SearchAbortError();
    if (timedOut) throw new GitListError("timeout", "git ls-files timed out");
    if (childError) throw childError;
    if (closeCode !== 0) throw new GitListError("error", stderr.trim() || `git exited ${closeCode}`);
    if (remainder) {
      checkAbort(ctx);
      if (checkWallClock(ctx)) return;
      yield normalizeCandidatePath(remainder);
    }
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    if (!closed) {
      child.kill("SIGKILL");
      void closePromise.catch(() => undefined);
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function validatePlainText(value: string, label: string): string | null {
  if ([...value].length > 512) return `QueryError: ${label} is too long`;
  if (QUERY_SYNTAX_RE.test(value)) return `QueryError: ${label} must use plain lexical terms; pass boosts/excludeTerms as typed parameters instead of query syntax`;
  return null;
}

function validate(query: string, boosts?: TermBoost[], excludeTerms?: string[]): string | null {
  const queryError = validatePlainText(query, "query");
  if (queryError) return queryError;
  if ((boosts?.length ?? 0) > 20) return "QueryError: boosts supports at most 20 entries";
  if ((excludeTerms?.length ?? 0) > 20) return "QueryError: excludeTerms supports at most 20 entries";
  for (const boost of boosts ?? []) {
    const term = boost.term.trim();
    if (!term) return "QueryError: boost term must not be empty";
    const boostError = validatePlainText(term, "boost term");
    if (boostError) return boostError;
    if (!Number.isFinite(boost.weight) || boost.weight <= 0 || boost.weight > 10) return "QueryError: boost weight must be > 0 and <= 10";
  }
  for (const termRaw of excludeTerms ?? []) {
    const term = termRaw.trim();
    if (!term) return "QueryError: exclude term must not be empty";
    const excludeError = validatePlainText(term, "exclude term");
    if (excludeError) return excludeError;
  }
  return null;
}

function tokens(text: string): string[] {
  return [...text.toLowerCase().matchAll(TOKEN_RE)].map((match) => match[0]!);
}

function termsFromQuery(query: string): string[] {
  return [...new Set(tokens(query))];
}

function isPhrase(value: string): boolean {
  return value.trim().split(/\s+/).length > 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTermWithBoundary(haystackLower: string, needleLower: string, tokenRe: RegExp): boolean {
  if (isPhrase(needleLower)) return haystackLower.includes(needleLower);
  const re = new RegExp(`(^|${tokenRe.source})${escapeRegExp(needleLower)}(${tokenRe.source}|$)`, "u");
  return re.test(haystackLower);
}

function containsPlainTerm(haystackLower: string, needleLower: string): boolean {
  return containsTermWithBoundary(haystackLower, needleLower, /[^\p{L}\p{N}_]/u);
}

function containsAnalyzedTerm(haystackLower: string, needleLower: string): boolean {
  return containsTermWithBoundary(haystackLower, needleLower, /[^\p{L}\p{N}]/u);
}

async function readIgnorePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const rel of [".agentignore", ".piignore"]) {
    try {
      const raw = await readFile(resolve(root, rel), "utf8");
      patterns.push(...raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!")));
    } catch {
      // Missing ignore files are treated as no additional excludes.
    }
  }
  try {
    const raw = await readFile(resolve(root, ".bravo", "source-search.json"), "utf8");
    const parsed = JSON.parse(raw) as { exclude?: unknown };
    if (Array.isArray(parsed.exclude)) patterns.push(...parsed.exclude.filter((value): value is string => typeof value === "string"));
  } catch {
    // Missing or invalid config is ignored by live search.
  }
  return patterns;
}

function simpleStarMatch(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return path === pattern;
  const anchoredStart = !pattern.startsWith("*");
  const anchoredEnd = !pattern.endsWith("*");
  const parts = pattern.split("*").filter(Boolean);
  if (!parts.length) return true;
  let remaining = path;
  for (let i = 0; i < parts.length; i += 1) {
    const pos = remaining.indexOf(parts[i]!);
    if (pos < 0) return false;
    if (i === 0 && anchoredStart && pos !== 0) return false;
    remaining = remaining.slice(pos + parts[i]!.length);
  }
  return anchoredEnd ? remaining.length === 0 : true;
}

function pathHasDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`);
}

function simpleMatch(pattern: string, path: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "**") return true;
  if (normalized.endsWith("/")) return pathHasDir(path, normalized.slice(0, -1));
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    if (simpleStarMatch(prefix, path)) return true;
    for (let i = 0; i < path.length; i += 1) if (path[i] === "/" && simpleStarMatch(prefix, path.slice(0, i))) return true;
    return false;
  }
  return simpleStarMatch(normalized, path);
}

function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => simpleMatch(pattern, path));
}

function depthOf(rel: string): number {
  if (!rel) return 0;
  return rel.split("/").filter(Boolean).length;
}

async function* walkFilesIterative(root: string, startRel: string | undefined, ignorePatterns: string[], ctx: QueryContext): AsyncGenerator<string> {
  const start = startRel ? normalizeCandidatePath(startRel).replace(/\/$/, "") : "";
  const startAbs = resolve(root, start || ".");
  const startStat = await stat(startAbs).catch(() => null);
  if (!startStat) return;
  if (startStat.isFile()) {
    if (!SECRET_OR_NOISE_RE.test(start.toLowerCase()) && !isIgnored(start, ignorePatterns)) yield start;
    return;
  }
  if (!startStat.isDirectory()) return;

  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: startAbs, rel: start, depth: depthOf(start) }];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    checkAbort(ctx);
    if (checkWallClock(ctx)) return;
    const current = queue[queueIndex]!;
    if (current.depth > ctx.budgets.maxDepth) {
      addWarning(ctx, "depth_budget_exceeded");
      continue;
    }
    if (current.rel && (SECRET_OR_NOISE_RE.test(current.rel.toLowerCase()) || isIgnored(current.rel, ignorePatterns))) continue;
    const entries = await readdir(current.abs, { withFileTypes: true }).catch((error: unknown) => {
      sampleReadError(ctx, current.rel || ".", error);
      return [];
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const lower = rel.toLowerCase();
      if (DENIED_DIR_NAMES.has(entry.name) || SECRET_OR_NOISE_RE.test(lower) || isIgnored(rel, ignorePatterns)) continue;
      const abs = resolve(current.abs, entry.name);
      if (entry.isDirectory()) {
        queue.push({ abs, rel, depth: current.depth + 1 });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        yield rel;
      }
    }
  }
}

async function* candidateFiles(root: string, pathPrefix: string | undefined, ignorePatterns: string[], ctx: QueryContext): AsyncGenerator<string> {
  if (await isLikelyGitRoot(root)) {
    try {
      for await (const path of gitCandidateFiles(root, pathPrefix, ctx)) {
        if (SECRET_OR_NOISE_RE.test(path.toLowerCase()) || isIgnored(path, ignorePatterns)) continue;
        yield path;
      }
      return;
    } catch (error) {
      if (error instanceof SearchAbortError) throw error;
      if (error instanceof GitListError && error.kind === "timeout") addWarning(ctx, "git_timeout");
      else addWarning(ctx, "git_error");
      return;
    }
  }
  yield* walkFilesIterative(root, pathPrefix, ignorePatterns, ctx);
}

function sampleReadError(ctx: QueryContext, path: string, error: unknown): void {
  if (ctx.readErrorSamples.length < ctx.budgets.maxReadErrorSamples) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    ctx.readErrorSamples.push(`${path}: ${message}`);
  }
  addWarning(ctx, "read_errors_omitted", ctx.readErrorSamples.join("; "));
}

type ReadResult = { kind: "ok"; body: string; bytes: number } | { kind: "skip"; reason: "secret" | "outside_root" | "not_file" | "large_or_binary" | "byte_budget" | "read_error" };

async function safeReadText(rel: string, ctx: QueryContext): Promise<ReadResult> {
  const relNormalized = normalizeCandidatePath(rel);
  if (SECRET_OR_NOISE_RE.test(relNormalized.toLowerCase())) return { kind: "skip", reason: "secret" };
  const abs = resolve(ctx.rootReal, relNormalized);
  const real = await realpath(abs).catch((error: unknown) => {
    sampleReadError(ctx, relNormalized, error);
    return null;
  });
  if (!real || (real !== ctx.rootReal && !real.startsWith(`${ctx.rootReal}/`))) return { kind: "skip", reason: "outside_root" };
  const meta = await stat(real).catch((error: unknown) => {
    sampleReadError(ctx, relNormalized, error);
    return null;
  });
  if (!meta?.isFile()) return { kind: "skip", reason: "not_file" };
  if (meta.size > ctx.budgets.maxFileBytes) return { kind: "skip", reason: "large_or_binary" };
  if (ctx.bytesRead + meta.size > ctx.budgets.maxBytesRead) return { kind: "skip", reason: "byte_budget" };
  const buf = await readFile(real).catch((error: unknown) => {
    sampleReadError(ctx, relNormalized, error);
    return null;
  });
  if (!buf) return { kind: "skip", reason: "read_error" };
  if (buf.subarray(0, 8192).includes(0)) return { kind: "skip", reason: "large_or_binary" };
  return { kind: "ok", body: buf.toString("utf8"), bytes: buf.length };
}

function fileName(rel: string): string {
  return basename(rel) || rel;
}

function matchedFields(path: string, body: string, query: string): string[] {
  const queryTerms = termsFromQuery(query);
  const filenameLower = fileName(path).toLowerCase();
  const pathLower = path.toLowerCase();
  const bodyLower = body.toLowerCase();
  const fields: string[] = [];
  if (queryTerms.some((term) => containsAnalyzedTerm(filenameLower, term))) fields.push("filename");
  if (queryTerms.some((term) => containsAnalyzedTerm(pathLower, term))) fields.push("path");
  if (queryTerms.some((term) => containsAnalyzedTerm(bodyLower, term))) fields.push("content");
  return fields;
}

function cleanSymbolName(raw: string): string {
  return raw.replace(/[({=:].*$/, "").trim();
}

function symbolAfterKeyword(line: string, keyword: string): string | undefined {
  const idx = line.indexOf(keyword);
  if (idx < 0) return undefined;
  const rest = line.slice(idx + keyword.length).trim();
  return cleanSymbolName(rest.split(/\s+/)[0] ?? "") || undefined;
}

function structuralContextAt(line: string, lineNumber: number): SearchSnippetContext | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return { kind: "heading", name: trimmed.replace(/^#+\s*/, "").trim(), line: lineNumber };
  const patterns: Array<[RegExp, string]> = [
    [/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
    [/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
    [/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, "type"],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "export"],
    [/^def\s+([A-Za-z_][\w]*)/, "function"],
    [/^fn\s+([A-Za-z_][\w]*)/, "function"],
    [/^struct\s+([A-Za-z_][\w]*)/, "struct"],
    [/^enum\s+([A-Za-z_][\w]*)/, "enum"],
    [/^trait\s+([A-Za-z_][\w]*)/, "trait"],
  ];
  for (const [pattern, kind] of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return { kind, name: match[1], line: lineNumber };
  }
  const fallbackFunction = symbolAfterKeyword(trimmed, "function ");
  if (fallbackFunction) return { kind: "function", name: fallbackFunction, line: lineNumber };
  return undefined;
}

function enclosingContext(lines: string[], focus: number): SearchSnippetContext | undefined {
  for (let i = focus; i >= 0; i -= 1) {
    const context = structuralContextAt(lines[i] ?? "", i + 1);
    if (context) return context;
  }
  return undefined;
}

function lineTermCount(line: string, terms: string[]): [number, number] {
  const lower = line.toLowerCase();
  let unique = 0;
  let total = 0;
  for (const term of terms) {
    if (containsPlainTerm(lower, term)) {
      unique += 1;
      total += [...lower.matchAll(new RegExp(escapeRegExp(term), "g"))].length;
    }
  }
  return [unique, total];
}

function candidateScore(lines: string[], terms: string[], start: number, end: number, focus: number): number {
  let score = 0;
  for (let i = start; i <= end; i += 1) {
    const [unique, total] = lineTermCount(lines[i] ?? "", terms);
    score += unique * 10 + total * 2;
    if (i === focus) score += unique * 4;
    if (structuralContextAt(lines[i] ?? "", i + 1)) score += 3;
  }
  return score;
}

function cropLineAroundTerms(line: string, terms: string[], maxChars: number): [string, boolean, boolean] {
  if ([...line].length <= maxChars) return [line, false, false];
  const lower = line.toLowerCase();
  const firstMatch = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - Math.floor(maxChars / 3));
  const text = [...line].slice(start, start + maxChars).join("");
  return [text, start > 0, start + maxChars < [...line].length];
}

function bestSnippets(body: string, query: string): Pick<SearchHit, "line" | "snippet" | "snippets" | "lineStart" | "lineEnd"> {
  const terms = termsFromQuery(query);
  const lines = body.split(/\r?\n/);
  if (!lines.length) return { line: null, snippet: "", snippets: [], lineStart: null, lineEnd: null };
  const contextLines = 2;
  const candidates: Array<{ start: number; end: number; focus: number; score: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const [lineMatches] = lineTermCount(lines[i] ?? "", terms);
    if (!lineMatches) continue;
    const start = Math.max(0, i - contextLines);
    const end = Math.min(lines.length - 1, i + contextLines);
    candidates.push({ start, end, focus: i, score: candidateScore(lines, terms, start, end, i) });
  }
  if (!candidates.length) candidates.push({ start: 0, end: Math.min(lines.length - 1, contextLines), focus: 0, score: 0 });
  candidates.sort((a, b) => b.score - a.score || a.focus - b.focus);
  const ranges: typeof candidates = [];
  for (const candidate of candidates) {
    if (ranges.some((range) => candidate.start <= range.end && candidate.end >= range.start)) continue;
    ranges.push(candidate);
    if (ranges.length >= 3) break;
  }
  const snippets: SearchSnippetWindow[] = [];
  let usedChars = 0;
  for (const range of ranges) {
    if (usedChars >= 1400) break;
    const maxChars = Math.min(600, 1400 - usedChars);
    let lineStart = range.start + 1;
    let lineEnd = range.end + 1;
    let text = lines.slice(range.start, range.end + 1).join("\n");
    let truncatedBefore = range.start > 0;
    let truncatedAfter = range.end + 1 < lines.length;
    if ([...text].length > maxChars) {
      lineStart = range.focus + 1;
      lineEnd = range.focus + 1;
      const [focusedText, croppedBefore, croppedAfter] = cropLineAroundTerms(lines[range.focus] ?? "", terms, maxChars);
      text = focusedText;
      truncatedBefore = range.focus > 0 || croppedBefore;
      truncatedAfter = range.focus + 1 < lines.length || croppedAfter;
    }
    usedChars += [...text].length;
    snippets.push({
      lineStart,
      lineEnd,
      text,
      truncated: truncatedBefore || truncatedAfter,
      truncatedBefore,
      truncatedAfter,
      context: enclosingContext(lines, range.focus),
    });
  }
  return {
    line: (ranges[0]?.focus ?? 0) + 1,
    snippet: (lines[ranges[0]?.focus ?? 0] ?? "").trim().slice(0, 300),
    snippets,
    lineStart: snippets.length ? Math.min(...snippets.map((snippet) => snippet.lineStart)) : null,
    lineEnd: snippets.length ? Math.max(...snippets.map((snippet) => snippet.lineEnd)) : null,
  };
}

function scoreFile(path: string, body: string, queryTerms: string[], boosts?: TermBoost[]): { score: number; matched: boolean } {
  const pathLower = path.toLowerCase();
  const filenameLower = fileName(path).toLowerCase();
  const bodyTokens = tokens(body);
  let score = 0;
  let matched = false;
  for (const term of queryTerms) {
    const filenameMatch = containsAnalyzedTerm(filenameLower, term);
    const pathMatch = containsAnalyzedTerm(pathLower, term);
    const bodyCount = bodyTokens.filter((token) => token === term).length;
    if (filenameMatch) { score += 6; matched = true; }
    if (pathMatch) { score += 4; matched = true; }
    if (bodyCount) { score += 1 + Math.log2(bodyCount + 1); matched = true; }
  }
  const haystack = `${path}\n${body}`.toLowerCase();
  for (const boost of boosts ?? []) {
    if (containsPlainTerm(haystack, boost.term.toLowerCase())) score *= boost.weight;
  }
  return { score, matched };
}

function hitCompare(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || a.path.localeCompare(b.path);
}

function isBetterHit(candidate: SearchHit, current: SearchHit): boolean {
  return hitCompare(candidate, current) < 0;
}

function retainTopHit(hits: SearchHit[], hit: SearchHit, limit: number): void {
  if (hits.length < limit) {
    hits.push(hit);
    hits.sort(hitCompare);
    return;
  }
  const worst = hits[hits.length - 1]!;
  if (!isBetterHit(hit, worst)) return;
  hits[hits.length - 1] = hit;
  hits.sort(hitCompare);
}

function baseResponse(repo: string, query: string, limit: number, boosts?: TermBoost[], excludeTerms?: string[], warnings: string[] = [], ok = true, error?: string): QueryResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ok,
    repoRoot: repo,
    query,
    boosts,
    excludeTerms,
    hits: [],
    count: 0,
    indexFreshness: "live",
    warnings,
    error,
  };
}

export async function queryRepo(repo: string, query: string, limit: number, pathPrefix?: string, boosts?: TermBoost[], excludeTerms?: string[], options: QueryRepoOptions = {}): Promise<QueryResponse> {
  const error = validate(query, boosts, excludeTerms);
  if (error) return baseResponse(repo, query, limit, boosts, excludeTerms, [], false, error);

  const topLimit = Math.min(50, Math.max(1, Math.floor(limit || 10)));
  const rootReal = await realpath(repo).catch(() => repo);
  const ctx: QueryContext = {
    signal: options.signal,
    budgets: { ...DEFAULT_SEARCH_BUDGET, ...(options.budgets ?? {}) },
    warnings: [],
    warningCodes: new Set(),
    rootReal,
    startedAt: Date.now(),
    lastYieldAt: Date.now(),
    filesRead: 0,
    bytesRead: 0,
    readErrorSamples: [],
  };
  const queryTerms = termsFromQuery(query);
  const prefix = pathPrefix?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const excludeNeedles = (excludeTerms ?? []).map((term) => term.toLowerCase());
  const topHits: SearchHit[] = [];
  let candidatesSeen = 0;

  try {
    checkAbort(ctx);
    const ignorePatterns = await readIgnorePatterns(repo);
    for await (const path of candidateFiles(repo, prefix, ignorePatterns, ctx)) {
      checkAbort(ctx);
      if (checkWallClock(ctx)) break;
      if (candidatesSeen >= ctx.budgets.maxCandidates) {
        addWarning(ctx, "candidate_budget_exceeded");
        break;
      }
      candidatesSeen += 1;
      await maybeYield(ctx, candidatesSeen);
      const candidateLimitReached = candidatesSeen >= ctx.budgets.maxCandidates;
      if (!(await fileExists(resolve(repo, path)))) {
        if (candidateLimitReached) {
          addWarning(ctx, "candidate_budget_exceeded");
          break;
        }
        continue;
      }
      if (ctx.filesRead >= ctx.budgets.maxFilesRead) {
        addWarning(ctx, "file_read_budget_exceeded");
        break;
      }
      if (ctx.bytesRead >= ctx.budgets.maxBytesRead) {
        addWarning(ctx, "byte_read_budget_exceeded");
        break;
      }
      ctx.filesRead += 1;
      const read = await safeReadText(path, ctx);
      if (read.kind === "skip") {
        if (read.reason === "large_or_binary") addWarning(ctx, "large_or_binary_files_skipped");
        if (read.reason === "byte_budget") {
          addWarning(ctx, "byte_read_budget_exceeded");
          break;
        }
        if (candidateLimitReached) {
          addWarning(ctx, "candidate_budget_exceeded");
          break;
        }
        continue;
      }
      ctx.bytesRead += read.bytes;
      const haystack = `${path}\n${read.body}`.toLowerCase();
      if (!excludeNeedles.some((term) => containsPlainTerm(haystack, term))) {
        const scored = scoreFile(path, read.body, queryTerms, boosts);
        if (scored.matched) {
          retainTopHit(topHits, {
            path,
            score: scored.score,
            matchedFields: matchedFields(path, read.body, query),
            ...bestSnippets(read.body, query),
          }, topLimit);
        }
      }
      if (candidateLimitReached) {
        addWarning(ctx, "candidate_budget_exceeded");
        break;
      }
    }
  } catch (caught) {
    if (!(caught instanceof SearchAbortError)) throw caught;
    addWarning(ctx, "search_aborted");
    const aborted = baseResponse(repo, query, topLimit, boosts, excludeTerms, ctx.warnings, topHits.length > 0, topHits.length > 0 ? undefined : "Search aborted.");
    aborted.hits = topHits.sort(hitCompare);
    aborted.count = aborted.hits.length;
    return aborted;
  }

  const usesPhraseOrDownWeight = (boosts ?? []).some((boost) => boost.weight < 1 || isPhrase(boost.term)) || (excludeTerms ?? []).some(isPhrase);
  const warnings = usesPhraseOrDownWeight ? [...ctx.warnings, "phrase controls or down-weight boosts are applied after collecting the live candidate set"] : ctx.warnings;
  const response = baseResponse(repo, query, topLimit, boosts, excludeTerms, warnings);
  response.hits = topHits.sort(hitCompare);
  response.count = response.hits.length;
  return response;
}

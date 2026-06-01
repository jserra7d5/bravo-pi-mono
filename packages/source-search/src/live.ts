import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { QueryResponse, TermBoost, SearchHit, SearchSnippetContext, SearchSnippetWindow } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

const QUERY_SYNTAX_RE = /[:^~*()[\]{}"\\]|\b(?:AND|OR|NOT)\b|(?:^|\s)[+-]/;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const MAX_FILE_BYTES = 1024 * 1024;
const SECRET_OR_NOISE_RE = /(^|\/)(\.git(?:\/|$)|\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|id_rsa$|id_dsa$|id_ed25519$|.*secret.*|.*credential.*|.*token.*|dist|build|target|node_modules)(?:\/|$)?/i;

function execGit(repo: string, args: string[], timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("git command timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(Buffer.concat(chunks));
      else reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `git exited ${code}`));
    });
  });
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
    const parsed = JSON.parse(raw) as { exclude?: unknown; enabled?: unknown };
    if (parsed.enabled === false) patterns.push("**");
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

async function walkFiles(root: string, base = root): Promise<string[]> {
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true })).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === "target") continue;
    const abs = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(abs, base));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(base, abs).replace(/\\/g, "/"));
  }
  return files;
}

async function candidateFiles(root: string, pathPrefix?: string): Promise<string[]> {
  if (pathPrefix) {
    const scoped = resolve(root, pathPrefix);
    const scopedStat = await stat(scoped).catch(() => null);
    if (!scopedStat) return [];
    if (scopedStat.isFile()) return [pathPrefix.replace(/\\/g, "/")];
    if (scopedStat.isDirectory()) return walkFiles(scoped, root);
    return [];
  }
  try {
    const out = await execGit(root, ["ls-files", "-z", "-co", "--exclude-standard"]);
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return walkFiles(root);
  }
}

async function safeReadText(repo: string, rel: string): Promise<string | null> {
  const relNormalized = rel.replace(/\\/g, "/");
  if (SECRET_OR_NOISE_RE.test(relNormalized.toLowerCase())) return null;
  const root = await realpath(repo);
  const abs = resolve(root, relNormalized);
  const real = await realpath(abs).catch(() => null);
  if (!real || (real !== root && !real.startsWith(`${root}/`))) return null;
  const meta = await stat(real).catch(() => null);
  if (!meta?.isFile() || meta.size > MAX_FILE_BYTES) return null;
  const buf = await readFile(real).catch(() => null);
  if (!buf || buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString("utf8");
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

export async function queryRepo(repo: string, query: string, limit: number, pathPrefix?: string, boosts?: TermBoost[], excludeTerms?: string[]): Promise<QueryResponse> {
  const error = validate(query, boosts, excludeTerms);
  if (error) return { protocolVersion: PROTOCOL_VERSION, ok: false, repoRoot: repo, query, boosts, excludeTerms, hits: [], count: 0, indexFreshness: "live", error };
  const queryTerms = termsFromQuery(query);
  const ignorePatterns = await readIgnorePatterns(repo);
  const prefix = pathPrefix?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const files = (await candidateFiles(repo, prefix)).filter((path) => !ignorePatterns.some((pattern) => simpleMatch(pattern, path)));
  const excludeNeedles = (excludeTerms ?? []).map((term) => term.toLowerCase());
  const hits: SearchHit[] = [];
  for (const path of files) {
    if (!(await fileExists(resolve(repo, path)))) continue;
    const body = await safeReadText(repo, path);
    if (body == null) continue;
    const haystack = `${path}\n${body}`.toLowerCase();
    if (excludeNeedles.some((term) => containsPlainTerm(haystack, term))) continue;
    const scored = scoreFile(path, body, queryTerms, boosts);
    if (!scored.matched) continue;
    hits.push({
      path,
      score: scored.score,
      matchedFields: matchedFields(path, body, query),
      ...bestSnippets(body, query),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const usesPhraseOrDownWeight = (boosts ?? []).some((boost) => boost.weight < 1 || isPhrase(boost.term)) || (excludeTerms ?? []).some(isPhrase);
  return {
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    repoRoot: repo,
    query,
    boosts,
    excludeTerms,
    hits: hits.slice(0, limit),
    count: Math.min(hits.length, limit),
    indexFreshness: "live",
    warnings: usesPhraseOrDownWeight ? ["phrase controls or down-weight boosts are applied after collecting the live candidate set"] : [],
  };
}

import { createReadStream } from "node:fs";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  defineTool,
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
  renderDiff,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const SHOWCASE_PROMPT =
  "Use the showcase tool only upon user request. You may prompt the user about using showcase when discussing very specific edits, code sections, prompt sections, or showcasing a plan/design. Do not use showcase completely unprompted.";
const MAX_LINES = 1_000;
const DEFAULT_LIMIT = 200;

const showcaseSchema = Type.Object({
  path: Type.String({ description: "File path to render for the user. Relative paths resolve from the current Pi session cwd." }),
  offset: Type.Optional(Type.Number({ description: "1-indexed starting line. Defaults to 1." })),
  limit: Type.Optional(Type.Number({ description: `Maximum lines to render. Defaults to ${DEFAULT_LIMIT}; capped at ${MAX_LINES}.` })),
  title: Type.Optional(Type.String({ description: "Optional title shown above the rendered content." })),
  lineNumbers: Type.Optional(Type.Boolean({
    description: "Show 1-indexed line number gutter on each rendered line. Defaults to true. Pass false when the user explicitly requests no line numbers (e.g., \"showcase X without line numbers\").",
  })),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("markdown"),
        Type.Literal("code"),
        Type.Literal("json"),
        Type.Literal("diff"),
        Type.Literal("plain"),
      ],
      { description: "Rendering mode. auto infers from path extension/content." },
    ),
  ),
  language: Type.Optional(Type.String({ description: "Language hint for code highlighting." })),
});

type ShowcaseArgs = Static<typeof showcaseSchema>;
type ShowcaseMode = "auto" | "markdown" | "code" | "json" | "diff" | "plain";
type RenderedMode = Exclude<ShowcaseMode, "auto">;

interface ShowcaseDetails {
  summary: string;
  ok: boolean;
  path?: string;
  title?: string;
  offset?: number;
  limit?: number;
  endLine?: number;
  lineCount?: number;
  mode?: RenderedMode;
  language?: string;
  body?: string;
  lineNumbers?: boolean;
  error?: string;
}

interface LineSlice {
  body: string;
  lineCount: number;
  endLine: number;
}

function ctxCwd(ctx: ExtensionContext): string {
  return typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value ?? 1)) return 1;
  return Math.max(1, Math.floor(value ?? 1));
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_LIMIT)) return DEFAULT_LIMIT;
  return Math.min(MAX_LINES, Math.max(1, Math.floor(value ?? DEFAULT_LIMIT)));
}

function inferMode(filePath: string, content: string, requested: ShowcaseMode | undefined): RenderedMode {
  if (requested && requested !== "auto") return requested;
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown";
  if (ext === ".json" || ext === ".jsonl") return "json";
  if (ext === ".diff" || ext === ".patch" || content.startsWith("diff --git") || content.startsWith("--- ")) return "diff";
  if (ext === ".txt" || ext === ".log") return "plain";
  return "code";
}

function codeFenceLanguage(mode: RenderedMode, language: string | undefined): string | undefined {
  if (language) return language;
  if (mode === "json") return "json";
  if (mode === "diff") return "diff";
  return undefined;
}

async function readLineSlice(filePath: string, offset: number, limit: number): Promise<LineSlice> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let currentLine = 0;
  const lastRequestedLine = offset + limit - 1;

  try {
    for await (const line of reader) {
      currentLine++;
      if (currentLine >= offset && currentLine <= lastRequestedLine) {
        lines.push(line);
      }
      if (currentLine >= lastRequestedLine) {
        reader.close();
        break;
      }
    }
  } finally {
    stream.destroy();
  }

  return {
    body: lines.join("\n"),
    lineCount: lines.length,
    endLine: lines.length > 0 ? offset + lines.length - 1 : offset - 1,
  };
}

function addLineNumbers(lines: string[], startLine: number | undefined): string[] {
  if (!startLine) return lines;
  const width = String(startLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, index) => `${ANSI.dim}${String(startLine + index).padStart(width, " ")} │${ANSI.reset} ${line}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Chrome / identity palette
// ────────────────────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[38;2;120;120;128m",
  muted: "\x1b[38;2;160;160;170m",
  chrome: "\x1b[38;2;110;110;120m",
} as const;

// Mode-color map. Semantic colors chosen for at-a-glance mode recognition.
const MODE_COLORS: Record<RenderedMode, string> = {
  markdown: "\x1b[38;2;229;181;72m", // amber
  code: "\x1b[38;2;126;201;145m",    // green
  json: "\x1b[38;2;232;200;126m",    // butter
  diff: "\x1b[38;2;213;163;233m",    // lavender
  plain: "\x1b[38;2;160;160;170m",   // muted
};

// Identity palette — copy of `IDENTITY_PALETTE` from
// `@bravo/async-subagents` `renderers.ts`. Not imported because showcase
// must not take a hard runtime dep on a sibling pi-package; kept in sync
// by convention (and a test pinning the RGB triplets here).
const IDENTITY_PALETTE = [
  "\x1b[38;2;229;145;91m",
  "\x1b[38;2;199;125;186m",
  "\x1b[38;2;123;201;123m",
  "\x1b[38;2;111;169;217m",
  "\x1b[38;2;155;123;217m",
  "\x1b[38;2;91;201;181m",
  "\x1b[38;2;217;195;111m",
  "\x1b[38;2;217;125;125m",
] as const;

export function identitySlot(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h * 31) + path.charCodeAt(i)) >>> 0;
  return h % IDENTITY_PALETTE.length;
}

export function identityColor(path: string): string {
  return IDENTITY_PALETTE[identitySlot(path)];
}

export function modeColor(mode: RenderedMode | undefined): string {
  return MODE_COLORS[mode ?? "plain"] ?? MODE_COLORS.plain;
}

// Short abbreviations for known languages so the badge shows e.g. "TS" not "CODE"
// when we know the file's language. Falls back to "CODE" for unknown languages.
const CODE_LANG_BADGE: Record<string, string> = {
  typescript: "TS",
  tsx: "TSX",
  javascript: "JS",
  jsx: "JSX",
  python: "PY",
  ruby: "RB",
  rust: "RS",
  go: "GO",
  java: "JAVA",
  kotlin: "KT",
  swift: "SWIFT",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  shell: "SH",
  bash: "SH",
  yaml: "YAML",
  toml: "TOML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
};

export function modeBadgeText(mode: RenderedMode | undefined, language?: string): string {
  switch (mode) {
    case "markdown": return "MD";
    case "json": return "JSON";
    case "diff": return "DIFF";
    case "plain": return "TXT";
    case "code": {
      if (!language) return "CODE";
      const key = language.toLowerCase();
      return CODE_LANG_BADGE[key] ?? language.toUpperCase().slice(0, 4);
    }
    default: return "TXT";
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0;
  if (codePoint === 0x200d) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) return 2;
  return 1;
}

// Strip ANSI for width measurement.
export function visWidth(str: string): number {
  let width = 0;
  for (const char of stripAnsi(str)) width += codePointWidth(char.codePointAt(0) ?? 0);
  return width;
}

function truncateToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0 || visWidth(str) <= maxWidth) return maxWidth <= 0 ? "" : str;
  if (maxWidth === 1) return "…";
  let out = "";
  let width = 0;
  let openAnsi = false;
  for (let i = 0; i < str.length;) {
    if (str[i] === "\x1b") {
      ANSI_RE.lastIndex = i;
      const match = ANSI_RE.exec(str);
      if (match && match.index === i) {
        out += match[0];
        openAnsi = !match[0].endsWith("[0m");
        i += match[0].length;
        continue;
      }
    }
    const codePoint = str.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const charWidth = codePointWidth(codePoint);
    if (width + charWidth > maxWidth - 1) break;
    out += char;
    width += charWidth;
    i += char.length;
  }
  return `${out}${openAnsi ? ANSI.reset : ""}…`;
}

function fitLine(str: string, width: number): string {
  return truncateToWidth(str, Math.max(0, width));
}

// ────────────────────────────────────────────────────────────────────────────
// Top / bottom rules — bookend chrome only, no side bars on content rows.
// ────────────────────────────────────────────────────────────────────────────

interface TopRuleInput {
  filename: string;        // bold + identity color in the bar
  mode: RenderedMode;      // drives MODE badge color
  language?: string;       // refines badge text for "code" mode (TS, PY, …)
  lineRange: string;       // pre-formatted ("lines N-M" or "LN-M")
  rightSegment?: string;   // parent dir (optional; dropped if too narrow)
  idColor: string;         // identity color for corners + filename
  badgeFitsMin: number;    // narrowest width that still includes the mode badge
}

export function topRule(width: number, input: TopRuleInput): string {
  const { filename, mode, language, lineRange, rightSegment, idColor, badgeFitsMin } = input;
  const fname = `${idColor}${ANSI.bold}${filename}${ANSI.reset}`;
  const badge = `${modeColor(mode)}${modeBadgeText(mode, language)}${ANSI.reset}`;
  const range = `${ANSI.dim}${lineRange}${ANSI.reset}`;
  const sep = `${ANSI.dim}·${ANSI.reset}`;

  // Title assembly — drop badge first at very narrow widths, then keep just filename + range.
  const title = width >= badgeFitsMin
    ? `${fname} ${sep} ${badge} ${sep} ${range}`
    : `${fname} ${sep} ${range}`;
  const tw = visWidth(title);

  // Try with right segment; drop if it doesn't fit alongside title + min dashes.
  if (rightSegment) {
    const rw = visWidth(rightSegment);
    // ╭─ <title> ── <right> ─╮  → 2 corners + spaces around title + " " + min2 dashes + " " + right + " " + "─╮"
    const minWithRight = 2 + 1 + tw + 1 + 2 + 1 + rw + 1 + 2;
    if (minWithRight <= width) {
      const dashes = width - (2 + 1 + tw + 1 + 1 + rw + 1 + 2);
      return `${idColor}╭─${ANSI.reset} ${title} ${ANSI.chrome}${"─".repeat(Math.max(2, dashes))}${ANSI.reset} ${rightSegment} ${idColor}─╮${ANSI.reset}`;
    }
  }
  // ╭─ <title> ──...──╮
  const dashes = Math.max(2, width - (2 + 1 + tw + 1 + 2));
  return `${idColor}╭─${ANSI.reset} ${title} ${ANSI.chrome}${"─".repeat(dashes)}${ANSI.reset}${idColor}─╮${ANSI.reset}`;
}

export function bottomRule(width: number, idColor: string): string {
  const dashes = Math.max(2, width - 2);
  return `${idColor}╰${ANSI.chrome}${"─".repeat(dashes)}${idColor}╯${ANSI.reset}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Card composition
// ────────────────────────────────────────────────────────────────────────────

interface CardSpec {
  filename: string;
  mode: RenderedMode;
  language?: string;
  offset: number;
  endLine: number;
  parentDir?: string;
  idColor: string;
  bodyLines: (width: number) => string[];
}

// Width thresholds for adaptive rule formatting (mirroring the v2 mockup).
const LINE_RANGE_LONG_MIN = 70;   // ≥ 70 → "lines N-M", else "LN-M"
const PARENT_DIR_MIN = 80;        // ≥ 80 → try to include parent dir on right
const BADGE_MIN = 50;             // ≥ 50 → include MODE badge

export function buildCardLines(width: number, spec: CardSpec): string[] {
  const lineRange = width >= LINE_RANGE_LONG_MIN
    ? `lines ${spec.offset}-${spec.endLine}`
    : `L${spec.offset}-${spec.endLine}`;
  // Parent dir shown verbatim (no truncation). topRule drops it whole if it
  // can't fit alongside the title + min dashes.
  const rightSegment = spec.parentDir && width >= PARENT_DIR_MIN
    ? `${ANSI.dim}${spec.parentDir}${ANSI.reset}`
    : undefined;
  const top = topRule(width, {
    filename: spec.filename,
    mode: spec.mode,
    language: spec.language,
    lineRange,
    rightSegment,
    idColor: spec.idColor,
    badgeFitsMin: BADGE_MIN,
  });
  const bottom = bottomRule(width, spec.idColor);
  return [fitLine(top, width), ...spec.bodyLines(width).map((line) => fitLine(line, width)), fitLine(bottom, width)];
}

// ────────────────────────────────────────────────────────────────────────────
// Component: ShowcaseCard
// One Component per result; pi calls render(width) with real terminal width.
// ────────────────────────────────────────────────────────────────────────────

class ShowcaseCard implements Component {
  constructor(private readonly spec: CardSpec) {}
  invalidate(): void {}
  render(width: number): string[] {
    return buildCardLines(Math.max(20, width), this.spec);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Body builders per mode
// ────────────────────────────────────────────────────────────────────────────

function codeBodyLines(details: ShowcaseDetails): string[] {
  const mode = details.mode ?? "plain";
  const language = details.language ?? getLanguageFromPath(details.path ?? "") ?? codeFenceLanguage(mode, undefined);
  const body = details.body ?? "";
  const rendered = mode === "plain" ? body.split("\n") : highlightCode(body, language);
  // Line-number gutter is opt-out: true/undefined = show, false = hide.
  if (details.lineNumbers === false) return rendered;
  return addLineNumbers(rendered, details.offset);
}

function diffBodyLines(details: ShowcaseDetails): string[] {
  return renderDiff(details.body ?? "").split("\n");
}

function markdownBodyLines(details: ShowcaseDetails, width: number): string[] {
  // Delegate to pi-tui Markdown with paddingless config so content flows
  // free between the rules. Construct fresh each render — the body is small
  // and width may change between calls.
  const md = new Markdown(details.body ?? "", 0, 0, getMarkdownTheme());
  return md.render(width);
}

// Pick the body-lines function for a given details payload.
function bodyLinesFor(details: ShowcaseDetails): (width: number) => string[] {
  const mode = details.mode ?? "plain";
  if (mode === "markdown") return (w) => markdownBodyLines(details, w);
  if (mode === "diff") return () => diffBodyLines(details);
  return () => codeBodyLines(details);
}

// ────────────────────────────────────────────────────────────────────────────
// Filename / title resolution
// ────────────────────────────────────────────────────────────────────────────

function filenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function parentDirOf(path: string): string | undefined {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return undefined;
  return path.slice(0, idx);
}

export function cardSpecFromDetails(details: ShowcaseDetails): CardSpec {
  const path = details.path ?? "";
  const filename = details.title && details.title.length > 0 ? details.title : filenameOf(path);
  const parentDir = parentDirOf(path);
  return {
    filename,
    mode: details.mode ?? "plain",
    language: details.language ?? getLanguageFromPath(path) ?? undefined,
    offset: details.offset ?? 1,
    endLine: details.endLine ?? details.offset ?? 1,
    parentDir,
    idColor: identityColor(path || filename),
    bodyLines: bodyLinesFor(details),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// renderCall / renderResult
// ────────────────────────────────────────────────────────────────────────────

export function renderShowcaseResult(result: AgentToolResult<ShowcaseDetails>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details?.ok) {
    return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
  }
  return new ShowcaseCard(cardSpecFromDetails(details));
}

export function renderShowcaseCall(_args: ShowcaseArgs): Component {
  // The call has nothing to show beyond the chrome that pi suppresses — keep silent.
  return new Text("");
}

// Test-only export so tests can render a card to lines without rebuilding pi context.
export function renderCardForTest(details: ShowcaseDetails, width: number): string[] {
  return buildCardLines(width, cardSpecFromDetails(details));
}

export default function showcaseExtension(pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "showcase",
      label: "Showcase",
      description: "Render a file or file slice inline in the Pi TUI for the user. Returns only a short success/error message to the model.",
      promptSnippet: "showcase: render a requested file/slice inline for the user without returning large content to you.",
      promptGuidelines: [SHOWCASE_PROMPT],
      parameters: showcaseSchema,
      renderShell: "self",
      async execute(
        _toolCallId: string,
        params: ShowcaseArgs,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<AgentToolResult<ShowcaseDetails>> {
        const cwd = ctxCwd(ctx);
        const filePath = resolve(cwd, params.path);
        const offset = normalizeOffset(params.offset);
        const limit = normalizeLimit(params.limit);
        try {
          if (signal?.aborted) throw new Error("Operation aborted");
          const slice = await readLineSlice(filePath, offset, limit);
          if (signal?.aborted) throw new Error("Operation aborted");
          if (slice.lineCount === 0) {
            const summary = `Could not showcase ${params.path}: offset ${offset} is beyond end of file.`;
            return {
              content: [{ type: "text", text: summary }],
              details: { summary, ok: false, path: params.path, offset, limit, error: `Offset ${offset} is beyond end of file.` },
            };
          }

          let body = slice.body;
          const mode = inferMode(filePath, body, params.mode as ShowcaseMode | undefined);
          if (mode === "json") {
            try {
              body = JSON.stringify(JSON.parse(body), null, 2);
            } catch {
              // Partial or invalid JSON is still useful to render with JSON highlighting.
            }
          }
          const language = params.language ?? codeFenceLanguage(mode, getLanguageFromPath(filePath));
          const title = params.title;
          const lineNumbers = params.lineNumbers;
          const summary = `Showcased ${params.path}:${offset}-${slice.endLine} to the user.`;
          return {
            content: [{ type: "text", text: summary }],
            details: { summary, ok: true, path: params.path, title, offset, limit, endLine: slice.endLine, lineCount: slice.lineCount, mode, language, body, lineNumbers },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const summary = `Could not showcase ${params.path}: ${message}`;
          return {
            content: [{ type: "text", text: summary }],
            details: { summary, ok: false, path: params.path, error: message },
          };
        }
      },
      renderCall: renderShowcaseCall,
      renderResult: renderShowcaseResult,
    }),
  );

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${SHOWCASE_PROMPT}`,
  }));
}

import { Text, type Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { WebFetchResult, WebLookupResult, WebSearchResult } from "../../src/types.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[38;2;120;120;128m",
  text: "\x1b[38;2;220;220;221m",
  chrome: "\x1b[38;2;110;110;120m",
  ok: "\x1b[38;2;126;201;145m",
  warn: "\x1b[38;2;229;181;72m",
  bad: "\x1b[38;2;232;111;111m",
} as const;

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

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function visWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce((sum, char) => sum + codePointWidth(char.codePointAt(0) ?? 0), 0);
}

function codePointWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1f300 && cp <= 0x1faff)) return 2;
  return 1;
}

export function identityColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h * 31) + seed.charCodeAt(i)) >>> 0;
  return IDENTITY_PALETTE[h % IDENTITY_PALETTE.length];
}

function truncateEnd(value: string, width: number): string {
  if (width <= 0) return "";
  if (visWidth(value) <= width) return value;
  if (width <= 1) return "…";
  let out = "";
  let used = 0;
  for (const char of value) {
    const w = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return "";
  if (visWidth(value) <= width) return value;
  if (width <= 5) return truncateEnd(value, width);
  const tail = Math.min(value.length - 1, Math.ceil((width - 1) * 0.55));
  const half = width - 1 - tail;
  return `${value.slice(0, half)}…${value.slice(Math.max(half, value.length - tail))}`;
}

function padLine(value: string, width: number): string {
  const fitted = truncateEnd(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visWidth(fitted)))}`;
}

function row(width: number, color: string, value: string): string {
  const innerWidth = Math.max(1, width - 4);
  return `${color}▌${ANSI.reset} ${padLine(value, innerWidth)} ${ANSI.chrome}│${ANSI.reset}`;
}

function cardLines(width: number, seed: string, title: string, rows: string[]): string[] {
  const w = Math.max(32, width);
  const color = identityColor(seed);
  const t = `${color}${ANSI.bold}${title}${ANSI.reset}`;
  const titlePlain = visWidth(t);
  const dash = Math.max(2, w - titlePlain - 5);
  return [
    `${color}╭─${ANSI.reset} ${t} ${ANSI.chrome}${"─".repeat(dash)}${ANSI.reset}${color}╮${ANSI.reset}`,
    ...rows.map((r) => row(w, color, r)),
    `${color}╰${ANSI.chrome}${"─".repeat(w - 2)}${color}╯${ANSI.reset}`,
  ].map((line) => padLine(line, w));
}

class EvidenceCard implements Component {
  constructor(private readonly seed: string, private readonly title: string, private readonly rows: string[]) {}
  invalidate(): void {}
  render(width: number): string[] {
    return cardLines(width, this.seed, this.title, this.rows);
  }
}

export function renderSearchCall(args: Record<string, unknown>): Component {
  return new EvidenceCard(String(args.query ?? "web_search"), "◐ Web Search", [`query  ${String(args.query ?? "")}`, `limit  ${String(args.limit ?? "auto")}`]);
}

export function renderFetchCall(args: Record<string, unknown>): Component {
  const refs = Array.isArray(args.refs) ? args.refs.join(", ") : "";
  return new EvidenceCard(refs || "web_fetch", "◐ Web Fetch", [`refs   ${refs}`, `format ${String(args.format ?? "auto")}`]);
}

export function renderLookupCall(args: Record<string, unknown>): Component {
  return new EvidenceCard(String(args.query ?? "web_lookup"), "◐ Web Lookup", [`query  ${String(args.query ?? "")}`, `limit  ${String(args.limit ?? "auto")}`]);
}

export function renderSearchResult(result: AgentToolResult<WebSearchResult>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details) return new Text(contentText(result));
  return new EvidenceCard("web_search", "✓ Web Search", details.results.slice(0, 5).flatMap((r) => [
    `[${r.alias}] ${r.title} · ${r.provider}`,
    `id  ${r.id}`,
    truncateMiddle(r.url, 120),
  ]));
}

export function renderFetchResult(result: AgentToolResult<WebFetchResult>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details) return new Text(contentText(result));
  return new EvidenceCard("web_fetch", "✓ Web Fetch", details.results.flatMap((r) => [
    `[${shortId(r.id)}] ${r.title} · ${r.extraction.engine}/${r.extraction.confidence}${r.extraction.confidence === "good" ? "" : " · verify"}`,
    `id       ${r.id}`,
    `best     ${r.best_format} ${truncateMiddle(r.best_path, 112)}`,
    `semantic ${truncateMiddle(r.semantic_html_path, 120)}`,
    `markdown ${truncateMiddle(r.markdown_path, 120)}`,
  ]));
}

export function renderLookupResult(result: AgentToolResult<WebLookupResult>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details) return new Text(contentText(result));
  return new EvidenceCard("web_lookup", "✓ Web Lookup", details.results.slice(0, 8).flatMap((r) => [
    `[${shortId(r.page_id)}:${shortId(r.chunk_id)}] ${r.title}${r.heading_path ? ` > ${r.heading_path}` : ""}`,
    `matched ${r.matched_terms.join(", ") || "—"}`,
    `best ${r.best_format} ${truncateMiddle(`${r.best_path}${r.line_start ? `:${r.line_start}` : ""}`, 112)}`,
  ]));
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function renderErrorCard(error: unknown): Component {
  const message = error instanceof Error ? error.message : String(error);
  return new EvidenceCard("web_error", "✗ Web Evidence", [`${ANSI.bad}${message}${ANSI.reset}`]);
}

function contentText(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

export function renderCardForTest(width: number, title = "✓ Web Fetch", rows = ["semantic /tmp/pi-web-cache/example/page.semantic.html"]): string[] {
  return cardLines(width, "test", title, rows);
}

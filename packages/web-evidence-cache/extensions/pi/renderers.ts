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
  const chars = Array.from(stripAnsi(value));
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    width += codePointWidth(chars[i].codePointAt(0) ?? 0, chars[i + 1]?.codePointAt(0));
  }
  return width;
}

function isDefaultEmojiWide(cp: number): boolean {
  return (
    cp === 0x00a9 || cp === 0x00ae ||
    cp === 0x203c || cp === 0x2049 ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 || cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x1f000 && cp <= 0x1faff)
  );
}

function canTakeEmojiPresentation(cp: number): boolean {
  return isDefaultEmojiWide(cp) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff);
}

function codePointWidth(cp: number, nextCp?: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((nextCp === 0xfe0f && canTakeEmojiPresentation(cp)) || isDefaultEmojiWide(cp)) return 2;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)) return 2;
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
  const chars = Array.from(value);
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0) ?? 0;
    const nextCp = chars[i + 1]?.codePointAt(0);
    const cluster = nextCp === 0xfe0f && canTakeEmojiPresentation(cp) ? chars[i] + chars[i + 1] : chars[i];
    const w = visWidth(cluster);
    if (used + w > width - 1) break;
    out += cluster;
    used += w;
    if (cluster.length > chars[i].length) i++;
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
  const rows = [`refs   ${refs}`];
  if (args.format !== undefined) rows.push(`format ${String(args.format)}`);
  if (args.refresh !== undefined) rows.push(`refresh ${String(args.refresh)}`);
  return new EvidenceCard(refs || "web_fetch", "◐ Web Fetch", rows);
}

export function renderLookupCall(args: Record<string, unknown>): Component {
  const rows = [`query  ${String(args.query ?? "")}`, `limit  ${String(args.limit ?? "auto")}`];
  if (args.match_mode !== undefined) rows.push(`mode   ${String(args.match_mode)}`);
  return new EvidenceCard(String(args.query ?? "web_lookup"), "◐ Web Lookup", rows);
}

export function renderSearchResult(result: AgentToolResult<WebSearchResult>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details) return new Text(contentText(result));
  return new EvidenceCard("web_search", "✓ Web Search Leads", [
    "next web_fetch selected aliases/ids",
    ...details.results.slice(0, 5).flatMap((r) => [
      `[${r.alias}] id ${r.id}`,
      `${r.title} · ${r.provider}`,
      truncateMiddle(r.url, 120),
    ]),
  ]);
}

export function renderFetchResult(result: AgentToolResult<WebFetchResult>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details) return new Text(contentText(result));
  return new EvidenceCard("web_fetch", "✓ Web Fetch", details.results.flatMap((r) => {
    const warning = r.extraction.confidence === "good" ? [] : [`warning  ${r.extraction.confidence}: ${r.extraction.warnings.join("; ") || "verify before citing"}`];
    const preview = r.preview ? [`preview  ${truncateEnd(r.preview.replace(/\s+/g, " ").trim(), 120)} (not citable)`] : [];
    return [
      `[${shortId(r.id)}] ${r.title} · ${r.extraction.engine}/${r.extraction.confidence}`,
      `READ NEXT ${r.best_format} ${truncateMiddle(r.best_path, 108)}`,
      ...warning,
      ...preview,
      `details  id ${r.id}; alternate paths in tool details`,
    ];
  }));
}

export function renderLookupResult(result: AgentToolResult<WebLookupResult>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details) return new Text(contentText(result));
  if (!details.results.length) return new EvidenceCard("web_lookup", "✓ Web Lookup", [
    "no matches in fetched artifacts; not proof of absence",
    "try broader terms, remove filters, fetch more sources, or run web_search",
  ]);
  return new EvidenceCard("web_lookup", "✓ Web Lookup", details.results.slice(0, 8).flatMap((r) => [
    `[${shortId(r.page_id)}:${shortId(r.chunk_id)}] ${r.title}${r.heading_path ? ` > ${r.heading_path}` : ""}`,
    `READ NEXT ${r.best_format} ${truncateMiddle(`${r.best_path}${r.line_start ? `:${r.line_start}` : ""}`, 108)}`,
    `matched recall:${r.match_mode} ${r.matched_terms.join(", ") || "—"}`,
    `snippet   ${truncateEnd(r.snippet.replace(/\s+/g, " ").trim(), 120)} (not citable)`,
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

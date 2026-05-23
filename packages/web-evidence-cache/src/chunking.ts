import { parseHTML } from "linkedom";
import type { ChunkRecord } from "./types.js";

const HARD_CHARS = 9_000;

export interface ChunkArtifacts {
  semanticHtml: string;
  chunks: Omit<ChunkRecord, "page_id" | "semantic_html_path" | "markdown_path" | "text_path">[];
}

export function chunkSemanticHtml(input: { pageId: string; semanticHtml: string; text: string }): ChunkArtifacts {
  const { document } = parseHTML(input.semanticHtml);
  const article = document.querySelector("article") ?? document.body;
  const headingPath: string[] = [];
  const chunks: Omit<ChunkRecord, "page_id" | "semantic_html_path" | "markdown_path" | "text_path">[] = [];
  const blocks = Array.from(article.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,table,blockquote,ul,ol,dl"));
  const lineIndex = buildLineIndex(input.text);

  for (const block of blocks) {
    const tag = block.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      headingPath.splice(level - 1);
      headingPath[level - 1] = clean(block.textContent ?? "");
      continue;
    }
    const text = clean(block.textContent ?? "");
    if (!text) continue;
    const parts = splitOversized(text, HARD_CHARS);
    for (const part of parts) {
      const ordinal = chunks.length;
      const id = `${input.pageId}-c${ordinal + 1}`;
      block.setAttribute("data-chunk-id", id);
      const line = findLine(lineIndex, part.slice(0, 80));
      chunks.push({
        id,
        ordinal,
        heading_path: headingPath.filter(Boolean).join(" > ") || undefined,
        line_start: line,
        line_end: line ? line + Math.max(0, part.split("\n").length - 1) : undefined,
        text: part,
        token_count: Math.ceil(part.length / 4),
      });
    }
  }

  if (!chunks.length) {
    const text = clean(article.textContent ?? input.text);
    chunks.push({
      id: `${input.pageId}-c1`,
      ordinal: 0,
      text,
      line_start: 1,
      line_end: Math.max(1, input.text.split("\n").length),
      token_count: Math.ceil(text.length / 4),
    });
  }

  return { semanticHtml: `${article.outerHTML}\n`, chunks };
}

function splitOversized(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildLineIndex(text: string): string[] {
  return text.split(/\r?\n/);
}

function findLine(lines: string[], needle: string): number | undefined {
  const shortNeedle = clean(needle).slice(0, 60);
  const idx = lines.findIndex((line) => clean(line).includes(shortNeedle));
  return idx >= 0 ? idx + 1 : undefined;
}

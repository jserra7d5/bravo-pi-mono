import { Readability } from "@mozilla/readability";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { parseHTML } from "linkedom";
import { htmlToText, semanticHtml } from "./html.js";

export interface ExtractionResult {
  title: string;
  semanticHtml: string;
  markdown: string;
  text: string;
  engine: string;
  confidence: "good" | "partial" | "weak";
  warnings: string[];
}

interface DefuddleOutput {
  title?: string;
  content?: string;
  contentHtml?: string;
  markdown?: string;
}

interface DefuddleModule {
  Defuddle?: new (document: Document, options?: Record<string, unknown>) => { parse: () => DefuddleOutput };
}

export async function extractDocument(html: string, sourceUrl: string, sourceId: string): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const defuddle = await tryDefuddle(html, sourceUrl).catch((error: unknown) => {
    warnings.push(`defuddle failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (defuddle?.contentHtml || defuddle?.content) {
    const title = defuddle.title || titleFromHtml(html) || sourceUrl;
    const sem = semanticHtml({ html: defuddle.contentHtml || defuddle.content || "", sourceUrl, sourceId, title });
    const markdown = defuddle.markdown?.trim() || NodeHtmlMarkdown.translate(sem);
    const text = htmlToText(sem);
    return { title, semanticHtml: sem, markdown: `${markdown.trim()}\n`, text, engine: "defuddle", confidence: "good", warnings };
  }

  const fallback = readabilityExtract(html, sourceUrl);
  warnings.push("used readability fallback");
  const sem = semanticHtml({ html: fallback.content, sourceUrl, sourceId, title: fallback.title });
  return {
    title: fallback.title,
    semanticHtml: sem,
    markdown: `${NodeHtmlMarkdown.translate(sem).trim()}\n`,
    text: htmlToText(sem),
    engine: "readability",
    confidence: fallback.content.trim().length > 200 ? "partial" : "weak",
    warnings,
  };
}

async function tryDefuddle(html: string, sourceUrl: string): Promise<DefuddleOutput | undefined> {
  const mod = await import("defuddle") as DefuddleModule;
  if (!mod.Defuddle) return undefined;
  const { document } = parseHTML(html);
  const parsed = new mod.Defuddle(document as unknown as Document, { url: sourceUrl, markdown: true }).parse();
  return {
    title: parsed.title,
    contentHtml: parsed.contentHtml ?? parsed.content,
    markdown: parsed.markdown,
  };
}

function readabilityExtract(html: string, sourceUrl: string): { title: string; content: string } {
  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as Document);
  const parsed = reader.parse();
  return {
    title: parsed?.title || titleFromHtml(html) || sourceUrl,
    content: parsed?.content || document.body?.innerHTML || html,
  };
}

function titleFromHtml(html: string): string | undefined {
  const { document } = parseHTML(html);
  return document.querySelector("title")?.textContent?.trim() || document.querySelector("h1")?.textContent?.trim() || undefined;
}

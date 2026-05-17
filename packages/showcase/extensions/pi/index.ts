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
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
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

interface ShowcaseDetails {
  summary: string;
  ok: boolean;
  path?: string;
  title?: string;
  offset?: number;
  limit?: number;
  endLine?: number;
  lineCount?: number;
  mode?: Exclude<ShowcaseMode, "auto">;
  language?: string;
  body?: string;
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

function inferMode(filePath: string, content: string, requested: ShowcaseMode | undefined): Exclude<ShowcaseMode, "auto"> {
  if (requested && requested !== "auto") return requested;
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown";
  if (ext === ".json" || ext === ".jsonl") return "json";
  if (ext === ".diff" || ext === ".patch" || content.startsWith("diff --git") || content.startsWith("--- ")) return "diff";
  if (ext === ".txt" || ext === ".log") return "plain";
  return "code";
}

function codeFenceLanguage(mode: Exclude<ShowcaseMode, "auto">, language: string | undefined): string | undefined {
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
  return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} │ ${line}`);
}

function showcaseLocation(details: ShowcaseDetails): string {
  return details.path ? `${details.path}${details.offset && details.endLine ? `:${details.offset}-${details.endLine}` : ""}` : "";
}

function showcaseLabel(details: ShowcaseDetails): string {
  const location = showcaseLocation(details);
  if (!details.title) return location;
  if (!location || details.title.includes(details.path ?? location)) return details.title;
  return `${details.title} — ${location}`;
}

function showcaseRule(kind: "start" | "end", details: ShowcaseDetails): string {
  const text = kind === "start" ? ` Showcase: ${showcaseLabel(details) || "content"} ` : " End showcase ";
  const width = Math.max(8, 80 - text.length - 2);
  const left = kind === "start" ? "╭" : "╰";
  return `${left}${"─".repeat(2)}${text}${"─".repeat(width)}`;
}

function renderMarkdownBody(details: ShowcaseDetails): Component {
  const container = new Container();
  container.addChild(new Text(showcaseRule("start", details), 0, 0));
  container.addChild(new Markdown(details.body ?? "", 0, 0, getMarkdownTheme()));
  container.addChild(new Text(showcaseRule("end", details), 0, 0));
  return container;
}

function renderTextBody(details: ShowcaseDetails): Component {
  const mode = details.mode ?? "plain";
  const language = details.language ?? getLanguageFromPath(details.path ?? "") ?? codeFenceLanguage(mode, undefined);
  const body = details.body ?? "";
  const renderedLines = mode === "diff" ? renderDiff(body).split("\n") : mode === "plain" ? body.split("\n") : highlightCode(body, language);
  const lines = mode === "diff" ? renderedLines : addLineNumbers(renderedLines, details.offset);
  return new Text([showcaseRule("start", details), ...lines, showcaseRule("end", details)].join("\n"));
}

function renderShowcaseResult(result: AgentToolResult<ShowcaseDetails>, _options: ToolRenderResultOptions): Component {
  const details = result.details;
  if (!details?.ok) return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
  if (details.mode === "markdown") return renderMarkdownBody(details);
  return renderTextBody(details);
}

function renderShowcaseCall(_args: ShowcaseArgs): Component {
  return new Text("");
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
          const summary = `Showcased ${params.path}:${offset}-${slice.endLine} to the user.`;
          return {
            content: [{ type: "text", text: summary }],
            details: { summary, ok: true, path: params.path, title, offset, limit, endLine: slice.endLine, lineCount: slice.lineCount, mode, language, body },
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

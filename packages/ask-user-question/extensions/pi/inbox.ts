import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { QuestionRequest, Urgency } from "./schema.js";

export function badge(requests: QuestionRequest[]): { text?: string; urgency?: Urgency } {
  const pending = requests.filter((r) => r.state === "pending");
  if (!pending.length) return {};
  const rank = { low: 0, normal: 1, high: 2 } as const;
  const urgency = pending.reduce<Urgency>((max, r) => rank[r.urgency] > rank[max] ? r.urgency : max, "low");
  return { text: `[${pending.length}${pending.some((r) => r.delivery === "blocking") ? " ?" : ""} user-questions]`, urgency };
}

export class QuestionInboxComponent implements Component {
  private cursor = 0;
  constructor(private readonly requests: QuestionRequest[], private readonly theme: Theme, private readonly done: (requestId?: string) => void, private readonly rerender: () => void) {}
  invalidate(): void {}
  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth < 5) return [truncateToWidth("? User questions", safeWidth)];

    const lines = [titleBorder(safeWidth, this.theme)];
    for (let i = 0; i < this.requests.length; i++) {
      const r = this.requests[i];
      const blocking = r.delivery === "blocking";
      const glyph = blocking ? "?" : "·";
      const topic = r.questions.map((q) => q.header).join(", ");
      const age = ageText(r.createdAt);
      const prefix = i === this.cursor ? "> " : "  ";
      const delivery = blocking ? "blocking" : "async";
      const candidates = [
        `${prefix}${glyph} ${r.urgency} ${delivery} ${age} ${topic}`,
        `${prefix}${glyph} ${r.urgency} ${delivery} ${topic}`,
        `${prefix}${glyph} ${r.urgency} ${topic}`,
        `${prefix}${glyph} ${topic}`,
      ];
      const innerWidth = safeWidth - 4;
      const text = candidates.find((candidate) => visibleWidth(candidate) <= innerWidth) ?? candidates.at(-1)!;
      const styled = `${this.theme.fg(i === this.cursor ? "accent" : "dim", prefix)}${this.theme.fg(blocking ? "warning" : "muted", glyph)}${text.slice(prefix.length + glyph.length)}`;
      lines.push(containerRow(styled, safeWidth, this.theme));
    }
    lines.push(containerRow(this.theme.fg("dim", "↑↓ navigate · Enter open · Esc close"), safeWidth, this.theme));
    lines.push(this.theme.fg("muted", `╰${"─".repeat(safeWidth - 2)}╯`));
    return lines;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.done();
    if (matchesKey(data, Key.enter) && this.requests[this.cursor]) return this.done(this.requests[this.cursor].requestId);
    if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down)) this.cursor = Math.min(this.requests.length - 1, this.cursor + 1);
    else return;
    this.rerender();
  }
}

function titleBorder(width: number, theme: Theme): string {
  const title = truncateToWidth("? User questions", width - 5);
  const rule = "─".repeat(Math.max(0, width - 5 - visibleWidth(title)));
  return `${theme.fg("muted", "╭─ ")}${theme.fg("warning", title)}${theme.fg("muted", ` ${rule}╮`)}`;
}

function containerRow(content: string, width: number, theme: Theme): string {
  const innerWidth = width - 4;
  const truncated = truncateToWidth(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  return `${theme.fg("muted", "▌ ")}${truncated}${padding}${theme.fg("muted", " │")}`;
}

function ageText(value: string): string { const mins = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000)); return mins < 1 ? "now" : `${mins}m`; }

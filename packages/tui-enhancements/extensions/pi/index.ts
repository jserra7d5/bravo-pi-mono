import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

type InlineSlashAutocompleteItem = AutocompleteItem & {
	__inlineSlashCommand?: true;
};

type AutocompleteSuggestions = {
	items: AutocompleteItem[];
	prefix: string;
};

type AutocompleteProvider = {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
};

type CommandInfo = ReturnType<ExtensionAPI["getCommands"]>[number];

type LinkItem = {
	label: string;
	target: string;
	description: string;
};

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OSC52_MAX_CHARS = 100_000;

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	return match ? content.slice(match[0].length) : content;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRemovedDirectiveWhitespace(text: string): string {
	return text
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function skillCommands(pi: ExtensionAPI): CommandInfo[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
		.filter((command) => SKILL_NAME_RE.test(command.name.slice("skill:".length)) && Boolean(command.sourceInfo?.path));
}

function transformInlineSkills(text: string, pi: ExtensionAPI): string | undefined {
	const commands = skillCommands(pi);
	if (commands.length === 0) return undefined;

	const byName = new Map(commands.map((command) => [command.name.slice("skill:".length), command]));
	const namesAlternation = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
	if (!namesAlternation) return undefined;

	const directiveRe = new RegExp(`(^|\\s)/skill:(${namesAlternation})(?=$|\\s)`, "g");
	const matches = [...text.matchAll(directiveRe)];
	if (matches.length === 0) return undefined;

	const leadingOnlyRe = new RegExp(`^\\s*/skill:(${namesAlternation})(?:\\s+[\\s\\S]*)?$`);
	if (matches.length === 1 && leadingOnlyRe.test(text)) {
		return undefined;
	}

	const orderedUniqueNames: string[] = [];
	for (const match of matches) {
		const name = match[2];
		if (!orderedUniqueNames.includes(name)) orderedUniqueNames.push(name);
	}

	const blocks: string[] = [];
	for (const name of orderedUniqueNames) {
		const command = byName.get(name);
		const location = command?.sourceInfo?.path;
		if (!location) continue;
		let body: string;
		try {
			body = stripFrontmatter(readFileSync(location, "utf8")).trim();
		} catch {
			return undefined;
		}
		blocks.push(
			`<skill name="${escapeAttribute(name)}" location="${escapeAttribute(location)}">\nReferences are relative to ${dirname(location)}.\n\n${body}\n</skill>`,
		);
	}
	if (blocks.length === 0) return undefined;

	const request = normalizeRemovedDirectiveWhitespace(text.replace(directiveRe, "$1"));
	return request ? `${blocks.join("\n\n")}\n\n${request}` : blocks.join("\n\n");
}

function inlineSlashPrefix(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	const currentLine = lines[cursorLine] ?? "";
	const beforeCursor = currentLine.slice(0, cursorCol);
	const match = beforeCursor.match(/(^|\s)(\/[A-Za-z0-9:._-]*)$/);
	if (!match) return undefined;
	const prefix = match[2];
	if (prefix.slice(1).includes("/")) return undefined;
	return prefix;
}

function markInlineSlashItems(items: AutocompleteItem[]): InlineSlashAutocompleteItem[] {
	return items.map((item) => ({ ...item, __inlineSlashCommand: true }));
}

function isInlineSlashItem(item: AutocompleteItem): item is InlineSlashAutocompleteItem {
	return (item as InlineSlashAutocompleteItem).__inlineSlashCommand === true;
}

function wrapInlineSlashProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const prefix = inlineSlashPrefix(lines, cursorLine, cursorCol);
			if (prefix) {
				const synthetic = await current.getSuggestions([prefix], 0, prefix.length, {
					signal: options.signal,
					force: false,
				});
				if (synthetic) return { ...synthetic, items: markInlineSlashItems(synthetic.items), prefix };
			}

			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!isInlineSlashItem(item)) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLine = `${beforePrefix}/${item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}

function shorten(value: string, max = 72): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function compactUrlLabel(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		return shorten(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`);
	} catch {
		return shorten(rawUrl);
	}
}

function compactFileLabel(filePath: string, line?: string): string {
	const rel = relative(process.cwd(), filePath);
	const displayPath = rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : filePath;
	return shorten(`${displayPath}${line ? `:${line}` : ""}`);
}

function trimTerminalPunctuation(value: string): string {
	return value.replace(/[),.;!?]+$/g, "");
}

function fileTarget(filePath: string, line?: string, col?: string): string {
	const url = pathToFileURL(filePath).href;
	if (!line) return url;
	return `${url}#L${line}${col ? `C${col}` : ""}`;
}

function addLink(map: Map<string, LinkItem>, item: LinkItem): void {
	if (map.has(item.target)) map.delete(item.target);
	map.set(item.target, item);
}

function extractLinksFromText(text: string): LinkItem[] {
	const links = new Map<string, LinkItem>();
	const markdownSpans: Array<[number, number]> = [];
	const markdownRe = /\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
	for (const match of text.matchAll(markdownRe)) {
		const target = trimTerminalPunctuation(match[2]);
		markdownSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
		addLink(links, {
			label: shorten(match[1].trim() || compactUrlLabel(target)),
			target,
			description: shorten(target),
		});
	}

	const inMarkdown = (index: number) => markdownSpans.some(([start, end]) => index >= start && index < end);
	const urlRe = /https?:\/\/[^\s<>)\]]+/g;
	for (const match of text.matchAll(urlRe)) {
		if (inMarkdown(match.index ?? 0)) continue;
		const target = trimTerminalPunctuation(match[0]);
		addLink(links, { label: compactUrlLabel(target), target, description: shorten(target) });
	}

	const fileRe = /(^|[\s([`'"])(\/(?:[^\s\])}>'"])+)/g;
	for (const match of text.matchAll(fileRe)) {
		let raw = trimTerminalPunctuation(match[2]);
		if (!raw || raw.startsWith("//")) continue;
		const suffix = raw.match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/);
		const filePath = suffix?.[1] ?? raw;
		const line = suffix?.[2];
		const col = suffix?.[3];
		if (!filePath.startsWith("/")) continue;
		const target = fileTarget(filePath, line, col);
		addLink(links, {
			label: compactFileLabel(filePath, line),
			target,
			description: shorten(target),
		});
	}

	return [...links.values()];
}

function messageTexts(message: any): string[] {
	const texts: string[] = [];
	const addContent = (content: unknown) => {
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && "text" in block && typeof block.text === "string") texts.push(block.text);
				if (block && typeof block === "object" && "thinking" in block && typeof block.thinking === "string") texts.push(block.thinking);
			}
		}
	};
	addContent(message?.content);
	if (typeof message?.output === "string") texts.push(message.output);
	if (typeof message?.summary === "string") texts.push(message.summary);
	return texts;
}

function scanSessionLinks(ctx: { sessionManager?: { getBranch?: () => any[]; getEntries?: () => any[] } }): LinkItem[] {
	const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	const byTarget = new Map<string, LinkItem>();
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : entry?.message;
		if (!message) continue;
		for (const text of messageTexts(message)) {
			for (const link of extractLinksFromText(text)) addLink(byTarget, link);
		}
	}
	return [...byTarget.values()].reverse();
}

function osc8(label: string, target: string): string {
	return `\u001b]8;;${target}\u0007${label}\u001b]8;;\u0007`;
}

function copyWithOsc52(text: string): { ok: true } | { ok: false; reason: string } {
	if (text.length > OSC52_MAX_CHARS) return { ok: false, reason: "Link is too large for OSC52 clipboard copy." };
	const payload = Buffer.from(text, "utf8").toString("base64");
	const sequence = `\u001b]52;c;${payload}\u0007`;
	process.stdout.write(process.env.TMUX ? `\u001bPtmux;\u001b${sequence}\u001b\\` : sequence);
	return { ok: true };
}

function selectLink(links: LinkItem[], arg: string): LinkItem | undefined {
	const query = arg.trim();
	if (!query) return links[0];
	if (/^\d+$/.test(query)) return links[Number(query) - 1];
	const needle = query.toLocaleLowerCase();
	return links.find((link) => link.label.toLocaleLowerCase().includes(needle) || link.target.toLocaleLowerCase().includes(needle));
}

async function showLinksOverlay(ctx: any): Promise<void> {
	const links = scanSessionLinks(ctx);
	if (links.length === 0) {
		ctx.ui.notify("No links found in the current session branch.", "warning");
		return;
	}

	const items: SelectItem[] = links.map((link) => ({ value: link.target, label: link.label, description: link.description }));
	const linkByTarget = new Map(links.map((link) => [link.target, link]));
	const selected: string | null = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: string | null) => void) => {
		let selectedTarget = links[0]?.target;
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Session Links")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Enter/y copies selected link • Esc cancels"), 1, 0));
		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (s: string) => theme.fg("accent", s),
			selectedText: (s: string) => theme.fg("accent", s),
			description: (s: string) => theme.fg("muted", s),
			scrollInfo: (s: string) => theme.fg("dim", s),
			noMatch: (s: string) => theme.fg("warning", s),
		});
		selectList.onSelect = (item) => done(String(item.value));
		selectList.onCancel = () => done(null);
		selectList.onSelectionChange = (item) => {
			selectedTarget = String(item.value);
		};
		container.addChild(selectList);
		container.addChild({
			render: (width: number) => {
				const link = selectedTarget ? linkByTarget.get(selectedTarget) : undefined;
				if (!link) return [];
				const label = shorten(`Clickable: ${link.label}`, Math.max(8, width - 4));
				return [`  ${theme.fg("dim", osc8(label, link.target))}`];
			},
			invalidate: () => undefined,
		});
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "y") {
					const item = selectList.getSelectedItem();
					if (item) done(String(item.value));
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	if (!selected) return;
	const copied = copyWithOsc52(selected);
	ctx.ui.notify(copied.ok ? "Copied link to clipboard." : copied.reason, copied.ok ? "info" : "warning");
}

function copyLinkCommand(arg: string, ctx: any): void {
	const links = scanSessionLinks(ctx);
	const link = selectLink(links, arg);
	if (!link) {
		ctx.ui.notify(arg.trim() ? `No link matched: ${arg.trim()}` : "No links found in the current session branch.", "warning");
		return;
	}
	const copied = copyWithOsc52(link.target);
	ctx.ui.notify(copied.ok ? `Copied: ${link.label}` : copied.reason, copied.ok ? "info" : "warning");
}

export default function tuiEnhancementsExtension(pi: ExtensionAPI) {
	pi.registerCommand("links", {
		description: "Show recent links from the current session and copy one with OSC52.",
		handler: async (_args, ctx) => showLinksOverlay(ctx),
	});

	pi.registerCommand("copy-link", {
		description: "Copy the most recent, nth, or substring-matched session link with OSC52.",
		handler: async (args, ctx) => copyLinkCommand(args, ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider(wrapInlineSlashProvider);
	});

	pi.on("input", async (event) => {
		const transformed = transformInlineSkills(event.text, pi);
		if (!transformed || transformed === event.text) return { action: "continue" };
		return { action: "transform", text: transformed, images: event.images };
	});
}

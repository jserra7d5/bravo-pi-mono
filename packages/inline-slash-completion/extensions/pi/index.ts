import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export default function inlineSlashCompletionExtension(pi: ExtensionAPI) {
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

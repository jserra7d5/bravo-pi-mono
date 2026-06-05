import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

type CavemanMode = "lite" | "full" | "ultra";
type CavemanStateEntry = {
	mode?: CavemanMode;
	active?: boolean;
};

const STATE_ENTRY_TYPE = "bravo-caveman-state";
const MODE_ENV = "BRAVO_CAVEMAN_MODE";
const INHERITED_EXTENSIONS_ENV = "ASYNC_SUBAGENTS_INHERITED_EXTENSIONS";
const EXTENSION_PATH = fileURLToPath(import.meta.url);
const VALID_MODES = new Set<CavemanMode>(["lite", "full", "ultra"]);

function parseMode(args: string | undefined): CavemanMode {
	const requested = args?.trim().toLowerCase();
	if (!requested) return "full";
	if (VALID_MODES.has(requested as CavemanMode)) return requested as CavemanMode;
	throw new Error(`Unknown caveman mode: ${requested}. Expected lite, full, or ultra.`);
}

function modeFromEnv(): CavemanMode | undefined {
	const mode = process.env[MODE_ENV];
	return VALID_MODES.has(mode as CavemanMode) ? (mode as CavemanMode) : undefined;
}

function inheritedExtensionPaths(): string[] {
	const value = process.env[INHERITED_EXTENSIONS_ENV];
	if (!value) return [];
	try {
		const parsed = value.trim().startsWith("[") ? JSON.parse(value) : value.split(delimiter);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
	} catch {
		return [];
	}
}

function setInheritedExtensionPath(enabled: boolean): void {
	const paths = inheritedExtensionPaths().filter((path) => path !== EXTENSION_PATH);
	if (enabled) paths.push(EXTENSION_PATH);
	if (paths.length) process.env[INHERITED_EXTENSIONS_ENV] = [...new Set(paths)].join(delimiter);
	else delete process.env[INHERITED_EXTENSIONS_ENV];
}

function syncEnv(mode: CavemanMode | undefined): void {
	if (mode) process.env[MODE_ENV] = mode;
	else delete process.env[MODE_ENV];
	setInheritedExtensionPath(Boolean(mode));
}

function isStateEntry(value: unknown): value is CavemanStateEntry {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return data.active === false || data.mode === "lite" || data.mode === "full" || data.mode === "ultra";
}

function restoreMode(ctx: ExtensionContext): CavemanMode | undefined {
	let mode: CavemanMode | undefined = modeFromEnv();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		if (!isStateEntry(entry.data)) continue;
		mode = entry.data.active === false ? undefined : entry.data.mode;
	}
	return mode;
}

function levelGuidance(mode: CavemanMode): string {
	switch (mode) {
		case "lite":
			return "No filler/hedging. Keep normal grammar and articles. Professional but tight.";
		case "ultra":
			return "Maximum compression. Use common abbreviations like DB/auth/config/req/res/fn when clear. Use arrows for causality. Prefer short grammatical phrases over broken English.";
		case "full":
			return "Terse and direct. Fragments OK when they read cleanly. Do not drop words in ways that create childish or broken English.";
	}
}

function cavemanInstructions(mode: CavemanMode): string {
	return `## Caveman Mode Active — ${mode}

Respond terse like smart caveman. Keep all technical substance. Remove fluff.

Current intensity: ${levelGuidance(mode)}

Rules:
- Drop filler, pleasantries, and hedging.
- Preserve exact technical terms, file paths, command names, code symbols, and error text.
- Keep code blocks unchanged unless editing code is the task.
- Prefer short direct statements.
- Keep normal word order and enough articles/prepositions that the text reads like competent English.
- Do not write stunted pseudo-reasoning such as "Need start ready" or "Need maybe date slug". Write "Need to start the ready task" or "Need a date slug" instead.
- Tool-call preambles, progress notes, and internal planning text visible to the user should be compact professional English, not caveman grammar.
- For security warnings, irreversible action confirmations, or ambiguity where terse fragments could mislead, write normally enough to be clear, then resume terse style.
- Code, commit messages, and PR-ready text should remain professionally formatted unless the user explicitly asks for caveman style there.

Stop only when user invokes /normal.`;
}

function setStatus(ctx: ExtensionContext, mode: CavemanMode | undefined): void {
	ctx.ui.setStatus("caveman", mode ? `CAVEMAN:${mode}` : undefined);
}

export default function cavemanExtension(pi: ExtensionAPI) {
	let activeMode: CavemanMode | undefined;

	pi.registerCommand("caveman", {
		description: "Enable caveman response mode (optional: lite, full, ultra)",
		handler: async (args, ctx) => {
			const mode = parseMode(args);
			activeMode = mode;
			syncEnv(activeMode);
			pi.appendEntry(STATE_ENTRY_TYPE, { active: true, mode });
			setStatus(ctx, activeMode);
			ctx.ui.notify(`Caveman mode enabled: ${mode}`, "info");
		},
	});

	pi.registerCommand("normal", {
		description: "Disable caveman response mode",
		handler: async (_args, ctx) => {
			activeMode = undefined;
			syncEnv(activeMode);
			pi.appendEntry(STATE_ENTRY_TYPE, { active: false });
			setStatus(ctx, activeMode);
			ctx.ui.notify("Caveman mode disabled", "info");
		},
	});

	const restoreActiveMode = (ctx: ExtensionContext) => {
		activeMode = restoreMode(ctx);
		syncEnv(activeMode);
		setStatus(ctx, activeMode);
	};

	pi.on("session_start", async (_event, ctx) => restoreActiveMode(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreActiveMode(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!activeMode) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n---\n\n${cavemanInstructions(activeMode)}`,
		};
	});
}

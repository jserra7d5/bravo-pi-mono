import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type CavemanMode = "lite" | "full" | "ultra";
type CavemanStateEntry = {
	mode?: CavemanMode;
	active?: boolean;
};

const STATE_ENTRY_TYPE = "bravo-caveman-state";
const VALID_MODES = new Set<CavemanMode>(["lite", "full", "ultra"]);

function parseMode(args: string | undefined): CavemanMode {
	const requested = args?.trim().toLowerCase();
	if (!requested) return "full";
	if (VALID_MODES.has(requested as CavemanMode)) return requested as CavemanMode;
	throw new Error(`Unknown caveman mode: ${requested}. Expected lite, full, or ultra.`);
}

function isStateEntry(value: unknown): value is CavemanStateEntry {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return data.active === false || data.mode === "lite" || data.mode === "full" || data.mode === "ultra";
}

function restoreMode(ctx: ExtensionContext): CavemanMode | undefined {
	let mode: CavemanMode | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
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
			return "Maximum compression. Use common abbreviations like DB/auth/config/req/res/fn when clear. Use arrows for causality. One word when one word enough.";
		case "full":
			return "Drop articles where clear. Fragments OK. Short synonyms. Classic caveman style.";
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
- Pattern: [thing] [action] [reason]. [next step].
- For security warnings, irreversible action confirmations, or ambiguity where terse fragments could mislead, write normally enough to be clear, then resume caveman style.
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
			pi.appendEntry(STATE_ENTRY_TYPE, { active: true, mode });
			setStatus(ctx, activeMode);
			ctx.ui.notify(`Caveman mode enabled: ${mode}`, "info");
		},
	});

	pi.registerCommand("normal", {
		description: "Disable caveman response mode",
		handler: async (_args, ctx) => {
			activeMode = undefined;
			pi.appendEntry(STATE_ENTRY_TYPE, { active: false });
			setStatus(ctx, activeMode);
			ctx.ui.notify("Caveman mode disabled", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeMode = restoreMode(ctx);
		setStatus(ctx, activeMode);
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeMode) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n---\n\n${cavemanInstructions(activeMode)}`,
		};
	});
}

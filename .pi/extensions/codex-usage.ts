// Bravo footer redesign for pi-coding-agent.
//
// Takes over the entire pi footer via pi.ui.setFooter() and renders a two-line
// layout with a colored context bar, cost, and inline mini-bars for Codex
// rate-limit windows (when on a Codex model). Replaces the built-in
// "↑↓R$ ctx% (provider) model • thinking" footer.
//
// The Codex rate-limit fetching logic is preserved from the previous
// setStatus()-based version; only the rendering path changed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";

// ── codex usage fetch (preserved from previous version) ────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MODEL_SPEED_CONFIG_PATH = join(process.cwd(), ".pi", "model-speed.json");
const FAST_SERVICE_TIER = "priority";

type UsageWindow = {
	label: "primary" | "secondary";
	remainingPercent?: number;
	resetAt?: number;
	windowSeconds?: number;
};

type CodexUsage = {
	primary?: UsageWindow;
	secondary?: UsageWindow;
};

function isCodexModel(model: Model<any> | undefined): boolean {
	return model?.provider === "openai-codex" || model?.api === "openai-codex-responses";
}

function readFastModeSetting(): boolean {
	try {
		if (!existsSync(MODEL_SPEED_CONFIG_PATH)) return false;
		const parsed = JSON.parse(readFileSync(MODEL_SPEED_CONFIG_PATH, "utf8")) as { fast?: unknown };
		return parsed.fast === true;
	} catch {
		return false;
	}
}

function writeFastModeSetting(enabled: boolean): void {
	mkdirSync(dirname(MODEL_SPEED_CONFIG_PATH), { recursive: true });
	writeFileSync(
		MODEL_SPEED_CONFIG_PATH,
		`${JSON.stringify({ fast: enabled, mode: enabled ? "fast" : "normal" }, null, 2)}\n`,
		"utf8",
	);
}

export function parseFastCommand(args: string): "on" | "off" | "status" | "help" {
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "status";
	if (tokens.length > 1) return "help";
	const [first] = tokens;
	if (first === "on" || first === "enable" || first === "enabled" || first === "true") return "on";
	if (first === "off" || first === "disable" || first === "disabled" || first === "false") return "off";
	if (first === "status") return "status";
	return "help";
}

function isPayloadRecord(payload: unknown): payload is Record<string, unknown> {
	return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

export function applyModelSpeedToPayload(
	payload: unknown,
	model: Model<any> | undefined,
	fastEnabled: boolean,
): unknown | undefined {
	if (!fastEnabled || !isCodexModel(model) || !isPayloadRecord(payload)) return undefined;
	return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function decodeJwtPayload(token: string): Record<string, any> | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, any>;
	} catch {
		return undefined;
	}
}

function getAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asTimestampMs(value: unknown): number | undefined {
	const numberValue = asNumber(value);
	if (numberValue !== undefined) return numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function firstNumber(record: Record<string, any>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = asNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function firstTimestamp(record: Record<string, any>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = asTimestampMs(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function parseWindow(label: UsageWindow["label"], value: unknown): UsageWindow | undefined {
	const record = asRecord(value);
	if (!record) return undefined;

	let remainingPercent = firstNumber(record, [
		"remaining_percent",
		"remainingPercent",
		"percent_remaining",
		"percentRemaining",
	]);

	if (remainingPercent === undefined) {
		const usedPercent = firstNumber(record, ["used_percent", "usedPercent", "percent_used", "percentUsed"]);
		if (usedPercent !== undefined) remainingPercent = 100 - usedPercent;
	}

	if (remainingPercent === undefined) {
		const remaining = firstNumber(record, ["remaining", "remaining_tokens", "remainingTokens", "available"]);
		const limit = firstNumber(record, ["limit", "quota", "total", "max"]);
		const used = firstNumber(record, ["used", "current", "usage", "consumed"]);
		if (remaining !== undefined && limit && limit > 0) remainingPercent = (remaining / limit) * 100;
		else if (used !== undefined && limit && limit > 0) remainingPercent = 100 - (used / limit) * 100;
	}

	let resetAt = firstTimestamp(record, [
		"reset_at",
		"resetAt",
		"resets_at",
		"resetsAt",
		"reset_time",
		"resetTime",
		"end_time",
		"endTime",
		"end",
	]);
	if (resetAt === undefined) {
		const resetAfterSeconds = firstNumber(record, ["reset_after_seconds", "resetAfterSeconds"]);
		if (resetAfterSeconds !== undefined) resetAt = Date.now() + resetAfterSeconds * 1000;
	}
	const windowSeconds = firstNumber(record, [
		"limit_window_seconds",
		"limitWindowSeconds",
		"window_seconds",
		"windowSeconds",
	]);

	if (remainingPercent === undefined && resetAt === undefined) return undefined;
	return {
		label,
		remainingPercent: remainingPercent === undefined ? undefined : clampPercent(remainingPercent),
		resetAt,
		windowSeconds,
	};
}

function findNamedWindow(payload: unknown, name: UsageWindow["label"], seen = new Set<unknown>()): UsageWindow | undefined {
	if (!payload || typeof payload !== "object" || seen.has(payload)) return undefined;
	seen.add(payload);

	if (Array.isArray(payload)) {
		for (const item of payload) {
			const record = asRecord(item);
			const windowName = record?.name ?? record?.type ?? record?.window ?? record?.label;
			if (typeof windowName === "string" && windowName.toLowerCase() === name) {
				const parsed = parseWindow(name, item);
				if (parsed) return parsed;
			}
			const nested = findNamedWindow(item, name, seen);
			if (nested) return nested;
		}
		return undefined;
	}

	const record = payload as Record<string, any>;
	for (const key of Object.keys(record)) {
		if (key.toLowerCase() === name) {
			const parsed = parseWindow(name, record[key]);
			if (parsed) return parsed;
		}
	}
	for (const value of Object.values(record)) {
		const nested = findNamedWindow(value, name, seen);
		if (nested) return nested;
	}
	return undefined;
}

function parseUsage(payload: unknown): CodexUsage | undefined {
	const record = asRecord(payload);
	const rateLimit = asRecord(record?.rate_limit);
	const usage: CodexUsage = {
		primary:
			parseWindow("primary", rateLimit?.primary_window ?? rateLimit?.primaryWindow) ??
			findNamedWindow(payload, "primary"),
		secondary:
			parseWindow("secondary", rateLimit?.secondary_window ?? rateLimit?.secondaryWindow) ??
			findNamedWindow(payload, "secondary"),
	};
	return usage.primary || usage.secondary ? usage : undefined;
}

function formatReset(resetAt: number | undefined, now = Date.now()): string | undefined {
	if (!resetAt) return undefined;
	const diffMs = resetAt - now;
	if (diffMs <= 0) return "now";
	const minutes = Math.ceil(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<CodexUsage | undefined> {
	if (!isCodexModel(ctx.model)) return undefined;

	const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!token) return undefined;

	const accountId = getAccountId(token);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		originator: "pi",
		accept: "application/json",
	};
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const response = await fetch(CODEX_USAGE_URL, { headers, signal: ctx.signal });
	if (!response.ok) return undefined;

	const payload = (await response.json()) as unknown;
	return parseUsage(payload);
}

// ── rendering helpers (pure) ───────────────────────────────────────────────

const R = "\x1b[0m";
export const c = {
	dim: "\x1b[38;2;120;120;128m",
	muted: "\x1b[38;2;160;160;170m",
	text: "\x1b[38;2;220;220;225m",
	ok: "\x1b[38;2;126;201;145m",
	warn: "\x1b[38;2;229;181;72m",
	bad: "\x1b[38;2;232;111;111m",
	branch: "\x1b[38;2;174;215;255m",
	cost: "\x1b[38;2;200;220;200m",
	sub: "\x1b[38;2;180;200;220m",
	// Identity palette mirrors packages/async-subagents/extensions/pi/renderers.ts
	// IDENTITY_PALETTE so a given model/agent name renders with the same hue in
	// both the footer and the async-subagents cards.
	id: [
		"\x1b[38;2;229;145;91m",
		"\x1b[38;2;199;125;186m",
		"\x1b[38;2;123;201;123m",
		"\x1b[38;2;111;169;217m",
		"\x1b[38;2;155;123;217m",
		"\x1b[38;2;91;201;181m",
		"\x1b[38;2;217;195;111m",
		"\x1b[38;2;217;125;125m",
	],
} as const;

export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visWidth(s: string): number {
	return stripAnsi(s).length;
}

export function identitySlot(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
	return h % c.id.length;
}

export function identityColor(name: string): string {
	return c.id[identitySlot(name)];
}

export function threshold(pct: number): string {
	if (pct >= 90) return c.bad;
	if (pct >= 70) return c.warn;
	if (pct >= 50) return c.text;
	return c.dim;
}

// Codex rate-limit windows: input is REMAINING percent, so the warning
// thresholds are inverted compared to context.
export function codexThreshold(remainingPct: number): string {
	if (remainingPct <= 10) return c.bad;
	if (remainingPct <= 30) return c.warn;
	return c.ok;
}

export function bar(pct: number, width: number, fillColor: string): string {
	const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
	const cells = Math.max(0, Math.min(width, Math.round((safePct / 100) * width)));
	return `${fillColor}${"▰".repeat(cells)}${c.dim}${"▱".repeat(width - cells)}${R}`;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return `${Math.round(n)}`;
}

function truncMid(s: string, max: number): string {
	if (s.length <= max) return s;
	if (max <= 1) return s.slice(0, max);
	const head = Math.ceil((max - 1) / 2);
	const tail = Math.floor((max - 1) / 2);
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function truncEnd(s: string, max: number): string {
	if (s.length <= max) return s;
	if (max <= 1) return s.slice(0, max);
	return `${s.slice(0, max - 1)}…`;
}

function clampLine(line: string, width: number): string {
	return visWidth(line) <= width ? line : `${c.dim}${truncEnd(stripAnsi(line), width)}${R}`;
}

// ── footer state & layout ──────────────────────────────────────────────────

export interface FooterRenderState {
	cwd: string;
	branch: string | null;
	sessionName: string | null;
	model: string | null;
	provider: string | null;
	providerCount: number;
	thinking: string | null;
	fast: boolean;
	ctxPct: number;
	ctxUsed: number;
	ctxWindow: number;
	ctxKnown: boolean;
	cost: number | null;
	sub: boolean;
	codex: {
		primary: number | null;
		primaryReset: string | null;
		secondary: number | null;
		secondaryReset: string | null;
	} | null;
}

export interface LayoutWidths {
	ctxBar: number;
	codexBar: number;
}

export function pickLayoutWidths(width: number): LayoutWidths {
	if (width >= 120) return { ctxBar: 16, codexBar: 10 };
	if (width >= 80) return { ctxBar: 12, codexBar: 6 };
	if (width >= 60) return { ctxBar: 8, codexBar: 4 };
	return { ctxBar: 6, codexBar: 3 };
}

export function renderTopLine(width: number, s: FooterRenderState): string {
	// Right side first so the status segment is protected and the path yields.
	const maxRight = Math.max(10, width - 10);
	let right: string;
	if (s.model) {
		let prov = s.providerCount > 1 && s.provider ? `${c.dim}${s.provider}${R}${c.dim} · ${R}` : "";
		const thinkStr = s.thinking ? `${c.dim}  thinking ${R}${c.text}${s.thinking}${R}` : "";
		const fastStr = s.fast ? `${c.dim}  speed ${R}${c.ok}fast${R}` : "";
		const suffix = `${thinkStr}${fastStr}`;
		let modelMax = maxRight - visWidth(prov) - visWidth(suffix);
		if (modelMax < 4 && prov) {
			prov = "";
			modelMax = maxRight - visWidth(suffix);
		}
		const modelText = modelMax > 0 ? truncEnd(s.model, modelMax) : "";
		right = `${prov}${identityColor(s.model)}${modelText}${R}${suffix}`;
	} else {
		right = s.fast ? `${c.dim}no model  speed ${R}${c.ok}fast${R}` : `${c.dim}no model${R}`;
	}
	if (visWidth(right) > maxRight) right = `${c.dim}${truncEnd(stripAnsi(right), maxRight)}${R}`;

	const branchStr = s.branch ? ` ${c.branch}${s.branch}${R}` : "";
	const sessStr = s.sessionName ? `${c.dim} • ${s.sessionName}${R}` : "";
	const leftPlain = `${s.cwd}${s.branch ? ` ${s.branch}` : ""}${s.sessionName ? ` • ${s.sessionName}` : ""}`;
	const availForLeft = width - visWidth(right) - 2;
	if (availForLeft <= 0) return clampLine(right, width);

	let left: string;
	if (leftPlain.length > availForLeft) {
		left = `${c.muted}${truncMid(leftPlain, availForLeft)}${R}`;
	} else {
		left = `${c.muted}${s.cwd}${R}${branchStr}${sessStr}`;
	}

	const pad = Math.max(1, width - visWidth(left) - visWidth(right));
	return clampLine(`${left}${" ".repeat(pad)}${right}`, width);
}

export function ctxSegment(ctxPct: number, ctxUsed: number, ctxWindow: number, barW: number, known: boolean): string {
	const col = threshold(ctxPct);
	const label = `${c.dim}ctx${R}`;
	const pctStr = known ? `${col}${ctxPct.toFixed(1)}%${R}` : `${c.dim}?%${R}`;
	const usage = `${c.dim}${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}${R}`;
	return `${label} ${bar(known ? ctxPct : 0, barW, col)} ${pctStr}  ${usage}`;
}

export function costSegment(cost: number | null, sub: boolean): string | null {
	if (cost == null) return null;
	const formatted = cost < 1 ? cost.toFixed(3) : cost.toFixed(2);
	const dollar = `${c.cost}$${formatted}${R}`;
	return sub ? `${dollar} ${c.sub}sub${R}` : dollar;
}

export function codexWindowSegment(
	label: string,
	remainingPct: number | null,
	resetIn: string | null,
	barW: number,
): string | null {
	if (remainingPct == null) return null;
	const col = codexThreshold(remainingPct);
	const resetStr = resetIn ? `${c.dim} in ${resetIn}${R}` : "";
	return `${c.dim}${label}${R} ${bar(100 - remainingPct, barW, col)} ${col}${Math.round(remainingPct)}%${R}${resetStr}`;
}

export function renderStatsLine(width: number, s: FooterRenderState): string {
	const { ctxBar, codexBar } = pickLayoutWidths(width);

	const parts: string[] = [ctxSegment(s.ctxPct, s.ctxUsed, s.ctxWindow, ctxBar, s.ctxKnown)];
	const costSeg = costSegment(s.cost, s.sub);
	if (costSeg) parts.push(costSeg);

	if (s.codex) {
		const p = codexWindowSegment("5h", s.codex.primary, s.codex.primaryReset, codexBar);
		const sec = codexWindowSegment("wk", s.codex.secondary, s.codex.secondaryReset, codexBar);
		if (p) parts.push(p);
		if (sec) parts.push(sec);
	}

	const gutter = `${c.dim}   ${R}`;
	let line = parts.join(gutter);
	while (visWidth(line) > width && parts.length > 1) {
		parts.pop();
		line = parts.join(gutter);
	}
	if (visWidth(line) > width) {
		// Last resort: hard truncate the plain text.
		const plain = stripAnsi(line);
		line = `${c.dim}${truncEnd(plain, width)}${R}`;
	}
	return line;
}

export function renderFooter(state: FooterRenderState, width: number): string[] {
	return [renderTopLine(width, state), renderStatsLine(width, state)];
}

// ── state collection from ExtensionContext ─────────────────────────────────

const TERMINAL_WIDTH_FALLBACK = 80;

function safeColumns(): number {
	const cols = typeof process !== "undefined" ? process.stdout?.columns : undefined;
	return typeof cols === "number" && cols > 0 ? cols : TERMINAL_WIDTH_FALLBACK;
}

function withTilde(p: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function buildCodexState(
	usage: CodexUsage | undefined,
	now = Date.now(),
): FooterRenderState["codex"] {
	if (!usage) return null;
	const primary = usage.primary?.remainingPercent;
	const secondary = usage.secondary?.remainingPercent;
	if (primary == null && secondary == null) return null;
	return {
		primary: primary == null ? null : primary,
		primaryReset: usage.primary ? formatReset(usage.primary.resetAt, now) ?? null : null,
		secondary: secondary == null ? null : secondary,
		secondaryReset: usage.secondary ? formatReset(usage.secondary.resetAt, now) ?? null : null,
	};
}

function collectState(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	thinkingLevel: string,
	fastEnabled: boolean,
	codexUsage: CodexUsage | undefined,
): FooterRenderState {
	let totalCost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			totalCost += entry.message.usage.cost.total;
		}
	}

	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const ctxKnown = usage?.percent != null && usage?.tokens != null;
	const ctxPct = usage?.percent ?? 0;
	const ctxUsed = usage?.tokens ?? 0;

	const cwd = withTilde(ctx.cwd);
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName() ?? null;

	const model = ctx.model?.id ?? null;
	const provider = ctx.model?.provider ?? null;
	const providerCount = footerData.getAvailableProviderCount();
	const sub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;

	let thinking: string | null = null;
	if (ctx.model?.reasoning) {
		thinking = thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : null;
	}

	return {
		cwd,
		branch,
		sessionName,
		model,
		provider,
		providerCount,
		thinking,
		fast: fastEnabled,
		ctxPct,
		ctxUsed,
		ctxWindow: contextWindow,
		ctxKnown,
		cost: totalCost > 0 || sub ? totalCost : null,
		sub,
		codex: buildCodexState(codexUsage),
	};
}

// ── extension entry point ──────────────────────────────────────────────────

export default function codexUsageExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastRefresh = 0;
	let inFlight = false;
	let codexUsage: CodexUsage | undefined;
	let thinkingLevel = "off";
	let fastEnabled = false;
	let tuiRef: TUI | undefined;
	let footerInstalled = false;
	let unsubBranch: (() => void) | undefined;

	const requestRender = (): void => {
		tuiRef?.requestRender();
	};

	const refresh = (ctx: ExtensionContext, force = false): void => {
		if (inFlight) return;
		const now = Date.now();
		if (!force && now - lastRefresh < MIN_REFRESH_MS) return;
		lastRefresh = now;
		inFlight = true;
		void fetchCodexUsage(ctx)
			.then((usage) => {
				if (isCodexModel(ctx.model)) {
					codexUsage = usage;
				} else {
					codexUsage = undefined;
				}
				requestRender();
			})
			.catch(() => {
				// Silent: best-effort indicator, must not leak auth details.
			})
			.finally(() => {
				inFlight = false;
			});
	};

	const installFooter = (ctx: ExtensionContext): void => {
		if (footerInstalled || !ctx.hasUI) return;
		footerInstalled = true;

		ctx.ui.setFooter((tui, _theme: Theme, footerData) => {
			tuiRef = tui;
			if (unsubBranch) unsubBranch();
			unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			const component: Component & { dispose?(): void } = {
				render(width: number): string[] {
					const state = collectState(ctx, footerData, thinkingLevel, fastEnabled, codexUsage);
					return renderFooter(state, Math.max(20, width));
				},
				invalidate(): void {
					// No cached state — render rebuilds from ctx each tick.
				},
				dispose(): void {
					if (unsubBranch) {
						unsubBranch();
						unsubBranch = undefined;
					}
					tuiRef = undefined;
				},
			};
			return component;
		});
	};

	pi.registerCommand("fast", {
		description: "Toggle interactive model fast mode (/fast on|off|status).",
		handler: async (args, ctx) => {
			const action = parseFastCommand(args);
			if (action === "help") {
				ctx.ui.notify("Usage: /fast on|off|status", "error");
				return;
			}
			if (action === "on" || action === "off") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Fast mode is only applied to interactive UI sessions.", "info");
					return;
				}
				fastEnabled = action === "on";
				writeFastModeSetting(fastEnabled);
				requestRender();
			}
			ctx.ui.notify(`Model fast mode: ${fastEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		thinkingLevel = pi.getThinkingLevel?.() ?? "off";
		fastEnabled = ctx.hasUI ? readFastModeSetting() : false;
		installFooter(ctx);
		refresh(ctx, true);
		timer = setInterval(() => refresh(ctx), POLL_INTERVAL_MS);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!isCodexModel(ctx.model)) codexUsage = undefined;
		requestRender();
		refresh(ctx, true);
	});

	pi.on("thinking_level_select", async (event) => {
		thinkingLevel = event.level;
		requestRender();
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const payload = applyModelSpeedToPayload(event.payload, ctx.model, ctx.hasUI && fastEnabled);
		return payload;
	});

	pi.on("turn_end", async (_event, ctx) => {
		requestRender();
		refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		requestRender();
		refresh(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (unsubBranch) {
			unsubBranch();
			unsubBranch = undefined;
		}
		if (ctx.hasUI) {
			try {
				ctx.ui.setFooter(undefined);
			} catch {
				// session is already tearing down; ignore.
			}
		}
		footerInstalled = false;
		tuiRef = undefined;
	});
}

// Bravo footer redesign for pi-coding-agent.
//
// Takes over the entire pi footer via pi.ui.setFooter() and renders a two-line
// layout with a colored context bar, cost, and inline mini-bars for Codex
// rate-limit windows (when on a Codex model). Replaces the built-in
// "↑↓R$ ctx% (provider) model • thinking" footer.
//
// Codex account usage is cache-only through @bravo/codex-auth-balancer;
// /codex-accounts refresh explicitly refreshes the owned cache state.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { getUsage, ingestDirectPiLiveUsage, refreshUsage, resolveStateRoot } from "../../packages/codex-auth-balancer/src/index.ts";
import type { CodexUsage, CodexAccountSlot, CodexAccountStatus, UsageWindow } from "../../packages/codex-auth-balancer/src/index.ts";
import { dirname, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";

// ── codex usage via Codex auth balancer cache ──────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
const FOOTER_USAGE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MODEL_SPEED_CONFIG_PATH = join(process.cwd(), ".pi", "model-speed.json");
const FAST_SERVICE_TIER = "priority";

function isCodexModel(model: Model<any> | undefined): boolean {
	return model?.provider === "openai-codex" || model?.provider === "bravo-codex-balanced" || model?.api === "openai-codex-responses";
}

function isBalancedCodexModel(model: Model<any> | undefined): boolean {
	return model?.provider === "bravo-codex-balanced" || model?.id?.startsWith("bravo-codex-balanced/") === true;
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

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasOnlyKeys(r: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(r).every((key) => allowed.includes(key));
}

function parseUsageWindow(value: unknown): UsageWindow | undefined {
	const r = asRecord(value);
	if (!r || !hasOnlyKeys(r, ["label", "name", "remaining_percent", "reset_at", "reset_in_seconds", "stale"])) return undefined;
	if (!("remaining_percent" in r)) return undefined;
	const remaining = asNumber(r.remaining_percent);
	if (remaining == null || remaining < 0 || remaining > 100) return undefined;
	const label = typeof r.label === "string" ? r.label : typeof r.name === "string" ? r.name : "usage";
	const resetAt = "reset_at" in r ? asNumber(r.reset_at) : undefined;
	const resetInSeconds = "reset_in_seconds" in r ? asNumber(r.reset_in_seconds) : undefined;
	if (("reset_at" in r && resetAt == null) || ("reset_in_seconds" in r && resetInSeconds == null)) return undefined;
	if ("stale" in r && typeof r.stale !== "boolean") return undefined;
	return { label, remainingPercent: remaining, resetAt, resetInSeconds, stale: r.stale === true };
}

export function redactCodexAccountLabel(account: Pick<CodexAccountSlot, "slot" | "label" | "email" | "accountIdHash">): string {
	const raw = account.label || account.slot || account.accountIdHash || "?";
	if (account.email || /@/.test(raw)) return account.slot;
	if (/^[A-Za-z0-9_-]{24,}$/.test(raw)) return account.slot;
	return raw.slice(0, 16);
}

export function parseCodexUsage(payload: unknown, now = Date.now()): CodexUsage | undefined {
	const r = asRecord(payload);
	if (!r || !hasOnlyKeys(r, ["schema_version", "generated_at", "stale_after_ms", "accounts", "cache_path", "refreshed_slots", "failures"])) return undefined;
	if (r.schema_version !== 1 || !Array.isArray(r.accounts)) return undefined;
	const generatedAt = asNumber(r.generated_at);
	const staleAfterMs = asNumber(r.stale_after_ms);
	if (generatedAt == null || staleAfterMs == null) return undefined;
	const staleByAge = now - generatedAt > staleAfterMs;
	const accounts: CodexAccountSlot[] = [];
	for (const item of r.accounts) {
		const a = asRecord(item);
		if (!a || !hasOnlyKeys(a, ["slot", "label", "email", "account_id_hash", "active_pi", "active_codex", "status", "usage", "problem"])) return undefined;
		if ("account_id" in a || "accountId" in a) return undefined;
		if (typeof a.slot !== "string" || typeof a.active_pi !== "boolean" || typeof a.active_codex !== "boolean") return undefined;
		if (!["ok", "limited", "broken", "unknown"].includes(String(a.status))) return undefined;
		if (("label" in a && typeof a.label !== "string") || ("email" in a && typeof a.email !== "string") || ("account_id_hash" in a && typeof a.account_id_hash !== "string")) return undefined;
		const problem = a.problem == null ? undefined : asRecord(a.problem);
		if (a.problem != null && (!problem || !hasOnlyKeys(problem, ["code", "message"]) || typeof problem.code !== "string" || typeof problem.message !== "string")) return undefined;
		let usage: CodexAccountSlot["usage"];
		if (a.usage != null) {
			const u = asRecord(a.usage);
			if (!u || !hasOnlyKeys(u, ["primary", "secondary", "updated_at", "source"])) return undefined;
			const primary = u.primary == null ? undefined : parseUsageWindow(u.primary);
			const secondary = u.secondary == null ? undefined : parseUsageWindow(u.secondary);
			const updatedAt = "updated_at" in u ? asNumber(u.updated_at) : undefined;
			if ((u.primary != null && !primary) || (u.secondary != null && !secondary) || ("updated_at" in u && updatedAt == null)) return undefined;
			if ("source" in u && u.source !== "cache" && u.source !== "probe" && u.source !== "live" && u.source !== "unknown") return undefined;
			usage = { primary, secondary, updatedAt, source: u.source as "cache" | "probe" | "live" | "unknown" | undefined };
		}
		accounts.push({
			slot: a.slot,
			label: a.label,
			email: a.email,
			accountIdHash: a.account_id_hash,
			activePi: a.active_pi,
			activeCodex: a.active_codex,
			status: a.status as CodexAccountStatus,
			usage,
			problem: problem ? { code: problem.code, message: problem.message } : undefined,
		});
	}
	return { accounts, generatedAt, staleAfterMs, unavailable: false, error: staleByAge ? "stale" : undefined };
}

async function readCodexUsageCache(): Promise<CodexUsage> {
	return getUsage({ staleAfterMs: FOOTER_USAGE_STALE_AFTER_MS });
}

async function refreshCodexUsageCache(): Promise<CodexUsage> {
	return refreshUsage({ all: true });
}

// ── slot re-authentication (/reauth) ───────────────────────────────────────
// Shells out to the `codex` CLI against the slot's CODEX_HOME — the proven
// recipe that produces a complete codex auth.json (incl. id_token) — then seeds
// the pi credential and re-probes usage (a successful probe supersedes any
// 'broken' status, un-breaking the slot).

const REAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_URL_RE = /(https?:\/\/[^\s'"]+)/;

function runCodexCmd(
	args: string[],
	env: NodeJS.ProcessEnv,
	onLine?: (line: string) => void,
	timeoutMs?: number,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs) {
			timer = setTimeout(() => {
				try { child.kill("SIGTERM"); } catch { /* already gone */ }
				reject(new Error(`codex ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
		}
		const onData = (buf: Buffer): void => {
			for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLine?.(line);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
		child.on("close", (code) => { if (timer) clearTimeout(timer); resolve(code ?? 1); });
	});
}

type ReauthResult = { ok: boolean; message: string };

async function reauthSlot(
	slot: string,
	notify: (msg: string, level?: "info" | "error") => void,
): Promise<ReauthResult> {
	const stateRoot = resolveStateRoot();
	const slotDir = join(stateRoot, "accounts", slot);
	const authPath = join(slotDir, "auth.json");
	const piAuthPath = join(slotDir, "pi-openai-codex.json");
	if (!existsSync(slotDir)) return { ok: false, message: `unknown slot ${slot} (${slotDir} does not exist)` };

	// 1. Back up existing credentials (both shapes), best-effort.
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	try { if (existsSync(authPath)) copyFileSync(authPath, `${authPath}.bak-${ts}`); } catch { /* best-effort */ }
	try { if (existsSync(piAuthPath)) copyFileSync(piAuthPath, `${piAuthPath}.bak-${ts}`); } catch { /* best-effort */ }

	const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: slotDir };

	// 2. Logout (ignore failures) then interactive login.
	await runCodexCmd(["logout"], env).catch(() => undefined);

	let opened = false;
	const code = await runCodexCmd(["login"], env, (line) => {
		if (opened) return;
		const m = line.match(AUTH_URL_RE);
		if (!m) return;
		opened = true;
		const url = m[1];
		notify(`Authenticate slot ${slot} in your browser: ${url}`, "info");
		try { spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref(); } catch { /* no browser opener */ }
	}, REAUTH_TIMEOUT_MS);
	if (code !== 0) return { ok: false, message: `codex login exited with code ${code}` };
	if (!existsSync(authPath)) return { ok: false, message: "codex login completed but produced no auth.json" };

	// 3. Seed the pi credential from the fresh codex auth, then re-probe usage.
	copyFileSync(authPath, piAuthPath);
	try { chmodSync(piAuthPath, 0o600); } catch { /* best-effort perms */ }
	await refreshUsage({ slot });
	return { ok: true, message: `slot ${slot} re-authenticated` };
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
	return (
		isDefaultEmojiWide(cp) ||
		(cp >= 0x2600 && cp <= 0x27bf) ||
		(cp >= 0x2b00 && cp <= 0x2bff)
	);
}

export function visWidth(s: string): number {
	const chars = [...stripAnsi(s)];
	let width = 0;
	for (let i = 0; i < chars.length; i++) {
		const cp = chars[i].codePointAt(0) ?? 0;
		if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
		const nextCp = chars[i + 1]?.codePointAt(0);
		if (
			(nextCp === 0xfe0f && canTakeEmojiPresentation(cp)) ||
			isDefaultEmojiWide(cp) ||
			(cp >= 0x1100 && (
				cp <= 0x115f ||
				(cp >= 0x2e80 && cp <= 0x303e) ||
				(cp >= 0x3041 && cp <= 0x33ff) ||
				(cp >= 0x3400 && cp <= 0x4dbf) ||
				(cp >= 0x4e00 && cp <= 0x9fff) ||
				(cp >= 0xac00 && cp <= 0xd7a3)
			))
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
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
	if (visWidth(s) <= max) return s;
	if (max <= 1) return "…";
	const limit = max - 1;
	const chars = [...s];
	let out = "";
	let used = 0;
	for (let i = 0; i < chars.length; i++) {
		const cp = chars[i].codePointAt(0) ?? 0;
		const nextCp = chars[i + 1]?.codePointAt(0);
		const cluster = nextCp === 0xfe0f && canTakeEmojiPresentation(cp) ? chars[i] + chars[i + 1] : chars[i];
		const width = visWidth(cluster);
		if (used + width > limit) break;
		out += cluster;
		used += width;
		if (cluster.length > chars[i].length) i++;
	}
	return `${out}…`;
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
	tasksEnabled: boolean;
	ctxPct: number;
	ctxUsed: number;
	ctxWindow: number;
	ctxKnown: boolean;
	cost: number | null;
	sub: boolean;
	codex: {
		primary?: number | null;
		primaryReset?: string | null;
		secondary?: number | null;
		secondaryReset?: string | null;
		accounts?: Array<{ slot: string; label: string; active: boolean; status: CodexAccountStatus; primary: number | null; primaryReset: string | null; secondary: number | null; secondaryReset: string | null; stale: boolean }>;
		unavailable?: boolean;
		stale?: boolean;
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
		const tasksStr = `${c.dim}  tasks:${R}${s.tasksEnabled ? c.ok : c.warn}${s.tasksEnabled ? "on" : "off"}${R}`;
		const fastStr = s.fast ? `${c.dim}  speed ${R}${c.ok}fast${R}` : "";
		const suffix = `${thinkStr}${fastStr}${tasksStr}`;
		let modelMax = maxRight - visWidth(prov) - visWidth(suffix);
		if (modelMax < 4 && prov) {
			prov = "";
			modelMax = maxRight - visWidth(suffix);
		}
		const modelText = modelMax > 0 ? truncEnd(s.model, modelMax) : "";
		right = `${prov}${identityColor(s.model)}${modelText}${R}${suffix}`;
	} else {
		const tasksStr = `${c.dim}  tasks:${R}${s.tasksEnabled ? c.ok : c.warn}${s.tasksEnabled ? "on" : "off"}${R}`;
		right = s.fast ? `${c.dim}no model  speed ${R}${c.ok}fast${R}${tasksStr}` : `${c.dim}no model${R}${tasksStr}`;
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

export function tasksSegment(enabled: boolean): string {
	return `${c.dim}tasks:${R}${enabled ? c.ok : c.warn}${enabled ? "on" : "off"}${R}`;
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
	return `${c.dim}${label}${R} ${bar(remainingPct, barW, col)} ${col}${Math.round(remainingPct)}%${R}${resetStr}`;
}

function codexAccountPrimarySegment(
	remainingPct: number | null,
	resetIn: string | null,
	barW: number,
): string {
	if (remainingPct == null) return ` ${c.dim}5h${R} ?`;
	const col = codexThreshold(remainingPct);
	return ` ${c.dim}5h${R} ${bar(remainingPct, barW, col)} ${col}${Math.round(remainingPct)}%${R}${resetIn ? `${c.dim}/${resetIn}${R}` : ""}`;
}

export function renderStatsLine(width: number, s: FooterRenderState): string {
	const { ctxBar, codexBar } = pickLayoutWidths(width);

	const parts: string[] = [ctxSegment(s.ctxPct, s.ctxUsed, s.ctxWindow, ctxBar, s.ctxKnown)];
	const costSeg = costSegment(s.cost, s.sub);
	if (costSeg) parts.push(costSeg);

	if (s.codex) {
		if (!s.codex.accounts && (s.codex.primary != null || s.codex.secondary != null)) {
			const p = codexWindowSegment("5h", s.codex.primary ?? null, s.codex.primaryReset ?? null, codexBar);
			const sec = codexWindowSegment("wk", s.codex.secondary ?? null, s.codex.secondaryReset ?? null, codexBar);
			if (p) parts.push(p);
			if (sec) parts.push(sec);
		} else if (s.codex.unavailable) {
			parts.push(`${c.warn}codex usage ?${R}`);
		} else if (s.codex.accounts && s.codex.accounts.length > 0) {
			const sortedAccounts = [...s.codex.accounts].sort((a, b) => Number(b.active) - Number(a.active));
			const limit = width >= 100 ? 3 : 2;
			const renderAccounts = (mode: "full" | "noSecondary" | "identity", activeOnly: boolean): string[] => {
				return sortedAccounts
					.filter((account) => !activeOnly || account.active)
					.slice(0, limit)
					.map((account) => {
						const mark = account.active ? "*" : "";
						const status = account.status === "broken" ? `${c.bad}!${R}` : account.status === "limited" ? `${c.warn}!${R}` : "";
						const stale = account.stale ? `${c.warn} stale${R}` : "";
						const head = `${c.dim}cx${mark}${R}${status}${c.text}${account.label}${R}`;
						if (mode === "identity") return `${head}${stale}`;
						const p = account.primary == null ? "?" : `${Math.round(account.primary)}%`;
						const primary = mode === "full" && account.active
							? codexAccountPrimarySegment(account.primary, account.primaryReset, codexBar)
							: ` ${c.dim}5h${R} ${p}${account.primaryReset ? `${c.dim}/${account.primaryReset}${R}` : ""}`;
						if (mode === "noSecondary") return `${head}${primary}${stale}`;
						const sec = account.secondary == null ? "?" : `${Math.round(account.secondary)}%`;
						return `${head}${primary} ${c.dim}wk${R} ${sec}${account.secondaryReset ? `${c.dim}/${account.secondaryReset}${R}` : ""}${stale}`;
					});
			};
			parts.push(...renderAccounts("full", false));
			for (const [mode, activeOnly] of [["noSecondary", false], ["identity", false], ["identity", true]] as const) {
				if (visWidth(parts.join(`${c.dim}   ${R}`)) <= width) break;
				while (parts.length > 0 && stripAnsi(parts[parts.length - 1]).startsWith("cx")) parts.pop();
				parts.push(...renderAccounts(mode, activeOnly));
			}
		} else {
			parts.push(`${c.warn}codex usage unknown${R}`);
		}
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

function withTilde(p: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function resetFor(w: UsageWindow | undefined, now: number): string | null {
	if (!w) return null;
	if (w.resetAt) return formatReset(w.resetAt, now) ?? null;
	if (w.resetInSeconds != null) return formatReset(now + w.resetInSeconds * 1000, now) ?? null;
	return null;
}

function balancedAffinityPath(sessionId: string): string {
	const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
	return join(resolveStateRoot(), "leases", "affinity", `${key}.json`);
}

function readBalancedAffinitySlot(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(balancedAffinityPath(sessionId), "utf8")) as { slot?: unknown; expires_at?: unknown };
		if (typeof parsed.expires_at === "number" && parsed.expires_at <= Date.now()) return undefined;
		return typeof parsed.slot === "string" ? parsed.slot : undefined;
	} catch {
		return undefined;
	}
}

function findAsyncProjectRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git")) || existsSync(join(current, "package.json")) || existsSync(join(current, ".subagents"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function asyncSubagentsHome(): string {
	return process.env.ASYNC_SUBAGENTS_HOME ? resolve(process.env.ASYNC_SUBAGENTS_HOME) : join(process.env.HOME || process.env.USERPROFILE || ".", ".async-subagents");
}

function asyncSubagentsRunRoot(cwd: string): string {
	const projectRoot = findAsyncProjectRoot(cwd);
	const scope = createHash("sha256").update(projectRoot).digest("base64url").slice(0, 16);
	return join(asyncSubagentsHome(), "projects", scope, "runs");
}

function readAsyncSubagentsTaskMode(ctx: ExtensionContext): boolean {
	try {
		const runRoot = asyncSubagentsRunRoot(ctx.cwd);
		const sessionsDir = resolve(runRoot, "..", "sessions");
		if (!existsSync(sessionsDir)) return true;
		const piSessionId = ctx.sessionManager.getSessionId();
		const identity = readdirSync(sessionsDir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => JSON.parse(readFileSync(join(sessionsDir, file), "utf8")) as { cwd?: unknown; piSessionId?: unknown; rootSessionId?: unknown; updatedAt?: unknown })
			.filter((session) => typeof session.rootSessionId === "string" && resolve(String(session.cwd)) === resolve(ctx.cwd))
			.filter((session) => !piSessionId || session.piSessionId === piSessionId)
			.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")))
			.at(-1);
		if (!identity || typeof identity.rootSessionId !== "string") return true;
		const statePath = join(runRoot, "session-task-runtime", `${identity.rootSessionId}.json`);
		if (!existsSync(statePath)) return true;
		const state = JSON.parse(readFileSync(statePath, "utf8")) as { enabled?: unknown };
		return state.enabled !== false;
	} catch {
		return true;
	}
}

interface FooterCostState {
	totalCost: number;
	entryCount: number;
}

function collectFooterCostState(ctx: ExtensionContext): FooterCostState {
	let totalCost = 0;
	let entryCount = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		entryCount += 1;
		if (entry.type === "message" && entry.message.role === "assistant") {
			totalCost += entry.message.usage.cost.total;
		}
	}
	return { totalCost, entryCount };
}

function buildCodexState(
	usage: CodexUsage | undefined,
	now = Date.now(),
	balancedAffinitySlot?: string,
): FooterRenderState["codex"] {
	if (!usage) return null;
	if (usage.unavailable) return { accounts: [], unavailable: true };
	const accounts = usage.accounts.map((a) => ({
		slot: a.slot,
		label: redactCodexAccountLabel(a),
		active: a.slot === balancedAffinitySlot || a.activeCodex || a.activePi,
		status: a.status,
		primary: a.usage?.primary?.remainingPercent ?? null,
		primaryReset: resetFor(a.usage?.primary, now),
		secondary: a.usage?.secondary?.remainingPercent ?? null,
		secondaryReset: resetFor(a.usage?.secondary, now),
		stale: usage.error === "stale" || a.usage?.primary?.stale === true || a.usage?.secondary?.stale === true,
	}));
	return { accounts, stale: usage.error === "stale" };
}

function codexWindowSemanticKey(window: UsageWindow | undefined): unknown {
	if (!window) return null;
	return {
		label: window.label,
		remainingPercent: window.remainingPercent,
		resetAt: window.resetAt ?? null,
		resetInSeconds: window.resetInSeconds ?? null,
		stale: window.stale === true,
	};
}

function codexUsageSemanticKey(usage: CodexUsage | undefined, balancedAffinitySlot: string | undefined): string {
	if (!usage) return "null";
	if (usage.unavailable) return JSON.stringify({ unavailable: true, error: usage.error ?? null });
	return JSON.stringify({
		unavailable: false,
		error: usage.error ?? null,
		balancedAffinitySlot: balancedAffinitySlot ?? null,
		accounts: usage.accounts.map((account) => ({
			slot: account.slot,
			label: redactCodexAccountLabel(account),
			activePi: account.activePi,
			activeCodex: account.activeCodex,
			status: account.status,
			problemCode: account.problem?.code ?? null,
			primary: codexWindowSemanticKey(account.usage?.primary),
			secondary: codexWindowSemanticKey(account.usage?.secondary),
		})),
	});
}

function collectState(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	thinkingLevel: string,
	fastEnabled: boolean,
	codexUsage: CodexUsage | undefined,
	footerCost: FooterCostState,
	balancedAffinitySlot: string | undefined,
): FooterRenderState {
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
		tasksEnabled: readAsyncSubagentsTaskMode(ctx),
		ctxPct,
		ctxUsed,
		ctxWindow: contextWindow,
		ctxKnown,
		cost: footerCost.totalCost > 0 || sub ? footerCost.totalCost : null,
		sub,
		codex: buildCodexState(codexUsage, Date.now(), isBalancedCodexModel(ctx.model) ? balancedAffinitySlot : undefined),
	};
}

// ── extension entry point ──────────────────────────────────────────────────

export default function codexUsageExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastRefresh = 0;
	let inFlight = false;
	let codexUsage: CodexUsage | undefined;
	let footerCost: FooterCostState = { totalCost: 0, entryCount: 0 };
	let balancedAffinitySlot: string | undefined;
	let thinkingLevel = "off";
	let fastEnabled = false;
	let tuiRef: TUI | undefined;
	let footerInstalled = false;
	let unsubBranch: (() => void) | undefined;

	const requestRender = (): void => {
		tuiRef?.requestRender();
	};

	const refreshBalancedAffinity = (ctx: ExtensionContext): void => {
		balancedAffinitySlot = isBalancedCodexModel(ctx.model) ? readBalancedAffinitySlot(ctx.sessionManager.getSessionId()) : undefined;
	};

	const recomputeFooterCost = (ctx: ExtensionContext): void => {
		footerCost = collectFooterCostState(ctx);
	};

	const refresh = (ctx: ExtensionContext, force = false): void => {
		if (inFlight) return;
		const now = Date.now();
		if (!force && now - lastRefresh < MIN_REFRESH_MS) return;
		lastRefresh = now;
		inFlight = true;
		void readCodexUsageCache()
			.then((usage) => {
				const previousSemanticKey = codexUsageSemanticKey(codexUsage, balancedAffinitySlot);
				if (isCodexModel(ctx.model)) {
					codexUsage = usage;
				} else {
					codexUsage = undefined;
				}
				refreshBalancedAffinity(ctx);
				const nextSemanticKey = codexUsageSemanticKey(codexUsage, balancedAffinitySlot);
				if (force || nextSemanticKey !== previousSemanticKey) requestRender();
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
					const state = collectState(ctx, footerData, thinkingLevel, fastEnabled, codexUsage, footerCost, balancedAffinitySlot);
					return renderFooter(state, Math.max(20, width));
				},
				invalidate(): void {
					// Cached event-driven state is refreshed by session/model/turn events.
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

	pi.registerCommand("codex-accounts", {
		description: "Show Codex auth balancer account usage; /codex-accounts refresh probes explicitly.",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "refresh") {
				ctx.ui.notify("Refreshing Codex account usage…", "info");
				codexUsage = await refreshCodexUsageCache();
				refreshBalancedAffinity(ctx);
				requestRender();
				ctx.ui.notify(codexUsage.unavailable ? "Codex account usage refresh failed." : "Codex account usage refreshed.", codexUsage.unavailable ? "error" : "info");
				return;
			}
			if (action && action !== "status") {
				ctx.ui.notify("Usage: /codex-accounts [status|refresh]", "error");
				return;
			}
			codexUsage = await readCodexUsageCache();
			refreshBalancedAffinity(ctx);
			requestRender();
			ctx.ui.notify(codexUsage.unavailable ? "Codex account usage cache unavailable." : `Codex accounts: ${codexUsage.accounts.length}`, codexUsage.unavailable ? "error" : "info");
		},
	});

	pi.registerCommand("reauth", {
		description: "Re-authenticate a Codex balancer account slot (/reauth <slot>).",
		handler: async (args, ctx) => {
			const slot = args.trim();
			if (!slot || !/^[A-Za-z0-9_-]+$/.test(slot)) {
				ctx.ui.notify("Usage: /reauth <slot>  (e.g. /reauth 2)", "error");
				return;
			}
			ctx.ui.notify(`Re-authenticating slot ${slot}… complete the browser login when it opens.`, "info");
			let result: ReauthResult;
			try {
				result = await reauthSlot(slot, (m, l) => ctx.ui.notify(m, l ?? "info"));
			} catch (e) {
				ctx.ui.notify(`Re-auth failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}
			if (!result.ok) {
				ctx.ui.notify(`Re-auth failed: ${result.message}`, "error");
				return;
			}
			codexUsage = await readCodexUsageCache();
			refreshBalancedAffinity(ctx);
			requestRender();
			ctx.ui.notify(`✓ ${result.message}.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		thinkingLevel = pi.getThinkingLevel?.() ?? "off";
		fastEnabled = ctx.hasUI ? readFastModeSetting() : false;
		recomputeFooterCost(ctx);
		refreshBalancedAffinity(ctx);
		installFooter(ctx);
		refresh(ctx, true);
		timer = setInterval(() => refresh(ctx), POLL_INTERVAL_MS);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!isCodexModel(ctx.model)) codexUsage = undefined;
		refreshBalancedAffinity(ctx);
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

	pi.on("after_provider_response", async (event, ctx) => {
		if (ctx.model?.provider === "openai-codex") {
			void ingestDirectPiLiveUsage({ headers: event.headers }).catch(() => undefined);
		}
		refreshBalancedAffinity(ctx);
		requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		recomputeFooterCost(ctx);
		refreshBalancedAffinity(ctx);
		requestRender();
		refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		recomputeFooterCost(ctx);
		refreshBalancedAffinity(ctx);
		requestRender();
		refresh(ctx, true);
	});

	pi.on("session_compact", async (_event, ctx) => {
		recomputeFooterCost(ctx);
		requestRender();
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

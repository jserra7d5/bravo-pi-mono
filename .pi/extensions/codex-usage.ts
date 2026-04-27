import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

const STATUS_KEY = "codex-usage";
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

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
	const windowSeconds = firstNumber(record, ["limit_window_seconds", "limitWindowSeconds", "window_seconds", "windowSeconds"]);

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
	const usage = {
		primary: parseWindow("primary", rateLimit?.primary_window ?? rateLimit?.primaryWindow) ?? findNamedWindow(payload, "primary"),
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

function formatDuration(seconds: number | undefined, fallback: string): string {
	if (!seconds || seconds <= 0) return fallback;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.ceil(hours / 24);
	return days === 7 ? "wk" : `${days}d`;
}

function formatWindow(window: UsageWindow | undefined): string | undefined {
	if (!window) return undefined;
	const prefix = formatDuration(window.windowSeconds, window.label === "primary" ? "5h" : "wk");
	const percent = window.remainingPercent === undefined ? "?" : `${Math.round(window.remainingPercent)}%`;
	const reset = formatReset(window.resetAt);
	return `(${[prefix, percent, reset].filter(Boolean).join(" | ")})`;
}

function formatUsage(usage: CodexUsage | undefined): string | undefined {
	if (!usage) return "Codex usage ?";
	const parts = [formatWindow(usage.primary), formatWindow(usage.secondary)].filter(Boolean);
	return parts.length > 0 ? `Codex ${parts.join(" ")}` : "Codex usage ?";
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	if (!isCodexModel(ctx.model)) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return undefined;
	}

	const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!token) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return undefined;
	}

	const accountId = getAccountId(token);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		originator: "pi",
		accept: "application/json",
	};
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const response = await fetch(CODEX_USAGE_URL, { headers, signal: ctx.signal });
	if (response.status === 401 || response.status === 403 || response.status === 404) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return undefined;
	}
	if (!response.ok) return undefined;

	const payload = (await response.json()) as unknown;
	return formatUsage(parseUsage(payload));
}

export default function codexUsageExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastRefresh = 0;
	let inFlight = false;

	const refresh = (ctx: ExtensionContext, force = false) => {
		if (inFlight) return;
		const now = Date.now();
		if (!force && now - lastRefresh < MIN_REFRESH_MS) return;
		lastRefresh = now;
		inFlight = true;
		void fetchCodexUsage(ctx)
			.then((status) => {
				if (status && ctx.hasUI && isCodexModel(ctx.model)) ctx.ui.setStatus(STATUS_KEY, status);
			})
			.catch(() => {
				// Intentionally silent: this is a best-effort footer indicator and must not leak auth details.
			})
			.finally(() => {
				inFlight = false;
			});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		refresh(ctx, true);
		timer = setInterval(() => refresh(ctx), POLL_INTERVAL_MS);
	});

	pi.on("model_select", async (_event, ctx) => {
		refresh(ctx, true);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		refresh(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

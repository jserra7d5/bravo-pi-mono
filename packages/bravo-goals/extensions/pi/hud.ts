import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { discoverWorkspaceRoot } from "../../src/workspace.js";

export const HUD_STATUS_KEY = "bravo-goals";
export const HUD_WIDGET_KEY = "bravo-goals-hud";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	gold: "\x1b[38;2;229;181;72m",
	green: "\x1b[38;2;106;191;115m",
	cyan: "\x1b[38;2;95;179;212m",
	amber: "\x1b[38;2;229;156;72m",
	red: "\x1b[38;2;220;88;88m",
	gray: "\x1b[38;2;110;110;110m",
	white: "\x1b[38;2;220;220;220m",
} as const;

export interface GoalTaskView {
	id: string;
	title: string;
	status?: string;
	receipt?: string | null;
}

export interface GoalStateView {
	goal: {
		id: string;
		title: string;
		status: string;
	};
	active_task: string | null;
	tasks: GoalTaskView[];
	judge?: {
		last_verdict?: string;
		active?: boolean;
	};
	progress?: {
		completed_tasks?: number;
		total_tasks?: number;
	};
	final_audit: {
		status: "pending" | "passed" | "failed";
	};
	user_verification: {
		status: "pending" | "verified";
	};
}

export interface ActiveGoalEntry {
	goal_id: string;
	path: string;
	pi_session_id?: string | null;
	status?: string;
	active_task?: string | null;
}

export interface HudSnapshot {
	goalPath: string;
	state: GoalStateView;
	indexEntry?: ActiveGoalEntry;
}

interface HudWidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
	update?(snapshot: HudSnapshot | undefined, frameIndex: number): void;
}

interface HudWidgetSetter {
	(key: string, value: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
	(
		key: string,
		value: ((tui: unknown, theme: unknown) => HudWidgetComponent) | undefined,
		options?: { placement?: "belowEditor" | "aboveEditor" },
	): void;
}

interface UiLike {
	setStatus?: (key: string, value: string | undefined) => void;
	setWidget?: HudWidgetSetter;
}

interface ContextLike {
	cwd?: string;
	ui?: UiLike;
	sessionManager?: {
		getSessionId?: () => string;
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTask(value: unknown): GoalTaskView | undefined {
	if (!isObject(value)) return undefined;
	const id = asString(value.id);
	if (!id) return undefined;
	return {
		id,
		title: asString(value.title, id),
		status: typeof value.status === "string" ? value.status : undefined,
		receipt: typeof value.receipt === "string" ? value.receipt : null,
	};
}

export function normalizeGoalState(value: unknown): GoalStateView | undefined {
	if (!isObject(value) || !isObject(value.goal)) return undefined;
	const id = asString(value.goal.id);
	const title = asString(value.goal.title, id);
	if (!id || !title) return undefined;
	const tasks = Array.isArray(value.tasks)
		? value.tasks.map(normalizeTask).filter((task): task is GoalTaskView => Boolean(task))
		: [];

	let finalAuditStatus: "pending" | "passed" | "failed" = "pending";
	if (isObject(value.final_audit)) {
		const s = value.final_audit.status;
		if (s === "passed" || s === "failed" || s === "pending") finalAuditStatus = s;
	}

	let userVerificationStatus: "pending" | "verified" = "pending";
	if (isObject(value.user_verification)) {
		const s = value.user_verification.status;
		if (s === "verified" || s === "pending") userVerificationStatus = s;
	}

	return {
		goal: {
			id,
			title,
			status: asString(value.goal.status, "unknown"),
		},
		active_task: typeof value.active_task === "string" ? value.active_task : null,
		tasks,
		judge: isObject(value.judge)
			? {
					last_verdict: typeof value.judge.last_verdict === "string" ? value.judge.last_verdict : undefined,
					active: typeof value.judge.active === "boolean" ? value.judge.active : undefined,
				}
			: undefined,
		progress: isObject(value.progress)
			? {
					completed_tasks: asNumber(value.progress.completed_tasks),
					total_tasks: asNumber(value.progress.total_tasks, tasks.length),
				}
			: { completed_tasks: tasks.filter((task) => task.status === "done").length, total_tasks: tasks.length },
		final_audit: { status: finalAuditStatus },
		user_verification: { status: userVerificationStatus },
	};
}

function normalizeActiveEntry(value: unknown): ActiveGoalEntry | undefined {
	if (!isObject(value)) return undefined;
	const goalId = asString(value.goal_id);
	const path = asString(value.path);
	if (!goalId || !path) return undefined;
	return {
		goal_id: goalId,
		path,
		pi_session_id: typeof value.pi_session_id === "string" ? value.pi_session_id : null,
		status: typeof value.status === "string" ? value.status : undefined,
		active_task: typeof value.active_task === "string" ? value.active_task : null,
	};
}

function normalizeInline(s: string): string {
	return s.replace(/\t/g, "  ").replace(/\r?\n|\r/g, " ");
}

/**
 * Compute the visible terminal cell width of a string, stripping ANSI escape
 * sequences and accounting for variation selectors and wide (CJK/emoji) glyphs.
 */
export function visWidth(s: string): number {
	const stripped = normalizeInline(s).replace(/\x1b\[[0-9;]*m/g, "");
	let w = 0;
	for (const ch of stripped) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
		if (
			cp >= 0x1100 &&
			(cp <= 0x115f ||
				(cp >= 0x2e80 && cp <= 0x303e) ||
				(cp >= 0x3041 && cp <= 0x33ff) ||
				(cp >= 0x3400 && cp <= 0x4dbf) ||
				(cp >= 0x4e00 && cp <= 0x9fff) ||
				(cp >= 0xa000 && cp <= 0xa4cf) ||
				(cp >= 0xac00 && cp <= 0xd7a3) ||
				(cp >= 0xf900 && cp <= 0xfaff) ||
				(cp >= 0xfe30 && cp <= 0xfe4f) ||
				(cp >= 0xff00 && cp <= 0xff60) ||
				(cp >= 0xffe0 && cp <= 0xffe6) ||
				(cp >= 0x1f300 && cp <= 0x1f64f) ||
				(cp >= 0x1f680 && cp <= 0x1f6ff) ||
				(cp >= 0x1f900 && cp <= 0x1f9ff))
		) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}

/**
 * Truncate an ANSI-colored, potentially emoji-bearing string to at most
 * `maxCells` terminal cells, appending `…` if truncation occurs.
 */
export function truncAnsi(str: string, maxCells: number): string {
	str = normalizeInline(str);
	if (visWidth(str) <= maxCells) return str;
	if (maxCells <= 1) return "…" + C.reset;
	let out = "";
	let cells = 0;
	let i = 0;
	const limit = maxCells - 1;
	while (i < str.length) {
		if (str.charCodeAt(i) === 0x1b && str[i + 1] === "[") {
			const end = str.indexOf("m", i);
			if (end === -1) break;
			out += str.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		const cp = str.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(cp);
		const w = visWidth(ch);
		if (cells + w > limit) break;
		out += ch;
		cells += w;
		i += ch.length;
	}
	return out + "…" + C.reset;
}

function mkChrome(width: number) {
	const top = (): string => C.gray + "╭" + "─".repeat(width - 2) + "╮" + C.reset;
	const bot = (): string => C.gray + "╰" + "─".repeat(width - 2) + "╯" + C.reset;
	const div = (): string => C.gray + "│ " + "─".repeat(width - 4) + " │" + C.reset;

	const row = (content: string): string => {
		const final = truncAnsi(content, width - 4);
		const inner = " " + final + " ";
		const pad = Math.max(0, width - 2 - visWidth(inner));
		return C.gray + "│" + C.reset + inner + " ".repeat(pad) + C.gray + "│" + C.reset;
	};

	const rowRight = (left: string, right: string): string => {
		const innerR = right + " ";
		const wR = visWidth(innerR);
		const maxLeft = width - 2 - 1 - wR - 1;
		const truncLeft = truncAnsi(left, maxLeft);
		const innerL = " " + truncLeft;
		const used = visWidth(innerL) + visWidth(innerR);
		const pad = Math.max(1, width - 2 - used);
		return C.gray + "│" + C.reset + innerL + " ".repeat(pad) + innerR + C.gray + "│" + C.reset;
	};

	return { top, bot, div, row, rowRight };
}

type GateState = "done" | "active" | "pending" | "fail";

function gate(state: GateState, name: string, suffix?: string): string {
	let glyph: string;
	let glyphColor: string;
	let nameColor: string;
	if (state === "done") {
		glyph = "●";
		glyphColor = C.green;
		nameColor = C.green;
	} else if (state === "active") {
		glyph = "◉";
		glyphColor = C.cyan;
		nameColor = C.bold + C.cyan;
	} else if (state === "fail") {
		glyph = "✗";
		glyphColor = C.red;
		nameColor = C.red;
	} else {
		glyph = "○";
		glyphColor = C.gray;
		nameColor = C.gray;
	}
	const tail = suffix ? "  " + suffix : "";
	return glyphColor + glyph + C.reset + " " + nameColor + name + C.reset + tail;
}

interface GatesOpts {
	tasks: GateState;
	audit: GateState;
	verify: GateState;
	tasksLabel?: string;
	auditLabel?: string;
	verifyLabel?: string;
}

function gates(opts: GatesOpts): string {
	const t = gate(opts.tasks, "tasks", opts.tasksLabel);
	const a = gate(opts.audit, "audit", opts.auditLabel);
	const v = gate(opts.verify, "verify", opts.verifyLabel);
	return `${t}     ${a}     ${v}`;
}

/** Compact three-dot representation (no labels) for the status line. */
function gatesCompact(opts: Pick<GatesOpts, "tasks" | "audit" | "verify">): string {
	const cell = (state: GateState): string => {
		if (state === "done") return C.green + "●" + C.reset;
		if (state === "active") return C.cyan + "◉" + C.reset;
		if (state === "fail") return C.red + "✗" + C.reset;
		return C.gray + "○" + C.reset;
	};
	return cell(opts.tasks) + cell(opts.audit) + cell(opts.verify);
}

type ChipKind = "pass" | "fail" | "active" | "warn";

function chip(text: string, kind: ChipKind): string {
	const color =
		kind === "pass" ? C.green : kind === "fail" ? C.red : kind === "active" ? C.cyan : C.amber;
	return color + text + C.reset;
}

export function progressBar(done: number, total: number, barWidth = 22): string {
	if (total <= 0) return C.gray + "▱".repeat(barWidth) + C.reset;
	const filled = Math.max(0, Math.min(barWidth, Math.round((done / total) * barWidth)));
	return C.cyan + "▰".repeat(filled) + C.gray + "▱".repeat(barWidth - filled) + C.reset;
}

interface ActiveGate {
	tasks: GateState;
	audit: GateState;
	verify: GateState;
}

function deriveActiveGate(state: GoalStateView): ActiveGate {
	if (state.user_verification.status === "verified") {
		return { tasks: "done", audit: "done", verify: "done" };
	}
	if (state.final_audit.status === "passed") {
		return { tasks: "done", audit: "done", verify: "active" };
	}
	if (state.final_audit.status === "failed") {
		return { tasks: "done", audit: "fail", verify: "pending" };
	}
	if (state.goal.status === "final_audit") {
		return { tasks: "done", audit: "active", verify: "pending" };
	}
	return { tasks: "active", audit: "pending", verify: "pending" };
}

interface JudgeChipInfo {
	show: boolean;
	text: string;
	kind: ChipKind;
}

const JUDGE_FRAMES = ["◐", "◓", "◑", "◒"] as const;
let judgeFrameCursor = 0;

function nextJudgeFrame(): number {
	const frame = judgeFrameCursor;
	judgeFrameCursor = (judgeFrameCursor + 1) % JUDGE_FRAMES.length;
	return frame;
}

export function judgeGlyphForFrame(frameIndex: number): string {
	return JUDGE_FRAMES[((frameIndex % JUDGE_FRAMES.length) + JUDGE_FRAMES.length) % JUDGE_FRAMES.length]!;
}

function deriveJudgeChip(state: GoalStateView, frameIndex = 0): JudgeChipInfo {
	const activeTask = state.tasks.find((t) => t.id === state.active_task);
	const verdict = state.judge?.last_verdict;
	const isJudgeActive = state.judge?.active === true;

	if (activeTask?.status === "awaiting_judge" || activeTask?.status === "judging" || isJudgeActive) {
		return { show: true, text: `${judgeGlyphForFrame(frameIndex)} judging`, kind: "active" };
	}
	if ((verdict === "fail" || verdict === "needs_more_evidence") && activeTask) {
		return { show: true, text: "✗ judge fail", kind: "fail" };
	}
	if (activeTask?.status === "blocked") {
		return { show: true, text: "⚠ blocked", kind: "warn" };
	}
	return { show: false, text: "", kind: "pass" };
}

function deriveCaption(state: GoalStateView, gateStates: ActiveGate): string | null {
	if (gateStates.verify === "done") {
		return C.green + "done" + C.reset + C.gray + " — ready to /goal archive" + C.reset;
	}
	if (gateStates.audit === "done" && gateStates.verify === "active") {
		return C.cyan + "ready for /goal verify" + C.reset;
	}
	if (gateStates.audit === "fail") {
		return C.red + "final audit failed" + C.reset + C.gray + " — see state.final_audit.receipt" + C.reset;
	}
	if (gateStates.audit === "active") {
		return C.amber + "awaiting final audit" + C.reset;
	}

	const verdict = state.judge?.last_verdict;
	if ((verdict === "fail" || verdict === "needs_more_evidence") && state.active_task) {
		const receiptPath = `receipts/${state.active_task}-judge.md`;
		return C.red + verdict + C.reset + C.gray + ` — see ${receiptPath}` + C.reset;
	}

	return null;
}

function renderFull(state: GoalStateView, width: number, frameIndex = 0): string[] {
	const ch = mkChrome(width);
	const done = state.progress?.completed_tasks ?? 0;
	const total = state.progress?.total_tasks ?? state.tasks.length;
	const percent = total > 0 ? Math.round((done / total) * 100) : 0;

	const gateStates = deriveActiveGate(state);
	const judgeChip = deriveJudgeChip(state, frameIndex);
	const caption = deriveCaption(state, gateStates);

	const titleText = C.bold + C.gold + state.goal.title + C.reset;
	const titleRow =
		gateStates.verify === "done"
			? ch.rowRight(titleText, C.bold + C.gold + "✓" + C.reset)
			: ch.row(titleText);

	let taskRow: string | undefined;
	if (gateStates.tasks === "active") {
		const activeTask = state.tasks.find((t) => t.id === state.active_task);
		if (activeTask) {
			const chipStr = judgeChip.show ? "   " + chip(judgeChip.text, judgeChip.kind) : "";
			const chipWidth = visWidth(chipStr);
			const prefix = C.white + "task    " + C.reset + activeTask.id + "  ";
			const prefixWidth = visWidth(prefix);
			const titleMaxCells = width - 4 - prefixWidth - chipWidth;
			const titleStr = truncAnsi(activeTask.title, Math.max(0, titleMaxCells));
			taskRow = ch.row(prefix + titleStr + chipStr);
		} else {
			taskRow = ch.row(C.white + "task    " + C.reset + C.gray + "─" + C.reset);
		}
	} else if (gateStates.verify !== "done") {
		taskRow = ch.row(C.white + "task    " + C.reset + C.gray + "─" + C.reset);
	}

	const tasksLabel =
		gateStates.tasks === "done"
			? C.green + `${done}/${total}` + C.reset
			: C.cyan + `${done}/${total}` + C.reset;
	const auditLabel = gateStates.audit === "done" ? C.green + "✓" + C.reset : undefined;
	const verifyLabel = gateStates.verify === "done" ? C.green + "✓" + C.reset : undefined;

	const gatesRow = ch.row(
		C.white + "gates   " + C.reset +
			gates({ ...gateStates, tasksLabel, auditLabel, verifyLabel }),
	);

	// Intentional: when there is a status-bearing caption (judge failure,
	// awaiting/passed audit, done), the caption is the salient row and the
	// progress bar is suppressed to match the mockup. The bar only earns its
	// place when tasks are actively being worked and there's nothing else to say.
	const showProgress = gateStates.tasks === "active" && total > 0 && caption === null;
	const progressRow = showProgress
		? ch.row("        " + progressBar(done, total) + "  " + C.gray + `${percent}%` + C.reset)
		: undefined;

	const captionRow = caption ? ch.row("        " + caption) : undefined;

	const lines: string[] = [ch.top(), titleRow, ch.div()];
	if (taskRow !== undefined) lines.push(taskRow);
	lines.push(gatesRow);
	if (progressRow !== undefined) lines.push(progressRow);
	if (captionRow !== undefined) lines.push(captionRow);
	lines.push(ch.bot());
	return lines;
}

function renderCompact(state: GoalStateView, width: number, frameIndex = 0): string[] {
	const ch = mkChrome(width);
	const gateStates = deriveActiveGate(state);
	const caption = deriveCaption(state, gateStates);

	const titleRow = ch.row(C.bold + C.gold + state.goal.title + C.reset);
	const inline =
		gatesCompact(gateStates) + "  " + (caption ?? C.gray + state.goal.status + C.reset);
	const inlineRow = ch.row(inline);

	return [ch.top(), titleRow, inlineRow, ch.bot()];
}

function renderMinimal(state: GoalStateView, width: number, frameIndex = 0): string[] {
	const gateStates = deriveActiveGate(state);
	const inner = C.bold + C.gold + state.goal.title + C.reset + " " + gatesCompact(gateStates);
	return [truncAnsi(inner, width)];
}

/** Select and render the appropriate layout for the given terminal width. */
export function pickLayout(state: GoalStateView, width: number, frameIndex = 0): string[] {
	if (width >= 56) return renderFull(state, width, frameIndex);
	if (width >= 36) return renderCompact(state, width, frameIndex);
	return renderMinimal(state, width, frameIndex);
}

/**
 * v2 status line:  <gold bold title>  ●◉○  <caption>
 */
export function renderStatusLine(snapshot?: HudSnapshot, frameIndex = 0): string | undefined {
	if (!snapshot) return undefined;
	const { state } = snapshot;
	const gateStates = deriveActiveGate(state);
	const dots = gatesCompact(gateStates);

	let caption: string;
	if (gateStates.verify === "done") {
		caption = C.green + C.dim + "done — ready to /goal archive" + C.reset;
	} else if (gateStates.audit === "done" && gateStates.verify === "active") {
		caption = C.cyan + "ready for /goal verify" + C.reset;
	} else if (gateStates.audit === "fail") {
		caption = C.red + "final audit failed" + C.reset;
	} else if (gateStates.audit === "active") {
		caption = C.amber + "awaiting final audit" + C.reset;
	} else {
		const done = state.progress?.completed_tasks ?? 0;
		const total = state.progress?.total_tasks ?? state.tasks.length;
		caption = C.gray + `${done}/${total} tasks` + C.reset;
	}

	const title = C.bold + C.gold + state.goal.title + C.reset;
	return `${title}  ${dots}  ${caption}`;
}

function clampHudWidth(width: number): number {
	if (!Number.isFinite(width) || width <= 0) return 64;
	return Math.max(4, Math.min(96, Math.floor(width)));
}

function renderHudAtWidth(snapshot: HudSnapshot | undefined, width: number, frameIndex: number): string[] {
	if (!snapshot) return [];
	return pickLayout(snapshot.state, clampHudWidth(width), frameIndex);
}

export function renderHud(snapshot?: HudSnapshot, frameIndex = nextJudgeFrame()): string[] {
	// Backward-compatible one-shot renderer for tests and transcript callers that
	// still use string-array widget semantics.
	const raw = process.stdout.columns ?? 66;
	return renderHudAtWidth(snapshot, raw - 2, frameIndex);
}

export async function readGoalState(goalPath: string): Promise<GoalStateView | undefined> {
	const text = await readFile(join(goalPath, "state.yaml"), "utf8");
	return normalizeGoalState(YAML.parse(text));
}

export async function readActiveGoals(root: string): Promise<ActiveGoalEntry[]> {
	try {
		const text = await readFile(join(root, ".bravo", "runtime", "active-goals.yaml"), "utf8");
		const parsed = YAML.parse(text);
		if (!isObject(parsed) || !Array.isArray(parsed.active_goals)) return [];
		return parsed.active_goals
			.map(normalizeActiveEntry)
			.filter((entry): entry is ActiveGoalEntry => Boolean(entry));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function snapshotForSession(ctx: ContextLike): Promise<HudSnapshot | undefined> {
	const cwd = await discoverWorkspaceRoot(ctx.cwd ?? process.cwd());
	if (!cwd) return undefined;
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const activeGoals = await readActiveGoals(cwd);
	const entry = sessionId
		? activeGoals.find((goal) => goal.pi_session_id === sessionId)
		: undefined;
	if (!entry) return undefined;
	const goalPath = resolve(cwd, entry.path);
	const state = await readGoalState(goalPath);
	if (!state) return undefined;
	return { goalPath, state, indexEntry: entry };
}

interface RenderRequester {
	requestRender?: () => void;
}

let mountedHudWidget: HudWidgetComponent | undefined;

function createHudWidget(snapshot: HudSnapshot | undefined, frameIndex: number, tui: unknown): HudWidgetComponent {
	let currentSnapshot = snapshot;
	let currentFrameIndex = frameIndex;
	const requestRender = (tui as RenderRequester | undefined)?.requestRender;
	const component: HudWidgetComponent = {
		update(nextSnapshot: HudSnapshot | undefined, nextFrameIndex: number) {
			currentSnapshot = nextSnapshot;
			currentFrameIndex = nextFrameIndex;
			requestRender?.();
		},
		render(width: number) {
			return renderHudAtWidth(currentSnapshot, width, currentFrameIndex);
		},
		invalidate() {},
		dispose() {
			if (mountedHudWidget === component) mountedHudWidget = undefined;
		},
	};
	return component;
}

export async function updateHud(ctx: ContextLike): Promise<void> {
	const ui = ctx.ui;
	if (!ui) return;
	const snapshot = await snapshotForSession(ctx);
	const frameIndex = nextJudgeFrame();
	ui.setStatus?.(HUD_STATUS_KEY, renderStatusLine(snapshot, frameIndex));
	if (!snapshot) {
		clearHud(ctx);
		return;
	}
	if (mountedHudWidget) {
		mountedHudWidget.update?.(snapshot, frameIndex);
		return;
	}
	ui.setWidget?.(
		HUD_WIDGET_KEY,
		(tui) => {
			mountedHudWidget = createHudWidget(snapshot, frameIndex, tui);
			return mountedHudWidget;
		},
		{ placement: "belowEditor" },
	);
}

export function clearHud(ctx: ContextLike): void {
	mountedHudWidget = undefined;
	ctx.ui?.setStatus?.(HUD_STATUS_KEY, undefined);
	ctx.ui?.setWidget?.(HUD_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

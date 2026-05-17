// Visual preview for the pi footer extension. Run with:
//   node --experimental-strip-types scripts/preview-footer.mts
//
// Renders the same showcases as /tmp/bravo-footer-mockup.mjs and
// /tmp/bravo-footer-stress.mjs so the output can be diffed against the
// approved mockups.

import { renderFooter, type FooterRenderState } from "../.pi/extensions/codex-usage.ts";

const RESET = "\x1b[0m";
const GOLD = "\x1b[38;2;229;181;72m";
const DIM = "\x1b[38;2;120;120;128m";

function banner(label: string): void {
	console.log(`\n${GOLD}━━ ${label} ━━${RESET}`);
}

function subBanner(label: string, width: number): void {
	console.log(`\n${DIM}${label.padEnd(width, "·")}${RESET}`);
}

function show(label: string, state: FooterRenderState, width: number): void {
	subBanner(`${label}  (${width} cols)`, width);
	for (const line of renderFooter(state, width)) console.log(line);
}

function baseState(): FooterRenderState {
	return {
		cwd: "~/Documents/projects/bravo-pi-mono",
		branch: "main",
		sessionName: null,
		model: "gpt-5.5",
		provider: "openai-codex",
		providerCount: 2,
		thinking: "medium",
		ctxPct: 12,
		ctxUsed: 33_000,
		ctxWindow: 272_000,
		ctxKnown: true,
		cost: 0.42,
		sub: true,
		codex: { primary: 80, primaryReset: "4h", secondary: 55, secondaryReset: "4d" },
	};
}

banner("PI FOOTER — wide (120)");
const W = 120;
show("fresh session, ample headroom", { ...baseState(), ctxPct: 4.7, ctxUsed: 12_700, cost: 0.192, codex: { primary: 96, primaryReset: "4h59m", secondary: 60, secondaryReset: "5d" } }, W);
show("mid-session, codex 5h depleting", {
	...baseState(),
	branch: "feat/footer-redesign",
	sessionName: "footer-work",
	thinking: "high",
	ctxPct: 58.3,
	ctxUsed: 158_000,
	cost: 1.842,
	codex: { primary: 28, primaryReset: "2h14m", secondary: 47, secondaryReset: "4d3h" },
}, W);
show("context warm, 5h almost out — amber + amber", {
	...baseState(),
	ctxPct: 76.2,
	ctxUsed: 207_000,
	cost: 3.401,
	codex: { primary: 12, primaryReset: "47m", secondary: 31, secondaryReset: "3d12h" },
}, W);
show("danger zone — ctx 93%, 5h 4%", {
	...baseState(),
	ctxPct: 93.1,
	ctxUsed: 253_000,
	cost: 5.117,
	codex: { primary: 4, primaryReset: "23m", secondary: 18, secondaryReset: "2d6h" },
}, W);
show("no codex windows (anthropic claude)", {
	...baseState(),
	model: "claude-opus-4-7",
	provider: "anthropic",
	thinking: "high",
	ctxPct: 32.4,
	ctxUsed: 324_000,
	ctxWindow: 1_000_000,
	cost: 2.43,
	sub: false,
	codex: null,
}, W);
show("identity color demo — sonnet", { ...baseState(), model: "claude-sonnet-4-6", provider: "anthropic", ctxPct: 22.0, ctxUsed: 44_000, ctxWindow: 200_000, cost: 0.412, sub: false, codex: null }, W);
show("identity color demo — haiku", { ...baseState(), model: "claude-haiku-4-5", provider: "anthropic", thinking: null, ctxPct: 8.1, ctxUsed: 16_200, ctxWindow: 200_000, cost: 0.012, sub: false, codex: null }, W);

banner("PI FOOTER — medium (94, current tmux)");
const M = 94;
show("fresh", { ...baseState(), ctxPct: 4.7, ctxUsed: 12_700, cost: 0.192, codex: { primary: 96, primaryReset: "4h59m", secondary: 60, secondaryReset: "5d" } }, M);
show("warm", { ...baseState(), ctxPct: 76.2, ctxUsed: 207_000, cost: 3.401, codex: { primary: 12, primaryReset: "47m", secondary: 31, secondaryReset: "3d12h" } }, M);
show("danger", { ...baseState(), ctxPct: 93.1, ctxUsed: 253_000, cost: 5.117, codex: { primary: 4, primaryReset: "23m", secondary: 18, secondaryReset: "2d6h" } }, M);

banner("PI FOOTER — narrow (60)");
const N = 60;
show("fresh, codex windows drop on overflow", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 4.7, ctxUsed: 12_700, cost: 0.192, codex: { primary: 96, primaryReset: "5h", secondary: 60, secondaryReset: "5d" } }, N);
show("warm", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 76.2, ctxUsed: 207_000, cost: 3.401, codex: { primary: 12, primaryReset: "47m", secondary: 31, secondaryReset: "3d" } }, N);
show("danger", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 93.1, ctxUsed: 253_000, cost: 5.117, codex: { primary: 4, primaryReset: "23m", secondary: 18, secondaryReset: "2d" } }, N);

banner("STRESS — edge cases");
show("super deep pwd, 80c", {
	...baseState(),
	cwd: "~/Documents/projects/internal/2026-q2/research-spike/very-long-experiment-name/repo",
	ctxPct: 18.0,
	ctxUsed: 49_000,
	cost: 0.41,
	codex: { primary: 84, primaryReset: "3h", secondary: 55, secondaryReset: "4d" },
}, 80);
show("long branch, 94c", {
	...baseState(),
	branch: "feature/2026-footer-redesign-with-progress-bars-and-thresholds",
	ctxPct: 41,
	ctxUsed: 112_000,
	cost: 0.83,
	codex: { primary: 72, primaryReset: "3h", secondary: 50, secondaryReset: "4d" },
}, 94);
show("long session name, 94c", {
	...baseState(),
	cwd: "~/p/bravo",
	sessionName: "investigating-the-async-subagents-thinking-level-wireup",
	ctxPct: 28,
	ctxUsed: 76_000,
	cost: 0.61,
	codex: { primary: 82, primaryReset: "3h", secondary: 53, secondaryReset: "4d" },
}, 94);
show("no branch", { ...baseState(), cwd: "~/scratch/repro", branch: null, ctxPct: 12, ctxUsed: 33_000, cost: 0.05, codex: { primary: 98, primaryReset: "5h", secondary: 62, secondaryReset: "5d" } }, 94);
show("no model", { ...baseState(), cwd: "~/p/bravo-pi-mono", model: null, provider: null, providerCount: 0, thinking: null, ctxPct: 0, ctxUsed: 0, ctxWindow: 0, ctxKnown: false, cost: null, sub: false, codex: null }, 94);
show("single provider — no prefix", { ...baseState(), cwd: "~/p/bravo-pi-mono", model: "claude-opus-4-7", provider: "anthropic", providerCount: 1, thinking: "high", ctxPct: 41.2, ctxUsed: 412_000, ctxWindow: 1_000_000, cost: 2.18, sub: false, codex: null }, 94);
show("no thinking", { ...baseState(), cwd: "~/p/bravo-pi-mono", model: "claude-haiku-4-5", provider: "anthropic", thinking: null, ctxPct: 5.0, ctxUsed: 10_000, ctxWindow: 200_000, cost: 0.011, sub: false, codex: null }, 94);
show("$0 cost, no sub", { ...baseState(), cwd: "~/p/bravo-pi-mono", model: "claude-sonnet-4-6", provider: "anthropic", thinking: "medium", ctxPct: 0.8, ctxUsed: 1_600, ctxWindow: 200_000, cost: 0, sub: false, codex: null }, 94);
show("$0 cost on sub, codex", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 0.4, ctxUsed: 1_100, cost: 0, codex: { primary: 100, primaryReset: "5h", secondary: 100, secondaryReset: "wk" } }, 94);
show("primary only", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 30, ctxUsed: 81_600, cost: 0.6, codex: { primary: 47, primaryReset: "2h", secondary: null, secondaryReset: null } }, 94);
show("no reset times", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 30, ctxUsed: 81_600, cost: 0.6, codex: { primary: 47, primaryReset: null, secondary: 22, secondaryReset: null } }, 94);
show("both windows depleted", { ...baseState(), cwd: "~/p/bravo-pi-mono", ctxPct: 50, ctxUsed: 136_000, cost: 4.0, codex: { primary: 0, primaryReset: "12m", secondary: 0, secondaryReset: "now" } }, 94);

banner("EXTREME narrow widths");
show("50c", { ...baseState(), cwd: "~/p/bravo", ctxPct: 58, ctxUsed: 158_000, cost: 1.84, codex: { primary: 28, primaryReset: "2h", secondary: 47, secondaryReset: "4d" } }, 50);
show("44c", { ...baseState(), cwd: "~/p/bravo", ctxPct: 58, ctxUsed: 158_000, cost: 1.84, codex: { primary: 28, primaryReset: "2h", secondary: 47, secondaryReset: "4d" } }, 44);
show("40c", { ...baseState(), cwd: "~/bravo", ctxPct: 76, ctxUsed: 207_000, cost: 3.4, codex: null }, 40);

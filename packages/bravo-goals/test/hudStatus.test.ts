import assert from "node:assert/strict";
import test from "node:test";
import {
	HUD_WIDGET_KEY,
	updateHudSnapshot,
	type GoalStateView,
	type HudSnapshot,
} from "../extensions/pi/hud.js";

interface FakeWidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
	update?(snapshot: HudSnapshot | undefined, frameIndex: number, options?: { suppressRender?: boolean }): void;
}

interface SetWidgetCall {
	key: string;
	value: ((tui: unknown, theme: unknown) => FakeWidgetComponent) | string[] | undefined;
	options?: { placement?: "belowEditor" | "aboveEditor" };
}

interface FakeUi {
	setStatus(key: string, value: string | undefined): void;
	setWidget(
		key: string,
		value: ((tui: unknown, theme: unknown) => FakeWidgetComponent) | string[] | undefined,
		options?: { placement?: "belowEditor" | "aboveEditor" },
	): void;
	setStatusCalls: number;
	setWidgetCalls: SetWidgetCall[];
	requestRenderCalls: number;
}

function makeUi(): FakeUi {
	return {
		setStatusCalls: 0,
		setWidgetCalls: [],
		requestRenderCalls: 0,
		setStatus() {
			this.setStatusCalls += 1;
		},
		setWidget(key, value, options) {
			this.setWidgetCalls.push({ key, value, options });
			if (typeof value === "function") {
				value({ requestRender: () => { this.requestRenderCalls += 1; } }, undefined);
			}
		},
	};
}

function makeState(overrides: Partial<GoalStateView> = {}): GoalStateView {
	return {
		goal: { id: "test-goal", title: "Test Goal", status: "active" },
		active_task: "task-1",
		tasks: [{ id: "task-1", title: "Task One", status: "active" }],
		judge: { last_verdict: "none", active: false },
		progress: { completed_tasks: 0, total_tasks: 1 },
		final_audit: { status: "pending" },
		user_verification: { status: "pending" },
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<GoalStateView> = {}): HudSnapshot {
	return {
		goalPath: "/workspace/.bravo/goals/test-goal",
		state: makeState(overrides),
	};
}

function resetCounters(ui: FakeUi): void {
	ui.setStatusCalls = 0;
	ui.setWidgetCalls = [];
	ui.requestRenderCalls = 0;
}

test("HUD update emits zero for repeated unchanged snapshot and unchanged judge frame", () => {
	const ui = makeUi();
	const ctx = { ui };
	const snapshot = makeSnapshot();

	updateHudSnapshot(ctx, snapshot, 0);
	assert.equal(ui.setStatusCalls, 1);
	assert.equal(ui.setWidgetCalls.length, 1);
	assert.equal(ui.setWidgetCalls[0]?.key, HUD_WIDGET_KEY);
	assert.equal(typeof ui.setWidgetCalls[0]?.value, "function");
	assert.deepEqual(ui.setWidgetCalls[0]?.options, { placement: "belowEditor" });
	assert.equal(ui.requestRenderCalls, 0);

	resetCounters(ui);
	updateHudSnapshot(ctx, snapshot, 0);
	updateHudSnapshot(ctx, snapshot, 0);
	assert.equal(ui.setStatusCalls, 0);
	assert.equal(ui.setWidgetCalls.length, 0);
	assert.equal(ui.requestRenderCalls, 0);
});

test("HUD update emits exactly once when judge frame advances", () => {
	const ui = makeUi();
	const ctx = { ui };
	const snapshot = makeSnapshot({
		active_task: "task-1",
		tasks: [{ id: "task-1", title: "Task One", status: "judging" }],
		judge: { last_verdict: "none", active: true },
	});

	updateHudSnapshot(ctx, snapshot, 0);
	resetCounters(ui);

	updateHudSnapshot(ctx, snapshot, 1);
	assert.equal(ui.setStatusCalls, 0);
	assert.equal(ui.requestRenderCalls, 1);
});

test("HUD update emits exactly once when status changes", () => {
	const ui = makeUi();
	const ctx = { ui };

	updateHudSnapshot(ctx, makeSnapshot({ progress: { completed_tasks: 0, total_tasks: 2 } }), 0);
	resetCounters(ui);

	updateHudSnapshot(ctx, makeSnapshot({ progress: { completed_tasks: 1, total_tasks: 2 } }), 0);
	assert.equal(ui.setStatusCalls, 1);
	assert.equal(ui.requestRenderCalls, 0);
});

test("HUD clear emits once for no active goal then stays silent", () => {
	const ui = makeUi();
	const ctx = { ui };

	updateHudSnapshot(ctx, makeSnapshot(), 0);
	resetCounters(ui);

	updateHudSnapshot(ctx, undefined, 0);
	assert.equal(ui.setStatusCalls, 1);
	assert.equal(ui.setWidgetCalls.length, 1);
	assert.equal(ui.setWidgetCalls[0]?.key, HUD_WIDGET_KEY);
	assert.equal(ui.setWidgetCalls[0]?.value, undefined);
	assert.deepEqual(ui.setWidgetCalls[0]?.options, { placement: "belowEditor" });
	assert.equal(ui.requestRenderCalls, 0);

	resetCounters(ui);
	updateHudSnapshot(ctx, undefined, 0);
	updateHudSnapshot(ctx, undefined, 0);
	assert.equal(ui.setStatusCalls, 0);
	assert.equal(ui.setWidgetCalls.length, 0);
	assert.equal(ui.requestRenderCalls, 0);
});

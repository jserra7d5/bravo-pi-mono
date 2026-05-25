import test from "node:test";
import assert from "node:assert/strict";
import {
  chrome,
  costHeaderSegment,
  formatCost,
  formatRunRow,
  identityColor,
  identitySlot,
  idBar,
  idMention,
  pickWidgetLayout,
  renderLaunchCard,
  renderResultCard,
  renderSubagentToolCallComponent,
  renderSubagentToolResultComponent,
  renderSubagentWakeMessage,
  renderSubagentWakeMessageComponent,
  renderWakeCard,
  renderWidgetCard,
  renderWidgetRow,
  stateGlyph,
  summarizeRunResult,
  summarizeWaitResult,
  truncAnsi,
  visWidth,
} from "../extensions/pi/renderers.js";
import type { SubagentWaitResult } from "../src/types.js";
import type { RunSummaryRow } from "../src/watcher.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("identitySlot hashes deterministically into the 8-color palette", () => {
  for (const name of ["taro", "blip", "nori", "yumi", "koji"]) {
    const a = identitySlot(name);
    const b = identitySlot(name);
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 8, `slot ${a} out of bounds for ${name}`);
    assert.equal(identityColor(name), identityColor(name));
  }
});

test("identitySlot accepts color collisions between distinct names (8 slots, more names)", () => {
  // The 8-color palette is intentionally small. Distinct names may share a slot — this is fine
  // because the @name text is always paired with the color. Pin two known collisions from the
  // mockup so the palette/hash combo doesn't drift silently.
  assert.equal(identitySlot("nori"), identitySlot("yumi"));
  assert.equal(identitySlot("koji"), identitySlot("shio"));
});

test("idMention and idBar paint the same color for a name across calls", () => {
  const mention = idMention("blip");
  const bar = idBar("blip");
  const color = identityColor("blip");
  assert.ok(mention.includes(color));
  assert.ok(bar.includes(color));
});

test("idBar override replaces the identity color with the supplied ANSI", () => {
  const amber = "\x1b[38;2;229;156;72m";
  const overridden = idBar("blip", { override: amber });
  assert.ok(overridden.startsWith(amber));
  assert.ok(!overridden.includes(identityColor("blip")));
});

test("stateGlyph maps each runtime state to its decision-2 glyph", () => {
  assert.equal(stateGlyph("running").g, "◐");
  assert.equal(stateGlyph("queued").g, "○");
  assert.equal(stateGlyph("waiting_for_input").g, "?");
  assert.equal(stateGlyph("blocked").g, "⚠");
  assert.equal(stateGlyph("paused").g, "⏸");
  assert.equal(stateGlyph("stalled").g, "◌");
  assert.equal(stateGlyph("completed").g, "✓");
  assert.equal(stateGlyph("failed").g, "✗");
  assert.equal(stateGlyph("cancelled").g, "⊘");
  assert.equal(stateGlyph("expired").g, "⊘");
  assert.equal(stateGlyph("result_ready").g, "★");
});

test("stateGlyph colors are semantic", () => {
  const cyan = "\x1b[38;2;95;179;212m";
  const amber = "\x1b[38;2;229;156;72m";
  const green = "\x1b[38;2;106;191;115m";
  const red = "\x1b[38;2;220;88;88m";
  const gold = "\x1b[38;2;229;181;72m";
  assert.equal(stateGlyph("running").color, cyan);
  assert.equal(stateGlyph("waiting_for_input").color, amber);
  assert.equal(stateGlyph("completed").color, green);
  assert.equal(stateGlyph("failed").color, red);
  assert.equal(stateGlyph("result_ready").color, gold);
});

test("visWidth treats CJK and emoji as 2 cells and ignores ANSI escapes", () => {
  assert.equal(visWidth("hello"), 5);
  assert.equal(visWidth("中文"), 4);
  assert.equal(visWidth("\x1b[31mhello\x1b[0m"), 5);
  assert.equal(visWidth("a🛰️b"), 4);
  assert.equal(visWidth("✅"), 2);
  assert.equal(visWidth("✓"), 1);
  assert.equal(visWidth("⚠"), 1);
  assert.equal(visWidth("⚠️"), 2);
});

test("truncAnsi caps visible width and appends an ellipsis", () => {
  const out = truncAnsi("the quick brown fox", 10);
  assert.ok(out.endsWith("…\x1b[0m"));
  assert.ok(visWidth(out) <= 10);
  assert.ok(visWidth(truncAnsi("ok ⚠️ done", 7)) <= 7);
});

test("widget row hierarchy: urgent overrides identity color, done dims, active uses identity", () => {
  const amber = "\x1b[38;2;229;156;72m";
  const blue = identityColor("blip");
  const ch = chrome(72);
  const urgent = renderWidgetRow(72, ch, { displayName: "blip", role: "auditor", state: "waiting_for_input", summary: "need creds" });
  const active = renderWidgetRow(72, ch, { displayName: "blip", role: "auditor", state: "running", summary: "working" });
  const done = renderWidgetRow(72, ch, { displayName: "blip", role: "auditor", state: "completed", summary: "done" });
  assert.ok(urgent.includes(amber), "urgent row uses amber bar");
  assert.ok(active.includes(blue), "active row uses identity color");
  assert.ok(done.includes("\x1b[2m"), "done row uses dim");
});

test("widget responsive layout dispatches at the 54 and 70 boundaries", () => {
  assert.equal(pickWidgetLayout(96), "full");
  assert.equal(pickWidgetLayout(70), "full");
  assert.equal(pickWidgetLayout(69), "no-role");
  assert.equal(pickWidgetLayout(54), "no-role");
  assert.equal(pickWidgetLayout(53), "minimal");
  assert.equal(pickWidgetLayout(32), "minimal");
});

test("widget row layouts include or omit the role and age per width", () => {
  const ch72 = chrome(72);
  const ch56 = chrome(56);
  const ch44 = chrome(44);
  const row = { displayName: "blip", role: "auditor", state: "running" as const, summary: "x", age: "3m" };
  const full = stripAnsi(renderWidgetRow(72, ch72, row));
  const noRole = stripAnsi(renderWidgetRow(56, ch56, row));
  const minimal = stripAnsi(renderWidgetRow(44, ch44, row));
  assert.ok(full.includes("auditor"), "full layout includes role");
  assert.ok(full.includes("3m"), "full layout includes age");
  assert.ok(!noRole.includes("auditor"), "no-role layout drops role");
  assert.ok(noRole.includes("3m"), "no-role layout keeps age");
  assert.ok(!minimal.includes("auditor"), "minimal layout drops role");
  assert.ok(!minimal.includes("3m"), "minimal layout drops age");
});

test("widget header counts active/urgent/ready in their semantic colors and omits zeros", () => {
  const cyan = "\x1b[38;2;95;179;212m";
  const amber = "\x1b[38;2;229;156;72m";
  const gold = "\x1b[38;2;229;181;72m";
  const card = renderWidgetCard({
    width: 72,
    rows: [
      { displayName: "a", role: "r", state: "running", summary: "x" },
      { displayName: "b", role: "r", state: "waiting_for_input", summary: "y", urgent: true },
      { displayName: "c", role: "r", state: "completed", summary: "z", done: true, resultReady: true },
    ],
  });
  const header = card[0];
  assert.ok(header.includes(`${cyan}2 active`));
  assert.ok(header.includes(`${amber}1 need you`));
  assert.ok(header.includes(`${gold}1 ready`));
});

test("widget header treats unread failed results as ready but not active", () => {
  const card = renderWidgetCard({
    width: 72,
    rows: [
      { displayName: "fail", role: "reviewer", state: "failed", summary: "boom", resultReady: true },
    ],
  });
  const header = stripAnsi(card[0]);
  assert.ok(header.includes("1 ready"));
  assert.ok(!header.includes("active"));
});

test("card chrome holds its box at widths 72, 56, 44, and 32", () => {
  const row = { displayName: "blip", role: "auditor", state: "running" as const, summary: "x" };
  for (const w of [72, 56, 44, 32]) {
    const card = renderWidgetCard({ width: w, rows: [row] });
    for (const line of card) {
      assert.equal(visWidth(line), w, `expected width ${w} at line "${stripAnsi(line)}"`);
    }
  }
});

test("display name is capped at 16 visible cells with an ellipsis in widget rows", () => {
  const longName = "performance-regression-investigator";
  const ch = chrome(72);
  const out = renderWidgetRow(72, ch, { displayName: longName, role: "x", state: "running", summary: "y" });
  const stripped = stripAnsi(out);
  assert.ok(!stripped.includes(longName), `should truncate ${longName}`);
  assert.ok(stripped.includes("…"));
});

test("affordances wrap onto multiple rows instead of truncating", () => {
  const card = renderWakeCard({
    width: 72,
    displayName: "blip",
    role: "auditor",
    kind: "waiting_for_input",
    badge: "needs you",
    headline: "hi",
    affordances: ["draft 1", "draft 2", "draft 3", "matrix first", "wait"],
  });
  // Each row exactly width=72 visible cells; affordance brackets appear at least twice.
  const stripped = card.map(stripAnsi).join("\n");
  const opens = (stripped.match(/\[ /g) ?? []).length;
  assert.equal(opens, 5);
});

test("launch card surfaces task, model, thinking, skills, tools, budget, and context", () => {
  const card = renderLaunchCard({
    width: 72,
    displayName: "taro",
    role: "researcher",
    state: "queued",
    task: "Investigate auth middleware",
    model: "claude-opus-4-7",
    thinking: "high",
    skills: ["reading-code", "debugging-helpers"],
    tools: ["read", "grep"],
    budget: "30m max",
    context: "fresh session",
  });
  const text = card.map(stripAnsi).join("\n");
  assert.ok(text.includes("Investigate auth middleware"));
  assert.ok(text.includes("claude-opus-4-7"));
  assert.ok(text.includes("thinking high"));
  assert.ok(text.includes("reading-code"));
  assert.ok(text.includes("read"));
  assert.ok(text.includes("30m max"));
  assert.ok(text.includes("fresh session"));
});

test("result card shows summary, metrics, artifacts, and duration in the badge", () => {
  const card = renderResultCard({
    width: 72,
    displayName: "taro",
    role: "researcher",
    state: "completed",
    duration: "3m 42s",
    summary: "Found three issues",
    metrics: "12.4k in · 3.2k out",
    artifacts: ["notes/auth.md", "diffs/auth.patch"],
  });
  const text = card.map(stripAnsi).join("\n");
  assert.ok(text.includes("done"));
  assert.ok(text.includes("3m 42s"));
  assert.ok(text.includes("Found three issues"));
  assert.ok(text.includes("12.4k in"));
  assert.ok(text.includes("notes/auth.md"));
});

test("result card holds width when body lines contain default-wide emoji", () => {
  const card = renderResultCard({
    width: 93,
    displayName: "Gray",
    role: "reviewer",
    state: "completed",
    duration: "35s",
    summary: "No blockers found.",
    body: "Checks run:\n- `cargo test --manifest-path packages/source-search/sidecar/Cargo.toml` ✅\n- `npm test --workspace packages/source-search` ✅ 13/13 passed",
  });
  for (const line of card) {
    assert.equal(visWidth(line), 93, `expected width 93 at line "${stripAnsi(line)}"`);
  }
});

test("wake card kind picks the correct badge and affordances", () => {
  const needs = renderWakeCard({
    width: 72,
    displayName: "blip",
    role: "auditor",
    kind: "waiting_for_input",
    badge: "needs you",
    headline: "creds?",
    affordances: ["reply", "wait", "dismiss"],
  });
  const failed = renderWakeCard({
    width: 72,
    displayName: "nori",
    role: "scribe",
    kind: "failed",
    badge: "failed",
    headline: "perm denied",
    affordances: ["retry", "dismiss"],
  });
  const needsText = needs.map(stripAnsi).join("\n");
  const failedText = failed.map(stripAnsi).join("\n");
  assert.ok(needsText.includes("needs you"));
  assert.ok(needsText.includes("[ reply ]"));
  assert.ok(failedText.includes("failed"));
  assert.ok(failedText.includes("[ retry ]"));
});

test("formatRunRow plain-text fallback preserves identity mention and state label", () => {
  const row: RunSummaryRow = {
    runId: "run_test",
    runDir: "/tmp/run_test",
    displayName: "Rex",
    agentName: "scout",
    state: "completed",
    summary: "Completed a long reconnaissance task with useful findings",
    resultReady: true,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
  const stripped = stripAnsi(formatRunRow(row));
  assert.ok(stripped.includes("@Rex"));
  assert.ok(stripped.includes("scout"));
  assert.ok(stripped.includes("done"));
  assert.ok(!stripped.includes("run_test"));
});

test("renderSubagentToolCallComponent renders a launch card when called with agent args", () => {
  const comp = renderSubagentToolCallComponent({ agent: "researcher", task: "look around" }, undefined, "subagent_start");
  const rendered = comp.render(72).map(stripAnsi).join("\n");
  assert.ok(rendered.includes("start subagent"));
  assert.ok(rendered.includes("researcher"));
  assert.ok(rendered.includes("from active pack"));
  assert.ok(rendered.includes("look around"));
});

test("renderSubagentToolCallComponent renders a wait card when no agent is supplied", () => {
  const comp = renderSubagentToolCallComponent({}, undefined, "subagent_wait");
  const rendered = comp.render(72).map(stripAnsi).join("\n");
  assert.ok(rendered.includes("wait for subagents"));
  assert.ok(rendered.includes("direct children"));
  assert.ok(rendered.includes("interesting"));
});

test("renderSubagentToolResultComponent renders a result card from terminal result details", () => {
  const comp = renderSubagentToolResultComponent({
    details: {
      summary: "x",
      agentName: "reviewer",
      displayName: "Fives",
      state: "completed",
      success: true,
      durationMs: 12000,
    },
  });
  const rendered = comp.render(72).map(stripAnsi).join("\n");
  assert.ok(rendered.includes("@Fives"));
  assert.ok(rendered.includes("done"));
});

test("renderSubagentToolResultComponent launch card surfaces agent-definition detail", () => {
  // SubagentStartResult shape: runId + agentName + started + skills/tools/budget fields.
  const comp = renderSubagentToolResultComponent({
    details: {
      runId: "run_taro",
      agentName: "researcher",
      displayName: "taro",
      started: true,
      state: "queued",
      model: "claude-opus-4-7",
      thinkingLevel: "high",
      skills: ["reading-code", "debugging-helpers"],
      tools: ["read", "grep", "bash"],
      maxRunMs: 30 * 60_000,
      maxSubagentDepth: 4,
      contextPolicy: "fresh",
    },
  });
  const rendered = comp.render(72).map(stripAnsi).join("\n");
  assert.ok(rendered.includes("@taro"));
  assert.ok(rendered.includes("researcher"));
  assert.ok(rendered.includes("claude-opus-4-7"));
  assert.ok(rendered.includes("thinking high"));
  assert.ok(rendered.includes("reading-code"));
  assert.ok(rendered.includes("read"));
  assert.ok(rendered.includes("30m max"));
  assert.ok(rendered.includes("depth 4"));
  assert.ok(rendered.includes("fresh session"));
});

test("renderSubagentToolResultComponent falls back to text summary when not a card payload", () => {
  const comp = renderSubagentToolResultComponent({ details: { summary: "Started worker" } });
  const rendered = comp.render(80).join("\n");
  assert.ok(rendered.includes("Started worker"));
});

test("renderSubagentToolResultComponent renders nested wait-body details when expanded", () => {
  const comp = renderSubagentToolResultComponent(
    {
      details: {
        summary: "Subagent wait: 1 ready, 1 result",
        results: [{ runId: "run_a", displayName: "Fives", agentName: "reviewer", body: "Reviewer found path safety gaps" }],
      },
    },
    { expanded: true },
  );
  const rendered = stripAnsi(comp.render(80).join("\n"));
  assert.ok(rendered.includes("@Fives reviewer:"));
  assert.ok(rendered.includes("Reviewer found path safety gaps"));
});

test("renderSubagentWakeMessage renders a wake card with badge and affordances", () => {
  const rendered = renderSubagentWakeMessage({
    kind: "subagent_wakeup",
    title: "scout",
    runId: "run_a",
    state: "waiting_for_input",
    summary: "I need credentials",
  });
  const stripped = stripAnsi(rendered);
  assert.ok(stripped.includes("@scout"));
  assert.ok(stripped.includes("needs you"));
  assert.ok(stripped.includes("[ reply ]"));
});

test("renderSubagentWakeMessageComponent adapts the card width to the render viewport", () => {
  const comp = renderSubagentWakeMessageComponent({
    kind: "subagent_wakeup",
    title: "scout",
    runId: "run_a",
    state: "completed",
    summary: "all done",
  });
  for (const w of [72, 56, 44, 32]) {
    const lines = comp.render(w);
    for (const line of lines) assert.equal(visWidth(line), w);
  }
});

test("run result summary preserves the child result summary", () => {
  assert.match(summarizeRunResult({
    schemaVersion: 1,
    runId: "run_a",
    parentRunId: "root_a",
    agentName: "scout",
    contextPolicy: "fresh",
    sessionPolicy: "record",
    state: "completed",
    success: true,
    createdAt: "2026-05-14T00:00:01.000Z",
    durationMs: 1000,
    summary: "Found 3 issues",
    body: "body",
    artifacts: [],
    error: null,
  }, "run_a"), /Found 3 issues/);
});

test("wait summary collapses result details and avoids duplicating the agent name", () => {
  const waited: SubagentWaitResult = {
    state: "ready",
    mode: "race",
    readyRunIds: ["run_a"],
    events: [],
    results: [
      {
        schemaVersion: 1,
        runId: "run_a",
        parentRunId: "root_a",
        agentName: "scout",
        contextPolicy: "fresh",
        sessionPolicy: "record",
        state: "completed",
        success: true,
        createdAt: "2026-05-14T00:00:01.000Z",
        durationMs: 1000,
        summary: "Done",
        body: "Done",
        artifacts: [],
        error: null,
      },
    ],
    statuses: [],
    cursors: {},
    remainingRunIds: [],
    timedOut: false,
    next: [],
  };
  assert.match(summarizeWaitResult(waited), /scout completed/);
  assert.doesNotMatch(summarizeWaitResult(waited), /Done/);
  assert.doesNotMatch(summarizeWaitResult(waited), /scout scout/);
});

test("formatCost suppresses values under one cent and switches decimals at the dollar mark", () => {
  assert.equal(formatCost(0.0001), undefined);
  assert.equal(formatCost(0.009), undefined);
  assert.equal(formatCost(0.012), "$0.012");
  assert.equal(formatCost(0.42), "$0.420");
  assert.equal(formatCost(1.0), "$1.00");
  assert.equal(formatCost(12.5), "$12.50");
  assert.equal(formatCost(undefined), undefined);
  assert.equal(formatCost(Number.NaN), undefined);
});

test("costHeaderSegment paints in the shared cost color when present and disappears under threshold", () => {
  const costColor = "\x1b[38;2;200;220;200m";
  const seg = costHeaderSegment(0.42);
  assert.ok(seg);
  assert.ok(seg.startsWith(costColor));
  assert.ok(stripAnsi(seg).includes("$0.420 total"));
  assert.equal(costHeaderSegment(0.001), undefined);
});

test("widget header surfaces the cumulative cost segment when totalCost is at or above one cent", () => {
  const card = renderWidgetCard({
    width: 72,
    totalCost: 0.42,
    rows: [
      { displayName: "a", role: "r", state: "running", summary: "x" },
      { displayName: "b", role: "r", state: "completed", summary: "y", done: true },
    ],
  });
  const header = stripAnsi(card[0]);
  assert.ok(header.includes("$0.420 total"), `header missing cost: "${header}"`);
});

test("widget header omits the cost segment when totalCost is undefined or under the threshold", () => {
  const noCost = renderWidgetCard({
    width: 72,
    rows: [{ displayName: "a", role: "r", state: "running", summary: "x" }],
  });
  assert.ok(!stripAnsi(noCost[0]).includes("total"));
  const tinyCost = renderWidgetCard({
    width: 72,
    totalCost: 0.001,
    rows: [{ displayName: "a", role: "r", state: "running", summary: "x" }],
  });
  assert.ok(!stripAnsi(tinyCost[0]).includes("total"));
});

test("widget header drops the cost segment first when the badge cannot fit at narrow widths", () => {
  // Three counts + cost would never fit at width 32; the cost is the lowest
  // priority piece, so it goes first while the active/needs/ready counts stay.
  const card = renderWidgetCard({
    width: 32,
    totalCost: 12.34,
    rows: [
      { displayName: "a", role: "r", state: "running", summary: "x" },
      { displayName: "b", role: "r", state: "waiting_for_input", summary: "y", urgent: true },
      { displayName: "c", role: "r", state: "completed", summary: "z", done: true },
    ],
  });
  const header = stripAnsi(card[0]);
  assert.ok(!header.includes("$12.34"));
});

test("widget chrome holds its declared width when the card includes a cost segment", () => {
  for (const w of [72, 64, 56, 44, 32]) {
    const card = renderWidgetCard({
      width: w,
      totalCost: 0.42,
      rows: [{ displayName: "rex", role: "scout", state: "running", summary: "working" }],
    });
    for (const line of card) {
      assert.equal(visWidth(line), w, `width ${w} broken at "${stripAnsi(line)}"`);
    }
  }
});

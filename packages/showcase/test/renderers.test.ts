import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  bottomRule,
  buildCardLines,
  cardSpecFromDetails,
  identityColor,
  identitySlot,
  modeBadgeText,
  modeColor,
  renderCardForTest,
  renderShowcaseResult,
  topRule,
  visWidth,
} from "../extensions/pi/index.js";

// Markdown + diff renderers from pi-coding-agent both touch the shared theme.
// Initialize once for the entire test file.
initTheme();

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// ────────────────────────────────────────────────────────────────────────────
// Identity palette
// ────────────────────────────────────────────────────────────────────────────

test("identitySlot hashes deterministically into the 8-color palette", () => {
  for (const p of [
    "packages/showcase/extensions/pi/index.ts",
    "packages/async-subagents/extensions/pi/renderers.ts",
    "packages/bravo-goals/extensions/pi/judge-control.ts",
    "VERSION",
    "logs/session.log",
  ]) {
    const a = identitySlot(p);
    const b = identitySlot(p);
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 8, `slot ${a} out of bounds for ${p}`);
    assert.equal(identityColor(p), identityColor(p));
  }
});

test("identitySlot distributes across 8 distinct paths (uses ≥ 5 slots)", () => {
  const paths = [
    "packages/showcase/extensions/pi/index.ts",
    "packages/async-subagents/extensions/pi/renderers.ts",
    "packages/bravo-goals/extensions/pi/judge-control.ts",
    ".pi/extensions/codex-usage.ts",
    "packages/showcase/src/types.ts",
    "docs/specs/foo.md",
    "src/payments.ts",
    "logs/session.log",
    "README.md",
    "VERSION",
  ];
  const slots = new Set(paths.map(identitySlot));
  assert.ok(slots.size >= 5, `expected ≥ 5 distinct slots, got ${slots.size}`);
});

test("identity palette mirrors the async-subagents RGB triplets exactly", () => {
  // Pin all 8 palette colors so they don't silently drift from
  // `packages/async-subagents/extensions/pi/renderers.ts` `IDENTITY_PALETTE`.
  const expected = [
    "\x1b[38;2;229;145;91m",
    "\x1b[38;2;199;125;186m",
    "\x1b[38;2;123;201;123m",
    "\x1b[38;2;111;169;217m",
    "\x1b[38;2;155;123;217m",
    "\x1b[38;2;91;201;181m",
    "\x1b[38;2;217;195;111m",
    "\x1b[38;2;217;125;125m",
  ];
  // Probe: hash a few inputs into each slot by brute force.
  const found = new Map<number, string>();
  for (let i = 0; i < 200 && found.size < 8; i++) {
    const slot = identitySlot(`probe-${i}`);
    if (!found.has(slot)) found.set(slot, identityColor(`probe-${i}`));
  }
  assert.equal(found.size, 8);
  for (let i = 0; i < 8; i++) {
    assert.equal(found.get(i), expected[i], `slot ${i} drift`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Mode color mapping
// ────────────────────────────────────────────────────────────────────────────

test("modeColor and modeBadgeText map every mode to expected color + badge text", () => {
  const amber = "\x1b[38;2;229;181;72m";
  const green = "\x1b[38;2;126;201;145m";
  const butter = "\x1b[38;2;232;200;126m";
  const lavender = "\x1b[38;2;213;163;233m";
  const muted = "\x1b[38;2;160;160;170m";

  assert.equal(modeColor("markdown"), amber);
  assert.equal(modeColor("code"), green);
  assert.equal(modeColor("json"), butter);
  assert.equal(modeColor("diff"), lavender);
  assert.equal(modeColor("plain"), muted);

  assert.equal(modeBadgeText("markdown"), "MD");
  assert.equal(modeBadgeText("code"), "CODE"); // fallback when language unknown
  assert.equal(modeBadgeText("json"), "JSON");
  assert.equal(modeBadgeText("diff"), "DIFF");
  assert.equal(modeBadgeText("plain"), "TXT");
});

test("modeBadgeText derives short abbreviation from language for code mode", () => {
  assert.equal(modeBadgeText("code", "typescript"), "TS");
  assert.equal(modeBadgeText("code", "javascript"), "JS");
  assert.equal(modeBadgeText("code", "python"), "PY");
  assert.equal(modeBadgeText("code", "rust"), "RS");
  // Unknown language: upper-case prefix, capped at 4.
  assert.equal(modeBadgeText("code", "haskell"), "HASK");
  // Non-code modes ignore the language argument.
  assert.equal(modeBadgeText("json", "typescript"), "JSON");
  assert.equal(modeBadgeText("markdown", "typescript"), "MD");
});

// ────────────────────────────────────────────────────────────────────────────
// Top / bottom rules
// ────────────────────────────────────────────────────────────────────────────

test("topRule paints identity color on corners and filename", () => {
  const id = identityColor("packages/showcase/extensions/pi/index.ts");
  const line = topRule(96, {
    filename: "index.ts",
    mode: "code",
    lineRange: "lines 1-7",
    rightSegment: undefined,
    idColor: id,
    badgeFitsMin: 44,
  });
  // Both corner glyphs must be wrapped in the identity color escape.
  assert.ok(line.includes(`${id}╭─`), "left corner missing identity color");
  assert.ok(line.includes(`${id}─╮`), "right corner missing identity color");
  // Filename appears in bold + identity color.
  assert.ok(line.includes(`${id}\x1b[1mindex.ts`), "filename missing bold + identity color");
  // Stripped width equals requested width.
  assert.equal(visWidth(line), 96);
});

test("bottomRule paints identity color on corners and respects width", () => {
  const id = identityColor("VERSION");
  const line = bottomRule(72, id);
  assert.ok(line.startsWith(`${id}╰`), "left corner missing identity color");
  assert.ok(line.endsWith(`${id}╯\x1b[0m`), "right corner missing identity color");
  assert.equal(visWidth(line), 72);
});

test("topRule uses short line range form at narrow widths", () => {
  const id = identityColor("a.ts");
  const wide = topRule(96, { filename: "a.ts", mode: "code", lineRange: "lines 1-12", idColor: id, badgeFitsMin: 44 });
  const narrow = topRule(56, { filename: "a.ts", mode: "code", lineRange: "L1-12", idColor: id, badgeFitsMin: 44 });
  assert.ok(stripAnsi(wide).includes("lines 1-12"));
  assert.ok(stripAnsi(narrow).includes("L1-12"));
  assert.ok(!stripAnsi(narrow).includes("lines 1-12"));
});

test("topRule drops the right segment when it cannot fit", () => {
  const id = identityColor("a.ts");
  const tight = topRule(50, {
    filename: "a.ts",
    mode: "code",
    lineRange: "L1-12",
    rightSegment: "\x1b[38;2;120;120;128msome/very/long/parent/dir\x1b[0m",
    idColor: id,
    badgeFitsMin: 44,
  });
  // No parent dir should appear in the stripped output.
  assert.ok(!stripAnsi(tight).includes("some/very/long/parent/dir"));
  assert.equal(visWidth(tight), 50);
});

test("topRule drops the mode badge at very narrow widths", () => {
  const id = identityColor("a.ts");
  const allowed = topRule(50, { filename: "a.ts", mode: "code", lineRange: "L1-3", idColor: id, badgeFitsMin: 50 });
  const dropped = topRule(48, { filename: "a.ts", mode: "code", lineRange: "L1-3", idColor: id, badgeFitsMin: 50 });
  assert.ok(stripAnsi(allowed).includes("CODE"));
  assert.ok(!stripAnsi(dropped).includes("CODE"));
});

test("topRule renders language-derived badge for code mode when language is provided", () => {
  const id = identityColor("a.ts");
  const line = topRule(96, {
    filename: "a.ts",
    mode: "code",
    language: "typescript",
    lineRange: "lines 1-7",
    idColor: id,
    badgeFitsMin: 50,
  });
  const plain = stripAnsi(line);
  assert.ok(plain.includes("TS"), "expected TS badge");
  assert.ok(!plain.includes("CODE"), "should not fall back to CODE when language is known");
});

// ────────────────────────────────────────────────────────────────────────────
// Card builder (full output)
// ────────────────────────────────────────────────────────────────────────────

const codeDetails = {
  summary: "ok",
  ok: true as const,
  path: "packages/showcase/extensions/pi/index.ts",
  offset: 145,
  endLine: 148,
  lineCount: 4,
  mode: "code" as const,
  language: "typescript",
  body: "function showcaseRule(kind, details) {\n  const text = kind === \"start\" ? `...` : \" End showcase \";\n  return `...`;\n}",
};

for (const width of [44, 56, 72, 96, 120]) {
  test(`card renders at width ${width} with rules ${width} cells wide and no side bars on content`, () => {
    const lines = renderCardForTest(codeDetails, width);
    assert.ok(lines.length >= 3, `expected ≥ 3 lines, got ${lines.length}`);
    // First + last are rules — exactly `width` visible cells.
    assert.equal(visWidth(lines[0]), width, `top rule width mismatch at ${width}`);
    assert.equal(visWidth(lines[lines.length - 1]), width, `bottom rule width mismatch at ${width}`);
    // Content rows must NOT carry side bars (▌ or │ at their start) — the only │
    // glyphs allowed inside content are line-number separators (preceded by a digit
    // and a space).
    for (let i = 1; i < lines.length - 1; i++) {
      const plain = stripAnsi(lines[i]);
      assert.ok(!plain.startsWith("▌"), `row ${i} starts with side bar`);
      assert.ok(!plain.startsWith("│"), `row ${i} starts with side bar`);
    }
  });
}

test("card uses parent dir only at widths ≥ 80", () => {
  const wide = renderCardForTest(codeDetails, 96).join("\n");
  const narrow = renderCardForTest(codeDetails, 72).join("\n");
  assert.ok(stripAnsi(wide).includes("packages/showcase/extensions/pi"));
  assert.ok(!stripAnsi(narrow).includes("packages/showcase/extensions/pi"));
});

test("card renders parent dir verbatim (no ellipsis truncation)", () => {
  // Regression: the implementer originally truncated parent dir at width/3,
  // which clipped legitimate dirs like "packages/async-subagents/extensions/pi"
  // at width 96. Mockup behavior is verbatim — drop whole if it can't fit.
  const longParent = "packages/async-subagents/extensions/pi"; // 38 chars
  const detailsWithLongParent = {
    summary: "ok",
    ok: true as const,
    path: `${longParent}/renderers.ts`,
    offset: 1,
    endLine: 3,
    lineCount: 3,
    mode: "code" as const,
    language: "typescript",
    body: "x",
  };
  const out = stripAnsi(renderCardForTest(detailsWithLongParent, 96).join("\n"));
  assert.ok(out.includes(longParent), `expected verbatim parent dir, got line: ${out.split("\n")[0]}`);
  assert.ok(!out.includes("…"), "no ellipsis truncation on parent dir");
});

test("custom title replaces filename in the bar", () => {
  const out = renderCardForTest(
    { ...codeDetails, title: "Payment retry logic" },
    96,
  );
  const top = stripAnsi(out[0]);
  assert.ok(top.includes("Payment retry logic"), "custom title missing");
  assert.ok(!top.includes("index.ts"), "filename should be replaced by title");
});

test("markdown details produce a card whose body lines come from pi-tui Markdown (not a single Text)", () => {
  const md = {
    summary: "ok",
    ok: true as const,
    path: "README.md",
    offset: 1,
    endLine: 3,
    lineCount: 3,
    mode: "markdown" as const,
    body: "# Hello\n\nWorld paragraph.",
  };
  const lines = renderCardForTest(md, 80);
  // The card must have a top rule, a bottom rule, AND multiple body lines from Markdown render.
  assert.ok(lines.length >= 3);
  assert.equal(visWidth(lines[0]), 80);
  assert.equal(visWidth(lines[lines.length - 1]), 80);
  // The Markdown renderer should have produced the heading text somewhere in the middle.
  const middle = lines.slice(1, -1).join("\n");
  assert.ok(stripAnsi(middle).includes("Hello"), "markdown body did not render");
});

test("diff mode body uses diff coloring helpers", () => {
  const diff = {
    summary: "ok",
    ok: true as const,
    path: "feature.diff",
    offset: 1,
    endLine: 4,
    lineCount: 4,
    mode: "diff" as const,
    body: "@@ -1,3 +1,3 @@\n-removed\n+added\n context",
  };
  const lines = renderCardForTest(diff, 80);
  const middle = lines.slice(1, -1).join("\n");
  assert.ok(stripAnsi(middle).includes("removed"), "diff body missing removed line");
  assert.ok(stripAnsi(middle).includes("added"), "diff body missing added line");
});

test("plain mode body has gutter line numbers and no syntax highlighting", () => {
  const plain = {
    summary: "ok",
    ok: true as const,
    path: "logs/session.log",
    offset: 100,
    endLine: 102,
    lineCount: 3,
    mode: "plain" as const,
    body: "line a\nline b\nline c",
  };
  const lines = renderCardForTest(plain, 96);
  const middle = stripAnsi(lines.slice(1, -1).join("\n"));
  // Line numbers should appear: 100, 101, 102.
  assert.ok(middle.includes("100 │"), "missing line number 100");
  assert.ok(middle.includes("101 │"));
  assert.ok(middle.includes("102 │"));
});

test("cardSpecFromDetails derives filename and parentDir from path when no title", () => {
  const spec = cardSpecFromDetails({
    summary: "ok",
    ok: true,
    path: "packages/showcase/extensions/pi/index.ts",
    offset: 1,
    endLine: 1,
    lineCount: 1,
    mode: "code",
    body: "x",
  });
  assert.equal(spec.filename, "index.ts");
  assert.equal(spec.parentDir, "packages/showcase/extensions/pi");
});

test("cardSpecFromDetails uses title verbatim as filename when supplied", () => {
  const spec = cardSpecFromDetails({
    summary: "ok",
    ok: true,
    path: "src/payments.ts",
    title: "Payment retry logic",
    offset: 88,
    endLine: 102,
    lineCount: 15,
    mode: "code",
    body: "x",
  });
  assert.equal(spec.filename, "Payment retry logic");
});

test("renderShowcaseResult on a failed result returns a Text component with the error", () => {
  const c = renderShowcaseResult(
    {
      content: [{ type: "text" as const, text: "Could not showcase missing.md: ENOENT" }],
      details: { summary: "x", ok: false, path: "missing.md", error: "ENOENT" },
    },
    {} as never,
  );
  // The Component must implement render(width). Probe at a sane width.
  const lines = c.render(80);
  assert.ok(lines.join("\n").includes("Could not showcase"), "error text missing");
});

test("renderShowcaseResult on success returns a ShowcaseCard component that adapts to width", () => {
  const result = {
    content: [{ type: "text" as const, text: "ok" }],
    details: codeDetails,
  };
  const c = renderShowcaseResult(result, {} as never);
  const wide = c.render(120);
  const narrow = c.render(56);
  // Top rule width should match the width pi requested.
  assert.equal(visWidth(wide[0]), 120);
  assert.equal(visWidth(narrow[0]), 56);
  // Adaptive behavior: parent dir dropped at 56.
  assert.ok(!stripAnsi(narrow.join("\n")).includes("packages/showcase/extensions/pi"));
});

test("buildCardLines uses identity color hashed off the path on both rules", () => {
  const id = identityColor("packages/showcase/extensions/pi/index.ts");
  const lines = buildCardLines(96, cardSpecFromDetails(codeDetails));
  assert.ok(lines[0].includes(id), "top rule missing identity color");
  assert.ok(lines[lines.length - 1].includes(id), "bottom rule missing identity color");
});

// ────────────────────────────────────────────────────────────────────────────
// lineNumbers parameter — opt-out gutter
// ────────────────────────────────────────────────────────────────────────────

test("code mode renders gutter by default", () => {
  const lines = renderCardForTest(codeDetails, 96);
  const middle = stripAnsi(lines.slice(1, -1).join("\n"));
  assert.ok(/\b145 │/.test(middle), "expected line-number gutter for line 145");
});

test("lineNumbers: false omits the gutter in code mode", () => {
  const lines = renderCardForTest({ ...codeDetails, lineNumbers: false }, 96);
  const middle = stripAnsi(lines.slice(1, -1).join("\n"));
  assert.ok(!/\b145 │/.test(middle), "gutter still present despite lineNumbers: false");
  assert.ok(!middle.split("\n").some((row) => /^\s*\d+\s+│\s/.test(row)), "no row should start with line-number gutter");
});

test("lineNumbers: false omits the gutter in plain mode", () => {
  const plain = {
    summary: "ok",
    ok: true as const,
    path: "logs/session.log",
    offset: 100,
    endLine: 102,
    lineCount: 3,
    mode: "plain" as const,
    body: "line a\nline b\nline c",
    lineNumbers: false,
  };
  const middle = stripAnsi(renderCardForTest(plain, 96).slice(1, -1).join("\n"));
  assert.ok(!middle.includes("100 │"), "gutter present in plain mode");
  assert.ok(middle.includes("line a"), "body content missing");
});

test("lineNumbers: false omits the gutter in json mode", () => {
  const json = {
    summary: "ok",
    ok: true as const,
    path: "pkg.json",
    offset: 1,
    endLine: 3,
    lineCount: 3,
    mode: "json" as const,
    language: "json",
    body: "{\n  \"a\": 1\n}",
    lineNumbers: false,
  };
  const middle = stripAnsi(renderCardForTest(json, 96).slice(1, -1).join("\n"));
  assert.ok(!/^\s*\d+\s+│\s/m.test(middle), "json should have no gutter");
  assert.ok(middle.includes("\"a\""), "json body missing");
});

test("lineNumbers: false is a no-op for markdown mode (markdown has no gutter)", () => {
  const md = {
    summary: "ok",
    ok: true as const,
    path: "README.md",
    offset: 1,
    endLine: 3,
    lineCount: 3,
    mode: "markdown" as const,
    body: "# Hello\n\nWorld.",
    lineNumbers: false,
  };
  const lines = renderCardForTest(md, 80);
  assert.equal(visWidth(lines[0]), 80);
  const middle = stripAnsi(lines.slice(1, -1).join("\n"));
  assert.ok(middle.includes("Hello"), "markdown body missing");
});

test("lineNumbers: false is a no-op for diff mode (renderDiff has its own format)", () => {
  const diff = {
    summary: "ok",
    ok: true as const,
    path: "feature.diff",
    offset: 1,
    endLine: 4,
    lineCount: 4,
    mode: "diff" as const,
    body: "@@ -1,3 +1,3 @@\n-removed\n+added\n context",
    lineNumbers: false,
  };
  const middle = stripAnsi(renderCardForTest(diff, 80).slice(1, -1).join("\n"));
  // Diff body still renders (its own coloring), no line-number gutter to drop.
  assert.ok(middle.includes("removed"));
  assert.ok(middle.includes("added"));
});

test("lineNumbers: true (explicit) keeps the gutter on", () => {
  const lines = renderCardForTest({ ...codeDetails, lineNumbers: true }, 96);
  const middle = stripAnsi(lines.slice(1, -1).join("\n"));
  assert.ok(/\b145 │/.test(middle), "explicit lineNumbers: true should keep gutter");
});

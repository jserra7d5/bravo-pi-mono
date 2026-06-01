import test from "node:test";
import assert from "node:assert/strict";
import { renderCardForTest, renderErrorCard, stripAnsi, truncateMiddle, visWidth } from "../extensions/pi/renderers.js";

test("renderer cards hold declared width at common cutoffs", () => {
  for (const width of [44, 56, 72, 96]) {
    const lines = renderCardForTest(width);
    for (const line of lines) assert.equal(visWidth(line), width, `bad width ${width}: ${stripAnsi(line)}`);
  }
});

test("visWidth handles emoji, text dingbats, and variation selectors", () => {
  assert.equal(visWidth("✅"), 2);
  assert.equal(visWidth("✓"), 1);
  assert.equal(visWidth("⚠"), 1);
  assert.equal(visWidth("⚠️"), 2);
});

test("truncateEnd path through card rows keeps variation-selector emoji within width", () => {
  const [line] = renderCardForTest(44, "✓ Emoji", ["status ⚠️ ".repeat(12)]).slice(1, 2);
  assert.equal(visWidth(line), 44);
});

test("card rows normalize embedded newlines before rendering", () => {
  const lines = renderCardForTest(56, "✓ Multiline", ["query first line\nsecond line"]);
  for (const line of lines) {
    assert.ok(!/[\r\n]/.test(line), `line contains embedded newline: ${JSON.stringify(stripAnsi(line))}`);
    assert.equal(visWidth(line), 56);
  }
});

test("ANSI-colored error rows truncate without counting escape bytes as cells", () => {
  const lines = renderErrorCard(new Error("x".repeat(120))).render(44);
  for (const line of lines) assert.equal(visWidth(line), 44);
  const row = lines[1] ?? "";
  assert.ok(row.includes("x".repeat(20)), "visible payload is not prematurely truncated by ANSI escape bytes");
  assert.ok(row.includes("…\x1b[0m"), "truncated colored payload closes ANSI before padding/border");
});

test("truncateMiddle keeps path head and tail", () => {
  const value = "/tmp/pi-web-cache/workspace/session/pages/page/page.semantic.html";
  const out = truncateMiddle(value, 24);
  assert.ok(out.startsWith("/tmp/"));
  assert.ok(out.endsWith("semantic.html"));
  assert.ok(out.includes("…"));
});

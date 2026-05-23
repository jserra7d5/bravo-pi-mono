import test from "node:test";
import assert from "node:assert/strict";
import { renderCardForTest, stripAnsi, truncateMiddle, visWidth } from "../extensions/pi/renderers.js";

test("renderer cards hold declared width at common cutoffs", () => {
  for (const width of [44, 56, 72, 96]) {
    const lines = renderCardForTest(width);
    for (const line of lines) assert.equal(visWidth(line), width, `bad width ${width}: ${stripAnsi(line)}`);
  }
});

test("truncateMiddle keeps path head and tail", () => {
  const value = "/tmp/pi-web-cache/workspace/session/pages/page/page.semantic.html";
  const out = truncateMiddle(value, 24);
  assert.ok(out.startsWith("/tmp/"));
  assert.ok(out.endsWith("semantic.html"));
  assert.ok(out.includes("…"));
});

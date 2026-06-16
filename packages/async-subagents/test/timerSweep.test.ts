import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(dir, entry.name));
}

test("migrated pi extension surfaces do not own setInterval timers", () => {
  const files = [
    ...tsFiles("packages/async-subagents/extensions/pi"),
    ...tsFiles("packages/bravo-goals/extensions/pi"),
    ".pi/extensions/codex-usage.ts",
  ];

  const offenders = files.filter((file) => readFileSync(file, "utf8").includes("setInterval("));
  assert.deepEqual(offenders, [], "remaining setInterval ownership must live in @bravo/render-clock, not migrated pi extension surfaces");
});

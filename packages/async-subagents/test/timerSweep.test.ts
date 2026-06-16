import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve guarded paths against the monorepo root derived from this test's own
// location (<root>/packages/async-subagents/dist/test/timerSweep.test.js), so the
// sweep runs identically whether invoked from the repo root or the package dir
// (`npm test --workspace`). CWD-relative paths silently matched nothing — or
// crashed on the literal file path — when the package runner set CWD to the package.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function tsFiles(dir: string): string[] {
  const abs = resolve(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(abs, entry.name));
}

// Each migrated surface is a committed file that must always be present and swept.
// Asserting per-target presence (not just a non-empty aggregate) means a surface
// that gets moved/renamed out of the sweep fails loudly here instead of silently
// rotting the guard while the other targets keep the file count above zero.
const DIR_TARGETS = [
  "packages/async-subagents/extensions/pi",
  "packages/bravo-goals/extensions/pi",
];
const FILE_TARGETS = [".pi/extensions/codex-usage.ts"];

test("migrated pi extension surfaces do not own setInterval timers", () => {
  const files: string[] = [];

  for (const dir of DIR_TARGETS) {
    const found = tsFiles(dir);
    assert.ok(found.length > 0, `expected migrated pi extension sources under ${dir} (none found from repo root ${repoRoot})`);
    files.push(...found);
  }

  for (const path of FILE_TARGETS) {
    const abs = resolve(repoRoot, path);
    assert.ok(existsSync(abs), `expected migrated surface ${path} to exist and be swept (from repo root ${repoRoot})`);
    files.push(abs);
  }

  const offenders = files.filter((file) => readFileSync(file, "utf8").includes("setInterval("));
  assert.deepEqual(offenders, [], "remaining setInterval ownership must live in @bravo/render-clock, not migrated pi extension surfaces");
});

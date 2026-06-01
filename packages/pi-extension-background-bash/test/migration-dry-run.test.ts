import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackups } from "../src/migration/backups.js";
import { createMigrationPlan } from "../src/migration/planner.js";
import { rollback } from "../src/migration/rollback.js";
import { scanAsyncSubagents } from "../src/migration/scanner.js";
import { applyChanges } from "../src/migration/transforms.js";

test("migration dry-run plans prompt and JSON tool-list updates without writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-migrate-"));
  try {
    const profile = path.join(root, "alpha");
    await mkdir(profile, { recursive: true });
    const promptPath = path.join(profile, "prompt.md");
    const configPath = path.join(profile, "config.json");
    await writeFile(promptPath, "Use bash for long server commands; avoid shell & when possible.\n", "utf8");
    await writeFile(configPath, JSON.stringify({ tools: ["read", "bash"], extensions: [] }), "utf8");

    const files = await scanAsyncSubagents({ root });
    const plan = createMigrationPlan(root, files, true);
    assert.equal(plan.files.filter(f => f.changes.length > 0).length, 2);
    assert.equal(await readFile(promptPath, "utf8"), "Use bash for long server commands; avoid shell & when possible.\n");

    const configPlan = plan.files.find(f => f.file.path === configPath)!;
    const updated = applyChanges(configPlan.file.content, configPlan.changes);
    assert.match(updated, /background_task_status/);
    assert.match(updated, /@bravo\/pi-extension-background-bash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration canary selection and run-artifact warnings gate writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-canary-"));
  try {
    await mkdir(path.join(root, "alpha"), { recursive: true });
    await mkdir(path.join(root, "beta"), { recursive: true });
    await mkdir(path.join(root, "beta", "runs", "run1"), { recursive: true });
    await writeFile(path.join(root, "alpha", "prompt.md"), "Use tmux for background bash servers.\n", "utf8");
    await writeFile(path.join(root, "beta", "prompt.md"), "Use tmux for background bash servers.\n", "utf8");
    await writeFile(path.join(root, "beta", "runs", "run1", "state.json"), JSON.stringify({ status: "running", pid: 12345, note: "bash" }), "utf8");

    const canaryFiles = await scanAsyncSubagents({ root, canary: 1 });
    assert.deepEqual([...new Set(canaryFiles.map(f => f.profile))], ["alpha"]);

    const allFiles = await scanAsyncSubagents({ root });
    const plan = createMigrationPlan(root, allFiles, false);
    assert.ok(plan.files.some(f => f.file.activeRunWarning?.includes("active")));
    assert.ok(plan.files.some(f => f.skippedReason?.includes("Generated/cache/run artifacts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration does not append background task tools to JSON excludeTools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-exclude-"));
  try {
    const profile = path.join(root, "alpha");
    await mkdir(profile, { recursive: true });
    const configPath = path.join(profile, "config.json");
    await writeFile(configPath, JSON.stringify({ excludeTools: ["bash"], extensions: [] }), "utf8");

    const files = await scanAsyncSubagents({ root });
    const plan = createMigrationPlan(root, files, true);
    const configPlan = plan.files.find(f => f.file.path === configPath)!;
    const updated = applyChanges(configPlan.file.content, configPlan.changes);
    const parsed = JSON.parse(updated);
    assert.deepEqual(parsed.excludeTools, ["bash"]);
    assert.equal(configPlan.changes.some(c => c.id === "warn-json-deny-bash"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration backups can be rolled back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-rollback-"));
  try {
    const profile = path.join(root, "alpha");
    await mkdir(profile, { recursive: true });
    const promptPath = path.join(profile, "prompt.md");
    await writeFile(promptPath, "Use bash for background monitors.\n", "utf8");
    const files = await scanAsyncSubagents({ root });
    const plan = createMigrationPlan(root, files, false);
    const manifest = await createBackups(plan);
    const fp = plan.files[0]!;
    await writeFile(fp.file.path, applyChanges(fp.file.content, fp.changes), "utf8");
    assert.notEqual(await readFile(promptPath, "utf8"), "Use bash for background monitors.\n");
    await rollback(manifest);
    assert.equal(await readFile(promptPath, "utf8"), "Use bash for background monitors.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

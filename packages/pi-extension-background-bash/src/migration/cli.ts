#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createBackups } from "./backups.js";
import { createMigrationPlan, renderPlan } from "./planner.js";
import { readManifest, rollback } from "./rollback.js";
import { defaultAsyncSubagentsRoot, scanAsyncSubagents } from "./scanner.js";
import { applyChanges } from "./transforms.js";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function has(name: string): boolean { return process.argv.includes(name); }
function printHelp(): void {
  console.log(`pi-background-bash migrate [--root <dir>] [--profiles a,b] [--canary <n>] [--apply --yes]
pi-background-bash dry-run [--root <dir>] [--profiles a,b] [--canary <n>]
pi-background-bash rollback --manifest <path>

Dry-run is the default. Writes require migrate --apply --yes and are refused when run artifacts are in scope.`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "migrate";
  if (cmd === "--help" || cmd === "help" || has("--help")) { printHelp(); return; }
  if (cmd === "rollback") {
    const manifestPath = arg("--manifest");
    if (!manifestPath) throw new Error("rollback requires --manifest <path>");
    const restored = await rollback(await readManifest(manifestPath));
    console.log(`Restored ${restored.length} files.`);
    return;
  }
  if (cmd !== "migrate" && cmd !== "dry-run") throw new Error(`Unknown command: ${cmd}`);
  const root = arg("--root") ?? defaultAsyncSubagentsRoot();
  const dryRun = cmd === "dry-run" || !has("--apply");
  const profiles = arg("--profiles")?.split(",").map(s => s.trim()).filter(Boolean);
  const canary = arg("--canary") ? Number(arg("--canary")) : undefined;
  const files = await scanAsyncSubagents({ root, profiles, canary });
  const plan = createMigrationPlan(root, files, dryRun);
  console.log(renderPlan(plan));
  const activeWarnings = plan.files.filter(f => f.file.activeRunWarning);
  if (activeWarnings.length) console.log(`\nActive-run warnings: ${activeWarnings.length}. These files are skipped; narrow with --profiles/--canary after stopping agents before applying.`);
  if (dryRun) {
    console.log("\nDry-run only. Re-run with migrate --apply to write changes.");
    return;
  }
  if (!has("--yes")) throw new Error("Refusing to write without --yes. Review dry-run output first.");
  if (activeWarnings.length || plan.files.some(f => f.skippedReason?.includes("run"))) throw new Error("Active/run artifact warnings present; refusing writes. Use --profiles/--canary after stopping active agents.");
  const manifest = await createBackups(plan);
  let written = 0;
  for (const fp of plan.files) {
    if (fp.skippedReason) continue;
    const changed = fp.changes.filter(c => c.oldText !== c.newText);
    if (!changed.length) continue;
    await fs.writeFile(fp.file.path, applyChanges(fp.file.content, changed), "utf8");
    written++;
  }
  console.log(`Wrote ${written} files. Backup manifest entries: ${manifest.entries.length}`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });

import type { MigrationPlan, ScannedFile } from "./types.js";
import { proposeTransforms } from "./transforms.js";

export function createMigrationPlan(root: string, files: ScannedFile[], dryRun = true): MigrationPlan {
  return {
    root,
    dryRun,
    createdAt: new Date().toISOString(),
    files: files.map(file => ({
      file,
      changes: proposeTransforms(file),
      skippedReason: file.kind === "run-artifact" || file.kind === "cache" ? "Generated/cache/run artifacts are not edited by default." : file.activeRunWarning,
    })).filter(plan => plan.changes.length > 0 || plan.skippedReason),
  };
}

export function renderPlan(plan: MigrationPlan): string {
  const lines = [`Background bash migration plan (${plan.dryRun ? "dry-run" : "apply"})`, `Root: ${plan.root}`, `Files: ${plan.files.length}`, ""];
  for (const file of plan.files) {
    lines.push(`${file.file.path} [${file.file.kind}]${file.skippedReason ? ` SKIP: ${file.skippedReason}` : ""}`);
    for (const change of file.changes) lines.push(`  - ${change.id} (${change.risk}): ${change.description}`);
  }
  return lines.join("\n");
}

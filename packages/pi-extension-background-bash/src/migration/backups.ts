import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupManifest, MigrationPlan } from "./types.js";

export async function createBackups(plan: MigrationPlan): Promise<BackupManifest> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(plan.root, ".background-bash-migration", stamp);
  await fs.mkdir(backupRoot, { recursive: true });
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), root: plan.root, entries: [] };
  for (const fp of plan.files) {
    const transforms = fp.changes.filter(c => c.oldText !== c.newText).map(c => c.id);
    if (!transforms.length || fp.skippedReason) continue;
    const rel = path.relative(plan.root, fp.file.path);
    const backupPath = path.join(backupRoot, rel);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(fp.file.path, backupPath);
    manifest.entries.push({ originalPath: fp.file.path, backupPath, transformIds: transforms });
  }
  await fs.writeFile(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

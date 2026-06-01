import { promises as fs } from "node:fs";
import type { BackupManifest } from "./types.js";

export async function readManifest(path: string): Promise<BackupManifest> {
  return JSON.parse(await fs.readFile(path, "utf8")) as BackupManifest;
}

export async function rollback(manifest: BackupManifest): Promise<string[]> {
  const restored: string[] = [];
  for (const entry of manifest.entries) {
    await fs.copyFile(entry.backupPath, entry.originalPath);
    restored.push(entry.originalPath);
  }
  return restored;
}

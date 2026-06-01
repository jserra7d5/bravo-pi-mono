import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextMapArtifact } from "./types.js";

export const STATE_DIR = join(".pi", "state", "context-maps");

export function mapPath(cwd: string, mapId: string): string {
  if (!/^ctx_[A-Za-z0-9_.-]+$/.test(mapId)) throw new Error("Invalid context map id.");
  return join(cwd, STATE_DIR, `${mapId}.json`);
}

export async function saveMap(cwd: string, artifact: ContextMapArtifact): Promise<void> {
  const dir = join(cwd, STATE_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(mapPath(cwd, artifact.map_id), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
}

export async function loadMap(cwd: string, mapId: string): Promise<ContextMapArtifact> {
  const raw = await readFile(mapPath(cwd, mapId), "utf8");
  const parsed = JSON.parse(raw) as ContextMapArtifact;
  if (parsed.schema_version !== 1 || parsed.map_id !== mapId || !Array.isArray(parsed.slices)) throw new Error("Invalid context map artifact.");
  return parsed;
}

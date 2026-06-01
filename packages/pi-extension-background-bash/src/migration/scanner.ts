import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProfileSelection, ScannedFile } from "./types.js";

const TEXT_EXT = new Set([".json", ".jsonc", ".yaml", ".yml", ".md", ".txt", ".toml", ".ini", ".sh", ".env"]);
const MAX_FILE_BYTES = 512 * 1024;

export function defaultAsyncSubagentsRoot(): string {
  return path.join(os.homedir(), ".async-subagents");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name === ".background-bash-migration" || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function classify(file: string): ScannedFile["kind"] {
  const parts = file.split(path.sep);
  if (parts.includes("runs")) return "run-artifact";
  if (parts.includes("cache") || parts.includes(".cache")) return "cache";
  const base = path.basename(file).toLowerCase();
  if (base.includes("prompt") || base.endsWith(".md")) return "prompt";
  if (base.endsWith(".sh")) return "script";
  if ([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini"].includes(path.extname(base))) return "config";
  return "unknown";
}

function profileName(root: string, file: string): string {
  const rel = path.relative(root, file);
  return rel.split(path.sep)[0] || ".";
}

function activeRunWarning(file: string, content: string, kind: ScannedFile["kind"]): string | undefined {
  if (kind !== "run-artifact") return undefined;
  const lower = content.toLowerCase();
  if (/["']?(status|state)["']?\s*[:=]\s*["']?(running|starting|active)\b/.test(lower)) return "File is under runs/ and appears to describe an active agent run.";
  if (/["']?(pid|processId)["']?\s*[:=]\s*\d+/.test(content)) return "File is under runs/ and contains process metadata; verify the agent is stopped before migration.";
  return "File is under runs/ and may belong to an active or historical agent run.";
}

export async function scanAsyncSubagents(selection: Partial<ProfileSelection> = {}): Promise<ScannedFile[]> {
  const root = selection.root ?? defaultAsyncSubagentsRoot();
  const all = await walk(root);
  const selected = new Set(selection.profiles ?? []);
  const files: ScannedFile[] = [];
  for (const file of all) {
    const profile = profileName(root, file);
    if (selected.size && !selected.has(profile)) continue;
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXT.has(ext) && !["Dockerfile", "Makefile"].includes(path.basename(file))) continue;
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) continue;
    const kind = classify(file);
    let content: string;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }
    files.push({ path: file, profile, kind, content, activeRunWarning: activeRunWarning(file, content, kind) });
  }
  const canary = selection.canary;
  if (canary && canary > 0) {
    const profiles = [...new Set(files.map(f => f.profile))].sort().slice(0, canary);
    return files.filter(f => profiles.includes(f.profile));
  }
  return files;
}

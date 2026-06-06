import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { Diagnostic, DynamicSkill } from "./types.js";

export function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("..\\") && !rel.startsWith("../") && !resolve(rel).startsWith("..");
}
export function isContainedOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("..\\") && !rel.startsWith("../") && !resolve(rel).startsWith(".."));
}
function contained(parent: string, child: string, equal = false) {
  return equal ? isContainedOrEqual(parent, child) : isContained(parent, child);
}
function diag(type: Diagnostic["type"], message: string, location?: string, name?: string): Diagnostic { return { type, message, location, name, at: new Date().toISOString() }; }

export async function discoverDynamicSkillCandidates(cwd: string, inputPath: string): Promise<{ candidates: DynamicSkill[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const candidates: DynamicSkill[] = [];
  let realCwd: string, target: string;
  try { realCwd = await realpath(cwd); target = await realpath(resolve(cwd, inputPath)); } catch { return { candidates, diagnostics }; }
  if (!contained(realCwd, target)) return { candidates, diagnostics };
  let st; try { st = await stat(target); } catch { return { candidates, diagnostics }; }
  let dir = st.isFile() ? dirname(target) : st.isDirectory() ? target : undefined;
  if (!dir) return { candidates, diagnostics };
  const dirs: string[] = [];
  while (isContainedOrEqual(realCwd, dir)) { dirs.push(dir); if (dir === realCwd) break; dir = dirname(dir); }
  const discoveredFrom = target;
  for (const d of dirs) {
    const agentsReal = await safePlainDir(join(d, ".agents"), realCwd, diagnostics, ".agents directory");
    if (!agentsReal) continue;
    const root = join(agentsReal, "skills");
    const rootReal = await safePlainDir(root, realCwd, diagnostics, ".agents/skills root");
    if (!rootReal) continue;
    let children: string[] = [];
    try { children = await readdir(rootReal); } catch { continue; }
    for (const child of children.sort()) {
      const skillDir = join(rootReal, child);
      const safeDir = await safePlainDir(skillDir, realCwd, diagnostics, "skill directory");
      if (!safeDir) continue;
      const skillFile = join(safeDir, "SKILL.md");
      const safeFile = await safePlainFile(skillFile, realCwd, diagnostics, "SKILL.md");
      if (!safeFile) continue;
      const loaded = loadSkillsFromDir({ dir: safeDir, source: "dynamic-subtree-read" });
      for (const rd of loaded.diagnostics ?? []) diagnostics.push(diag("invalid-skill", String((rd as { message?: unknown }).message ?? "Invalid skill."), safeFile));
      for (const s of loaded.skills) {
        const loc = await realpath(s.filePath).catch(() => s.filePath);
        if (s.disableModelInvocation || !s.name || !s.description || !contained(realCwd, loc, true)) continue;
        candidates.push({ name: s.name, description: s.description, location: loc, baseDir: dirname(loc), discoveredFrom, discoveredAt: new Date().toISOString() });
      }
    }
  }
  return { candidates, diagnostics };
}

async function safePlainDir(p: string, cwd: string, diagnostics: Diagnostic[], label: string): Promise<string | undefined> {
  try {
    const ls = await lstat(p); if (!ls.isDirectory() || ls.isSymbolicLink()) { diagnostics.push(diag("security-boundary", `Rejected non-plain ${label}.`, p)); return; }
    const rp = await realpath(p); if (!contained(cwd, rp, true)) { diagnostics.push(diag("security-boundary", `Rejected ${label} outside cwd.`, p)); return; }
    return rp;
  } catch { return; }
}
async function safePlainFile(p: string, cwd: string, diagnostics: Diagnostic[], label: string): Promise<string | undefined> {
  try {
    const ls = await lstat(p); if (!ls.isFile() || ls.isSymbolicLink()) { diagnostics.push(diag("security-boundary", `Rejected non-plain ${label}.`, p)); return; }
    const rp = await realpath(p); if (!contained(cwd, rp, true)) { diagnostics.push(diag("security-boundary", `Rejected ${label} outside cwd.`, p)); return; }
    return rp;
  } catch { return; }
}

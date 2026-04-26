import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { packageSkillsDir, userSkillsDir } from "./paths.js";

export function resolveSkillFile(skill: string, cwd: string): string {
  const searched: string[] = [];
  for (const candidate of skillFileCandidates(skill, cwd)) {
    const resolved = resolve(candidate);
    searched.push(resolved);
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  }
  throw new Error(`Skill not found: ${skill}. Searched: ${searched.join(", ")}`);
}

export function resolveSkillDir(skill: string, cwd: string): string {
  const searched: string[] = [];
  for (const candidate of skillDirCandidates(skill, cwd)) {
    const resolved = resolve(candidate);
    searched.push(resolved);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) return resolved;
  }
  const file = resolveSkillFileOrUndefined(skill, cwd);
  if (file) throw new Error(`Claude skill must be a directory: ${skill}`);
  throw new Error(`Skill directory not found: ${skill}. Searched: ${searched.join(", ")}`);
}

function resolveSkillFileOrUndefined(skill: string, cwd: string): string | undefined {
  try { return resolveSkillFile(skill, cwd); } catch { return undefined; }
}

function skillFileCandidates(skill: string, cwd: string): string[] {
  const out = [skill];
  for (const dir of skillDirCandidates(skill, cwd)) out.push(join(dir, "SKILL.md"));
  out.push(join(userSkillsDir(), `${skill}.md`));
  out.push(join(packageSkillsDir(), `${skill}.md`));
  out.push(...piUserSkillFileCandidates(skill, cwd));
  out.push(...piPackageSkillFileCandidates(skill, cwd));
  return out;
}

function skillDirCandidates(skill: string, cwd: string): string[] {
  return [
    skill,
    join(userSkillsDir(), skill, "claude"),
    join(userSkillsDir(), skill),
    join(packageSkillsDir(), skill, "claude"),
    join(packageSkillsDir(), skill),
    ...piUserSkillDirCandidates(skill, cwd),
    ...piPackageSkillDirCandidates(skill, cwd),
  ];
}

function piUserSkillDirCandidates(skill: string, cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  const out = [join(piAgentDir, "skills", skill)];
  for (const dir of ancestorDirs(cwd)) {
    out.push(join(dir, ".pi", "skills", skill));
    out.push(join(dir, ".agents", "skills", skill));
  }
  return out;
}

function piUserSkillFileCandidates(skill: string, cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  const out = [join(piAgentDir, "skills", `${skill}.md`)];
  for (const dir of ancestorDirs(cwd)) out.push(join(dir, ".pi", "skills", `${skill}.md`));
  return out;
}

function piPackageSkillDirCandidates(skill: string, cwd: string): string[] {
  return piPackageSkillCandidates(skill, cwd).filter((p) => !p.endsWith(".md"));
}

function piPackageSkillFileCandidates(skill: string, cwd: string): string[] {
  return piPackageSkillCandidates(skill, cwd).filter((p) => p.endsWith(".md"));
}

function piPackageSkillCandidates(skill: string, cwd: string): string[] {
  const out: string[] = [];
  for (const settingsPath of piSettingsPaths(cwd)) {
    const settings = readJson(settingsPath);
    const packages = Array.isArray(settings?.packages) ? settings.packages : [];
    for (const entry of packages) {
      const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : undefined;
      if (!source) continue;
      const packageRoot = resolvePackageSource(source, dirname(settingsPath));
      if (!packageRoot || !existsSync(packageRoot)) continue;
      out.push(...packageSkillCandidates(packageRoot, skill));
    }
  }
  return out;
}

function piSettingsPaths(cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  const paths = [join(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "settings.json")];
  for (const dir of ancestorDirs(cwd)) paths.push(join(dir, ".pi", "settings.json"));
  return [...new Set(paths)].filter((p) => existsSync(p));
}

function resolvePackageSource(source: string, settingsDir: string): string | undefined {
  if (/^(npm|git):/.test(source) || /^[a-z]+:\/\//i.test(source)) return undefined;
  return isAbsolute(source) ? resolve(source) : resolve(settingsDir, source);
}

function packageSkillCandidates(root: string, skill: string): string[] {
  const pkg = readJson(join(root, "package.json"));
  const manifestSkills = Array.isArray(pkg?.pi?.skills) ? pkg.pi.skills : undefined;
  const entries = manifestSkills ?? ["skills"];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.startsWith("!")) continue;
    for (const base of expandSkillEntry(root, entry)) {
      if (base.endsWith(".md")) out.push(base);
      else {
        out.push(join(base, skill));
        out.push(join(base, `${skill}.md`));
      }
    }
  }
  return out;
}

function expandSkillEntry(root: string, entry: string): string[] {
  const normalized = entry.replace(/^\.\//, "");
  if (!normalized.includes("*")) return [resolve(root, normalized)];
  const starIndex = normalized.indexOf("*");
  const prefix = normalized.slice(0, starIndex);
  const suffix = normalized.slice(starIndex + 1).replace(/^\//, "");
  const dir = resolve(root, prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).map((name) => join(dir, name)).filter((path) => !suffix || path.endsWith(suffix));
  } catch { return []; }
}

function ancestorDirs(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  while (true) {
    out.push(dir);
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function readJson(path: string): any {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return undefined; }
}

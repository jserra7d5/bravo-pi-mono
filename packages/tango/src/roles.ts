import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OrchestrationPolicy, RoleConfig, ThinkingLevel } from "./types.js";
import { packageIncludesDir, packageRolesDir, userIncludesDir, userRolesDir } from "./paths.js";

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  }
  return trimmed.replace(/^['\"]|['\"]$/g, "");
}

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) return { data: {}, body: content.trim() };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: content.trim() };
  const raw = content.slice(4, end).trimEnd();
  const body = content.slice(content.indexOf("\n", end + 1) + 1).trim();
  const data: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2] ?? "";
    if (rest.trim() === "") {
      const arr: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i++;
        arr.push(lines[i].replace(/^\s+-\s+/, "").trim().replace(/^['\"]|['\"]$/g, ""));
      }
      data[key] = arr;
    } else {
      data[key] = parseScalar(rest);
    }
  }
  return { data, body };
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asOrchestrationPolicy(value: unknown): OrchestrationPolicy | undefined {
  if (value === "none" || value === "cli" || value === "tools" || value === "auto") return value;
  return undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  throw new Error(`Invalid thinking level: ${String(value)}. Expected off, minimal, low, medium, high, or xhigh.`);
}

function roleFromFile(filePath: string): RoleConfig {
  const content = readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(content);
  const name = String(data.name ?? filePath.split("/").pop()?.replace(/\.md$/, "") ?? "role");
  return {
    name,
    description: data.description === undefined ? undefined : String(data.description),
    harness: data.harness === undefined ? undefined : String(data.harness),
    mode: data.mode === "interactive" ? "interactive" : data.mode === "oneshot" ? "oneshot" : undefined,
    model: data.model === undefined ? undefined : String(data.model),
    thinking: asThinkingLevel(data.thinking),
    tools: asStringArray(data.tools),
    contextFiles: typeof data.contextFiles === "boolean" ? data.contextFiles : undefined,
    skills: asStringArray(data.skills),
    extensions: asStringArray(data.extensions),
    includes: asStringArray(data.includes),
    recursive: typeof data.recursive === "boolean" ? data.recursive : undefined,
    orchestration: asOrchestrationPolicy(data.orchestration),
    allowedChildRoles: asStringArray(data.allowedChildRoles),
    body,
    filePath,
  };
}

export function findRoleFile(name: string): string | undefined {
  const candidates = [
    join(userRolesDir(), `${name}.md`),
    join(packageRolesDir(), `${name}.md`),
    resolve(name),
  ];
  return candidates.find((p) => existsSync(p));
}

export function loadRole(name: string): RoleConfig {
  const file = findRoleFile(name);
  if (!file) throw new Error(`Role not found: ${name}`);
  return roleFromFile(file);
}

export function listRoles(): RoleConfig[] {
  const found = new Map<string, RoleConfig>();
  for (const dir of [packageRolesDir(), userRolesDir()]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const role = roleFromFile(join(dir, entry));
      found.set(role.name, role);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findIncludeFile(name: string): string | undefined {
  const file = name.endsWith(".md") ? name : `${name}.md`;
  const candidates = [join(userIncludesDir(), file), join(packageIncludesDir(), file), resolve(name)];
  return candidates.find((p) => existsSync(p));
}

export function loadInclude(name: string): string {
  const file = findIncludeFile(name);
  if (!file) throw new Error(`Include not found: ${name}`);
  return readFileSync(file, "utf8").trim();
}

export function resolveOrchestrationPolicy(role: RoleConfig): OrchestrationPolicy {
  return role.orchestration ?? (role.recursive ? "auto" : "none");
}

export function wantsToolOrchestration(role: RoleConfig | undefined): boolean {
  if (!role) return false;
  const policy = resolveOrchestrationPolicy(role);
  return policy === "tools" || (policy === "auto" && role.harness === "pi");
}

export function orchestrationIncludes(role: RoleConfig): string[] {
  const policy = resolveOrchestrationPolicy(role);
  if (policy === "none") return [];
  if (policy === "cli") return ["orchestration-core", "orchestration-cli"];
  if (policy === "tools") return ["orchestration-core", "orchestration-pi-tools", "orchestration-cli"];
  if (role.harness === "pi") return ["orchestration-core", "orchestration-pi-tools", "orchestration-cli"];
  return ["orchestration-core", "orchestration-cli"];
}

export function assembleSystemPrompt(role: RoleConfig): string {
  const includeNames = [...orchestrationIncludes(role), ...(role.includes ?? [])];
  if (role.recursive && !includeNames.includes("status-protocol")) includeNames.push("status-protocol");
  const uniqueIncludeNames = [...new Set(includeNames)];
  const parts = uniqueIncludeNames.map(loadInclude);
  parts.push(role.body.trim());
  return parts.filter(Boolean).join("\n\n---\n\n");
}

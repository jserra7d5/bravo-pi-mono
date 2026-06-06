import type { DynamicSkill } from "./types.js";

export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_RENDERED_SKILLS = 30;
export const BEGIN_MARKER = "<!-- dynamic-skill-discovery:begin -->";
export const END_MARKER = "<!-- dynamic-skill-discovery:end -->";

export function xmlEscape(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

export function boundDescription(description: string): string {
  return description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…` : description;
}

export function renderCatalog(skills: DynamicSkill[]): string {
  const rendered = skills.slice(0, MAX_RENDERED_SKILLS);
  const lines = [`<available_skills source="dynamic-subtree-read">`];
  for (const skill of rendered) {
    lines.push("  <skill>", `    <name>${xmlEscape(skill.name)}</name>`, `    <description>${xmlEscape(boundDescription(skill.description))}</description>`, `    <location>${xmlEscape(skill.location)}</location>`, "  </skill>");
  }
  if (skills.length > rendered.length) lines.push(`  <!-- ${skills.length - rendered.length} additional skills omitted -->`);
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function renderDiscoveryPreview(skills: DynamicSkill[]): string {
  return `Discovered ${skills.length} additional repo skills for this subtree. Use read on a skill location when its description matches the task.\n\n${renderCatalog(skills)}`;
}

export function appendDynamicSkillPrompt(systemPrompt: string, skills: DynamicSkill[]): string {
  const section = `${BEGIN_MARKER}\n## Dynamically discovered repo skills\n\nThese skills were discovered after reading files below the session cwd. Use \`read\` to load a skill file when the task matches its description.\n\n${renderCatalog(skills)}\n${END_MARKER}`;
  const start = systemPrompt.indexOf(BEGIN_MARKER);
  const end = systemPrompt.indexOf(END_MARKER);
  if (start >= 0 && end >= start) return `${systemPrompt.slice(0, start).trimEnd()}\n\n${section}${systemPrompt.slice(end + END_MARKER.length)}`;
  return `${systemPrompt.trimEnd()}\n\n${section}`;
}

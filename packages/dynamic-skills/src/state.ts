import { resolve } from "node:path";
import type { Diagnostic, DynamicSkill, DynamicSkillSnapshot, NativeSkill } from "./types.js";

export const ENTRY_TYPE = "dynamic-skill-discovery";
export const MAX_DIAGNOSTICS = 100;

function now() { return new Date().toISOString(); }
function skillPath(skill: NativeSkill): string | undefined {
  const p = skill.filePath ?? skill.location ?? skill.path;
  return typeof p === "string" ? resolve(p) : undefined;
}

export class DynamicSkillState {
  private byLocation = new Map<string, DynamicSkill>();
  private byName = new Map<string, DynamicSkill>();
  private pendingByLocation = new Map<string, DynamicSkill>();
  diagnostics: Diagnostic[] = [];

  clear() { this.byLocation.clear(); this.byName.clear(); this.pendingByLocation.clear(); this.diagnostics = []; }
  skills(): DynamicSkill[] { return [...this.byLocation.values()]; }
  pending(): DynamicSkill[] { return [...this.pendingByLocation.values()]; }
  storePending(candidates: DynamicSkill[]) {
    for (const c of candidates) {
      const stored = { ...c, location: resolve(c.location), baseDir: resolve(c.baseDir) };
      if (!this.byLocation.has(stored.location)) this.pendingByLocation.set(stored.location, stored);
    }
  }
  addDiagnostic(d: Omit<Diagnostic, "at">) { this.diagnostics.push({ ...d, at: now() }); if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS); }

  acceptCandidates(candidates: DynamicSkill[], nativeSkills?: NativeSkill[]): DynamicSkill[] {
    const accepted: DynamicSkill[] = [];
    const nativeByPath = new Set<string>();
    const nativeByName = new Map<string, string>();
    for (const n of nativeSkills ?? []) {
      const name = typeof n.name === "string" ? n.name : undefined;
      const p = skillPath(n);
      if (p) nativeByPath.add(p);
      if (name && p) nativeByName.set(name, p);
    }
    for (const c of candidates) {
      const loc = resolve(c.location);
      const nativeSameName = nativeByName.get(c.name);
      if (nativeByPath.has(loc)) { this.addDiagnostic({ type: "native-path-duplicate", name: c.name, location: loc, message: "Dynamic skill path is already loaded natively." }); continue; }
      if (nativeSameName && nativeSameName !== loc) { this.addDiagnostic({ type: "native-name-collision", name: c.name, location: loc, message: "Dynamic skill name collides with a native skill." }); continue; }
      const existing = this.byLocation.get(loc);
      if (existing) continue;
      const sameName = this.byName.get(c.name);
      if (sameName && sameName.location !== loc) { this.addDiagnostic({ type: "dynamic-name-collision", name: c.name, location: loc, message: "Dynamic skill name collides with an already discovered skill." }); continue; }
      const stored = { ...c, location: loc, baseDir: resolve(c.baseDir) };
      this.byLocation.set(loc, stored); this.byName.set(stored.name, stored); this.pendingByLocation.delete(loc); accepted.push(stored);
    }
    return accepted;
  }

  acceptPending(nativeSkills?: NativeSkill[]): DynamicSkill[] {
    const accepted: DynamicSkill[] = [];
    for (const candidate of this.pending()) {
      const loc = resolve(candidate.location);
      const beforeDiagnostics = this.diagnostics.length;
      const newlyAccepted = this.acceptCandidates([candidate], nativeSkills);
      accepted.push(...newlyAccepted);
      if (newlyAccepted.length || this.diagnostics.length !== beforeDiagnostics || this.byLocation.has(loc)) this.pendingByLocation.delete(loc);
    }
    return accepted;
  }

  eligibleAgainstNative(nativeSkills?: NativeSkill[]): DynamicSkill[] {
    const nativeByPath = new Set<string>();
    const nativeByName = new Map<string, string>();
    for (const n of nativeSkills ?? []) {
      const name = typeof n.name === "string" ? n.name : undefined;
      const p = skillPath(n);
      if (p) nativeByPath.add(p);
      if (name && p) nativeByName.set(name, p);
    }
    return this.skills().filter((s) => {
      const loc = resolve(s.location);
      const nativeSameName = nativeByName.get(s.name);
      return !nativeByPath.has(loc) && !(nativeSameName && nativeSameName !== loc);
    });
  }

  snapshot(): DynamicSkillSnapshot { return { version: 1, skills: this.skills(), diagnostics: this.diagnostics, pending: this.pending() }; }
  private validSkill(value: unknown): DynamicSkill | undefined {
    const s = value as Partial<DynamicSkill> | undefined;
    if (!s || typeof s.name !== "string" || typeof s.description !== "string" || typeof s.location !== "string" || typeof s.baseDir !== "string" || typeof s.discoveredFrom !== "string" || typeof s.discoveredAt !== "string") {
      this.addDiagnostic({ type: "invalid-skill", message: "Ignored invalid dynamic skill snapshot entry." });
      return undefined;
    }
    return s as DynamicSkill;
  }
  load(snapshot: unknown) {
    this.clear();
    if (!snapshot || (snapshot as { version?: unknown }).version !== 1) { this.addDiagnostic({ type: "invalid-skill", message: "Ignored unknown dynamic skill snapshot version." }); return; }
    const s = snapshot as DynamicSkillSnapshot;
    this.diagnostics = Array.isArray(s.diagnostics) ? s.diagnostics.slice(-MAX_DIAGNOSTICS) : [];
    for (const skill of Array.isArray(s.skills) ? s.skills : []) {
      const valid = this.validSkill(skill);
      if (valid) this.acceptCandidates([valid], []);
    }
    if (Array.isArray(s.pending)) this.storePending(s.pending.map((p) => this.validSkill(p)).filter((p): p is DynamicSkill => !!p));
  }
}

export function latestSnapshotFromBranch(branch: unknown): unknown {
  const entries = Array.isArray(branch) ? branch : Array.isArray((branch as { entries?: unknown } | undefined)?.entries) ? (branch as { entries: unknown[] }).entries : Array.isArray((branch as { messages?: unknown } | undefined)?.messages) ? (branch as { messages: unknown[] }).messages : [];
  let latest: unknown;
  for (const e of entries) {
    const r = e as Record<string, unknown>;
    const type = r.type ?? r.entryType ?? r.kind ?? r.name;
    if (type === ENTRY_TYPE) latest = r.value ?? r.data ?? r.payload ?? r.content ?? r;
    if (r.type === "custom" && r.customType === ENTRY_TYPE) latest = r.data;
    const custom = r.custom as Record<string, unknown> | undefined;
    if (custom && (custom.type === ENTRY_TYPE || custom.name === ENTRY_TYPE)) latest = custom.value ?? custom.data ?? custom.payload;
  }
  return latest;
}

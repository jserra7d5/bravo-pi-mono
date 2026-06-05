import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FastTrackReason = "not_requested" | "disabled" | "scout" | "ineligible_model";

export interface FastTrackLaunch {
  requested: boolean;
  enabled: boolean;
  applied: boolean;
  reason?: FastTrackReason;
  serviceTier?: "priority";
}

export interface FastTrackState {
  schemaVersion: 1;
  enabled: boolean;
  updatedAt: string;
}

export function fastTrackStatePath(runRoot: string, rootSessionId: string): string {
  return join(runRoot, "session-fast-track", `${rootSessionId}.json`);
}

export function readFastTrackState(runRoot: string, rootSessionId: string): FastTrackState {
  const path = fastTrackStatePath(runRoot, rootSessionId);
  if (!existsSync(path)) return { schemaVersion: 1, enabled: false, updatedAt: new Date(0).toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FastTrackState>;
    return { schemaVersion: 1, enabled: parsed.enabled === true, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString() };
  } catch {
    return { schemaVersion: 1, enabled: false, updatedAt: new Date(0).toISOString() };
  }
}

export function writeFastTrackState(runRoot: string, rootSessionId: string, enabled: boolean): FastTrackState {
  const state: FastTrackState = { schemaVersion: 1, enabled, updatedAt: new Date().toISOString() };
  const path = fastTrackStatePath(runRoot, rootSessionId);
  mkdirSync(join(runRoot, "session-fast-track"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

const GPT55_CODEX_PROVIDER_ALLOWLIST = new Set([
  "openai-codex",
]);

const ANY_MODEL_CODEX_PROVIDER_ALLOWLIST = new Set([
  "bravo-codex-balanced",
]);

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function isFastTrackEligibleModel(model?: string): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  const slash = normalized.indexOf("/");
  if (slash <= 0) return false;
  const provider = normalizeProvider(normalized.slice(0, slash));
  const suffix = normalized.slice(slash + 1);
  return ANY_MODEL_CODEX_PROVIDER_ALLOWLIST.has(provider) || (suffix === "gpt-5.5" && GPT55_CODEX_PROVIDER_ALLOWLIST.has(provider));
}

export function evaluateFastTrack(input: { requested?: boolean; enabled: boolean; agentName: string; model?: string }): FastTrackLaunch {
  const requested = input.requested === true;
  if (!requested) return { requested: false, enabled: input.enabled, applied: false, reason: "not_requested" };
  if (!input.enabled) return { requested: true, enabled: false, applied: false, reason: "disabled" };
  if (input.agentName === "scout") return { requested: true, enabled: true, applied: false, reason: "scout" };
  if (!isFastTrackEligibleModel(input.model)) return { requested: true, enabled: true, applied: false, reason: "ineligible_model" };
  return { requested: true, enabled: true, applied: true, serviceTier: "priority" };
}

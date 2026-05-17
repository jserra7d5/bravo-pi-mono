import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./jsonl.js";
import { SCHEMA_VERSION } from "./types.js";

export const NAME_PACKS = {
  default: ["Alex", "Blair", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper", "Jordan", "Quinn"],
  clones: ["Rex", "Cody", "Fives", "Echo", "Wolffe", "Gregor", "Jesse", "Kix", "Hardcase", "Tup"],
  ct: ["CT-7567", "CT-2224", "CT-5555", "CT-1409", "CT-6116", "CT-5385", "CC-3636", "CC-2224", "CT-5597", "CT-27-5555"],
} as const;

export type NamePackId = keyof typeof NAME_PACKS;

export interface NamePackConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  activePack: NamePackId;
  updatedAt: string;
}

interface NamePackState {
  schemaVersion: typeof SCHEMA_VERSION;
  counters: Partial<Record<NamePackId, number>>;
  updatedAt: string;
}

export interface NamePackSelection {
  activePack: NamePackId;
  availablePacks: Array<{ id: NamePackId; names: string[] }>;
  configPath: string;
}

function configPath(runRoot: string): string {
  return join(runRoot, "..", "name-config.json");
}

function statePath(runRoot: string): string {
  return join(runRoot, "..", "name-state.json");
}

function lockPath(runRoot: string): string {
  return join(runRoot, "..", "name-state.lock");
}

function isNamePackId(value: unknown): value is NamePackId {
  return typeof value === "string" && Object.hasOwn(NAME_PACKS, value);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

export function readNamePackSelection(runRoot: string): NamePackSelection {
  const path = configPath(runRoot);
  const config = readJson<Partial<NamePackConfig>>(path);
  const activePack = isNamePackId(config?.activePack) ? config.activePack : "default";
  return {
    activePack,
    availablePacks: Object.entries(NAME_PACKS).map(([id, names]) => ({ id: id as NamePackId, names: [...names] })),
    configPath: path,
  };
}

export function writeNamePackSelection(runRoot: string, pack: NamePackId): NamePackSelection {
  const path = configPath(runRoot);
  mkdirSync(join(runRoot, ".."), { recursive: true });
  atomicWriteJson(path, {
    schemaVersion: SCHEMA_VERSION,
    activePack: pack,
    updatedAt: new Date().toISOString(),
  } satisfies NamePackConfig);
  return readNamePackSelection(runRoot);
}

export function assignDisplayName(input: { runRoot: string; requestedName?: string }): { displayName: string; namePack: NamePackId } {
  const selection = readNamePackSelection(input.runRoot);
  const requested = input.requestedName?.trim();
  if (requested) return { displayName: requested, namePack: selection.activePack };

  mkdirSync(join(input.runRoot, ".."), { recursive: true });
  const lock = lockPath(input.runRoot);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try {
      const path = statePath(input.runRoot);
      const state = readJson<Partial<NamePackState>>(path);
      const counters = state?.counters ?? {};
      const names = NAME_PACKS[selection.activePack];
      const index = Math.max(0, Math.trunc(counters[selection.activePack] ?? 0));
      const displayName = names[index % names.length];
      atomicWriteJson(path, {
        schemaVersion: SCHEMA_VERSION,
        counters: { ...counters, [selection.activePack]: index + 1 },
        updatedAt: new Date().toISOString(),
      } satisfies NamePackState);
      return { displayName, namePack: selection.activePack };
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`timed out waiting for subagent name-pack lock: ${lock}`);
}

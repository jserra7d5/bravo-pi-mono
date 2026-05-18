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

export interface NamePackSelection {
  activePack: NamePackId;
  availablePacks: Array<{ id: NamePackId; names: string[] }>;
  configPath: string;
}

function configPath(runRoot: string): string {
  return join(runRoot, "..", "name-config.json");
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

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed) as T];
      } catch {
        return [];
      }
    });
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

function activeDisplayNames(runRoot: string): Set<string> {
  const active = new Set<string>();
  const records = readJsonl<{ runDir?: string }>(join(runRoot, "..", "run-index.jsonl"));
  for (const record of records) {
    if (!record.runDir) continue;
    const status = readJson<{ displayName?: string; state?: string }>(join(record.runDir, "status.json"));
    if (!status?.displayName) continue;
    if (status.state === "completed" || status.state === "failed" || status.state === "cancelled" || status.state === "expired") continue;
    active.add(status.displayName);
  }
  return active;
}

export function assignDisplayName(input: { runRoot: string; random?: () => number }): { displayName: string; namePack: NamePackId } {
  const selection = readNamePackSelection(input.runRoot);

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
      const names = NAME_PACKS[selection.activePack];
      const active = activeDisplayNames(input.runRoot);
      const available = names.filter((name) => !active.has(name));
      const pool = available.length ? available : names;
      const random = input.random ?? Math.random;
      const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
      return { displayName: pool[index], namePack: selection.activePack };
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`timed out waiting for subagent name-pack lock: ${lock}`);
}

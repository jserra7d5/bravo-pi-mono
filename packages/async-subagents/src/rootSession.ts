import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionRoot } from "./config.js";
import { newRootSessionId } from "./ids.js";
import { atomicWriteJson } from "./jsonl.js";
import { nowIso } from "./time.js";
import type { RootSessionIdentity } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface RootSessionOptions {
  cwd: string;
  rootSessionId?: string;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function rootSessionPath(options: RootSessionOptions, rootSessionId: string): string {
  return join(options.sessionsDir ?? sessionRoot(options.cwd, undefined, options.env ?? process.env), `${rootSessionId}.json`);
}

export function createRootSession(options: RootSessionOptions): RootSessionIdentity {
  const cwd = resolve(options.cwd);
  const rootSessionId = options.rootSessionId ?? newRootSessionId();
  const path = rootSessionPath(options, rootSessionId);
  const now = nowIso();
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RootSessionIdentity) : undefined;
  const identity: RootSessionIdentity = existing
    ? { ...existing, updatedAt: now }
    : {
        schemaVersion: SCHEMA_VERSION,
        rootSessionId,
        parentRunId: rootSessionId,
        cwd,
        createdAt: now,
        updatedAt: now,
      };
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteJson(path, identity);
  return identity;
}

export function readRootSession(options: RootSessionOptions): RootSessionIdentity | undefined {
  if (options.rootSessionId) {
    const path = rootSessionPath(options, options.rootSessionId);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RootSessionIdentity) : undefined;
  }
  const dir = options.sessionsDir ?? sessionRoot(options.cwd, undefined, options.env ?? process.env);
  if (!existsSync(dir)) return undefined;
  const sessions = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as RootSessionIdentity)
    .filter((session) => resolve(session.cwd) === resolve(options.cwd))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return sessions.at(-1);
}

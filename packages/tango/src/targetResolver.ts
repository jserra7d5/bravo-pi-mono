import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listMetadata, metadataPath, readMetadata } from "./metadata.js";
import type { AgentMetadata } from "./types.js";

export interface ResolveTargetOptions {
  name?: string;
  runId?: string;
  runDir?: string;
  cwd?: string;
  env?: {
    TANGO_RUN_ID?: string;
    TANGO_RUN_DIR?: string;
    TANGO_ROOT_SESSION_ID?: string;
    TANGO_WORKSTREAM_ID?: string;
  };
}

function normalizePath(p?: string): string | undefined {
  if (!p) return undefined;
  return resolve(p);
}

export function resolveTarget(options: ResolveTargetOptions): AgentMetadata {
  const { name, runId, runDir, cwd, env = {} } = options;

  if (runId) {
    const all = listMetadata(undefined);
    const found = all.find((a) => a.runId === runId);
    if (found) return found;
    throw new Error(`Agent not found by run-id: ${runId}`);
  }

  if (runDir) {
    const norm = normalizePath(runDir);
    if (norm && existsSync(metadataPath(norm))) {
      try {
        return readMetadata(norm);
      } catch {
        // fall through to error
      }
    }
    throw new Error(`Agent not found by run-dir: ${runDir}`);
  }

  if (!name) {
    throw new Error("Agent name required (or pass --run-id or --run-dir).");
  }

  const all = listMetadata(undefined);
  const hasLineage = !!(env.TANGO_RUN_ID || env.TANGO_RUN_DIR || env.TANGO_ROOT_SESSION_ID || env.TANGO_WORKSTREAM_ID);

  // 2. Direct children of current run
  if (env.TANGO_RUN_ID || env.TANGO_RUN_DIR) {
    const candidates = all.filter(
      (a) =>
        (env.TANGO_RUN_ID && a.parentRunId === env.TANGO_RUN_ID) ||
        (env.TANGO_RUN_DIR && normalizePath(a.parentRunDir) === normalizePath(env.TANGO_RUN_DIR))
    );
    const named = candidates.filter((a) => a.name === name);
    if (named.length === 1) return named[0];
    if (named.length > 1) throw ambiguityError(name, named);
  }

  // 3. Descendants of current run (traversing child edges)
  if (env.TANGO_RUN_ID || env.TANGO_RUN_DIR) {
    let current: AgentMetadata | undefined;
    if (env.TANGO_RUN_ID) current = all.find((a) => a.runId === env.TANGO_RUN_ID);
    if (!current && env.TANGO_RUN_DIR) {
      const norm = normalizePath(env.TANGO_RUN_DIR);
      current = all.find((a) => normalizePath(a.runDir) === norm);
    }
    if (current) {
      const descendants = getDescendants(current, all);
      const named = descendants.filter((a) => a.name === name);
      if (named.length === 1) return named[0];
      if (named.length > 1) throw ambiguityError(name, named);
    }
  }

  // 4. Same-root legacy fallback (lower-confidence, unique only, conjoined)
  if (env.TANGO_ROOT_SESSION_ID || env.TANGO_WORKSTREAM_ID) {
    const candidates = all.filter((a) => {
      const rootMatch = env.TANGO_ROOT_SESSION_ID ? a.rootSessionId === env.TANGO_ROOT_SESSION_ID : true;
      const wsMatch = env.TANGO_WORKSTREAM_ID ? a.workstreamId === env.TANGO_WORKSTREAM_ID : true;
      return rootMatch && wsMatch;
    });
    const named = candidates.filter((a) => a.name === name);
    if (named.length === 1) return named[0];
    if (named.length > 1) throw ambiguityError(name, named);
  }

  // 5. cwd / project fallback (only when no lineage context is present)
  if (!hasLineage && cwd) {
    const candidates = listMetadata(cwd).filter((a) => a.name === name);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw ambiguityError(name, candidates);
  }

  // 6. Globally unique name (only when no lineage context is present)
  if (!hasLineage) {
    const allNamed = all.filter((a) => a.name === name);
    if (allNamed.length === 1) return allNamed[0];
    if (allNamed.length > 1) throw ambiguityError(name, allNamed);
  }

  throw new Error(`Agent not found: ${name}`);
}

export function isChildOf(child: AgentMetadata, parent: AgentMetadata): boolean {
  if (parent.runId && child.parentRunId === parent.runId) return true;
  if (parent.runDir && child.parentRunDir) {
    if (normalizePath(child.parentRunDir) === normalizePath(parent.runDir)) return true;
  }
  return false;
}

function getDescendants(parent: AgentMetadata, all: AgentMetadata[]): AgentMetadata[] {
  const result: AgentMetadata[] = [];
  const queue: AgentMetadata[] = [parent];
  const visited = new Set<string | undefined>();
  while (queue.length) {
    const p = queue.shift()!;
    if (p.runId && visited.has(p.runId)) continue;
    if (p.runId) visited.add(p.runId);
    for (const child of all) {
      if (isChildOf(child, p) && !result.includes(child) && child.runId !== parent.runId) {
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
}

function ambiguityError(name: string, matches: AgentMetadata[]): Error {
  const choices = matches
    .map(
      (m) =>
        `  - ${m.name} (runId=${m.runId ?? "?"}, runDir=${m.runDir}, parentRunId=${m.parentRunId ?? "-"}, rootSessionId=${m.rootSessionId ?? "-"}, workstreamId=${m.workstreamId ?? "-"}, status=${m.status})`
    )
    .join("\n");
  return new Error(
    `Ambiguous agent name "${name}". Multiple matches found:\n${choices}\nUse --run-id <id> or --run-dir <dir> to disambiguate.\nExamples:\n  tango activity ${name} --run-id <id>\n  tango message ${name} --run-dir <dir> <msg>`
  );
}

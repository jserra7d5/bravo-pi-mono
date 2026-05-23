import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cacheRoot, createSessionId } from "./filesystem.js";
import { EvidenceDatabase } from "./sqlite.js";

export interface SessionRegistry {
  workspaceHash: string;
  sessionId: string;
  rootDir: string;
  nextResultAlias: number;
  nextPageAlias: number;
  resultAliasToId: Map<string, string>;
  pageAliasToId: Map<string, string>;
  db: EvidenceDatabase;
}

const registries = new Map<string, Promise<SessionRegistry>>();

function ctxCwd(ctx: ExtensionContext | { cwd?: unknown }): string {
  return typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
}

function ctxSessionId(ctx: ExtensionContext | { sessionManager?: { getSessionId?: () => string } }): string {
  return createSessionId(ctx.sessionManager?.getSessionId?.());
}

export async function registryFor(ctx: ExtensionContext): Promise<SessionRegistry> {
  const cwd = ctxCwd(ctx);
  const sessionId = ctxSessionId(ctx);
  const key = `${cwd}\0${sessionId}`;
  let promise = registries.get(key);
  if (!promise) {
    promise = (async () => {
      const rootDir = cacheRoot(cwd, sessionId);
      const db = await EvidenceDatabase.open(rootDir);
      return {
        workspaceHash: rootDir.split("/").slice(-2, -1)[0] ?? "",
        sessionId,
        rootDir,
        nextResultAlias: 1,
        nextPageAlias: 1,
        resultAliasToId: new Map(),
        pageAliasToId: new Map(),
        db,
      };
    })();
    registries.set(key, promise);
  }
  return promise;
}

export function nextResultAlias(registry: SessionRegistry): string {
  return `r${registry.nextResultAlias++}`;
}

export function nextPageAlias(registry: SessionRegistry): string {
  return `p${registry.nextPageAlias++}`;
}

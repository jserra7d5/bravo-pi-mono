import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface ParentPiSessionRef {
  sessionFile: string;
  leafId: string;
}

export interface BranchPiSessionInput {
  parentSessionFile: string;
  leafId: string;
  piSessionDir: string;
}

export type BranchPiSession = (input: BranchPiSessionInput) => string;

export function readParentPiSessionRef(ctx: unknown): ParentPiSessionRef | null {
  const sessionManager = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager as
    | { getSessionFile?: () => unknown; getLeafId?: () => unknown }
    | undefined;
  const sessionFile = sessionManager?.getSessionFile?.();
  const leafId = sessionManager?.getLeafId?.();
  if (typeof sessionFile !== "string" || !sessionFile) return null;
  if (typeof leafId !== "string" || !leafId) return null;
  return { sessionFile, leafId };
}

export function branchPiSession(input: BranchPiSessionInput): string {
  mkdirSync(input.piSessionDir, { recursive: true });
  const opened = SessionManager.open(resolve(input.parentSessionFile), resolve(input.piSessionDir));
  const branchedPath = opened.createBranchedSession(input.leafId);
  if (typeof branchedPath !== "string" || !branchedPath) {
    throw new Error("Pi SessionManager.createBranchedSession did not return a persisted session path");
  }
  return branchedPath;
}

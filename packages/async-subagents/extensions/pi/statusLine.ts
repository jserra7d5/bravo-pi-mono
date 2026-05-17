import { RunStore } from "../../src/runStore.js";
import { readWatcherSnapshot } from "../../src/watcher.js";

export interface StatusLineInput {
  store: RunStore;
  parentRunId?: string;
  rootSessionId?: string;
}

export function renderStatusLine(input?: StatusLineInput): string | undefined {
  if (!input) return undefined;
  const snapshot = readWatcherSnapshot(input.store, {
    parentRunId: input.parentRunId,
    rootSessionId: input.rootSessionId,
  });
  const active = snapshot.activeRunIds.length;
  const blocked = snapshot.blockedRunIds.length;
  const results = snapshot.resultReadyRunIds.length;
  if (!active && !blocked && !results) return undefined;
  return `Subagents: ${active} running - ${blocked} waiting - ${results} finished`;
}

export function updateStatusLine(ctx: unknown, input: StatusLineInput): void {
  const ui = (ctx as { ui?: { setStatus?: (key: string, value: string | undefined) => void } } | undefined)?.ui;
  ui?.setStatus?.("async-subagents", renderStatusLine(input));
}

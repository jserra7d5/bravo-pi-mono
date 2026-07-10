import type { BrowserWorkspaceConfigV1 as C, StatusData } from "./contracts.js";
import { TmuxWorkspaceManager } from "./tmux.js";
import { assertPortFree, TtydSupervisor } from "./ttyd.js";
import { getStatus } from "./status.js";
export async function runServe(c: C, configPath: string, requireExisting: boolean, onReady: (status: StatusData) => void | Promise<void>): Promise<void> {
  const manager = new TmuxWorkspaceManager(c), ttyd = new TtydSupervisor(c); let stopping = false;
  const stop = async (signal: "SIGTERM" | "SIGINT") => { if (!stopping) { stopping = true; await ttyd.stop(signal); } };
  await assertPortFree(c.listenPort); await manager.prepareDetached(requireExisting);
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { await ttyd.start(true); await onReady(await getStatus(c, configPath)); await ttyd.wait(); }
  finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); await ttyd.stop(); }
}

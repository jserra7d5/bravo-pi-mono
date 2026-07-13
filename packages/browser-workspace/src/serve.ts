import net from "node:net";
import type { BrowserWorkspaceConfigV1 as C, StatusData } from "./contracts.js";
import { assertPortFree, defaultTtydOwnershipFile, TtydSupervisor } from "./ttyd.js";
import { getStatus } from "./status.js";
import { WorkspaceUiServer } from "./workspace-ui.js";
import { TmuxWorkspaceManager } from "./tmux.js";
import { AgentStatusRegistry } from "./agent-status-registry.js";
import { AgentStatusServer } from "./agent-status-server.js";
import { defaultDropRoot } from "./upload.js";

async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0)); }); }); }

export async function runServe(c: C, configPath: string, requireExisting: boolean, onReady: (status: StatusData) => void | Promise<void>): Promise<void> {
  if (requireExisting) await new TmuxWorkspaceManager(c).prepareDetached(true);
  await assertPortFree(c.listenPort);
  const ttyd = new TtydSupervisor({ ...c, listenPort: await freePort() }, process.env, true, defaultTtydOwnershipFile(c));
  const registry = new AgentStatusRegistry();
  const statusServer = new AgentStatusServer(c, registry);
  const ui = new WorkspaceUiServer(c, ttyd.config.listenPort, defaultDropRoot(), registry); let stopping = false;
  const stop = async (signal: "SIGTERM" | "SIGINT") => { if (!stopping) { stopping = true; await ui.stop(); await statusServer.stop(); await ttyd.stop(signal); } };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { await ttyd.start(); await statusServer.start(); await ui.start(); await onReady(await getStatus(c, configPath)); await ttyd.wait(); }
  finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); await ui.stop(); await statusServer.stop(); await ttyd.stop(); }
}

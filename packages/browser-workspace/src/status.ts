import type { BrowserWorkspaceConfigV1 as C, StatusData } from "./contracts.js";
import { inspectIngress } from "./ingress.js";
import { fetchBounded } from "./process.js";
import { TmuxWorkspaceManager } from "./tmux.js";
export async function getStatus(c: C, configPath: string): Promise<StatusData> { const [tmux, ingress, ready] = await Promise.all([new TmuxWorkspaceManager(c).inspectExact(), inspectIngress(c), fetchBounded(`http://127.0.0.1:${c.listenPort}/`, 500).then(response => response.ok).catch(() => false)]); return { configPath, tmux: { socketName: c.tmuxSocketName, sessionName: c.tmuxSessionName, exactSessionExists: !!tmux, ...(tmux ? { serverPid: tmux.serverPid } : {}) }, ttyd: { host: "127.0.0.1", port: c.listenPort, ready }, ingress: { state: ingress.state, ...(ingress.url ? { url: ingress.url } : {}) } }; }

import type { BrowserWorkspaceConfigV1 as C, ExternalCommand } from "./contracts.js";
const tm = (c: C, ...args: string[]): ExternalCommand => ({ executable: c.executables.tmux, args: ["-L", c.tmuxSocketName, ...args] });
export const buildTmuxListSessions = (c: C) => tm(c, "list-sessions", "-F", "#{session_name}\t#{session_id}\t#{pid}");
export const buildTmuxNewDetached = (c: C) => tm(c, "new-session", "-d", "-s", c.tmuxSessionName, "-c", c.workspace);
export const buildTmuxDisplayIdentity = (c: C) => tm(c, "display-message", "-p", "-t", `=${c.tmuxSessionName}`, "#{pid}\t#{session_id}");
export function buildTtyd(c: C, sessionFromUrl = false): ExternalCommand { return { executable: c.executables.ttyd, args: ["--interface", "127.0.0.1", "--port", String(c.listenPort), "--writable", "--check-origin", ...(sessionFromUrl ? ["--url-arg"] : ["--max-clients", "1"]), "--cwd", c.workspace, c.executables.tmux, "-L", c.tmuxSocketName, "attach-session", "-t", ...(!sessionFromUrl ? [`=${c.tmuxSessionName}`] : [])] }; }
export const buildTailscaleServeStatus = (c: C): ExternalCommand => ({ executable: c.executables.tailscale, args: ["serve", "status", "--json"] });
export const buildTailscaleFunnelStatus = (c: C): ExternalCommand => ({ executable: c.executables.tailscale, args: ["funnel", "status", "--json"] });

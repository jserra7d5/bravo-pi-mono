import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";

export const BROWSER_WORKSPACE_STATUS_TTL_MS = 7_000;
export const BROWSER_WORKSPACE_STATUS_TIMEOUT_MS = 500;
const ID = /^bw-[a-f0-9]{24}$/u;

export interface BrowserWorkspaceReportIdentity {
  workspace: { name: string; tmuxSocketPath: string; tmuxSessionId: string };
  lead: { piSessionId: string; rootSessionId: string };
}
export interface BrowserWorkspaceStatusReport extends BrowserWorkspaceReportIdentity {
  protocolVersion: 1;
  type: "lead_async_running_count";
  reporterInstanceId: string;
  sequence: number;
  runningCount: number;
  ttlMs: number;
}

export function defaultBrowserWorkspaceStatusSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR) ? path.join(env.XDG_RUNTIME_DIR, "bravo-browser-workspace", "status-v1.sock") : undefined;
}

function execTmux(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise(resolve => execFile(executable, args, { env, timeout: BROWSER_WORKSPACE_STATUS_TIMEOUT_MS, maxBuffer: 4096 }, (error, stdout) => resolve(error ? undefined : stdout.trim())));
}

export async function resolveBrowserWorkspaceIdentity(env: NodeJS.ProcessEnv = process.env): Promise<BrowserWorkspaceReportIdentity["workspace"] | undefined> {
  if (!env.TMUX) return;
  const socketPath = env.TMUX.split(",", 1)[0];
  if (!socketPath || !path.isAbsolute(socketPath)) return;
  const executable = env.BRAVO_TMUX_EXECUTABLE || "tmux";
  const displayed = await execTmux(executable, ["display-message", "-p", "#{session_name}\t#{session_id}\t#{socket_path}"], env);
  if (!displayed) return;
  const [name, tmuxSessionId, reportedSocketPath] = displayed.split("\t");
  if (!ID.test(name) || !/^\$\d+$/u.test(tmuxSessionId) || !reportedSocketPath || path.resolve(reportedSocketPath) !== path.resolve(socketPath)) return;
  return { name, tmuxSocketPath: reportedSocketPath, tmuxSessionId };
}

export function sendBrowserWorkspaceStatusReport(socketPath: string, report: BrowserWorkspaceStatusReport, timeoutMs = BROWSER_WORKSPACE_STATUS_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false, response = "";
    const socket = createConnection(socketPath);
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.();
    socket.on("connect", () => socket.end(`${JSON.stringify(report)}\n`));
    socket.on("data", chunk => { response += chunk.toString(); const newline = response.indexOf("\n"); if (newline >= 0) { try { finish(JSON.parse(response.slice(0, newline)).ok === true); } catch { finish(false); } } });
    socket.on("error", () => finish(false)); socket.on("end", () => finish(false));
  });
}

export class BrowserWorkspaceStatusReporter {
  readonly reporterInstanceId = randomBytes(16).toString("hex");
  private sequence = 0;
  constructor(readonly identity: BrowserWorkspaceReportIdentity, readonly socketPath: string, readonly send = sendBrowserWorkspaceStatusReport) {}
  report(runningCount: number): Promise<boolean> {
    this.sequence += 1;
    return this.send(this.socketPath, { protocolVersion: 1, type: "lead_async_running_count", ...this.identity, reporterInstanceId: this.reporterInstanceId, sequence: this.sequence, runningCount, ttlMs: BROWSER_WORKSPACE_STATUS_TTL_MS });
  }
}

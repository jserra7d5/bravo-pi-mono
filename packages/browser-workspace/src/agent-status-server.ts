import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { BrowserWorkspaceConfigV1 as C } from "./contracts.js";
import { inspectTmuxSession, type TmuxCommandRunner } from "./tmux-session-inspection.js";
import { AgentStatusRegistry } from "./agent-status-registry.js";
import { AGENT_STATUS_MAX_REQUEST_BYTES, parseAgentStatusReport, type AgentStatusErrorCode, type AgentStatusReportV1, type AgentStatusResponse } from "./agent-status-protocol.js";

export function defaultAgentStatusSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.XDG_RUNTIME_DIR || !path.isAbsolute(env.XDG_RUNTIME_DIR)) throw new Error("XDG_RUNTIME_DIR is required for the browser-workspace status socket");
  return path.join(env.XDG_RUNTIME_DIR, "bravo-browser-workspace", "status-v1.sock");
}

export class AgentStatusServer {
  private server?: net.Server;
  private bound?: { dev: number; ino: number };
  readonly socketPath: string;
  constructor(readonly config: C, readonly registry: AgentStatusRegistry, readonly env: NodeJS.ProcessEnv = process.env, socketPath = defaultAgentStatusSocketPath(env), readonly runTmux?: TmuxCommandRunner) { this.socketPath = socketPath; }
  private sameTmuxSocket(expectedPath: string, reported: string): boolean {
    try {
      const expected = fs.realpathSync(expectedPath), actual = fs.realpathSync(reported);
      const a = fs.statSync(expected), b = fs.statSync(actual);
      return expected === actual && a.dev === b.dev && a.ino === b.ino;
    } catch { return false; }
  }
  async inspectWorkspace(name: string) {
    return inspectTmuxSession({ executable: this.config.executables.tmux, socketName: this.config.tmuxSocketName, targetName: name, env: this.env, run: this.runTmux });
  }
  private async bind(report: AgentStatusReportV1): Promise<AgentStatusErrorCode | "unavailable" | undefined> {
    const inspection = await this.inspectWorkspace(report.workspace.name);
    if (inspection.state === "unavailable") return "unavailable";
    if (inspection.state === "absent") return "workspace_not_live";
    if (!this.sameTmuxSocket(inspection.socketPath, report.workspace.tmuxSocketPath) || inspection.sessionId !== report.workspace.tmuxSessionId) return "workspace_identity_mismatch";
  }
  private respond(socket: net.Socket, response: AgentStatusResponse): void { socket.end(`${JSON.stringify(response)}\n`); }
  private handle(socket: net.Socket): void {
    let bytes = 0, body = "", done = false;
    const onData = (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > AGENT_STATUS_MAX_REQUEST_BYTES) return reject("invalid_request");
      body += chunk;
    };
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("end", onEnd); };
    const finish = (response: AgentStatusResponse) => { if (done) return; done = true; cleanup(); socket.pause(); this.respond(socket, response); };
    const reject = (code: AgentStatusErrorCode) => finish({ ok: false, protocolVersion: 1, code });
    const onEnd = () => {
      if (done) return;
      const newline = body.indexOf("\n");
      if (newline < 0 || body.slice(newline + 1).trim()) return reject("invalid_request");
      const parsed = parseAgentStatusReport(body.slice(0, newline));
      if (!parsed.report) return reject(parsed.code ?? "invalid_request");
      done = true; cleanup(); socket.pause();
      void this.bind(parsed.report).then(code => {
        if (code === "unavailable") return socket.destroy();
        if (code) return this.respond(socket, { ok: false, protocolVersion: 1, code });
        const accepted = this.registry.accept(parsed.report!);
        this.respond(socket, accepted.ok
          ? { ok: true, protocolVersion: 1, acceptedSequence: parsed.report!.sequence, expiresInMs: accepted.expiresInMs }
          : { ok: false, protocolVersion: 1, code: accepted.code });
      }).catch(() => socket.destroy());
    };
    const timer = setTimeout(() => reject("invalid_request"), 1000); timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", cleanup);
  }
  private async preparePath(): Promise<void> {
    const parent = path.dirname(this.socketPath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = fs.statSync(parent);
    if (!parentStat.isDirectory() || parentStat.uid !== process.getuid!() || (parentStat.mode & 0o077) !== 0) throw new Error(`Status socket directory must be uid-owned mode 0700: ${parent}`);
    let stat: fs.Stats; try { stat = fs.lstatSync(this.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isSocket() || stat.uid !== process.getuid!()) throw new Error(`Refusing to replace non-owned socket path: ${this.socketPath}`);
    const live = await new Promise<boolean>(resolve => { const probe = net.createConnection(this.socketPath); const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 250); probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); }); probe.once("error", () => { clearTimeout(timer); resolve(false); }); });
    if (live) throw new Error(`Status socket already has a live listener: ${this.socketPath}`);
    fs.unlinkSync(this.socketPath);
  }
  async start(): Promise<void> {
    await this.preparePath();
    this.server = net.createServer({ allowHalfOpen: true }, socket => this.handle(socket));
    const old = process.umask(0o077);
    try { await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.socketPath, resolve); }); }
    finally { process.umask(old); }
    fs.chmodSync(this.socketPath, 0o600); const stat = fs.lstatSync(this.socketPath); this.bound = { dev: stat.dev, ino: stat.ino };
  }
  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    try { const stat = fs.lstatSync(this.socketPath); if (stat.isSocket() && this.bound && stat.dev === this.bound.dev && stat.ino === this.bound.ino) fs.unlinkSync(this.socketPath); } catch {}
    this.server = undefined; this.bound = undefined;
  }
}

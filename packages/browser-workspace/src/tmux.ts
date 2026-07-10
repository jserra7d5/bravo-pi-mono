import fs from "node:fs";
import path from "node:path";
import type { BrowserWorkspaceConfigV1 as C, ExternalCommand } from "./contracts.js";
import { buildTmuxDisplayIdentity, buildTmuxListSessions, buildTmuxNewDetached } from "./commands.js";
import { Exit, WorkspaceError } from "./errors.js";
import { execBounded, readProcessIdentity } from "./process.js";
export interface TmuxIdentity { serverPid: number; serverStartTicks: string; sessionId: string }
export class TmuxWorkspaceManager {
  constructor(readonly config: C, readonly env = process.env) {}
  private run(command: ExternalCommand) { return execBounded({ ...command, env: this.env }, 5000); }
  private socketPath() { return path.join("/tmp", `tmux-${process.getuid!()}`, this.config.tmuxSocketName); }
  async inspectExact(): Promise<TmuxIdentity | undefined> {
    const displayed = await this.run(buildTmuxDisplayIdentity(this.config)); if (displayed.code !== 0) return;
    const serverPidText = displayed.stdout.split("\t")[0].trim(), listed = await this.run(buildTmuxListSessions(this.config));
    const exact = listed.code === 0 ? listed.stdout.trim().split("\n").map(row => row.split("\t")).filter(([name]) => name === this.config.tmuxSessionName) : [];
    if (!/^\d+$/u.test(serverPidText) || exact.length !== 1) throw new WorkspaceError("TMUX_IDENTITY_INVALID", "Exact tmux identity is malformed or ambiguous", Exit.CONFLICT);
    const [, sessionId, listedPid] = exact[0]; if (!/^\$\d+$/u.test(sessionId) || listedPid !== serverPidText) throw new WorkspaceError("TMUX_IDENTITY_INVALID", "Tmux server/session identity mismatch", Exit.CONFLICT);
    const identity = readProcessIdentity(Number(serverPidText)); return { serverPid: identity.pid, serverStartTicks: identity.startTicks, sessionId };
  }
  async prepareDetached(requireExisting = false): Promise<TmuxIdentity> {
    const existing = await this.inspectExact(); if (existing) return existing;
    if (requireExisting) throw new WorkspaceError("TMUX_REQUIRED", "Exact tmux session does not exist", Exit.CONFLICT);
    const listed = await this.run(buildTmuxListSessions(this.config));
    if ((listed.code === 0 && listed.stdout.trim()) || fs.existsSync(this.socketPath())) throw new WorkspaceError("TMUX_NAMESPACE_CONFLICT", "Tmux namespace is occupied without the exact session", Exit.CONFLICT);
    if ((await this.run(buildTmuxNewDetached(this.config))).code !== 0) throw new WorkspaceError("TMUX_CREATE_FAILED", "Cannot create exact tmux session", Exit.RUNTIME);
    const created = await this.inspectExact(); if (!created) throw new WorkspaceError("TMUX_VERIFY_FAILED", "Created tmux session could not be verified", Exit.RUNTIME); return created;
  }
  async cleanupTestNamespace(): Promise<void> {
    if (!/^bw-test-[A-Za-z0-9_-]+$/u.test(this.config.tmuxSocketName)) throw new WorkspaceError("TMUX_CLEANUP_DENIED", "Cleanup is restricted to test namespaces", Exit.CONFLICT);
    await this.run({ executable: this.config.executables.tmux, args: ["-L", this.config.tmuxSocketName, "kill-server"] });
  }
}

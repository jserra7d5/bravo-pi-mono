import type { AgentStatusErrorCode, AgentStatusReportV1 } from "./agent-status-protocol.js";

export interface AgentStatusLease {
  tmuxSessionId: string;
  piSessionId: string;
  rootSessionId: string;
  reporterInstanceId: string;
  sequence: number;
  runningCount: number;
  receivedAtMonotonicMs: number;
  expiresAtMonotonicMs: number;
}

export class AgentStatusRegistry {
  private readonly leases = new Map<string, AgentStatusLease>();
  private readonly retiredInstances = new Map<string, Set<string>>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  accept(report: AgentStatusReportV1): { ok: true; expiresInMs: number } | { ok: false; code: AgentStatusErrorCode } {
    const now = this.now(), current = this.current(report.workspace.name, now);
    if (current) {
      if (current.piSessionId !== report.lead.piSessionId || current.rootSessionId !== report.lead.rootSessionId) return { ok: false, code: "lead_conflict" };
      if (current.reporterInstanceId === report.reporterInstanceId && report.sequence <= current.sequence) return { ok: false, code: "stale_sequence" };
      if (current.reporterInstanceId !== report.reporterInstanceId) {
        const retired = this.retiredInstances.get(report.workspace.name) ?? new Set<string>();
        if (retired.has(report.reporterInstanceId)) return { ok: false, code: "stale_sequence" };
        retired.add(current.reporterInstanceId);
        this.retiredInstances.set(report.workspace.name, retired);
      }
    } else {
      this.retiredInstances.delete(report.workspace.name);
    }
    this.leases.set(report.workspace.name, {
      tmuxSessionId: report.workspace.tmuxSessionId,
      piSessionId: report.lead.piSessionId,
      rootSessionId: report.lead.rootSessionId,
      reporterInstanceId: report.reporterInstanceId,
      sequence: report.sequence,
      runningCount: report.runningCount,
      receivedAtMonotonicMs: now,
      expiresAtMonotonicMs: now + report.ttlMs,
    });
    return { ok: true, expiresInMs: report.ttlMs };
  }
  get(workspace: string): AgentStatusLease | undefined { return this.current(workspace, this.now()); }
  evict(workspace: string): void { this.leases.delete(workspace); this.retiredInstances.delete(workspace); }
  private current(workspace: string, now: number): AgentStatusLease | undefined {
    const lease = this.leases.get(workspace);
    if (lease && lease.expiresAtMonotonicMs <= now) { this.leases.delete(workspace); return; }
    return lease;
  }
}

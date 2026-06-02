import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MonitorStatusService } from "../runtime/status.js";
import type { MonitorRecord, MonitorEvent, MonitorResult } from "../schema/types.js";
import { runFileCheck, runCommandPollCheck } from "../checks/index.js";
import { evaluateCondition } from "../conditions/evaluator.js";
import { generateEventId, generateLeaseId } from "../ids.js";
import { nowISO, addMs } from "../time.js";
import { monitorBelongsToRuntime, getRuntimeIdentity } from "../runtime/identity.js";

export type SchedulerOptions = {
  maxConcurrentRuns?: number;
  tickIntervalMs?: number;
  leaseTtlMs?: number;
};

const DEFAULT_OPTIONS: Required<SchedulerOptions> = {
  maxConcurrentRuns: 4,
  tickIntervalMs: 1000,
  leaseTtlMs: 30000,
};

export class MonitorScheduler {
  private store: JsonlMonitorStore;
  private opts: Required<SchedulerOptions>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private activeRuns = new Set<string>();
  private statusService?: MonitorStatusService;
  private ctx?: any;

  constructor(store: JsonlMonitorStore, opts?: SchedulerOptions, statusService?: MonitorStatusService) {
    this.store = store;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.statusService = statusService;
  }

  start(ctx?: any): void {
    if (this.running) return;
    this.ctx = ctx;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick("timer");
    }, this.opts.tickIntervalMs);
    void this.tick("startup");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Wait for active runs
    while (this.activeRuns.size > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async tick(reason: "timer" | "tool" | "startup"): Promise<void> {
    if (!this.running) return;
    try {
      const now = new Date();
      const identity = getRuntimeIdentity(this.ctx);
      const due = await this.store.claimDue(
        now,
        { lease_id: generateLeaseId(), ttl_ms: this.opts.leaseTtlMs },
        (monitor) => monitorBelongsToRuntime(monitor, identity) && (monitor.check.type !== "command" || (monitor.check as any).mode === "poll")
      );
      for (const m of due) {
        if (this.activeRuns.size >= this.opts.maxConcurrentRuns) break;
        if (this.activeRuns.has(m.monitor_id)) continue;
        this.activeRuns.add(m.monitor_id);
        void this.runOne(m).finally(() => {
          this.activeRuns.delete(m.monitor_id);
        });
      }
    } catch (err) {
      // Log but don't crash scheduler
      console.error(`[monitor] tick error (${reason}):`, err);
    }
  }

  private async runOne(monitor: MonitorRecord): Promise<void> {
    if (monitor.check.type === "command" && (monitor.check as any).mode !== "poll") {
      await this.store.releaseLease(monitor.monitor_id, monitor.lease_id ?? "", undefined);
      return;
    }

    const startAt = nowISO();
    const claimed = await this.store.get(monitor.monitor_id);
    if (!this.isCurrentClaim(claimed, monitor)) return;

    let result: MonitorResult;
    try {
      result = await this.executeCheck(claimed);
    } catch (err: any) {
      result = {
        result_id: `res-${Date.now()}`,
        monitor_id: monitor.monitor_id,
        status: "error",
        observation: { error: err?.message ?? String(err) },
        condition_matched: false,
        triggered: false,
        created_at: startAt,
        error_message: err?.message ?? String(err),
      };
    }

    const afterCheck = await this.store.get(monitor.monitor_id);
    if (!this.isCurrentClaim(afterCheck, monitor)) return;

    this.appendObservation(afterCheck, result);

    const conditionMatched = evaluateCondition(afterCheck.condition, result);
    result.condition_matched = conditionMatched;
    const nonterminalV2PollChange = (afterCheck.metadata as any)?.monitor_v2 === true && (afterCheck.metadata as any)?.kind === "poll" && result.status === "matched";
    result.triggered = conditionMatched && result.status === "matched" && !nonterminalV2PollChange;

    const current = await this.store.get(monitor.monitor_id);
    if (!this.isCurrentClaim(current, monitor)) return;

    const nextState = this.computeNextState(current, result);
    const nextRunAt = this.computeNextRun(current, result);
    const failureCount = result.status === "error" ? current.failure_count + 1 : current.failure_count;
    const consecutiveFailureCount = result.status === "error" ? current.consecutive_failure_count + 1 : 0;
    const runCount = current.run_count + 1;

    const monitorEvent = result.triggered || (nonterminalV2PollChange && result.condition_matched);
    if (monitorEvent || result.status === "error") {
      const wakeMode = (current.metadata as any)?.wake as string | undefined;
      const wake = wakeMode === "on_event" ? (monitorEvent || result.status === "error") : wakeMode === "on_failure" ? result.status === "error" : wakeMode === "on_terminal" ? ["failed", "succeeded", "completed", "expired", "triggered"].includes(nextState) : undefined;
      const beforeDelivery = await this.store.get(monitor.monitor_id);
      if (this.isCurrentClaim(beforeDelivery, monitor)) {
        const attention_delivery = await this.statusService?.deliverAttention(beforeDelivery, result, this.ctx, { wake });
        if (attention_delivery) result.attention_delivery = attention_delivery;
      }
    }

    const beforeUpdate = await this.store.get(monitor.monitor_id);
    if (!this.isCurrentClaim(beforeUpdate, monitor)) return;

    await this.store.update(beforeUpdate.monitor_id, beforeUpdate.version, {
      state: nextState,
      last_run_at: startAt,
      next_run_at: nextRunAt,
      failure_count: failureCount,
      consecutive_failure_count: consecutiveFailureCount,
      run_count: runCount,
      lease_id: undefined,
      lease_expires_at: undefined,
    });

    await this.store.appendResult(result);

    if (result.triggered) {
      await this.store.appendEvent({
        event_id: generateEventId(),
        monitor_id: monitor.monitor_id,
        type: "triggered",
        payload: { result_id: result.result_id },
        created_at: nowISO(),
      });
    } else if (result.status === "error") {
      await this.store.appendEvent({
        event_id: generateEventId(),
        monitor_id: monitor.monitor_id,
        type: "failed",
        payload: { result_id: result.result_id },
        created_at: nowISO(),
      });
    }

    await this.statusService?.refresh(this.ctx);
  }

  private isCurrentClaim(current: MonitorRecord | undefined, claimed: MonitorRecord): current is MonitorRecord {
    return !!current && current.state === "running" && current.lease_id === claimed.lease_id;
  }

  private appendObservation(monitor: MonitorRecord, result: MonitorResult): void {
    const outputPath = (monitor.metadata as any)?.output_path ?? (monitor.check as any).output_path;
    if (!outputPath || monitor.check.type === "command") return;
    try {
      mkdirSync(dirname(outputPath), { recursive: true });
      appendFileSync(outputPath, `${result.created_at} status=${result.status} triggered=${result.triggered} observation=${JSON.stringify(result.observation)}\n`);
    } catch (err) {
      console.error("[monitor] failed to append observation output:", err);
    }
  }

  private async executeCheck(monitor: MonitorRecord): Promise<MonitorResult> {
    switch (monitor.check.type) {
      case "file":
        return runFileCheck(monitor);
      case "command":
        return runCommandPollCheck(monitor, this.store);
      default:
        throw new Error(`Unsupported check type: ${(monitor.check as any).type}`);
    }
  }

  private computeNextState(monitor: MonitorRecord, result: MonitorResult): MonitorRecord["state"] {
    if (result.triggered) return "triggered";
    if (result.status === "error") return "failed";

    const terminalStates = new Set(["completed", "stopped", "canceled", "expired", "archived"]);
    if (terminalStates.has(monitor.state)) return monitor.state;

    if (monitor.schedule.deadline_at && Date.parse(monitor.schedule.deadline_at) <= Date.now()) {
      return "expired";
    }

    return "running";
  }

  private computeNextRun(monitor: MonitorRecord, result: MonitorResult): string | undefined {
    const terminalStates = new Set(["completed", "stopped", "canceled", "expired", "archived", "succeeded"]);
    if (terminalStates.has(monitor.state as string)) return undefined;
    if (monitor.schedule.deadline_at && Date.parse(monitor.schedule.deadline_at) <= Date.now()) return undefined;

    const interval = monitor.schedule.interval_ms ?? 60000;
    return addMs(nowISO(), interval);
  }
}

import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { MonitorStatusService } from "../runtime/status.js";
import type { MonitorRecord, MonitorEvent, MonitorResult } from "../schema/types.js";
import { runTimerCheck, runFileCheck } from "../checks/index.js";
import { evaluateCondition } from "../conditions/evaluator.js";
import { generateEventId, generateLeaseId } from "../ids.js";
import { nowISO, addMs } from "../time.js";
import { validateRecord } from "../validation.js";

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
      const due = await this.store.claimDue(now, { lease_id: generateLeaseId(), ttl_ms: this.opts.leaseTtlMs });
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
    const startAt = nowISO();
    let result: MonitorResult;
    try {
      result = await this.executeCheck(monitor);
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

    const conditionMatched = evaluateCondition(monitor.condition, result);
    result.condition_matched = conditionMatched;
    result.triggered = conditionMatched && result.status === "matched";

    await this.store.appendResult(result);

    const nextState = this.computeNextState(monitor, result);
    const nextRunAt = this.computeNextRun(monitor, result);
    const failureCount = result.status === "error" ? monitor.failure_count + 1 : monitor.failure_count;
    const consecutiveFailureCount = result.status === "error" ? monitor.consecutive_failure_count + 1 : 0;
    const runCount = monitor.run_count + 1;

    await this.store.update(monitor.monitor_id, undefined, {
      state: nextState,
      last_run_at: startAt,
      next_run_at: nextRunAt,
      failure_count: failureCount,
      consecutive_failure_count: consecutiveFailureCount,
      run_count: runCount,
    });

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

    if (result.triggered || result.status === "error") {
      const attention_delivery = await this.statusService?.deliverAttention(monitor, result, this.ctx);
      if (attention_delivery) await this.store.updateResult(monitor.monitor_id, result.result_id, { attention_delivery });
    }

    await this.statusService?.refresh(this.ctx);

    await this.store.releaseLease(monitor.monitor_id, monitor.lease_id ?? "", nextRunAt);
  }

  private async executeCheck(monitor: MonitorRecord): Promise<MonitorResult> {
    switch (monitor.check.type) {
      case "timer":
        return runTimerCheck(monitor);
      case "file":
        return runFileCheck(monitor);
      default:
        throw new Error(`Unsupported check type: ${(monitor.check as any).type}`);
    }
  }

  private computeNextState(monitor: MonitorRecord, result: MonitorResult): MonitorRecord["state"] {
    if (result.triggered) return "triggered";
    if (result.status === "error") return "failed";

    const terminalStates = new Set(["stopped", "canceled", "expired", "archived"]);
    if (terminalStates.has(monitor.state)) return monitor.state;

    // Check max_runs
    if (monitor.schedule.max_runs && monitor.run_count + 1 >= monitor.schedule.max_runs) {
      return "succeeded";
    }
    // Check deadline
    if (monitor.schedule.deadline_at && Date.parse(monitor.schedule.deadline_at) <= Date.now()) {
      return "expired";
    }

    return (monitor.state === "paused" ? "paused" : "running") as MonitorRecord["state"];
  }

  private computeNextRun(monitor: MonitorRecord, result: MonitorResult): string | undefined {
    const terminalStates = new Set(["stopped", "canceled", "expired", "archived", "succeeded"]);
    if (terminalStates.has(monitor.state as string)) return undefined;
    if (monitor.schedule.max_runs && monitor.run_count + 1 >= monitor.schedule.max_runs) return undefined;
    if (monitor.schedule.deadline_at && Date.parse(monitor.schedule.deadline_at) <= Date.now()) return undefined;
    if (monitor.state === "paused") return monitor.next_run_at;

    let interval = monitor.schedule.interval_ms ?? monitor.schedule.delay_ms ?? 60000;
    if (result.status === "error" && monitor.schedule.backoff) {
      const backoff = monitor.schedule.backoff;
      const failCount = monitor.consecutive_failure_count + 1;
      if (backoff.strategy === "linear") {
        interval = Math.min(interval * failCount, backoff.max_ms ?? interval * 5);
      } else if (backoff.strategy === "exponential") {
        interval = Math.min(interval * Math.pow(2, failCount - 1), backoff.max_ms ?? interval * 8);
      }
    }
    return addMs(nowISO(), interval);
  }
}

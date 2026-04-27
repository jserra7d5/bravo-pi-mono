import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorRecord, MonitorResult } from "../schema/types.js";
import { computeStatusSummary, renderMonitorStatus } from "../tui/status.js";

export class MonitorStatusService {
  private store: JsonlMonitorStore;
  private lastNotifyTime = new Map<string, number>();

  constructor(store: JsonlMonitorStore) {
    this.store = store;
  }

  async refresh(ctx?: any): Promise<void> {
    if (!ctx?.ui?.setStatus) return;
    const items = await this.store.list({ include_archived: false });
    const summary = computeStatusSummary(items);
    const text = renderMonitorStatus(summary);
    if (text) ctx.ui.setStatus("monitors", text);
  }

  async notify(monitor: MonitorRecord, result: MonitorResult, ctx?: any): Promise<void> {
    if (!ctx?.ui?.notify) return;
    if (monitor.attention.notify === false) return;
    const throttleMs = monitor.attention.throttle_ms ?? 30000;
    const last = this.lastNotifyTime.get(monitor.monitor_id) ?? 0;
    if (Date.now() - last < throttleMs) return;
    this.lastNotifyTime.set(monitor.monitor_id, Date.now());
    const message =
      monitor.attention.message ??
      `Monitor ${monitor.name || monitor.monitor_id} ${result.triggered ? "triggered" : "failed"}`;
    ctx.ui.notify(message, result.triggered ? "warning" : "error");
  }
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { AttentionDelivery, MonitorRecord, MonitorResult } from "../schema/types.js";
import { computeStatusSummary, renderMonitorStatus } from "../tui/status.js";

export class MonitorStatusService {
  private store: JsonlMonitorStore;
  private pi?: ExtensionAPI;
  private lastNotifyTime = new Map<string, number>();

  constructor(store: JsonlMonitorStore, pi?: ExtensionAPI) {
    this.store = store;
    this.pi = pi;
  }

  async refresh(ctx?: any): Promise<void> {
    if (!ctx?.ui?.setStatus) return;
    const items = await this.store.list({ include_archived: false });
    const summary = computeStatusSummary(items);
    const text = renderMonitorStatus(summary);
    if (text) ctx.ui.setStatus("monitors", text);
  }

  async deliverAttention(monitor: MonitorRecord, result: MonitorResult, ctx?: any): Promise<AttentionDelivery> {
    const severity = result.triggered ? "warning" : "error";
    const message =
      monitor.attention.message ??
      `Monitor ${monitor.name || monitor.monitor_id} ${result.triggered ? "triggered" : "failed"}`;
    const delivery: AttentionDelivery = {
      message,
      severity,
      notify_attempted: monitor.attention.notify !== false,
      notify_delivered: false,
      wake_attempted: monitor.attention.wake_agent === true,
      wake_delivered: false,
      target_session_id: monitor.owner.session_id,
      target_root_session_id: monitor.owner.root_session_id,
    };

    if (delivery.notify_attempted) {
      const throttleMs = monitor.attention.throttle_ms ?? 30000;
      const last = this.lastNotifyTime.get(monitor.monitor_id) ?? 0;
      if (Date.now() - last < throttleMs) {
        delivery.notify_error = "throttled";
      } else if (!ctx?.ui?.notify) {
        delivery.notify_error = "ui.notify unavailable";
      } else {
        try {
          this.lastNotifyTime.set(monitor.monitor_id, Date.now());
          ctx.ui.notify(message, severity);
          delivery.notify_delivered = true;
        } catch (err: any) {
          delivery.notify_error = err?.message ?? String(err);
        }
      }
    }

    if (delivery.wake_attempted) {
      if (!this.pi?.sendMessage) {
        delivery.wake_error = "pi.sendMessage unavailable";
      } else {
        try {
          this.pi.sendMessage({
            customType: "monitor-attention",
            content: `Monitor wake-up (not a user request):\n\n${message}\n\nMonitor: ${monitor.name || monitor.monitor_id}\nResult: ${result.result_id}\nStatus: ${result.status}\n\nInstructions for the agent:\n- Inspect the monitor with monitor_look or monitor_result if relevant.\n- Continue the active task/autonomous workstream.\n- Do not merely tell the user a monitor fired unless the original task is complete, blocked, or needs a decision.`,
            display: true,
            details: { monitor, result },
          }, { deliverAs: "followUp", triggerTurn: true });
          delivery.wake_delivered = true;
        } catch (err: any) {
          delivery.wake_error = err?.message ?? String(err);
        }
      }
    }

    if (delivery.notify_delivered || delivery.wake_delivered) delivery.delivered_at = new Date().toISOString();
    return delivery;
  }

  async backfillPending(ctx?: any): Promise<number> {
    const monitors = await this.store.list({ include_archived: false, limit: 1000 });
    let delivered = 0;
    for (const monitor of monitors) {
      const results = await this.store.listResults(monitor.monitor_id, { acked: false, limit: 100 });
      for (const result of results) {
        if (!result.triggered && result.status !== "error") continue;
        const previous = result.attention_delivery;
        const wakeNeeded = monitor.attention.wake_agent === true && previous?.wake_delivered !== true;
        const notifyNeeded = monitor.attention.notify !== false && previous?.notify_delivered !== true;
        if (!wakeNeeded && !notifyNeeded) continue;
        const attention_delivery = await this.deliverAttention(monitor, result, ctx);
        await this.store.updateResult(monitor.monitor_id, result.result_id, { attention_delivery });
        if (attention_delivery.wake_delivered || attention_delivery.notify_delivered) delivered++;
      }
    }
    return delivered;
  }

  /** Backward-compatible wrapper. Prefer deliverAttention so callers can persist delivery state. */
  async notify(monitor: MonitorRecord, result: MonitorResult, ctx?: any): Promise<void> {
    await this.deliverAttention(monitor, result, ctx);
  }
}

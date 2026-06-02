import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { AttentionDelivery, MonitorRecord, MonitorResult } from "../schema/types.js";
import { computeStatusSummary, renderMonitorStatus } from "../tui/status.js";
import { getRuntimeIdentity, monitorBelongsToRuntime } from "./identity.js";

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
    const identity = getRuntimeIdentity(ctx);
    const items = (await this.store.list({ include_archived: false })).filter((m) => monitorBelongsToRuntime(m, identity));
    const summary = computeStatusSummary(items);
    const text = renderMonitorStatus(summary);
    if (text) ctx.ui.setStatus("monitors", text);
  }

  async deliverAttention(monitor: MonitorRecord, result: MonitorResult, ctx?: any, options?: { notify?: boolean; wake?: boolean; previous?: AttentionDelivery }): Promise<AttentionDelivery> {
    const isFailure = result.status === "error" || result.status === "timeout";
    const isEvent = result.condition_matched && !result.triggered && !isFailure;
    const severity = isFailure ? "error" : "warning";
    const message =
      monitor.attention.message ??
      `Monitor ${monitor.name || monitor.monitor_id} ${isFailure ? "failed" : isEvent ? "event" : "ended"}`;
    const delivery: AttentionDelivery = {
      message,
      severity,
      notify_attempted: (options?.notify ?? true) && monitor.attention.notify !== false,
      notify_delivered: false,
      wake_attempted: (options?.wake ?? true) && monitor.attention.wake_agent === true,
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
          ctx.ui.notify(message, severity);
          this.lastNotifyTime.set(monitor.monitor_id, Date.now());
          delivery.notify_delivered = true;
        } catch (err: any) {
          delivery.notify_error = err?.message ?? String(err);
        }
      }
    }

    if (delivery.wake_attempted) {
      const identity = getRuntimeIdentity(ctx);
      if (!monitorBelongsToRuntime(monitor, identity)) {
        delivery.wake_error = `owner session mismatch: target=${monitor.owner.session_id ?? ""} current=${identity.session_id ?? ""}`;
      } else if (!this.pi?.sendMessage) {
        delivery.wake_error = "pi.sendMessage unavailable";
      } else {
        try {
          const eventType = isFailure ? "failed" : isEvent ? "event" : result.triggered ? "ended" : "attention";
          const header = eventType === "failed" ? "[MONITOR FAILED — NOT USER INPUT]" : eventType === "event" ? "[MONITOR EVENT — NOT USER INPUT]" : eventType === "ended" ? "[MONITOR ENDED — NOT USER INPUT]" : "[MONITOR ATTENTION — NOT USER INPUT]";
          const outputPath = (monitor.metadata as any)?.output_path ?? (monitor.check as any).output_path ?? "n/a";
          const kind = (monitor.metadata as any)?.kind ?? (monitor.check as any).type;
          const modelState = eventType === "failed" ? "failed" : eventType === "ended" ? "ended" : eventType === "event" ? "event" : monitor.state;
          const summary = message;
          const instructions = [
            "This is control-plane evidence, not a user request.",
            "Inspect Output path with the read tool only if needed.",
            "Continue the active workstream.",
            "Tell the user only if this changes the outcome, blocks progress, or completes the task.",
          ];
          this.pi.sendMessage({
            customType: "monitor-event",
            content: `${header}\n\nMonitor ID: ${monitor.monitor_id}\nName: ${monitor.name || ""}\nKind: ${kind}\nState: ${modelState}\nSummary: ${summary}\nOutput: ${outputPath}\n\nInstructions:\n${instructions.map((line) => `- ${line}`).join("\n")}`,
            display: true,
            details: {
              monitor_id: monitor.monitor_id,
              name: monitor.name,
              kind,
              state: modelState,
              event_type: eventType,
              summary,
              output_path: outputPath,
              event: { result_id: result.result_id, status: result.status, projection: (result.observation as any)?.projected, exit_code: (result.observation as any)?.exit_code ?? null },
              instructions,
            },
          }, { deliverAs: "followUp", triggerTurn: true });
          delivery.wake_delivered = true;
        } catch (err: any) {
          delivery.wake_error = err?.message ?? String(err);
        }
      }
    }

    if (delivery.notify_delivered || delivery.wake_delivered) delivery.delivered_at = new Date().toISOString();
    return this.mergeDelivery(options?.previous, delivery);
  }

  private mergeDelivery(previous: AttentionDelivery | undefined, next: AttentionDelivery): AttentionDelivery {
    if (!previous) return next;
    const merged: AttentionDelivery = { ...previous, ...next };
    if (previous.notify_delivered) {
      merged.notify_delivered = true;
      merged.notify_error = previous.notify_error;
    }
    if (previous.wake_delivered) {
      merged.wake_delivered = true;
      merged.wake_error = previous.wake_error;
    }
    if (previous.delivered_at && (previous.notify_delivered || previous.wake_delivered)) {
      merged.delivered_at = previous.delivered_at;
    } else if (!merged.delivered_at && (merged.notify_delivered || merged.wake_delivered)) {
      merged.delivered_at = new Date().toISOString();
    }
    merged.notify_attempted = previous.notify_attempted || next.notify_attempted;
    merged.wake_attempted = previous.wake_attempted || next.wake_attempted;
    return merged;
  }

  async backfillPending(ctx?: any): Promise<number> {
    const identity = getRuntimeIdentity(ctx);
    const monitors = (await this.store.list({ include_archived: false, limit: 1000 })).filter((m) => m.state === "running" && monitorBelongsToRuntime(m, identity));
    let delivered = 0;
    for (const monitor of monitors) {
      const results = await this.store.listResults(monitor.monitor_id, { limit: 100 });
      for (const result of results) {
        if (!result.triggered && result.status !== "error") continue;
        const previous = result.attention_delivery;
        const wakeNeeded = monitor.attention.wake_agent === true && previous?.wake_delivered !== true;
        const notifyNeeded = monitor.attention.notify !== false && previous?.notify_delivered !== true;
        if (!wakeNeeded && !notifyNeeded) continue;
        const attention_delivery = await this.deliverAttention(monitor, result, ctx, { notify: notifyNeeded, wake: wakeNeeded, previous });
        await this.store.updateResult(monitor.monitor_id, result.result_id, { attention_delivery });
        if (attention_delivery.wake_delivered || attention_delivery.notify_delivered) delivered++;
      }
    }
    return delivered;
  }

}

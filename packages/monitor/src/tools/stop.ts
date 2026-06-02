import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { MonitorStatusService } from "../runtime/status.js";
import { MonitorError, NotFoundError } from "../errors.js";
import { generateEventId } from "../ids.js";
import { nowISO } from "../time.js";
import type { StreamMonitorManager } from "../stream/stream-manager.js";

export async function stopMonitor(
  monitorId: string,
  store: JsonlMonitorStore,
  status?: MonitorStatusService,
  streams?: StreamMonitorManager,
  ctx?: any
) {
  const m = await store.get(monitorId);
  if (!m) throw new NotFoundError(`Monitor ${monitorId} not found`);
  if ((m.check as any).type === "command") {
    const outcome = await streams?.stopAndWait(monitorId, 5000);
    if (outcome?.found && outcome.wasRunning && !outcome.stopped) {
      throw new MonitorError(`Monitor ${monitorId} did not stop after SIGTERM/SIGKILL timeout`, "STOP_TIMEOUT", 409);
    }
  }
  const updated = await store.update(monitorId, undefined, { state: "stopped", next_run_at: undefined, lease_id: undefined, lease_expires_at: undefined });
  await store.appendEvent({
    event_id: generateEventId(),
    monitor_id: monitorId,
    type: "stopped",
    created_at: nowISO(),
  });
  await status?.refresh(ctx);
  return updated;
}

export function buildStopTool(_pi: ExtensionAPI, store: JsonlMonitorStore, status?: MonitorStatusService, streams?: StreamMonitorManager) {
  return {
    name: "monitor_stop",
    label: "Monitor Stop",
    description: "Stop a durable monitor permanently. For command monitors, terminates the command process group before persisting stopped state; preserves result/output history.",
    parameters: Type.Object({
      monitor_id: Type.String(),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const updated = await stopMonitor(params.monitor_id, store, status, streams, ctx);
      return {
        content: [{ type: "text" as const, text: `Monitor ${updated.monitor_id} stopped` }],
        details: { ok: true, monitor_id: updated.monitor_id, state: "stopped", output_path: (updated.metadata as any)?.output_path ?? (updated.check as any).output_path },
      };
    },
  };
}

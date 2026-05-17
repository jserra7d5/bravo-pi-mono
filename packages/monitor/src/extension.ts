import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JsonlMonitorStore } from "./store/jsonl-store.js";
import { MonitorScheduler } from "./scheduler/scheduler.js";
import {
  buildStartTool,
  buildListTool,
  buildLookTool,
  buildUpdateTool,
  buildPauseTool,
  buildResumeTool,
  buildStopTool,
  buildResultTool,
  buildAckTool,
  buildAttentionTool,
  buildStreamStartTool,
  buildStreamStopTool,
  buildStreamListTool,
  buildStreamOutputTool,
} from "./tools/index.js";
import { MonitorStatusService } from "./runtime/status.js";
import { StreamMonitorManager } from "./stream/stream-manager.js";
import { formatMonitorRow } from "./tui/format.js";
import { getRuntimeIdentity, monitorBelongsToRuntime } from "./runtime/identity.js";

export type MonitorRuntime = {
  store: JsonlMonitorStore;
  scheduler: MonitorScheduler;
  statusService: MonitorStatusService;
  streams: StreamMonitorManager;
};

export function createMonitorRuntime(pi: ExtensionAPI, stateRoot?: string): MonitorRuntime {
  const store = new JsonlMonitorStore(stateRoot);
  const statusService = new MonitorStatusService(store, pi);
  const scheduler = new MonitorScheduler(store, undefined, statusService);
  const streams = new StreamMonitorManager(pi, stateRoot);

  return { store, scheduler, statusService, streams };
}

export default function (pi: ExtensionAPI) {
  const runtime = createMonitorRuntime(pi);

  pi.on("session_start", async (_event, ctx) => {
    await runtime.store.init();
    runtime.scheduler.start(ctx);
    await runtime.statusService.backfillPending(ctx);
    await runtime.statusService.refresh(ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.scheduler.stop();
    await runtime.streams.stopAll();
  });

  const tools = [
    buildStartTool(pi, runtime.store, runtime.statusService),
    buildListTool(pi, runtime.store),
    buildLookTool(pi, runtime.store),
    buildUpdateTool(pi, runtime.store, runtime.statusService),
    buildPauseTool(pi, runtime.store, runtime.statusService),
    buildResumeTool(pi, runtime.store, runtime.statusService),
    buildStopTool(pi, runtime.store, runtime.statusService),
    buildResultTool(pi, runtime.store),
    buildAckTool(pi, runtime.store, runtime.statusService),
    buildAttentionTool(pi, runtime.store),
    buildStreamStartTool(pi, runtime.streams),
    buildStreamStopTool(pi, runtime.streams),
    buildStreamListTool(pi, runtime.streams),
    buildStreamOutputTool(pi, runtime.streams),
  ];

  for (const tool of tools) {
    pi.registerTool(tool as any);
  }

  pi.registerCommand("monitors", {
    description: "Monitor management panel and commands",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "";

      if (!sub || sub === "list") {
        const identity = getRuntimeIdentity(ctx);
        const items = (await runtime.store.list({ include_archived: false })).filter((m) => monitorBelongsToRuntime(m, identity));
        if (ctx.ui?.notify) {
          const lines = [
            "Monitors",
            "",
            ...items.map((m) => formatMonitorRow({
              monitor_id: m.monitor_id,
              name: m.name,
              state: m.state,
              next_run_at: m.next_run_at,
              last_run_at: m.last_run_at,
              check: m.check as any,
            })),
            "",
            items.length === 0 ? "No monitors." : "",
          ];
          ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
        }
        return;
      }

      if (sub === "pause" && parts[1]) {
        const updated = await runtime.store.update(parts[1], undefined, { state: "paused" });
        if (ctx.ui?.notify) ctx.ui.notify(`Paused ${updated.monitor_id}`, "info");
        await runtime.statusService.refresh(ctx);
        return;
      }
      if (sub === "resume" && parts[1]) {
        const updated = await runtime.store.update(parts[1], undefined, { state: "running" });
        if (ctx.ui?.notify) ctx.ui.notify(`Resumed ${updated.monitor_id}`, "info");
        await runtime.statusService.refresh(ctx);
        return;
      }
      if (sub === "stop" && parts[1]) {
        const updated = await runtime.store.update(parts[1], undefined, { state: "stopped", next_run_at: undefined });
        if (ctx.ui?.notify) ctx.ui.notify(`Stopped ${updated.monitor_id}`, "info");
        await runtime.statusService.refresh(ctx);
        return;
      }
      if (sub === "ack" && parts[1]) {
        if (parts[1] === "all") {
          const acked = await runtime.store.ackResults({ all: true });
          if (ctx.ui?.notify) ctx.ui.notify(`Acknowledged ${acked} result(s)`, "info");
          await runtime.statusService.refresh(ctx);
          return;
        }
        const acked = await runtime.store.ackResults({ monitor_id: parts[1] });
        if (ctx.ui?.notify) ctx.ui.notify(`Acknowledged ${acked} result(s) for ${parts[1]}`, "info");
        await runtime.statusService.refresh(ctx);
        return;
      }

      if (ctx.ui?.notify) ctx.ui.notify(`Unknown /monitors subcommand: ${sub}`, "warning");
    },
  });
}

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  buildOutputTool,
  buildAckTool,
  buildAttentionTool,
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

function monitorPromptGuidance(options: BuildSystemPromptOptions, basePrompt: string): string {
  const hasTool = (name: string) => options.selectedTools?.includes(name) ?? false;
  const hasMonitorTools = [
    "monitor_start",
    "monitor_output",
    "monitor_stop",
    "monitor_list",
    "monitor_look",
    "monitor_result",
    "monitor_attention",
  ].some(hasTool);

  if (!hasMonitorTools) return basePrompt;

  return `${basePrompt}

## Monitor Tool Guidance

Use monitors when waiting is part of the work. A monitor is a durable background watch with one stable \`monitor_id\`; it lets you continue other work, survive later turns, and return only when there is evidence to inspect.

Use a monitor when:
- a command, build, deploy, log tail, queue drain, file creation, or external process may take longer than a normal bounded tool wait;
- you need to keep working while a condition matures in the background;
- you need a durable handle to stop, inspect, ack, or recover the wait later;
- completion or failure should optionally notify or wake the agent.

Do not use a monitor when:
- a normal foreground \`bash\` command with a short timeout gives the answer immediately;
- you need a one-off repository search or file read;
- there is no useful future condition to observe;
- adding background state would be harder to reason about than just running the check now.

Operational rules:
- Use \`monitor_start\` to create monitors. Use \`check.type: "timer"\` or \`"file"\` for scheduled checks; use \`check.type: "command"\` with \`schedule: {}\` for shell commands or live output.
- For command monitors, read stdout/stderr with \`monitor_output\`; use \`monitor_result\` only for completion metadata such as exit code, signal, and output file.
- Set \`attention.notify\` for UI notifications and \`attention.wake_agent\` only when a follow-up message should wake the agent. Quiet command monitors still capture output for \`monitor_output\`.
- Use \`monitor_output\` with \`block: true\` only with a bounded \`timeout_ms\`; otherwise inspect later with \`monitor_look\` or \`monitor_list\`.
- Use \`monitor_stop\` to stop durable monitors. Command monitors are terminated as a POSIX process group with SIGTERM then SIGKILL escalation before stopped state is persisted.
- Treat monitor wake-ups as control-plane events, not user requests: inspect the monitor, continue the active workstream, and only report to the user when the original task is complete, blocked, or needs a decision.
`;
}

export default function (pi: ExtensionAPI) {
  const runtime = createMonitorRuntime(pi);

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: monitorPromptGuidance(event.systemPromptOptions, event.systemPrompt) };
  });

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
    buildStartTool(pi, runtime.store, runtime.statusService, runtime.streams),
    buildListTool(pi, runtime.store),
    buildLookTool(pi, runtime.store),
    buildUpdateTool(pi, runtime.store, runtime.statusService),
    buildPauseTool(pi, runtime.store, runtime.statusService),
    buildResumeTool(pi, runtime.store, runtime.statusService),
    buildStopTool(pi, runtime.store, runtime.statusService, runtime.streams),
    buildResultTool(pi, runtime.store),
    buildOutputTool(pi, runtime.store, runtime.streams),
    buildAckTool(pi, runtime.store, runtime.statusService),
    buildAttentionTool(pi, runtime.store),
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

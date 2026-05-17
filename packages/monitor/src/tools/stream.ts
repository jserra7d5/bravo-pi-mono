import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StreamMonitorManager } from "../stream/stream-manager.js";
import { NotFoundError } from "../errors.js";

export function buildStreamStartTool(_pi: ExtensionAPI, streams: StreamMonitorManager) {
  return {
    name: "monitor_stream_start",
    label: "Monitor Stream Start",
    description: "Start a Claude-style streaming monitor. The script runs in the background; each stdout/stderr line is delivered as a monitor notification. Use this for ongoing event streams, not one-shot waits.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell script/command to run and stream." }),
      description: Type.String({ description: "Human-readable monitor label shown in notifications." }),
      cwd: Type.Optional(Type.String()),
      timeout_ms: Type.Optional(Type.Number()),
      notify: Type.Optional(Type.Boolean({ default: true })),
      event_throttle_ms: Type.Optional(Type.Number({ default: 1000, description: "Minimum batching delay before stream lines wake the agent." })),
      max_lines_per_turn: Type.Optional(Type.Number({ default: 20, description: "Maximum stream lines batched into one wake-up." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const state = streams.start({
        command: params.command,
        description: params.description,
        cwd: params.cwd,
        timeout_ms: params.timeout_ms,
        notify: params.notify,
        event_throttle_ms: params.event_throttle_ms,
        max_lines_per_turn: params.max_lines_per_turn,
      }, ctx);
      return {
        content: [{ type: "text" as const, text: `Stream monitor ${state.stream_id} started` }],
        details: state,
      };
    },
  };
}

export function buildStreamStopTool(_pi: ExtensionAPI, streams: StreamMonitorManager) {
  return {
    name: "monitor_stream_stop",
    label: "Monitor Stream Stop",
    description: "Stop a running streaming monitor.",
    parameters: Type.Object({ stream_id: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const ok = streams.stop(params.stream_id);
      if (!ok) throw new NotFoundError(`Running stream monitor ${params.stream_id} not found`);
      return { content: [{ type: "text" as const, text: `Stream monitor ${params.stream_id} stopped` }], details: { stream_id: params.stream_id } };
    },
  };
}

export function buildStreamListTool(_pi: ExtensionAPI, streams: StreamMonitorManager) {
  return {
    name: "monitor_stream_list",
    label: "Monitor Stream List",
    description: "List session-local streaming monitors.",
    parameters: Type.Object({}),
    async execute() {
      const items = streams.list();
      return { content: [{ type: "text" as const, text: `Found ${items.length} stream monitor(s)` }], details: { streams: items } };
    },
  };
}

export function buildStreamOutputTool(_pi: ExtensionAPI, streams: StreamMonitorManager) {
  return {
    name: "monitor_stream_output",
    label: "Monitor Stream Output",
    description: "Read the recent output captured by a streaming monitor.",
    parameters: Type.Object({ stream_id: Type.String(), tail_bytes: Type.Optional(Type.Number({ default: 12000 })) }),
    async execute(_toolCallId: string, params: any) {
      const state = streams.get(params.stream_id);
      if (!state) throw new NotFoundError(`Stream monitor ${params.stream_id} not found`);
      const output = streams.output(params.stream_id, params.tail_bytes ?? 12000);
      return { content: [{ type: "text" as const, text: output || "No output available" }], details: { stream: state } };
    },
  };
}

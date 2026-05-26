import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import type { StreamMonitorManager } from "../stream/stream-manager.js";
import { NotFoundError } from "../errors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildOutputTool(_pi: ExtensionAPI, store: JsonlMonitorStore, streams: StreamMonitorManager) {
  return {
    name: "monitor_output",
    label: "Monitor Output",
    description: "Read stdout/stderr captured by a durable command monitor created with monitor_start check.type='command'.",
    parameters: Type.Object({
      monitor_id: Type.String({ description: "Durable monitor id returned by monitor_start." }),
      block: Type.Optional(Type.Boolean({ default: false, description: "Wait for output or terminal state before returning." })),
      timeout_ms: Type.Optional(Type.Number({ default: 5000, description: "Bounded wait when block=true; capped by the tool." })),
      tail_bytes: Type.Optional(Type.Number({ default: 12000, description: "Maximum bytes of recent output to return." })),
    }),
    async execute(_toolCallId: string, params: any) {
      const monitor = await store.get(params.monitor_id);
      if (!monitor) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      const timeout = Math.max(0, Math.min(params.timeout_ms ?? 5000, 30000));
      const tail = Math.max(1, Math.min(params.tail_bytes ?? (monitor.check as any).tail_bytes ?? 12000, 5_000_000));
      const start = Date.now();
      let output = streams.output(params.monitor_id, tail);
      let state = streams.get(params.monitor_id);
      const isTerminal = () => ["completed", "failed", "stopped", "succeeded", "triggered", "canceled", "expired", "archived"].includes((state?.status ?? monitor.state) as string);
      while (params.block && !output && !isTerminal() && Date.now() - start < timeout) {
        if (!state && monitor.state !== "running") break;
        await sleep(Math.min(100, timeout - (Date.now() - start)));
        output = streams.output(params.monitor_id, tail);
        state = streams.get(params.monitor_id);
      }
      const current = await store.get(params.monitor_id) ?? monitor;
      const [latestResult] = await store.listResults(params.monitor_id, { limit: 1 });
      const exitCode = state?.exit_code ?? (latestResult?.observation as any)?.exit_code;
      const signal = state?.signal ?? (latestResult?.observation as any)?.signal;
      const terminalEmpty = !output && ["completed", "failed", "stopped", "succeeded", "triggered", "canceled", "expired", "archived"].includes(current.state);
      const retrieval_status = output || terminalEmpty ? "success" : params.block && current.state === "running" ? "timeout" : "not_ready";
      const outcomeDetail = exitCode !== undefined && exitCode !== null
        ? ` (exit_code=${exitCode})`
        : signal
          ? ` (signal=${signal})`
          : "";
      const emptyText = retrieval_status === "timeout"
        ? "No command monitor output before timeout."
        : retrieval_status === "not_ready"
          ? "Command monitor output is not ready yet."
          : current.state === "failed"
            ? `Command monitor failed with no captured output${outcomeDetail}.`
            : current.state === "stopped"
              ? `Command monitor stopped with no captured output${outcomeDetail}.`
              : ["completed", "succeeded"].includes(current.state)
                ? "Command monitor completed with no captured output."
                : `Command monitor reached terminal state ${current.state} with no captured output${outcomeDetail}.`;
      return { content: [{ type: "text" as const, text: output || emptyText }], details: { ok: true, retrieval_status, monitor: current, output: output || undefined, exit_code: exitCode, signal } };
    },
  };
}

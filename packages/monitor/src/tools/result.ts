import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { NotFoundError } from "../errors.js";

function value(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

function resultRow(r: any): string {
  const observation = (r.observation && typeof r.observation === "object") ? r.observation as any : {};
  const errorMessage = value(r.error_message) ?? value(r.error);
  const exitCode = value(observation.exit_code) ?? value(r.exit_code);
  const signal = value(observation.signal) ?? value(r.signal);
  const outputFile = value(observation.output_file) ?? value(r.output_file);

  const parts = [
    value(r.created_at),
    `status=${r.status}`,
    `triggered=${Boolean(r.triggered)}`,
    `acked=${Boolean(r.acked_at)}`,
    errorMessage ? `error=${errorMessage}` : undefined,
    exitCode ? `exit_code=${exitCode}` : undefined,
    signal ? `signal=${signal}` : undefined,
    outputFile ? `output_file=${outputFile}` : undefined,
  ].filter(Boolean);
  return `- ${r.result_id}: ${parts.join(" ")}`;
}

export function buildResultTool(_pi: ExtensionAPI, store: JsonlMonitorStore) {
  return {
    name: "monitor_result",
    label: "Monitor Result",
    description: "Get latest or historical monitor results. Use this for scheduled timer/file check results; use monitor_output for command stdout/stderr.",
    parameters: Type.Object({
      monitor_id: Type.String(),
      limit: Type.Optional(Type.Number({ default: 5 })),
      acked: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, params: any) {
      const m = await store.get(params.monitor_id);
      if (!m) throw new NotFoundError(`Monitor ${params.monitor_id} not found`);
      const results = await store.listResults(params.monitor_id, {
        limit: params.limit ?? 5,
        acked: params.acked,
      });
      const text = results.length
        ? `${results.length} result(s) for monitor ${m.monitor_id}\n${results.map(resultRow).join("\n")}`
        : `No results for monitor ${m.monitor_id}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { monitor_id: m.monitor_id, results },
      };
    },
  };
}

export const AGENT_STATUS_MAX_REQUEST_BYTES = 8 * 1024;
export const WORKSPACE_ID = /^bw-[a-f0-9]{24}$/u;

export interface AgentStatusReportV1 {
  protocolVersion: 1;
  type: "lead_async_running_count";
  workspace: { name: string; tmuxSocketPath: string; tmuxSessionId: string };
  lead: { piSessionId: string; rootSessionId: string };
  reporterInstanceId: string;
  sequence: number;
  runningCount: number;
  ttlMs: number;
}

export type AgentStatusErrorCode = "invalid_request" | "unsupported_version" | "workspace_not_live" | "workspace_identity_mismatch" | "stale_sequence" | "lead_conflict";
export type AgentStatusResponse = { ok: true; protocolVersion: 1; acceptedSequence: number; expiresInMs: number } | { ok: false; protocolVersion: 1; code: AgentStatusErrorCode };

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function opaque(value: unknown): value is string { return typeof value === "string" && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 256; }
function integer(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }

export function parseAgentStatusReport(line: string): { report?: AgentStatusReportV1; code?: AgentStatusErrorCode } {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { code: "invalid_request" }; }
  if (!record(value)) return { code: "invalid_request" };
  if (value.protocolVersion !== 1) return { code: "unsupported_version" };
  if (!exact(value, ["protocolVersion", "type", "workspace", "lead", "reporterInstanceId", "sequence", "runningCount", "ttlMs"])) return { code: "invalid_request" };
  if (value.type !== "lead_async_running_count" || !record(value.workspace) || !exact(value.workspace, ["name", "tmuxSocketPath", "tmuxSessionId"]) || !record(value.lead) || !exact(value.lead, ["piSessionId", "rootSessionId"])) return { code: "invalid_request" };
  const workspace = value.workspace, lead = value.lead;
  if (typeof workspace.name !== "string" || !WORKSPACE_ID.test(workspace.name) || typeof workspace.tmuxSocketPath !== "string" || !workspace.tmuxSocketPath.startsWith("/") || typeof workspace.tmuxSessionId !== "string" || !/^\$[0-9]+$/u.test(workspace.tmuxSessionId)) return { code: "invalid_request" };
  if (!opaque(lead.piSessionId) || !opaque(lead.rootSessionId) || !opaque(value.reporterInstanceId) || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(value.runningCount, 0, 10_000) || !integer(value.ttlMs, 3_000, 15_000)) return { code: "invalid_request" };
  return { report: value as unknown as AgentStatusReportV1 };
}

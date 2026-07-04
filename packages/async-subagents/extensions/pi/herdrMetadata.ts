import { createConnection } from "node:net";
import type { AsyncSubagentsActivityState } from "./liveWidget.js";

export const HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE = "bravo:async-subagents";
export const HERDR_ASYNC_SUBAGENTS_METADATA_TTL_MS = 7_000;
export const HERDR_ASYNC_SUBAGENTS_SOCKET_TIMEOUT_MS = 500;

export interface HerdrMetadataEnv {
  HERDR_ENV?: string;
  HERDR_SOCKET_PATH?: string;
  HERDR_PANE_ID?: string;
}

export interface HerdrMetadataRequest {
  id: string;
  method: "pane.report_metadata";
  params: {
    pane_id: string;
    source: string;
    agent?: string;
    applies_to_source?: string;
    custom_status?: string;
    state_labels?: Record<string, string>;
    clear_custom_status?: boolean;
    clear_state_labels?: boolean;
    seq: number;
    ttl_ms?: number;
  };
}

let reportSeq = Date.now() * 1000;

export function nextHerdrMetadataSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

export function herdrMetadataEnabled(env: HerdrMetadataEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH) && Boolean(env.HERDR_PANE_ID);
}

export function asyncSubagentsCustomStatus(state: AsyncSubagentsActivityState): string | undefined {
  if (!state.active) return undefined;
  const count = state.activeCount;
  const noun = count === 1 ? "subagent" : "subagents";
  if (state.blocked) return `async blocked (${count} ${noun})`;
  return `async working (${count} ${noun})`;
}

export function buildHerdrAsyncSubagentsMetadataRequest(
  state: AsyncSubagentsActivityState,
  input: { paneId: string; seq: number; ttlMs?: number; requestIdSuffix?: string },
): HerdrMetadataRequest {
  const customStatus = asyncSubagentsCustomStatus(state);
  const suffix = input.requestIdSuffix ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (!customStatus) {
    return {
      id: `${HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE}:clear:${suffix}`,
      method: "pane.report_metadata",
      params: {
        pane_id: input.paneId,
        source: HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE,
        agent: "pi",
        applies_to_source: "herdr:pi",
        clear_custom_status: true,
        clear_state_labels: true,
        seq: input.seq,
      },
    };
  }

  const stateLabel = state.blocked ? customStatus : customStatus;
  return {
    id: `${HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE}:state:${suffix}`,
    method: "pane.report_metadata",
    params: {
      pane_id: input.paneId,
      source: HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE,
      agent: "pi",
      applies_to_source: "herdr:pi",
      custom_status: customStatus,
      state_labels: {
        idle: stateLabel,
        working: stateLabel,
        blocked: stateLabel,
      },
      seq: input.seq,
      ttl_ms: input.ttlMs ?? HERDR_ASYNC_SUBAGENTS_METADATA_TTL_MS,
    },
  };
}

export function sendHerdrSocketRequest(
  socketPath: string,
  request: unknown,
  timeoutMs = HERDR_ASYNC_SUBAGENTS_SOCKET_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
  });
}

export function reportHerdrAsyncSubagentsMetadata(
  state: AsyncSubagentsActivityState,
  env: HerdrMetadataEnv = process.env,
  send: (socketPath: string, request: unknown) => Promise<boolean> = sendHerdrSocketRequest,
): Promise<boolean> {
  if (!herdrMetadataEnabled(env)) return Promise.resolve(true);
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (!socketPath || !paneId) return Promise.resolve(true);
  const request = buildHerdrAsyncSubagentsMetadataRequest(state, {
    paneId,
    seq: nextHerdrMetadataSeq(),
  });
  return send(socketPath, request).catch(() => false);
}

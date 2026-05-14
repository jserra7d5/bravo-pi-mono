import { randomBytes } from "node:crypto";

function randomToken(bytes = 10): string {
  return randomBytes(bytes).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "");
}

export function newRunId(nowMs = Date.now()): string {
  return `run_${nowMs.toString(36)}_${randomToken(8)}`;
}

export function newMessageId(nowMs = Date.now()): string {
  return `msg_${nowMs.toString(36)}_${randomToken(8)}`;
}

export function newArtifactId(nowMs = Date.now()): string {
  return `art_${nowMs.toString(36)}_${randomToken(8)}`;
}

export function newRootSessionId(nowMs = Date.now()): string {
  return `root_${nowMs.toString(36)}_${randomToken(8)}`;
}

export function newLeaseId(nowMs = Date.now()): string {
  return `lease_${nowMs.toString(36)}_${randomToken(8)}`;
}

export function eventIdForSequence(sequence: number): string {
  return `evt_${String(sequence).padStart(6, "0")}`;
}

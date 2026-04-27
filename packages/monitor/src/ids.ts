import { randomBytes, createHash } from "node:crypto";

export function generateId(prefix: string): string {
  const rand = randomBytes(6).toString("hex");
  return `${prefix}-${rand}`;
}

export function generateResultId(): string {
  return generateId("res");
}

export function generateEventId(): string {
  return generateId("evt");
}

export function generateMonitorId(): string {
  return generateId("mon");
}

export function generateLeaseId(): string {
  return generateId("lease");
}

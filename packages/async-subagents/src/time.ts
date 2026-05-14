export function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function durationMs(startIso: string, endIso = nowIso()): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

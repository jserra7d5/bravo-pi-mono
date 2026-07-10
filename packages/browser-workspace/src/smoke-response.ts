const ERROR = /\b(error|fatal|failed|failure|unauthorized|forbidden|no api key|not authenticated|not found|command not found|connection refused|rate limit)\b/iu;

export type SmokeResponse =
  | { state: "pending" }
  | { state: "error"; message: string }
  | { state: "answer" };

export function classifyMarkerResponse(rows: readonly string[], marker: string): SmokeResponse {
  const normalized = rows.map(row => row.replaceAll("\u00a0", " ").trimEnd());
  const firstMarker = normalized.findIndex(row => row.includes(marker));
  if (firstMarker < 0) return { state: "pending" };
  const error = normalized.slice(firstMarker + 1).map(row => row.trim()).find(row => ERROR.test(row));
  if (error) return { state: "error", message: error };
  return normalized.slice(firstMarker + 1).some(row => row.includes(marker)) ? { state: "answer" } : { state: "pending" };
}

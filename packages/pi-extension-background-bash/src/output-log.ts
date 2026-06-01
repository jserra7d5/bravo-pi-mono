import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function initializeLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "", { mode: 0o600 });
}

export function appendLog(path: string, text: string): void {
  appendFileSync(path, text);
}

export function sentinel(message: string): string {
  return `\n[background-bash] ${new Date().toISOString()} ${message}\n`;
}

export function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

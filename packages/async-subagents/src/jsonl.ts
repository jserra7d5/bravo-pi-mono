import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SubagentError } from "./errors.js";

export interface ReadJsonlOptions {
  offset?: number;
  maxRecords?: number;
}

export interface ReadJsonlResult<T> {
  records: T[];
  nextOffset: number;
  lastId?: string;
}

function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort. Some platforms/filesystems do not allow fsync on all paths.
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsyncPath(tmp);
  renameSync(tmp, path);
  fsyncPath(dirname(path));
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

function idFromRecord(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const object = record as Record<string, unknown>;
  return typeof object.eventId === "string" ? object.eventId : typeof object.messageId === "string" ? object.messageId : undefined;
}

export function readJsonl<T = unknown>(path: string, options: ReadJsonlOptions = {}): ReadJsonlResult<T> {
  const offset = options.offset ?? 0;
  if (!existsSync(path)) return { records: [], nextOffset: offset };
  const buffer = readFileSync(path);
  if (offset >= buffer.length) return { records: [], nextOffset: buffer.length };

  const records: T[] = [];
  let lineStart = offset;
  let nextOffset = offset;
  let lastId: string | undefined;

  for (let i = offset; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    let lineEnd = i;
    if (lineEnd > lineStart && buffer[lineEnd - 1] === 0x0d) lineEnd--;
    const raw = buffer.subarray(lineStart, lineEnd).toString("utf8");
    nextOffset = i + 1;
    lineStart = i + 1;
    if (!raw.trim()) continue;
    try {
      const record = JSON.parse(raw) as T;
      records.push(record);
      lastId = idFromRecord(record) ?? lastId;
    } catch (error) {
      throw new SubagentError("INVALID_JSONL", `invalid complete JSONL record in ${path}`, {
        path,
        offset: lineStart,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (options.maxRecords && records.length >= options.maxRecords) break;
  }

  return { records, nextOffset, lastId };
}

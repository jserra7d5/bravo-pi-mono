import { closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
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

function parseJsonlBuffer<T>(path: string, buffer: Buffer, baseOffset: number, maxRecords?: number): ReadJsonlResult<T> {
  const records: T[] = [];
  let lineStart = 0;
  let nextOffset = baseOffset;
  let lastId: string | undefined;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    let lineEnd = i;
    if (lineEnd > lineStart && buffer[lineEnd - 1] === 0x0d) lineEnd--;
    const raw = buffer.subarray(lineStart, lineEnd).toString("utf8");
    const recordOffset = baseOffset + lineStart;
    nextOffset = baseOffset + i + 1;
    lineStart = i + 1;
    if (!raw.trim()) continue;
    try {
      const record = JSON.parse(raw) as T;
      records.push(record);
      lastId = idFromRecord(record) ?? lastId;
    } catch (error) {
      throw new SubagentError("INVALID_JSONL", `invalid complete JSONL record in ${path}`, {
        path,
        offset: recordOffset,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (maxRecords && records.length >= maxRecords) break;
  }

  return { records, nextOffset, lastId };
}

let jsonlFullFileReadCountForTest = 0;

export function jsonlReadStatsForTest(): { fullFileReads: number } {
  return { fullFileReads: jsonlFullFileReadCountForTest };
}

export function resetJsonlReadStatsForTest(): void {
  jsonlFullFileReadCountForTest = 0;
}

function readJsonlRangeInternal<T = unknown>(path: string, offset: number, endExclusive: number | undefined, maxRecords?: number): ReadJsonlResult<T> {
  if (!existsSync(path)) return { records: [], nextOffset: offset };
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const end = Math.min(endExclusive ?? size, size);
    if (offset >= end) return { records: [], nextOffset: end };
    const length = end - offset;
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const bytesRead = readSync(fd, buffer, total, length - total, offset + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return parseJsonlBuffer<T>(path, total === length ? buffer : buffer.subarray(0, total), offset, maxRecords);
  } finally {
    closeSync(fd);
  }
}

export function readJsonl<T = unknown>(path: string, options: ReadJsonlOptions = {}): ReadJsonlResult<T> {
  const offset = options.offset ?? 0;
  if (offset > 0) return readJsonlRangeInternal<T>(path, offset, undefined, options.maxRecords);
  if (!existsSync(path)) return { records: [], nextOffset: offset };
  jsonlFullFileReadCountForTest += 1;
  const buffer = readFileSync(path);
  if (offset >= buffer.length) return { records: [], nextOffset: buffer.length };
  return parseJsonlBuffer<T>(path, buffer.subarray(offset), offset, options.maxRecords);
}

export function readJsonlRange<T = unknown>(path: string, offset: number, endExclusive?: number): ReadJsonlResult<T> {
  return readJsonlRangeInternal<T>(path, offset, endExclusive);
}

/** Stream complete JSONL records, stopping as soon as the visitor returns false. */
export function visitJsonl<T = unknown>(path: string, visitor: (record: T) => boolean | void): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = "";
  let offset = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const rawLine = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const recordOffset = offset;
        offset += Buffer.byteLength(`${rawLine}\n`);
        if (!raw.trim()) continue;
        try {
          if (visitor(JSON.parse(raw) as T) === false) return;
        } catch (error) {
          if (error instanceof SubagentError) throw error;
          throw new SubagentError("INVALID_JSONL", `invalid complete JSONL record in ${path}`, {
            path,
            offset: recordOffset,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    decoder.end();
    // As elsewhere in this module, an incomplete final record is ignored until an append completes it.
  } finally {
    closeSync(fd);
  }
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentMetadata, CheckpointRecord } from "./types.js";

const MAX_INLINE_BODY_BYTES = 256 * 1024;
const MAX_ACTIVITY_PREVIEW_CHARS = 12_000;

export function checkpointsStorePath(runDir: string): string {
  return join(runDir, "checkpoints.jsonl");
}

export function checkpointBodyDir(runDir: string): string {
  return join(runDir, "checkpoints");
}

export function writeCheckpoint(meta: AgentMetadata, input: { summary: string; checkpointFile?: string }): CheckpointRecord {
  const summary = input.summary.trim();
  if (!summary && !input.checkpointFile) throw new Error("Checkpoint requires a summary or --checkpoint-file.");
  const now = new Date().toISOString();
  const checkpointId = `chk_${Date.now()}_${randomBytes(4).toString("hex")}`;
  mkdirSync(meta.runDir, { recursive: true });
  mkdirSync(checkpointBodyDir(meta.runDir), { recursive: true });

  let body: string | undefined;
  let path: string | undefined;
  let source: CheckpointRecord["source"] = "inline";
  if (input.checkpointFile) {
    const sourcePath = resolve(input.checkpointFile);
    if (!existsSync(sourcePath)) throw new Error(`Checkpoint file not found: ${input.checkpointFile}`);
    body = readFileSync(sourcePath, "utf8");
    const storedName = `${checkpointId}-${safeFileName(basename(sourcePath)) || "checkpoint.md"}`;
    path = join(checkpointBodyDir(meta.runDir), storedName);
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
    source = "file";
  } else {
    body = summary;
    path = join(checkpointBodyDir(meta.runDir), `${checkpointId}.md`);
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  }

  const sizeBytes = Buffer.byteLength(body ?? "", "utf8");
  if (sizeBytes > MAX_INLINE_BODY_BYTES) body = undefined;
  const record: CheckpointRecord = {
    schemaVersion: 1,
    checkpointId,
    runId: meta.runId,
    runDir: meta.runDir,
    summary: summary || `Checkpoint from ${input.checkpointFile}`,
    body,
    path,
    source,
    createdAt: now,
    sizeBytes,
  };
  appendCheckpointRecord(meta.runDir, record);
  return record;
}

export function readCheckpoints(runDir: string): CheckpointRecord[] {
  const path = checkpointsStorePath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as CheckpointRecord; }
      catch { return undefined; }
    })
    .filter((record): record is CheckpointRecord => !!record && record.schemaVersion === 1 && typeof record.checkpointId === "string")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function latestCheckpoint(runDir: string): CheckpointRecord | undefined {
  const records = readCheckpoints(runDir);
  return records[records.length - 1];
}

export function readCheckpointBody(record: CheckpointRecord, maxChars = MAX_ACTIVITY_PREVIEW_CHARS): string {
  let text = record.body;
  if (!text && record.path && existsSync(record.path)) text = readFileSync(record.path, "utf8");
  text = text ?? "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function checkpointStoreMtime(runDir: string): number | undefined {
  const candidates = [checkpointsStorePath(runDir), checkpointBodyDir(runDir)].filter(existsSync);
  const mtimes = candidates.map((path) => statSync(path).mtimeMs);
  return mtimes.length ? Math.max(...mtimes) : undefined;
}

function appendCheckpointRecord(runDir: string, record: CheckpointRecord): void {
  writeFileSync(checkpointsStorePath(runDir), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

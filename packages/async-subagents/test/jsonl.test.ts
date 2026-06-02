import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendJsonl, atomicWriteJson, jsonlReadStatsForTest, readJsonl, resetJsonlReadStatsForTest } from "../src/jsonl.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "async-subagents-jsonl-"));
}

test("readJsonl ignores truncated final line and does not advance past it", () => {
  const dir = tempDir();
  const path = join(dir, "events.jsonl");
  appendJsonl(path, { eventId: "evt_000001", ok: true });
  const completeOffset = Buffer.byteLength(readFileSync(path));
  writeFileSync(path, '{"eventId":"evt_000002"', { flag: "a" });

  const first = readJsonl<{ eventId: string }>(path);
  assert.deepEqual(first.records.map((record) => record.eventId), ["evt_000001"]);
  assert.equal(first.nextOffset, completeOffset);
  assert.equal(first.lastId, "evt_000001");

  writeFileSync(path, ',"ok":true}\n', { flag: "a" });
  const second = readJsonl<{ eventId: string }>(path, { offset: first.nextOffset });
  assert.deepEqual(second.records.map((record) => record.eventId), ["evt_000002"]);
  assert.equal(second.lastId, "evt_000002");
});

test("readJsonl offset reads preserve tail cursor semantics without full-file reads", () => {
  const dir = tempDir();
  const path = join(dir, "events.jsonl");
  appendJsonl(path, { eventId: "evt_000001", value: 1 });
  const offset = Buffer.byteLength(readFileSync(path));
  appendJsonl(path, { eventId: "evt_000002", value: 2 });
  appendJsonl(path, { eventId: "evt_000003", value: 3 });
  const completeOffset = Buffer.byteLength(readFileSync(path));
  writeFileSync(path, '{"eventId":"evt_000004","value":4', { flag: "a" });

  resetJsonlReadStatsForTest();
  const read = readJsonl<{ eventId: string; value: number }>(path, { offset, maxRecords: 1 });

  assert.deepEqual(read.records.map((record) => record.eventId), ["evt_000002"]);
  assert.equal(read.nextOffset, offset + Buffer.byteLength(JSON.stringify({ eventId: "evt_000002", value: 2 }) + "\n"));
  assert.equal(read.lastId, "evt_000002");
  assert.equal(jsonlReadStatsForTest().fullFileReads, 0);

  const rest = readJsonl<{ eventId: string; value: number }>(path, { offset: read.nextOffset });
  assert.deepEqual(rest.records.map((record) => record.eventId), ["evt_000003"]);
  assert.equal(rest.nextOffset, completeOffset);
  assert.equal(rest.lastId, "evt_000003");
  assert.equal(jsonlReadStatsForTest().fullFileReads, 0);

  const partialOnly = readJsonl(path, { offset: completeOffset });
  assert.deepEqual(partialOnly.records, []);
  assert.equal(partialOnly.nextOffset, completeOffset);
  assert.equal(jsonlReadStatsForTest().fullFileReads, 0);

  const fileSize = Buffer.byteLength(readFileSync(path));
  const unchanged = readJsonl(path, { offset: fileSize });
  assert.deepEqual(unchanged.records, []);
  assert.equal(unchanged.nextOffset, fileSize);
  assert.equal(jsonlReadStatsForTest().fullFileReads, 0);
});

test("readJsonl offset reports absolute invalid JSONL offsets", () => {
  const dir = tempDir();
  const path = join(dir, "events.jsonl");
  appendJsonl(path, { eventId: "evt_000001", ok: true });
  const offset = Buffer.byteLength(readFileSync(path));
  writeFileSync(path, "{bad json}\n", { flag: "a" });

  assert.throws(() => readJsonl(path, { offset }), (error) => {
    assert.equal((error as { details?: { offset?: number } }).details?.offset, offset);
    return true;
  });
});

test("atomicWriteJson writes complete JSON to the target path", () => {
  const dir = tempDir();
  const path = join(dir, "status.json");
  atomicWriteJson(path, { schemaVersion: 1, value: "first" });
  atomicWriteJson(path, { schemaVersion: 1, value: "second" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schemaVersion: 1, value: "second" });
});

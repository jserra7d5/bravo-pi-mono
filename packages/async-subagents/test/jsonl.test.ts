import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendJsonl, atomicWriteJson, readJsonl } from "../src/jsonl.js";

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

test("atomicWriteJson writes complete JSON to the target path", () => {
  const dir = tempDir();
  const path = join(dir, "status.json");
  atomicWriteJson(path, { schemaVersion: 1, value: "first" });
  atomicWriteJson(path, { schemaVersion: 1, value: "second" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schemaVersion: 1, value: "second" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { MAX_UPLOAD_BYTES, receiveUpload, sanitizeUploadName, UploadError } from "../src/upload.js";

function request(body: Buffer, name: string, declared = body.length) {
  const stream = Readable.from([body]) as http.IncomingMessage;
  stream.headers = { "content-length": String(declared), "x-file-name": encodeURIComponent(name) };
  return stream;
}

test("upload sanitizes basenames and allocates collision-safe dated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-upload-"));
  const now = new Date("2026-07-12T12:00:00Z");
  const first = await receiveUpload(request(Buffer.from("one"), "../../bad<> name.txt"), root, now);
  const second = await receiveUpload(request(Buffer.from("two"), "../../bad<> name.txt"), root, now);
  assert.equal(first.path, join(root, "2026-07-12", "bad_ name.txt"));
  assert.equal(second.path, join(root, "2026-07-12", "bad_ name-1.txt"));
  assert.equal(await readFile(first.path, "utf8"), "one");
  assert.equal(sanitizeUploadName("../.."), "upload.bin");
});

test("upload rejects oversized declarations before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-upload-"));
  await assert.rejects(receiveUpload(request(Buffer.from("x"), "x", MAX_UPLOAD_BYTES + 1), root), (error: unknown) => error instanceof UploadError && error.statusCode === 413);
  assert.deepEqual(await readdir(root), []);
});

test("upload removes incomplete partial files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bw-upload-"));
  await assert.rejects(receiveUpload(request(Buffer.from("short"), "partial.txt", 10), root, new Date("2026-07-12T12:00:00Z")), /incomplete upload/u);
  assert.deepEqual(await readdir(join(root, "2026-07-12")), []);
});

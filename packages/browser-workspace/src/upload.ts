import type http from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class UploadError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function defaultDropRoot(env = process.env): string {
  const configured = env.BRAVO_BROWSER_WORKSPACE_DROP_ROOT;
  if (!configured) return join(homedir(), "tmp-agent-drops");
  return resolve(configured.replace(/^~(?=\/|$)/u, homedir()));
}

export function sanitizeUploadName(value: string): string {
  const cleaned = basename(value).replace(/[^\w.\- ]+/gu, "_").replace(/\s+/gu, " ").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "upload.bin";
}

async function reserve(dir: string, filename: string) {
  const extension = extname(filename);
  const stem = basename(filename, extension) || "upload";
  for (let index = 0; index < 1000; index += 1) {
    const path = join(dir, `${stem}${index ? `-${index}` : ""}${extension}`);
    try { return { path, handle: await open(path, "wx", 0o600) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new UploadError(409, "could not allocate upload filename");
}

export async function receiveUpload(req: http.IncomingMessage, root: string, now = new Date()) {
  const length = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(length) || length <= 0) throw new UploadError(400, "empty upload");
  if (length > MAX_UPLOAD_BYTES) throw new UploadError(413, "upload too large");
  const rawHeader = req.headers["x-file-name"];
  const encodedName = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  let decodedName = "upload.bin";
  try { decodedName = decodeURIComponent(encodedName || decodedName); } catch { throw new UploadError(400, "invalid filename"); }
  const dir = join(root, now.toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = await reserve(dir, sanitizeUploadName(decodedName));
  let received = 0;
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    callback(received > MAX_UPLOAD_BYTES ? new UploadError(413, "upload too large") : undefined, chunk);
  } });
  try {
    await pipeline(req, limiter, createWriteStream(target.path, { fd: target.handle.fd, autoClose: false }));
    if (received !== length) throw new UploadError(400, "incomplete upload");
    await target.handle.close();
    const info = await stat(target.path);
    return { path: target.path, name: basename(target.path), size: info.size };
  } catch (error) {
    await target.handle.close().catch(() => undefined);
    await unlink(target.path).catch(() => undefined);
    throw error;
  }
}

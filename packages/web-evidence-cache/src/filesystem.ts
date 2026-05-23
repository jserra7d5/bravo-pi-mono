import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function workspaceHash(cwd: string): string {
  return sha256(cwd).slice(0, 16);
}

export function createSessionId(seed?: string): string {
  return seed && seed.trim() ? seed.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) : randomUUID();
}

export function cacheRoot(cwd: string, sessionId: string): string {
  return join(tmpdir(), "pi-web-cache", workspaceHash(cwd), createSessionId(sessionId));
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeTextFile(path: string, body: string): Promise<void> {
  await ensureDir(path.slice(0, path.lastIndexOf("/")));
  await writeFile(path, body, "utf8");
}

export function pageArtifactPaths(rootDir: string, pageId: string) {
  const artifactDir = join(rootDir, "pages", pageId);
  return {
    artifactDir,
    semanticHtmlPath: join(artifactDir, "page.semantic.html"),
    markdownPath: join(artifactDir, "page.md"),
    textPath: join(artifactDir, "page.txt"),
    metadataPath: join(artifactDir, "metadata.json"),
    chunksPath: join(artifactDir, "chunks.json"),
  };
}

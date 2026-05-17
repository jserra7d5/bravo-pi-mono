import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function atomicWriteFile(path: string, data: string): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, data);
	await rename(tmp, path);
}

export function nowIso(): string {
	return new Date().toISOString();
}

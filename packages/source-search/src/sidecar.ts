import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryResponse, StatusResponse } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export class SidecarUnavailableError extends Error {}
export class SidecarProtocolError extends Error {}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export async function sourceSearchPackageRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkgJson = join(dir, "package.json");
    try {
      const raw = await readFile(pkgJson, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (parsed.name === "@bravo/source-search") return dir;
    } catch {
      // Keep walking upward; this also handles TS source loaded through jiti.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SidecarUnavailableError("Could not locate @bravo/source-search package root from extension runtime.");
}

export async function sourceSearchCliPath(): Promise<string> {
  const root = await sourceSearchPackageRoot();
  const candidates = [join(root, "dist", "src", "cli.js")];
  for (const candidate of candidates) if (await fileExists(candidate)) return candidate;
  throw new SidecarUnavailableError("Source Search CLI was not found. Run `npm run build --workspace @bravo/source-search`.");
}

export async function findSidecar(): Promise<string> {
  if (process.env.SOURCE_SEARCH_SIDECAR) return process.env.SOURCE_SEARCH_SIDECAR;
  const pkg = await sourceSearchPackageRoot();
  const platform = `${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "source-search-sidecar.exe" : "source-search-sidecar";
  const candidates = [
    join(pkg, "vendor", platform, exe),
    join(pkg, "sidecar", "target", "debug", exe),
    join(pkg, "sidecar", "target", "release", exe),
  ];
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  if (process.env.SOURCE_SEARCH_DEV === "1") return exe;
  throw new SidecarUnavailableError("Source Search sidecar binary was not found. Run `npm run build --workspace @bravo/source-search` or set SOURCE_SEARCH_SIDECAR to a built source-search-sidecar binary.");
}

export async function runSidecar<T>(args: string[], timeoutMs = 120_000): Promise<T> {
  const bin = await findSidecar();
  return await new Promise<T>((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Source Search sidecar timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch {
        reject(new SidecarProtocolError(`Source Search sidecar returned non-JSON output (exit ${code}). ${stderr.trim()}`));
        return;
      }
      if ((parsed as { protocolVersion?: unknown }).protocolVersion !== PROTOCOL_VERSION) {
        reject(new SidecarProtocolError("Source Search sidecar protocol version mismatch."));
        return;
      }
      if (code !== 0 && !(parsed as { error?: unknown }).error) {
        reject(new Error(`Source Search sidecar failed with exit ${code}.`));
        return;
      }
      resolvePromise(parsed as T);
    });
  });
}

export async function queryRepo(repo: string, query: string, limit: number, pathPrefix?: string): Promise<QueryResponse> {
  const args = ["query", "--repo", repo, "--query", query, "--limit", String(limit), "--json"];
  if (pathPrefix) args.push("--path-prefix", pathPrefix);
  return runSidecar<QueryResponse>(args);
}

export async function statusRepo(repo: string): Promise<StatusResponse> {
  return runSidecar<StatusResponse>(["status", "--repo", repo, "--json"]);
}

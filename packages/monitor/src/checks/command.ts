import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { MonitorRecord, MonitorResult, CommandCheckSpec } from "../schema/types.js";
import { generateResultId } from "../ids.js";
import { nowISO } from "../time.js";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";

function run(command: string, opts: { cwd?: string; shell?: boolean; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (opts.shell === false) {
      reject(new Error("poll monitor shell:false is not supported for command strings; omit shell or set shell:true"));
      return;
    }
    const execOptions: any = { cwd: opts.cwd || process.cwd(), timeout: opts.timeout, maxBuffer: 5_000_000, shell: getShellConfig().shell };
    exec(command, execOptions, (error: any, stdout: string | Buffer, stderr: string | Buffer) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: typeof error?.code === "number" ? error.code : 0 });
    });
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function project(output: string, projection: unknown): unknown {
  const p = projection as any;
  if (!p || p.type === "line") return output.trimEnd();
  if (p.type === "json") {
    const parsed = JSON.parse(output || "null");
    const pick = (path: string) => path.split(".").reduce((v: any, k) => v == null || !(k in Object(v)) ? null : v[k], parsed);
    return canonicalize(Object.fromEntries((p.key_paths ?? []).map((path: string) => [path, canonicalize(pick(path))])));
  }
  if (p.type === "regex") {
    const match = new RegExp(p.pattern).exec(output);
    if (!match) return null;
    if (Array.isArray(p.group_names)) return Object.fromEntries(p.group_names.map((name: string, i: number) => [name, match[i + 1]]));
    return match.slice(1);
  }
  return output.trimEnd();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function appendCapped(path: string, text: string, capBytes = 5_000_000): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const current = readFileSync(path);
    const next = Buffer.concat([current, Buffer.from(text)]);
    if (next.length > capBytes) {
      writeFileSync(path, Buffer.concat([Buffer.from("[monitor output truncated to last 5MB]\n"), next.subarray(next.length - capBytes)]));
      return;
    }
  }
  appendFileSync(path, text);
}

export async function runCommandPollCheck(record: MonitorRecord, store: JsonlMonitorStore): Promise<MonitorResult> {
  const check = record.check as CommandCheckSpec;
  const resultBase = { result_id: generateResultId(), monitor_id: record.monitor_id, created_at: nowISO() };
  try {
    const { stdout, stderr, exitCode } = await run(check.command, { cwd: check.cwd, shell: check.shell, timeout: check.timeout_ms });
    const combined = `${stdout}${stderr}`;
    if (check.output_path) {
      appendCapped(check.output_path, `\n[${nowISO()}] poll exit=${exitCode}\n${combined}`);
    }
    const projected = project(stdout || stderr, check.projection);
    const currentHash = hash({ exitCode, projected });
    const [previous] = await store.listResults(record.monitor_id, { limit: 1 });
    const previousHash = (previous?.observation as any)?.state_hash;
    const changed = previousHash !== currentHash;
    const terminalOnly = check.emit === "terminal";
    const status = exitCode === 0 ? (changed && !terminalOnly ? "matched" : "not_matched") : "error";
    return { ...resultBase, status, observation: { output_path: check.output_path, exit_code: exitCode, projected, state_hash: currentHash, changed }, condition_matched: status === "matched", triggered: status === "matched", error_message: exitCode === 0 ? undefined : `poll observer failed (exit ${exitCode})` };
  } catch (err: any) {
    return { ...resultBase, status: "error", observation: { error: err?.message ?? String(err), output_path: check.output_path }, condition_matched: false, triggered: false, error_message: err?.message ?? String(err) };
  }
}

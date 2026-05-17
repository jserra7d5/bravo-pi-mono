import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { resolveStateRoot } from "../store/state-path.js";

export type StreamMonitorState = {
  stream_id: string;
  description: string;
  command: string;
  cwd?: string;
  status: "running" | "completed" | "failed" | "stopped";
  start_time: string;
  end_time?: string;
  output_file: string;
  exit_code?: number | null;
  signal?: string | null;
  line_count: number;
};

type StreamRuntime = StreamMonitorState & {
  child: ChildProcessByStdio<null, Readable, Readable>;
  buffer: string;
  stopped: boolean;
  ctx?: any;
  pendingEvents: Array<{ line: string; source: "stdout" | "stderr"; line_count: number }>;
  flushTimer?: ReturnType<typeof setTimeout>;
  eventThrottleMs: number;
  maxLinesPerTurn: number;
};

export type StreamStartParams = {
  command: string;
  description: string;
  cwd?: string;
  timeout_ms?: number;
  notify?: boolean;
  event_throttle_ms?: number;
  max_lines_per_turn?: number;
};

function makeStreamId(): string {
  return `str-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function streamDir(root?: string): string {
  const dir = join(root ?? resolveStateRoot(), "streams");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nowISO(): string {
  return new Date().toISOString();
}

export class StreamMonitorManager {
  private pi: ExtensionAPI;
  private root?: string;
  private streams = new Map<string, StreamRuntime>();

  constructor(pi: ExtensionAPI, stateRoot?: string) {
    this.pi = pi;
    this.root = stateRoot;
  }

  list(): StreamMonitorState[] {
    return [...this.streams.values()].map(({ child: _child, buffer: _buffer, stopped: _stopped, ctx: _ctx, pendingEvents: _pendingEvents, flushTimer: _flushTimer, eventThrottleMs: _eventThrottleMs, maxLinesPerTurn: _maxLinesPerTurn, ...state }) => state);
  }

  get(streamId: string): StreamMonitorState | undefined {
    const s = this.streams.get(streamId);
    if (!s) return undefined;
    const { child: _child, buffer: _buffer, stopped: _stopped, ctx: _ctx, pendingEvents: _pendingEvents, flushTimer: _flushTimer, eventThrottleMs: _eventThrottleMs, maxLinesPerTurn: _maxLinesPerTurn, ...state } = s;
    return state;
  }

  output(streamId: string, tailBytes = 12000): string {
    const state = this.get(streamId);
    if (!state || !existsSync(state.output_file)) return "";
    const buf = readFileSync(state.output_file);
    return buf.length > tailBytes ? buf.subarray(buf.length - tailBytes).toString("utf8") : buf.toString("utf8");
  }

  start(params: StreamStartParams, ctx?: any): StreamMonitorState {
    const streamId = makeStreamId();
    const outputFile = join(streamDir(this.root), `${streamId}.log`);
    const child = spawn(params.command, {
      cwd: params.cwd || process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const runtime: StreamRuntime = {
      stream_id: streamId,
      description: params.description,
      command: params.command,
      cwd: params.cwd,
      status: "running",
      start_time: nowISO(),
      output_file: outputFile,
      line_count: 0,
      child,
      buffer: "",
      stopped: false,
      ctx,
      pendingEvents: [],
      eventThrottleMs: Math.max(0, params.event_throttle_ms ?? 1000),
      maxLinesPerTurn: Math.max(1, params.max_lines_per_turn ?? 20),
    };
    this.streams.set(streamId, runtime);

    const onData = (chunk: Buffer, source: "stdout" | "stderr") => {
      appendFileSync(outputFile, chunk);
      runtime.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = runtime.buffer.indexOf("\n")) >= 0) {
        const line = runtime.buffer.slice(0, idx).replace(/\r$/, "");
        runtime.buffer = runtime.buffer.slice(idx + 1);
        if (line.length > 0) this.deliverLine(runtime, line, source, params.notify !== false);
      }
    };

    child.stdout.on("data", (c: Buffer) => onData(c, "stdout"));
    child.stderr.on("data", (c: Buffer) => onData(c, "stderr"));
    child.on("error", (err) => {
      appendFileSync(outputFile, `\n[monitor stream error] ${err.message}\n`);
      runtime.status = "failed";
      runtime.end_time = nowISO();
      this.deliverCompletion(runtime, `Monitor "${runtime.description}" script failed: ${err.message}`, "error", params.notify !== false);
    });
    child.on("close", (code, signal) => {
      if (runtime.buffer.trim().length > 0) {
        this.deliverLine(runtime, runtime.buffer.trimEnd(), "stdout", params.notify !== false);
        runtime.buffer = "";
      }
      this.flushEvents(runtime, params.notify !== false);
      runtime.exit_code = code;
      runtime.signal = signal;
      runtime.end_time = nowISO();
      runtime.status = runtime.stopped ? "stopped" : code === 0 ? "completed" : "failed";
      const summary = runtime.status === "completed"
        ? `Monitor "${runtime.description}" stream ended`
        : runtime.status === "stopped"
          ? `Monitor "${runtime.description}" stopped`
          : `Monitor "${runtime.description}" script failed${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ""}`;
      this.deliverCompletion(runtime, summary, runtime.status === "failed" ? "error" : "info", params.notify !== false);
    });

    if (params.timeout_ms && params.timeout_ms > 0) {
      const timer = setTimeout(() => this.stop(streamId), params.timeout_ms);
      timer.unref?.();
    }

    return this.get(streamId)!;
  }

  stop(streamId: string): boolean {
    const runtime = this.streams.get(streamId);
    if (!runtime || runtime.status !== "running") return false;
    runtime.stopped = true;
    runtime.child.kill("SIGTERM");
    return true;
  }

  async stopAll(): Promise<void> {
    for (const runtime of this.streams.values()) {
      if (runtime.status === "running") {
        runtime.stopped = true;
        runtime.child.kill("SIGTERM");
      }
    }
  }

  private deliverLine(runtime: StreamRuntime, line: string, source: "stdout" | "stderr", notify: boolean): void {
    runtime.line_count++;
    if (notify && runtime.ctx?.ui?.notify) runtime.ctx.ui.notify(`${runtime.description}: ${line}`, source === "stderr" ? "warning" : "info");
    runtime.pendingEvents.push({ line, source, line_count: runtime.line_count });
    if (runtime.pendingEvents.length >= runtime.maxLinesPerTurn) {
      this.flushEvents(runtime, notify);
      return;
    }
    if (!runtime.flushTimer) {
      runtime.flushTimer = setTimeout(() => this.flushEvents(runtime, notify), runtime.eventThrottleMs);
      runtime.flushTimer.unref?.();
    }
  }

  private flushEvents(runtime: StreamRuntime, _notify: boolean): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = undefined;
    }
    if (!runtime.pendingEvents.length) return;
    const events = runtime.pendingEvents.splice(0, runtime.maxLinesPerTurn);
    const content = `Monitor stream event${events.length === 1 ? "" : "s"}: ${runtime.description}\n\n${events.map((e) => e.line).join("\n")}`;
    this.pi.sendMessage?.({
      customType: "monitor-stream-event",
      content,
      display: true,
      details: { stream_id: runtime.stream_id, description: runtime.description, events, output_file: runtime.output_file, line_count: runtime.line_count },
    }, { deliverAs: "followUp", triggerTurn: true });
    if (runtime.pendingEvents.length) {
      runtime.flushTimer = setTimeout(() => this.flushEvents(runtime, _notify), runtime.eventThrottleMs);
      runtime.flushTimer.unref?.();
    }
  }

  private deliverCompletion(runtime: StreamRuntime, summary: string, level: "info" | "error", notify: boolean): void {
    if (notify && runtime.ctx?.ui?.notify) runtime.ctx.ui.notify(summary, level);
    this.pi.sendMessage?.({
      customType: "monitor-stream-status",
      content: `${summary}\n\nOutput file: ${runtime.output_file}`,
      display: true,
      details: this.get(runtime.stream_id),
    }, { deliverAs: "followUp", triggerTurn: true });
  }
}

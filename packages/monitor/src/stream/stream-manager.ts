import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { resolveStateRoot } from "../store/state-path.js";
import type { JsonlMonitorStore } from "../store/jsonl-store.js";
import { generateEventId, generateResultId } from "../ids.js";

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
  store?: JsonlMonitorStore;
  monitorId?: string;
  notify: boolean;
  wakeAgent: boolean;
  notify_attempted: boolean;
  notify_delivered: boolean;
  notify_error?: string;
  wake_attempted: boolean;
  wake_delivered: boolean;
  wake_error?: string;
  completion_notify_attempted: boolean;
  completion_notify_delivered: boolean;
  completion_notify_error?: string;
  completion_wake_attempted: boolean;
  completion_wake_delivered: boolean;
  completion_wake_error?: string;
  closePromise: Promise<void>;
  resolveClose: () => void;
};

export type StreamStartParams = {
  command: string;
  description: string;
  cwd?: string;
  timeout_ms?: number;
  notify?: boolean;
  wake_agent?: boolean;
  wake_on_line?: boolean;
  wake_on_completion?: boolean;
  wake_on_failure?: boolean;
  event_throttle_ms?: number;
  max_lines_per_turn?: number;
  stream_id?: string;
  shell?: boolean;
  store?: JsonlMonitorStore;
  monitor_id?: string;
  output_file?: string;
};

export type StopOutcome = {
  found: boolean;
  wasRunning: boolean;
  stopped: boolean;
  timedOut: boolean;
};

function makeStreamId(): string {
  return `str-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

function streamDir(root?: string): string {
  const dir = join(root ?? resolveStateRoot(), "streams");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function monitorOutputFile(streamId: string, root?: string): string {
  const dir = join(root ?? resolveStateRoot(), "monitors", streamId);
  mkdirSync(dir, { recursive: true });
  return join(dir, "output.log");
}

function nowISO(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendCapped(path: string, chunk: string | Buffer, capBytes = 5_000_000): void {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (existsSync(path)) {
    const current = readFileSync(path);
    const next = Buffer.concat([current, incoming]);
    if (next.length > capBytes) {
      writeFileSync(path, Buffer.concat([Buffer.from("[monitor output truncated to last 5MB]\n"), next.subarray(next.length - capBytes)]));
      return;
    }
  }
  appendFileSync(path, incoming);
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
    return [...this.streams.values()].map(({ child: _child, buffer: _buffer, stopped: _stopped, ctx: _ctx, pendingEvents: _pendingEvents, flushTimer: _flushTimer, eventThrottleMs: _eventThrottleMs, maxLinesPerTurn: _maxLinesPerTurn, notify: _notify, wakeAgent: _wakeAgent, notify_attempted: _notify_attempted, notify_delivered: _notify_delivered, notify_error: _notify_error, wake_attempted: _wake_attempted, wake_delivered: _wake_delivered, wake_error: _wake_error, completion_notify_attempted: _completion_notify_attempted, completion_notify_delivered: _completion_notify_delivered, completion_notify_error: _completion_notify_error, completion_wake_attempted: _completion_wake_attempted, completion_wake_delivered: _completion_wake_delivered, completion_wake_error: _completion_wake_error, closePromise: _closePromise, resolveClose: _resolveClose, ...state }) => state);
  }

  get(streamId: string): StreamMonitorState | undefined {
    const s = this.streams.get(streamId);
    if (!s) return undefined;
    const { child: _child, buffer: _buffer, stopped: _stopped, ctx: _ctx, pendingEvents: _pendingEvents, flushTimer: _flushTimer, eventThrottleMs: _eventThrottleMs, maxLinesPerTurn: _maxLinesPerTurn, notify: _notify, wakeAgent: _wakeAgent, notify_attempted: _notify_attempted, notify_delivered: _notify_delivered, notify_error: _notify_error, wake_attempted: _wake_attempted, wake_delivered: _wake_delivered, wake_error: _wake_error, completion_notify_attempted: _completion_notify_attempted, completion_notify_delivered: _completion_notify_delivered, completion_notify_error: _completion_notify_error, completion_wake_attempted: _completion_wake_attempted, completion_wake_delivered: _completion_wake_delivered, completion_wake_error: _completion_wake_error, closePromise: _closePromise, resolveClose: _resolveClose, ...state } = s;
    return state;
  }

  output(streamId: string, tailBytes = 12000): string {
    const outputFile = this.outputFile(streamId);
    if (!existsSync(outputFile)) return "";
    const buf = readFileSync(outputFile);
    return buf.length > tailBytes ? buf.subarray(buf.length - tailBytes).toString("utf8") : buf.toString("utf8");
  }

  outputFile(streamId: string): string {
    return this.get(streamId)?.output_file ?? monitorOutputFile(streamId, this.root);
  }

  start(params: StreamStartParams, ctx?: any): StreamMonitorState {
    const streamId = params.stream_id ?? makeStreamId();
    const outputFile = params.output_file ?? monitorOutputFile(streamId, this.root);
    const child = spawn(params.command, {
      cwd: params.cwd || process.cwd(),
      shell: params.shell ?? true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
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
      store: params.store,
      monitorId: params.monitor_id ?? params.stream_id,
      notify: params.notify !== false,
      wakeAgent: params.wake_agent === true || params.wake_on_line === true || params.wake_on_completion === true || params.wake_on_failure === true,
      notify_attempted: false,
      notify_delivered: false,
      wake_attempted: false,
      wake_delivered: false,
      completion_notify_attempted: false,
      completion_notify_delivered: false,
      completion_wake_attempted: false,
      completion_wake_delivered: false,
      closePromise,
      resolveClose,
    };
    this.streams.set(streamId, runtime);

    const onData = (chunk: Buffer, source: "stdout" | "stderr") => {
      appendCapped(outputFile, chunk);
      runtime.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = runtime.buffer.indexOf("\n")) >= 0) {
        const line = runtime.buffer.slice(0, idx).replace(/\r$/, "");
        runtime.buffer = runtime.buffer.slice(idx + 1);
        if (line.length > 0) this.deliverLine(runtime, line, source, params.notify !== false, params.wake_on_line ?? params.wake_agent === true);
      }
    };

    child.stdout.on("data", (c: Buffer) => onData(c, "stdout"));
    child.stderr.on("data", (c: Buffer) => onData(c, "stderr"));
    child.on("error", async (err) => {
      appendCapped(outputFile, `\n[command monitor error] ${err.message}\n`);
      runtime.status = "failed";
      runtime.end_time = nowISO();
      const summary = `Command monitor "${runtime.description}" failed: ${err.message}`;
      this.deliverCompletion(runtime, summary, "error", params.notify !== false, params.wake_on_line === true || params.wake_on_completion === true || params.wake_on_failure === true || params.wake_agent === true);
      await this.persistCompletion(runtime, summary).catch((persistErr) => console.error("[monitor] command error persistence failed:", persistErr));
      runtime.resolveClose();
    });
    child.on("close", async (code, signal) => {
      if (runtime.buffer.trim().length > 0) {
        this.deliverLine(runtime, runtime.buffer.trimEnd(), "stdout", params.notify !== false, params.wake_on_line ?? params.wake_agent === true);
        runtime.buffer = "";
      }
      this.flushEvents(runtime, params.wake_on_line ?? params.wake_agent === true);
      runtime.exit_code = code;
      runtime.signal = signal;
      runtime.end_time = nowISO();
      runtime.status = runtime.stopped ? "stopped" : code === 0 ? "completed" : "failed";
      const summary = runtime.status === "completed"
        ? `Command monitor "${runtime.description}" completed`
        : runtime.status === "stopped"
          ? `Command monitor "${runtime.description}" stopped`
          : `Command monitor "${runtime.description}" failed${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ""}`;
      this.deliverCompletion(runtime, summary, runtime.status === "failed" ? "error" : "info", params.notify !== false, params.wake_on_completion === true || (runtime.status === "failed" && (params.wake_on_line === true || params.wake_on_failure === true)) || params.wake_agent === true);
      await this.persistCompletion(runtime, summary).catch((err) => console.error("[monitor] command completion persistence failed:", err));
      runtime.resolveClose();
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
    this.signalProcessTree(runtime, "SIGTERM");
    return true;
  }

  async stopAndWait(streamId: string, timeoutMs = 5000): Promise<StopOutcome> {
    const runtime = this.streams.get(streamId);
    if (!runtime) return { found: false, wasRunning: false, stopped: false, timedOut: false };
    const wasRunning = runtime.status === "running";
    if (!wasRunning) return { found: true, wasRunning: false, stopped: runtime.status !== "running", timedOut: false };

    runtime.stopped = true;
    this.signalProcessTree(runtime, "SIGTERM");
    await withTimeout(runtime.closePromise, timeoutMs);
    if (runtime.status !== "running") return { found: true, wasRunning, stopped: true, timedOut: false };

    this.signalProcessTree(runtime, "SIGKILL");
    await withTimeout(runtime.closePromise, timeoutMs);
    const stopped = runtime.status !== "running";
    return { found: true, wasRunning, stopped, timedOut: !stopped };
  }

  async stopAll(timeoutMs = 5000): Promise<void> {
    const waits: Promise<StopOutcome>[] = [];
    for (const runtime of this.streams.values()) {
      if (runtime.status === "running") {
        waits.push(this.stopAndWait(runtime.stream_id, timeoutMs));
      }
    }
    await Promise.all(waits);
  }

  private signalProcessTree(runtime: StreamRuntime, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && runtime.child.pid) {
      try {
        process.kill(-runtime.child.pid, signal);
        return;
      } catch {
        // Fall back to signaling the child PID below if process-group signaling is unavailable.
      }
    }
    runtime.child.kill(signal);
  }

  private deliverLine(runtime: StreamRuntime, line: string, source: "stdout" | "stderr", notify: boolean, wakeAgent: boolean): void {
    runtime.line_count++;
    if (notify) {
      runtime.notify_attempted = true;
      if (!runtime.ctx?.ui?.notify) {
        runtime.notify_error = "ui.notify unavailable";
      } else {
        try {
          runtime.ctx.ui.notify(`${runtime.description}: ${line}`, source === "stderr" ? "warning" : "info");
          runtime.notify_delivered = true;
          runtime.notify_error = undefined;
        } catch (err) {
          runtime.notify_error = errorMessage(err);
        }
      }
    }
    if (!wakeAgent) return;
    runtime.wake_attempted = true;
    runtime.pendingEvents.push({ line, source, line_count: runtime.line_count });
    if (runtime.pendingEvents.length >= runtime.maxLinesPerTurn) {
      this.flushEvents(runtime, wakeAgent);
      return;
    }
    if (!runtime.flushTimer) {
      runtime.flushTimer = setTimeout(() => this.flushEvents(runtime, wakeAgent), runtime.eventThrottleMs);
      runtime.flushTimer.unref?.();
    }
  }

  private flushEvents(runtime: StreamRuntime, wakeAgent: boolean): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = undefined;
    }
    if (!runtime.pendingEvents.length) return;
    if (!wakeAgent) {
      runtime.pendingEvents = [];
      return;
    }
    const events = runtime.pendingEvents.splice(0, runtime.maxLinesPerTurn);
    const instructions = [
      "This is control-plane evidence, not a user request.",
      "Inspect Output path with the read tool only if needed.",
      "Continue the active workstream.",
      "Tell the user only if this changes the outcome, blocks progress, or completes the task.",
    ];
    const summary = `${events.length} stream event${events.length === 1 ? "" : "s"} captured for ${runtime.description}`;
    const content = `[MONITOR EVENT — NOT USER INPUT]\n\nMonitor ID: ${runtime.stream_id}\nName: ${runtime.description}\nKind: stream\nState: event\nSummary: ${summary}\nOutput: ${runtime.output_file}\n\nInstructions:\n${instructions.map((line) => `- ${line}`).join("\n")}`;
    runtime.wake_attempted = true;
    if (!this.pi.sendMessage) {
      runtime.wake_error = "pi.sendMessage unavailable";
    } else {
      try {
        this.pi.sendMessage({
          customType: "monitor-event",
          content,
          display: true,
          details: { monitor_id: runtime.stream_id, name: runtime.description, kind: "stream", state: "event", event_type: "event", summary, output_path: runtime.output_file, event: { line_count: runtime.line_count, batch_count: events.length }, instructions },
        }, { deliverAs: "followUp", triggerTurn: true });
        runtime.wake_delivered = true;
        runtime.wake_error = undefined;
      } catch (err) {
        runtime.wake_error = errorMessage(err);
      }
    }
    if (runtime.pendingEvents.length) {
      runtime.flushTimer = setTimeout(() => this.flushEvents(runtime, wakeAgent), runtime.eventThrottleMs);
      runtime.flushTimer.unref?.();
    }
  }

  private async persistCompletion(runtime: StreamRuntime, summary: string): Promise<void> {
    if (!runtime.store || !runtime.monitorId) return;
    const type = runtime.status === "failed" ? "failed" : runtime.status === "stopped" ? "stopped" : "completed";
    await runtime.store.update(runtime.monitorId, undefined, { state: type as any, next_run_at: undefined, last_run_at: runtime.end_time, lease_id: undefined, lease_expires_at: undefined });
    await runtime.store.appendEvent({ event_id: generateEventId(), monitor_id: runtime.monitorId, type: type as any, created_at: nowISO(), payload: { output_file: runtime.output_file, exit_code: runtime.exit_code, signal: runtime.signal, summary } });
    const monitor = await runtime.store.get(runtime.monitorId);
    const attention_delivery = {
      message: monitor?.attention.message ?? summary,
      severity: (runtime.status === "failed" ? "error" : "info") as "info" | "error",
      notify_attempted: runtime.completion_notify_attempted,
      notify_delivered: runtime.completion_notify_delivered,
      notify_error: runtime.completion_notify_error,
      wake_attempted: runtime.completion_wake_attempted,
      wake_delivered: runtime.completion_wake_delivered,
      wake_error: runtime.completion_wake_error,
      target_session_id: monitor?.owner.session_id,
      target_root_session_id: monitor?.owner.root_session_id,
      delivered_at: runtime.completion_notify_delivered || runtime.completion_wake_delivered ? nowISO() : undefined,
    };
    const failed = runtime.status === "failed";
    await runtime.store.appendResult({ result_id: generateResultId(), monitor_id: runtime.monitorId, status: failed ? "error" : "matched", observation: { output_file: runtime.output_file, exit_code: runtime.exit_code, signal: runtime.signal, line_count: runtime.line_count }, condition_matched: !failed, triggered: false, created_at: nowISO(), error_message: failed ? summary : undefined, attention_delivery });
  }

  private deliverCompletion(runtime: StreamRuntime, summary: string, level: "info" | "error", notify: boolean, wakeAgent: boolean): void {
    if (notify) {
      runtime.completion_notify_attempted = true;
      if (!runtime.ctx?.ui?.notify) {
        runtime.completion_notify_error = "ui.notify unavailable";
      } else {
        try {
          runtime.ctx.ui.notify(summary, level);
          runtime.completion_notify_delivered = true;
          runtime.completion_notify_error = undefined;
        } catch (err) {
          runtime.completion_notify_error = errorMessage(err);
        }
      }
    }
    if (!wakeAgent) return;
    runtime.completion_wake_attempted = true;
    if (!this.pi.sendMessage) {
      runtime.completion_wake_error = "pi.sendMessage unavailable";
      return;
    }
    try {
      const eventType = runtime.status === "failed" ? "failed" : "ended";
      const header = eventType === "failed" ? "[MONITOR FAILED — NOT USER INPUT]" : "[MONITOR ENDED — NOT USER INPUT]";
      const instructions = [
        "This is control-plane evidence, not a user request.",
        "Inspect Output path with the read tool only if needed.",
        "Continue the active workstream.",
        "Tell the user only if this changes the outcome, blocks progress, or completes the task.",
      ];
      this.pi.sendMessage({
        customType: "monitor-event",
        content: `${header}\n\nMonitor ID: ${runtime.stream_id}\nName: ${runtime.description}\nKind: stream\nState: ${eventType}\nSummary: ${summary}\nOutput: ${runtime.output_file}\n\nInstructions:\n${instructions.map((line) => `- ${line}`).join("\n")}`,
        display: true,
        details: { monitor_id: runtime.stream_id, name: runtime.description, kind: "stream", state: eventType, event_type: eventType, summary, output_path: runtime.output_file, event: { exit_code: runtime.exit_code, signal: runtime.signal }, instructions },
      }, { deliverAs: "followUp", triggerTurn: true });
      runtime.completion_wake_delivered = true;
      runtime.completion_wake_error = undefined;
    } catch (err) {
      runtime.completion_wake_error = errorMessage(err);
    }
  }
}

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMetadata, transitionStatus, writeMetadata } from "./metadata.js";
import { readMetrics } from "./metrics.js";
import { attachTmux, captureTmux, sendTmux, stopTmux, tmuxAlive } from "./runtime/tmux.js";
import { isTerminalStatus, reconcileAgentLifecycle } from "./lifecycle.js";
import { assessResultDeliverable, validateResultContent } from "./result.js";
import { getRecipientContext, markLatestDoneHandled, markResultHandled, readAllAttentionRecords } from "./attention.js";
import { derivedAttentionState, readInboxItems } from "./inbox.js";
import type { AgentMetadata, AgentStatus, ActivityEvent, ActivitySummary, RunState } from "./types.js";

export interface TargetRef {
  name?: string;
  cwd: string;
  runId?: string;
  runDir?: string;
  env?: NodeJS.ProcessEnv;
}

export type FollowCondition = "terminal" | "result-resolved" | "attention";
export type WaitCondition = "terminal" | "result-ready" | "attention" | "blocked" | "error" | "settled" | "inbox";
export type WaitMode = "any" | "all";

export interface WaitTargetState {
  runId?: string;
  runDir: string;
  name: string;
  status: AgentStatus | "stalled" | "offline";
  resultReady: boolean;
  attention: boolean;
  inbox: boolean;
}

export interface WaitResult {
  condition: WaitCondition;
  mode: WaitMode;
  matched: WaitTargetState[];
  pending: WaitTargetState[];
  failed: WaitTargetState[];
  timedOut: boolean;
}

export function refreshRunStatus(meta: AgentMetadata): AgentMetadata {
  return reconcileAgentLifecycle(meta);
}

export function withRunMetrics(meta: AgentMetadata): AgentMetadata {
  return { ...meta, metrics: readMetrics(meta.runDir) };
}

export function buildRunState(meta: AgentMetadata): RunState {
  const refreshed = withRunMetrics(refreshRunStatus(meta));
  const assessment = assessResultDeliverable(refreshed);
  const interactiveAlive = refreshed.mode === "interactive" && tmuxAlive(refreshed.tmuxSocket, refreshed.tmuxSession);
  const oneshotTracked = refreshed.mode === "oneshot" && (refreshed.pid || refreshed.supervisorPid);
  const processState = interactiveAlive
    ? "running"
    : refreshed.status === "stopped"
      ? "stopped"
      : (refreshed.status === "done" || refreshed.status === "error")
        ? "exited"
        : oneshotTracked
          ? "running"
          : "unknown";
  const activity = summarizeActivity(refreshed);
  return {
    schemaVersion: 1,
    identity: {
      runId: refreshed.runId,
      runDir: refreshed.runDir,
      name: refreshed.name,
      role: refreshed.role,
      mode: refreshed.mode,
      harness: refreshed.harness,
      parentRunId: refreshed.parentRunId,
      parentRunDir: refreshed.parentRunDir,
      rootSessionId: refreshed.rootSessionId,
      workstreamId: refreshed.workstreamId,
      cwd: refreshed.cwd,
      task: refreshed.task,
    },
    process: {
      state: processState,
      pid: refreshed.pid,
      supervisorPid: refreshed.supervisorPid,
      tmuxSocket: refreshed.tmuxSocket,
      tmuxSession: refreshed.tmuxSession,
      interactive: refreshed.mode === "interactive" ? {
        attached: false,
        inputMode: "tmux",
      } : undefined,
      exitCode: refreshed.exitCode,
      observedAt: new Date().toISOString(),
    },
    agent: {
      state: refreshed.status,
      terminal: isTerminalStatus(refreshed.status),
      attentionRequired: refreshed.status === "blocked" || refreshed.status === "error",
      summary: refreshed.summary,
      needs: refreshed.needs,
      lastReportAt: refreshed.lastReportAt,
      updatedAt: refreshed.updatedAt,
    },
    result: {
      state: assessment.resultState,
      ready: assessment.resultReady,
      safeToRead: assessment.safeToRead,
      deliverable: assessment.deliverable,
      source: assessment.resultSource,
      path: assessment.hasResultFile ? assessment.resultFile : undefined,
      candidatePath: refreshed.resultCandidateFile,
      finalizedAt: refreshed.resultFinalizedAt ?? refreshed.resultSummaryOnlyAt,
      issue: assessment.resultIssue,
      warning: assessment.resultWarning,
      provenance: assessment.provenance,
    },
    activity,
    attention: summarizeAttention(refreshed),
    metrics: refreshed.metrics,
    next: nextAction(refreshed, assessment),
  };
}

export function readActivity(meta: AgentMetadata, options: { lines?: number; raw?: boolean; events?: boolean } = {}): { text: string; events?: ActivityEvent[]; summary: ActivitySummary } {
  const lines = Math.max(1, Math.min(options.lines ?? 200, 5000));
  const rawText = readRawActivity(meta, lines);
  const events = normalizeActivity(rawText, meta);
  if (options.events) return { text: events.map(renderActivityEvent).join("\n"), events, summary: summarizeActivity(meta) };
  if (options.raw) return { text: rawText, events, summary: summarizeActivity(meta) };
  return { text: events.map(renderActivityEvent).join("\n"), events, summary: summarizeActivity(meta) };
}

export function reportRun(runDir: string, state: AgentStatus, summary: string, options: { needs?: string; resultFile?: string; summaryOnly?: boolean; cwd?: string } = {}): AgentMetadata {
  if (!isAgentStatus(state)) throw new Error(`Invalid status: ${state}`);
  if (options.resultFile && options.summaryOnly) throw new Error("Use either --result-file or --summary-only/--no-result, not both.");
  if (options.resultFile && state !== "done") throw new Error("--result-file is only valid with `tango report done`.");
  if (options.summaryOnly && state !== "done") throw new Error("--summary-only/--no-result is only valid with `tango report done`.");
  if (state === "done") enforceDoneResultPolicy(runDir, { resultFile: options.resultFile, summaryOnly: !!options.summaryOnly });
  if (options.resultFile) finalizeResultFileBeforeDone(runDir, options.resultFile);
  else if (state === "done" && options.summaryOnly) markSummaryOnlyResult(runDir);
  else if (state === "done") captureCandidateResult(runDir);
  if (state === "done") captureInteractiveTranscript(runDir);
  const meta = transitionStatus(runDir, state, summary, { needs: options.needs });
  meta.lastReportAt = new Date().toISOString();
  writeMetadata(meta);
  return meta;
}

export function messageRun(meta: AgentMetadata, message: string): void {
  if (meta.mode !== "interactive") throw new Error(`Agent ${meta.name} is not interactive (mode=${meta.mode}). Message only works with interactive agents.`);
  sendTmux(meta.tmuxSocket, meta.tmuxSession, message);
}

export function stopRun(meta: AgentMetadata): AgentMetadata {
  if (meta.mode === "oneshot") stopOneshot(meta);
  else stopTmux(meta.tmuxSocket, meta.tmuxSession);
  transitionStatus(meta.runDir, "stopped");
  return readMetadata(meta.runDir);
}

export async function followRun(meta: AgentMetadata, until: FollowCondition, timeoutMs: number): Promise<{ state: RunState; agent: AgentMetadata; resultAssessment: ReturnType<typeof assessResultDeliverable> }> {
  const start = Date.now();
  while (true) {
    const current = withRunMetrics(refreshRunStatus(readMetadata(meta.runDir)));
    const assessment = assessResultDeliverable(current);
    const matched = until === "terminal"
      ? isTerminalStatus(current.status)
      : until === "result-resolved"
        ? assessment.safeToRead || (isTerminalStatus(current.status) && !!assessment.resultIssue)
        : current.status === "blocked" || current.status === "error";
    if (matched) {
      if (until === "terminal" && current.status === "done" && assessment.resultReady) markLatestDoneHandled(getRecipientContext(), current.runDir);
      if (until === "result-resolved" && assessment.resultReady && (current.resultFinalizedAt || current.resultSummaryOnlyAt)) markResultHandled(getRecipientContext(), current.runDir, current.resultFinalizedAt ?? current.resultSummaryOnlyAt!);
      return { state: buildRunState(current), agent: current, resultAssessment: assessment };
    }
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) throw new Error(`Timed out following ${meta.name} until ${until}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function waitRuns(targets: AgentMetadata[], condition: WaitCondition, mode: WaitMode, timeoutMs: number): Promise<WaitResult> {
  if (!targets.length) throw new Error("Target required: pass at least one target to wait on.");
  const start = Date.now();
  while (true) {
    const states = targets.map((target) => waitTargetState(withRunMetrics(refreshRunStatus(readMetadata(target.runDir)))));
    const matched = states.filter((state) => waitConditionMet(state, condition));
    const pending = states.filter((state) => !waitConditionMet(state, condition));
    const done = mode === "any" ? matched.length > 0 : pending.length === 0;
    if (done) return { condition, mode, matched, pending, failed: [], timedOut: false };
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) return { condition, mode, matched, pending, failed: [], timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function waitTargetState(meta: AgentMetadata): WaitTargetState {
  const assessment = assessResultDeliverable(meta);
  const derived = derivedAttentionState(meta);
  const unresolvedInbox = readInboxItems().some((item) =>
    item.state !== "handled" && item.state !== "dismissed" && resolve(item.source.runDir) === resolve(meta.runDir)
  );
  return {
    runId: meta.runId,
    runDir: meta.runDir,
    name: meta.name,
    status: derived ?? meta.status,
    resultReady: assessment.safeToRead || assessment.resultReady,
    attention: meta.status === "blocked" || meta.status === "error" || derived === "stalled" || derived === "offline" || unresolvedInbox,
    inbox: unresolvedInbox,
  };
}

function waitConditionMet(state: WaitTargetState, condition: WaitCondition): boolean {
  switch (condition) {
    case "terminal": return state.status === "done" || state.status === "error" || state.status === "stopped";
    case "result-ready": return state.resultReady;
    case "attention": return state.attention;
    case "blocked": return state.status === "blocked";
    case "error": return state.status === "error";
    case "settled": return state.status === "done" || state.status === "error" || state.status === "stopped" || state.attention;
    case "inbox": return state.inbox;
  }
}

export function attachRun(meta: AgentMetadata): void {
  if (meta.mode !== "interactive") throw new Error(`Agent ${meta.name} is not interactive (mode=${meta.mode}). Attach only works with interactive agents.`);
  attachTmux(meta.tmuxSocket, meta.tmuxSession);
}

function nextAction(meta: AgentMetadata, assessment: ReturnType<typeof assessResultDeliverable>) {
  if (meta.status === "blocked") return { recommended: "message", reason: meta.needs ?? "agent is blocked" };
  if (!assessment.safeToRead) return { recommended: "follow", until: "result-resolved" };
  if (assessment.safeToRead) return { recommended: "result" };
  return { recommended: "inspect" };
}

function summarizeAttention(meta: AgentMetadata) {
  const records = readAllAttentionRecords().filter((r) => r.targetRunDir === meta.runDir && !["handled", "dismissed", "superseded"].includes(r.state));
  return {
    requested: meta.status === "blocked" || meta.status === "error" || records.length > 0,
    needs: meta.needs,
    pending: records.length,
    records: records.slice(-10),
  };
}

function summarizeActivity(meta: AgentMetadata): ActivitySummary {
  const sources = ["final-pane.log", "tmux.log", "output.log", "result.md"].filter((file) => existsSync(join(meta.runDir, file)));
  const latest = sources.map((file) => ({ file, mtime: statSync(join(meta.runDir, file)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  return {
    available: sources.length > 0 || (meta.mode === "interactive" && tmuxAlive(meta.tmuxSocket, meta.tmuxSession)),
    sources,
    latestSource: latest?.file,
    updatedAt: latest ? new Date(latest.mtime).toISOString() : undefined,
    recommended: "tango activity",
  };
}

function readRawActivity(meta: AgentMetadata, lines: number): string {
  if (meta.mode === "interactive" && tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) return captureTmux(meta.tmuxSocket, meta.tmuxSession, lines);
  for (const file of ["final-pane.log", "tmux.log", "output.log", "result.md"]) {
    const path = join(meta.runDir, file);
    if (existsSync(path)) return tailFileByLines(path, lines);
  }
  return "";
}

function normalizeActivity(raw: string, meta: AgentMetadata): ActivityEvent[] {
  const lines = raw.split(/\r?\n/).map(cleanActivityLine).filter(Boolean).slice(-500);
  return lines.map((text, index) => ({
    schemaVersion: 1,
    eventId: `act_${index}`,
    time: undefined,
    runId: meta.runId,
    runDir: meta.runDir,
    kind: classifyActivityLine(text),
    text,
  }));
}

function renderActivityEvent(event: ActivityEvent): string {
  const prefix = event.kind === "tool" ? "[tool] " : event.kind === "error" ? "[error] " : "";
  return `${prefix}${event.text}`;
}

function cleanActivityLine(line: string): string {
  let text = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
  if (!text.trim()) return "";
  if (/"encrypted_content"\s*:/.test(text)) return "[redacted encrypted reasoning payload]";
  if (/"thinkingSignature"\s*:/.test(text)) return "[redacted reasoning signature]";
  if (/"(apiKey|token|authorization|password|secret)"\s*:/i.test(text)) return "[redacted sensitive activity line]";
  if (text.length > 2000) text = `${text.slice(0, 2000)}…`;
  return text;
}

function classifyActivityLine(text: string): ActivityEvent["kind"] {
  if (/error|failed|exception/i.test(text)) return "error";
  if (/tool(Call|Result|_use)|Executing|bash|read|edit/i.test(text)) return "tool";
  if (/^\{|^\[/.test(text)) return "harness";
  return "message";
}

function enforceDoneResultPolicy(runDir: string, options: { resultFile?: string; summaryOnly: boolean }): void {
  const meta = readMetadata(runDir);
  if (isFinalStatus(meta.status)) {
    if (meta.status !== "done") throw new Error(`Cannot transition terminal agent status from ${meta.status} to done. Terminal statuses are sticky.`);
    if (options.resultFile || options.summaryOnly) throw new Error("Cannot finalize a result for an agent that is already done; done finalization is immutable.");
  }
  if (options.resultFile) return;
  if (options.summaryOnly) {
    if (meta.resultRequired) throw new Error("This agent was started with a required deliverable. Finish with `tango report done --result-file <path> \"summary\"`; --summary-only is not allowed for this run.");
    return;
  }
  if (meta.resultRequired) {
    captureCandidateResult(runDir);
    throw new Error("This agent was started with a required deliverable. A transcript-derived result candidate was captured, but the run cannot be marked done until it finishes with `tango report done --result-file <path> \"summary\"`.");
  }
}

function markSummaryOnlyResult(runDir: string): void {
  const meta = readMetadata(runDir);
  meta.resultSummaryOnlyAt = new Date().toISOString();
  meta.resultSource = "summary-only";
  delete meta.resultFinalizedAt;
  delete meta.resultFile;
  delete meta.resultIssue;
  delete meta.resultCandidateFile;
  writeMetadata(meta);
}

function finalizeResultFileBeforeDone(runDir: string, resultFileFlag: string): void {
  const source = resolve(resultFileFlag);
  if (!existsSync(source)) throw new Error(`Result file not found: ${resultFileFlag}`);
  const resultText = readFileSync(source, "utf8");
  const meta = readMetadata(runDir);
  const validation = validateResultContent(meta, resultText, { enforceRequired: true });
  if (!validation.ok) throw new Error(validation.issue ?? "Invalid result deliverable.");
  const resultFile = join(runDir, "result.md");
  writeFileSync(resultFile, resultText, "utf8");
  meta.resultFile = resultFile;
  meta.resultFinalizedAt = new Date().toISOString();
  meta.resultSource = "result-file";
  delete meta.resultIssue;
  delete meta.resultCandidateFile;
  writeMetadata(meta);
}

function captureCandidateResult(runDir: string): void {
  const meta = readMetadata(runDir);
  if (meta.mode !== "interactive") return;
  const transcript = captureInteractiveTranscript(runDir) || readRawActivity(meta, 5000);
  const candidateText = extractCandidateFromTranscript(transcript, meta.summary);
  const candidatePath = join(runDir, "result.candidate.md");
  writeFileSync(candidatePath, candidateText, "utf8");
  meta.resultCandidateFile = candidatePath;
  meta.resultSource = "interactive-transcript";
  meta.resultIssue = candidateText.trim()
    ? "Interactive agent reported done without --result-file; transcript-derived result candidate requires review/finalization."
    : "Interactive agent reported done without --result-file and no transcript-derived result candidate could be extracted.";
  meta.resultProvenance = {
    source: "interactive-transcript",
    sourceEventIds: [],
    confidence: candidateText.trim().length > 240 ? "medium" : "low",
    extractor: "controlPlane.extractCandidateFromTranscript.v1",
    validation: { ok: false, issue: meta.resultIssue },
  };
  writeMetadata(meta);
}

function extractCandidateFromTranscript(transcript: string, summary?: string): string {
  const cleaned = transcript.split(/\r?\n/).map(cleanActivityLine).filter((line) => line && !line.startsWith("[redacted ")).join("\n").trim();
  if (!cleaned) return summary?.trim() ? `# Transcript-derived result candidate\n\n${summary.trim()}\n` : "";
  const lines = cleaned.split(/\r?\n/);
  const tail = lines.slice(-160).join("\n").trim();
  return `# Transcript-derived result candidate\n\n${tail}\n`;
}

function captureInteractiveTranscript(runDir: string): string | undefined {
  const meta = readMetadata(runDir);
  if (meta.mode !== "interactive") return undefined;
  if (!tmuxAlive(meta.tmuxSocket, meta.tmuxSession)) return undefined;
  try {
    const text = captureTmux(meta.tmuxSocket, meta.tmuxSession, 5000);
    writeFileSync(join(runDir, "final-pane.log"), text, "utf8");
    return text;
  } catch {
    return undefined;
  }
}

function stopOneshot(meta: AgentMetadata): void {
  const log = join(meta.runDir, "supervisor.log");
  const note = (message: string) => writeFileSync(log, `${new Date().toISOString()} stop: ${message}\n`, { flag: "a" });
  for (const pid of [meta.pid, meta.supervisorPid]) {
    if (!pid) continue;
    try { process.kill(pid, "SIGTERM"); note(`sent SIGTERM to pid ${pid}`); }
    catch (error) { note(`pid ${pid} SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (meta.supervisorPid) {
    try { process.kill(-meta.supervisorPid, "SIGTERM"); note(`sent SIGTERM to process group ${meta.supervisorPid}`); }
    catch (error) { note(`process group ${meta.supervisorPid} SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const resultFile = join(meta.runDir, "result.md");
  if (!meta.resultFinalizedAt) {
    const current = readMetadata(meta.runDir);
    current.resultFile = resultFile;
    current.resultFinalizedAt = new Date().toISOString();
    current.resultIssue = "Oneshot agent was stopped before producing a finalized result.";
    if (!existsSync(resultFile)) writeFileSync(resultFile, "", "utf8");
    writeMetadata(current);
  }
}

function tailFileByLines(path: string, lines: number, maxBytes = 512 * 1024): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const prefix = start > 0 ? "[output truncated to tail]\n" : "";
    const parts = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (parts[parts.length - 1] === "") parts.pop();
    return prefix + parts.slice(-lines).join("\n");
  } finally {
    closeSync(fd);
  }
}

function isAgentStatus(value: string): value is AgentStatus {
  return ["created", "running", "blocked", "done", "error", "stopped"].includes(value);
}

function isFinalStatus(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

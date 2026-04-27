export type AgentMode = "oneshot" | "interactive";
export type AgentStatus = "created" | "running" | "done" | "error" | "blocked" | "stopped" | "unknown";
export type OrchestrationPolicy = "none" | "cli" | "tools" | "auto";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ResultParser = "pi-json" | "claude-stream-json" | "plain";
export type ResultSource = "result-file" | "interactive-transcript" | "oneshot-final-event" | "recovered-log" | "summary-only";

export interface RootSessionIdentity {
  rootSessionId: string;
  workstreamId?: string;
  origin: "pi" | "claude" | "gemini" | "generic" | "cli" | "dashboard" | "sdk";
  cwd?: string;
  title?: string;
  ownerProcess?: {
    pid?: number;
    command?: string;
    harness?: string;
  };
}

export interface ResultProvenance {
  source: Exclude<ResultSource, "summary-only">;
  sourceEventIds: string[];
  transcriptWindow?: { fromEventId: string; toEventId: string };
  confidence: "high" | "medium" | "low";
  extractor: string;
  validation: {
    ok: boolean;
    issue?: string;
    warning?: string;
  };
}

export interface ActivityEvent {
  schemaVersion: 1;
  eventId: string;
  time?: string;
  runId?: string;
  runDir: string;
  kind: "message" | "tool" | "error" | "harness";
  text: string;
}

export interface ActivitySummary {
  available: boolean;
  sources?: string[];
  latestSource?: string;
  updatedAt?: string;
  recommended: string;
}

export interface AttentionSummary {
  requested: boolean;
  needs?: string;
  pending?: number;
  records?: unknown[];
}

export interface NextAction {
  recommended: string;
  reason?: string;
  until?: string;
}

export interface RunState {
  schemaVersion: 1;
  identity: {
    runId?: string;
    runDir: string;
    name: string;
    role?: string;
    mode: AgentMode;
    harness: string;
    parentRunId?: string;
    parentRunDir?: string;
    rootSessionId?: string;
    workstreamId?: string;
    cwd: string;
    task: string;
  };
  process: {
    state: "starting" | "running" | "exited" | "lost" | "stopped" | "unknown";
    pid?: number;
    supervisorPid?: number;
    tmuxSocket?: string;
    tmuxSession?: string;
    interactive?: {
      attached: boolean;
      lastPaneCaptureAt?: string;
      inputMode?: "tmux" | "server-mediated";
    };
    exitCode?: number | null;
    signal?: string | null;
    observedAt: string;
    issue?: string;
  };
  agent: {
    state: AgentStatus;
    terminal: boolean;
    attentionRequired?: boolean;
    summary?: string;
    needs?: string;
    lastReportAt?: string;
    updatedAt: string;
  };
  result: {
    state: "none" | "capturing" | "candidate" | "available" | "invalid" | "failed" | "summary-only";
    ready: boolean;
    safeToRead: boolean;
    deliverable: boolean;
    source?: ResultSource;
    path?: string;
    candidatePath?: string;
    finalizedAt?: string;
    issue?: string;
    warning?: string;
    provenance?: ResultProvenance;
  };
  activity: ActivitySummary;
  attention: AttentionSummary;
  metrics?: AgentMetricsSnapshot;
  next: NextAction;
}

export interface RoleConfig {
  name: string;
  description?: string;
  harness?: string;
  mode?: AgentMode;
  model?: string;
  thinking?: ThinkingLevel;
  effort?: string;
  tools?: string[];
  contextFiles?: boolean;
  skills?: string[];
  extensions?: string[];
  includes?: string[];
  recursive?: boolean;
  orchestration?: OrchestrationPolicy;
  allowedChildRoles?: string[];
  body: string;
  filePath: string;
}

export interface AgentMetricsSnapshot {
  schemaVersion: 1;
  runDir: string;
  agent: string;
  startedAt: string;
  updatedAt: string;
  toolCalls: number;
  toolResults: number;
  activeToolCalls: number;
  toolErrors?: number;
  lastTool?: string;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  context?: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
  };
  cost?: {
    total: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AgentMetadata {
  name: string;
  role?: string;
  harness: string;
  mode: AgentMode;
  status: AgentStatus;
  cwd: string;
  task: string;
  runDir: string;
  homeDir: string;
  tmuxSocket: string;
  tmuxSession: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  thinking?: ThinkingLevel;
  effort?: string;
  pid?: number;
  supervisorPid?: number;
  exitCode?: number | null;
  summary?: string;
  needs?: string;
  runId?: string;
  parentRunId?: string;
  parentRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  resultFile?: string;
  resultFinalizedAt?: string;
  resultSummaryOnlyAt?: string;
  resultCandidateFile?: string;
  resultSource?: ResultSource;
  resultProvenance?: ResultProvenance;
  resultRequired?: boolean;
  resultIssue?: string;
  lastReportAt?: string;
  metrics?: AgentMetricsSnapshot;
}

export interface StartOptions {
  name: string;
  roleName?: string;
  harness?: string;
  mode?: AgentMode;
  model?: string;
  thinking?: ThinkingLevel;
  effort?: string;
  cwd: string;
  task: string;
  clean?: boolean;
  attach?: boolean;
  json?: boolean;
  dryRun?: boolean;
  recursive?: boolean;
  resultRequired?: boolean;
  parentRunId?: string;
  parentRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  resultParser?: ResultParser;
}

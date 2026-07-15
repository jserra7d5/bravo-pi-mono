export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export type RunState =
  | "created"
  | "queued"
  | "running"
  | "idle"
  | "waiting_for_input"
  | "paused"
  | "blocked"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type TerminalRunState = "completed" | "failed" | "cancelled" | "expired";
export type ClaudeLivenessState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_for_input"
  | "ack_pending"
  | "rate_limited"
  | "comatose"
  | "stale_transport"
  | "orphaned_process"
  | "paused"
  | TerminalRunState;

export type EventType =
  | "started"
  | "progress"
  | "status"
  | "message.received"
  | "message.handled"
  | "message.rejected"
  | "question"
  | "blocked"
  | "artifact"
  | "result"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "heartbeat"
  | "liveness";

export type InboxMessageType = "instruction" | "answer" | "cancel" | "pause" | "resume" | "context";
export type ParentMessageType = "instruction" | "answer" | "context";

export type AgentMode = "oneshot" | "interactive";
export type AgentHarness = "pi" | "claude";
export type LaunchHarness = AgentHarness | "claude-tmux-interactive" | "claude-stdio-oneshot";
export type ResultParser = "mcp-terminal" | "stdio-exit";
export type ClaudeMode = AgentMode;
export type ClaudeExecutionMode = "dangerous-auth";
export type ClaudeAuthHome = "seeded-run-home" | "operator-home";
export type ClaudeMemoryIsolation = "best-effort-non-bare";
export interface ClaudeInstalledSkill {
  name: string;
  sourcePath: string;
  targetPath: string;
  compatibility: "claude-native" | "pi-style";
}
export interface ClaudeDefinitionOptions {
  executionMode?: ClaudeExecutionMode;
  authHome?: ClaudeAuthHome;
  mode?: ClaudeMode;
}
export interface HarnessBoundaryProvenance {
  field: string;
  source: "base" | "variant" | "defaultConfig" | "environment";
  reason: "pi-only" | "harness-boundary" | "neutral-compatible";
}
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max" | string;
export type ContextPolicy = "fresh" | "fork";
export type SessionPolicy = "record" | "none";
export type AgentDefinitionSource = "project" | "user" | "builtin";
export type CwdPolicy = "inherit" | "explicit" | "sandbox";
export type ResultFormat = "text" | "json" | "files";
export type WriterRole = "launcher" | "child-runtime" | "parent-runtime";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ArtifactRef {
  artifactId: string;
  kind: string;
  path: string;
  mime?: string;
  bytes?: number;
}

export interface AttachmentRef {
  kind: string;
  path?: string;
  uri?: string;
  name?: string;
}

export interface TokenMetrics {
  input?: number;
  output?: number;
  total?: number;
}

export interface CostMetrics {
  total?: number;
}

export interface RunMetrics {
  tokens?: TokenMetrics;
  cost?: CostMetrics;
  toolCalls?: number;
}

export interface FastTrackLaunch {
  requested: boolean;
  enabled: boolean;
  applied: boolean;
  reason?: "not_requested" | "disabled" | "ineligible_model";
  serviceTier?: "priority";
}

export interface RunStatus {
  schemaVersion: SchemaVersion;
  runId: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  runRoot?: string;
  displayName?: string;
  namePack?: string;
  agent: {
    name: string;
    source: AgentDefinitionSource;
    definitionPath: string;
    mode: AgentMode;
    variant?: string;
  };
  harness?: AgentHarness;
  launchHarness?: LaunchHarness;
  variant?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  thinkingLevel?: ThinkingLevel;
  effort?: ClaudeEffort;
  executionMode?: ClaudeExecutionMode;
  resultParser?: ResultParser;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  continuedFromRunId?: string;
  continuationRootRunId?: string;
  continuationSequence?: number;
  continuationOfPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: { allowed: boolean; used: boolean; reason?: string } | null;
  fastTrack?: FastTrackLaunch;
  userBuiltinTools: string[];
  runtimeBuiltinTools: string[];
  runtimeExtensionPaths: string[];
  resolvedSkills?: string[];
  notInheritedAcrossHarness?: HarnessBoundaryProvenance[];
  excludedAcrossHarness?: HarnessBoundaryProvenance[];
  inheritedAcrossHarness?: HarnessBoundaryProvenance[];
  claudeHomeDir?: string;
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  claudeAuthHome?: ClaudeAuthHome;
  claudeMemoryIsolation?: ClaudeMemoryIsolation;
  claudeShellHomeDir?: string;
  claudeShellWrapperPath?: string;
  claudeTransport?: "mcp" | "none";
  claudeInstalledSkills?: ClaudeInstalledSkill[];
  launchLogPath?: string;
  inboxPath?: string;
  /** Authoritative prompt-enforced write scope when specified; not an OS sandbox. */
  allowedFiles?: string[];
  protectedPaths?: string[];
  state: RunState;
  writerRole?: WriterRole;
  pid?: number;
  supervisorPid?: number;
  supervisorHost?: string;
  supervisorStartedAtToken?: string;
  childPid?: number;
  panePid?: number;
  processGroupId?: number;
  tmuxSocket?: string;
  tmuxSession?: string;
  tmuxPane?: string;
  transcriptPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  processHealth?: "unknown" | "alive" | "dead";
  livenessState?: ClaudeLivenessState;
  lastTerminalOutputAt?: string;
  terminalOutputBytes?: number;
  lastMcpCallAt?: string;
  lastNudgeAt?: string;
  lastProbeAt?: string;
  outputBytesSinceNudge?: number;
  rateLimitResumeAt?: string | null;
  pendingAckMessageIds?: string[];
  livenessReason?: string | null;
  effectiveMaxRunMs?: number;
  timeout?: { softWarningAt?: string; hardTimeoutAt?: string; pausedAt?: string; additionalRunSeconds?: number; reason?: string } | null;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastEventId?: string;
  summary?: string;
  needs?: string | null;
  currentTool?: { name: string; startedAt: string } | null;
  metrics?: RunMetrics;
  resultReady: boolean;
  error?: { code: string; message: string; details?: unknown } | null;
}

export interface RunEvent {
  schemaVersion: SchemaVersion;
  eventId: string;
  runId: string;
  parentRunId: string;
  type: EventType;
  level?: "debug" | "info" | "warn" | "error";
  createdAt: string;
  summary?: string;
  body?: string;
  wake?: boolean;
  data?: Record<string, unknown>;
}

export interface InboxMessage {
  schemaVersion: SchemaVersion;
  messageId: string;
  toRunId: string;
  fromRunId: string;
  type: InboxMessageType;
  createdAt: string;
  body: string;
  attachments: AttachmentRef[];
  requiresAck: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface RunResult {
  schemaVersion: SchemaVersion;
  runId: string;
  parentRunId: string;
  agentName: string;
  displayName?: string;
  namePack?: string;
  harness?: AgentHarness;
  launchHarness?: LaunchHarness;
  variant?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  thinkingLevel?: ThinkingLevel;
  effort?: ClaudeEffort;
  executionMode?: ClaudeExecutionMode;
  resultParser?: ResultParser;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  continuedFromRunId?: string;
  continuationRootRunId?: string;
  continuationSequence?: number;
  continuationOfPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: { allowed: boolean; used: boolean; reason?: string } | null;
  fastTrack?: FastTrackLaunch;
  resolvedSkills?: string[];
  notInheritedAcrossHarness?: HarnessBoundaryProvenance[];
  excludedAcrossHarness?: HarnessBoundaryProvenance[];
  inheritedAcrossHarness?: HarnessBoundaryProvenance[];
  claudeHomeDir?: string;
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  claudeAuthHome?: ClaudeAuthHome;
  claudeMemoryIsolation?: ClaudeMemoryIsolation;
  claudeShellHomeDir?: string;
  claudeShellWrapperPath?: string;
  claudeTransport?: "mcp" | "none";
  claudeInstalledSkills?: ClaudeInstalledSkill[];
  livenessState?: ClaudeLivenessState;
  lastTerminalOutputAt?: string;
  terminalOutputBytes?: number;
  lastMcpCallAt?: string;
  lastNudgeAt?: string;
  pendingAckMessageIds?: string[];
  livenessReason?: string | null;
  supervisorPid?: number;
  childPid?: number;
  panePid?: number;
  processGroupId?: number;
  tmuxSocket?: string;
  tmuxSession?: string;
  tmuxPane?: string;
  transcriptPath?: string;
  state: TerminalRunState;
  success: boolean;
  createdAt: string;
  durationMs?: number;
  effectiveMaxRunMs?: number;
  timeout?: { softWarningAt?: string; hardTimeoutAt?: string; pausedAt?: string; additionalRunSeconds?: number; reason?: string } | null;
  summary?: string;
  body?: string;
  artifacts: ArtifactRef[];
  metrics?: RunMetrics;
  error?: { code: string; message: string; details?: unknown; recovered?: boolean } | null;
}

export interface WaitCursor {
  eventOffset: number;
  lastEventId?: string;
}

export type WaitCursorMap = Record<string, WaitCursor>;

export interface RunPaths {
  runRoot: string;
  runDir: string;
  inboxPath: string;
  eventsPath: string;
  statusPath: string;
  resultPath: string;
  artifactsDir: string;
  logsDir: string;
  piSessionDir: string;
  requestedPiSessionPath: string;
  piSessionPath: string;
}

export interface RunIndexRecord {
  schemaVersion: SchemaVersion;
  runId: string;
  runDir: string;
  projectRoot: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  contextPolicy?: ContextPolicy;
  sessionPolicy?: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  continuedFromRunId?: string;
  continuationRootRunId?: string;
  continuationSequence?: number;
  continuationOfPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  createdAt: string;
}

export interface ArchiveIndexRecord {
  schemaVersion: SchemaVersion;
  runId: string;
  agentName: string;
  state: TerminalRunState;
  createdAt: string;
  archivedAt: string;
  projectScope: string;
  archivePath: string;
}

export interface DeliverySubscription {
  schemaVersion: SchemaVersion;
  parentRunId: string;
  runId: string;
  notifyOn: EventType[];
  createdAt: string;
}

export interface DeliveryMetadata {
  schemaVersion: SchemaVersion;
  runId: string;
  deliveryKey: string;
  deliveredAt: string;
  ownerId: string;
}

export interface RootSessionIdentity {
  schemaVersion: SchemaVersion;
  rootSessionId: string;
  parentRunId: string;
  cwd: string;
  /**
   * Pi's durable session id for the lead session that owns this async root.
   * Older roots and non-Pi callers may not have one; Pi extension startup must
   * pass it so concurrent/resumed sessions in the same workspace stay isolated.
   */
  piSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RootSessionLease {
  schemaVersion: SchemaVersion;
  leaseId: string;
  ownerId: string;
  rootSessionId: string;
  cwd: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type TaskStatus = "open" | "active" | "blocked" | "done" | "failed" | "cancelled";
export type TaskReadiness = "ready" | "waiting" | null;
export type DerivedTaskState = TaskReadiness;
export type TaskEventType = "task.created" | "task.updated" | "task.done" | "task.failed" | "task.cancelled" | "task.invalidated";

export interface TaskRecord {
  schemaVersion: SchemaVersion;
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependsOn: string[];
  notes?: string;
  activeForm?: string;
  lastAttemptRunIds?: string[];
  receiptPaths?: string[];
  artifactPaths?: string[];
  evidence?: string[];
  createdBy: string;
  parentRunId: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskView = TaskRecord & {
  readiness: TaskReadiness;
  blockedBy: string[];
};

export interface TaskEvent {
  schemaVersion: SchemaVersion;
  eventId: string;
  sequence: number;
  rootSessionId: string;
  parentRunId: string;
  taskId: string;
  type: TaskEventType;
  summary: string;
  actor?: string;
  runId?: string;
  wake?: boolean;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface SubagentStartResult {
  runId: string;
  runDir: string;
  agentName: string;
  displayName?: string;
  namePack?: string;
  harness?: AgentHarness;
  launchHarness?: LaunchHarness;
  variant?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  thinkingLevel?: ThinkingLevel;
  effort?: ClaudeEffort;
  executionMode?: ClaudeExecutionMode;
  resultParser?: ResultParser;
  state: RunState;
  started: boolean;
  waited: boolean;
  waitResult?: SubagentWaitResult;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  continuedFromRunId?: string;
  continuationRootRunId?: string;
  continuationSequence?: number;
  continuationOfPiSessionPath?: string;
  // Agent-definition detail surfaced to the launch card so the user can see what skills/tools
  // the child has, its budget, and any nested subagent depth limit.
  skills?: string[];
  resolvedSkills?: string[];
  tools?: string[];
  notInheritedAcrossHarness?: HarnessBoundaryProvenance[];
  excludedAcrossHarness?: HarnessBoundaryProvenance[];
  inheritedAcrossHarness?: HarnessBoundaryProvenance[];
  claudeHomeDir?: string;
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  claudeAuthHome?: ClaudeAuthHome;
  claudeMemoryIsolation?: ClaudeMemoryIsolation;
  claudeShellHomeDir?: string;
  claudeShellWrapperPath?: string;
  claudeTransport?: "mcp" | "none";
  claudeInstalledSkills?: ClaudeInstalledSkill[];
  livenessState?: ClaudeLivenessState;
  lastTerminalOutputAt?: string;
  terminalOutputBytes?: number;
  lastMcpCallAt?: string;
  lastNudgeAt?: string;
  pendingAckMessageIds?: string[];
  livenessReason?: string | null;
  supervisorPid?: number;
  childPid?: number;
  panePid?: number;
  processGroupId?: number;
  tmuxSocket?: string;
  tmuxSession?: string;
  tmuxPane?: string;
  transcriptPath?: string;
  maxRunSeconds?: number;
  effectiveMaxRunMs?: number;
  maxSubagentDepth?: number;
  fastTrack?: FastTrackLaunch;
  task?: { taskId: string; title: string };
  next: Array<{ tool: string; args: Record<string, unknown> }>;
}

export interface SubagentWaitResult {
  state: "ready" | "timeout";
  mode: "race" | "all" | "each";
  readyRunIds: string[];
  events: RunEvent[];
  results: RunResult[];
  statuses: Array<Pick<RunStatus, "runId" | "state" | "summary" | "displayName" | "namePack">>;
  cursors: WaitCursorMap;
  remainingRunIds: string[];
  timedOut: boolean;
  next: Array<{ tool: string; args: Record<string, unknown> }>;
}

export interface SubagentMessageResult {
  messageId: string;
  runId: string;
  appended: boolean;
  liveDelivered: boolean;
  unsupported?: {
    code: "LIVE_MESSAGE_UNSUPPORTED";
    message: string;
  };
  ackEventId?: string;
}

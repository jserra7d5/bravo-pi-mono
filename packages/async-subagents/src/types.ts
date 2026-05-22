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

export type EventType =
  | "started"
  | "progress"
  | "status"
  | "message.received"
  | "question"
  | "blocked"
  | "artifact"
  | "result"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "heartbeat";

export type InboxMessageType = "instruction" | "answer" | "cancel" | "pause" | "resume" | "context";
export type ParentMessageType = "instruction" | "answer" | "context";

export type AgentMode = "oneshot" | "interactive";
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

export interface RunStatus {
  schemaVersion: SchemaVersion;
  runId: string;
  parentRunId: string;
  rootRunId?: string;
  rootSessionId?: string;
  displayName?: string;
  namePack?: string;
  agent: {
    name: string;
    source: AgentDefinitionSource;
    definitionPath: string;
    mode: AgentMode;
    variant?: string;
  };
  variant?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: { allowed: boolean; used: boolean; reason?: string } | null;
  userBuiltinTools: string[];
  runtimeBuiltinTools: string[];
  runtimeExtensionPaths: string[];
  launchLogPath?: string;
  inboxPath?: string;
  state: RunState;
  writerRole?: WriterRole;
  pid?: number;
  processHealth?: "unknown" | "alive" | "dead";
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
  variant?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: { allowed: boolean; used: boolean; reason?: string } | null;
  state: TerminalRunState;
  success: boolean;
  createdAt: string;
  durationMs?: number;
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
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  createdAt: string;
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

export interface SubagentStartResult {
  runId: string;
  runDir: string;
  agentName: string;
  displayName?: string;
  namePack?: string;
  variant?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  state: RunState;
  started: boolean;
  waited: boolean;
  waitResult?: SubagentWaitResult;
  contextPolicy: ContextPolicy;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  // Agent-definition detail surfaced to the launch card so the user can see what skills/tools
  // the child has, its budget, and any nested subagent depth limit.
  skills?: string[];
  tools?: string[];
  maxRunMs?: number;
  maxSubagentDepth?: number;
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

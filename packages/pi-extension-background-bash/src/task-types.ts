export type TaskStatus = "starting" | "running" | "blocked" | "exited" | "failed" | "timed_out" | "killed" | "orphaned" | "unknown";

export type StopReason = "timeout" | "output_cap" | "interactive_prompt" | "user" | "shutdown";

export interface BackgroundTaskRecord {
  schemaVersion: 1;
  taskId: string;
  command: string;
  cwd: string;
  ownerSessionId?: string;
  ownerSessionFile?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  pgid?: number;
  processStartTime?: number;
  processCommandLine?: string;
  ownerRuntimeId?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  outputPath: string;
  metadataPath: string;
  outputBytes: number;
  maxOutputBytes: number;
  maxRuntimeMs?: number;
  blockedReason?: string;
  stopReason?: StopReason;
  wakeOnCompletion: boolean;
  wakePolicyVersion?: 1;
  wakePolicySource?: "tool_arg_v1";
  modelWakeState?: "not_requested" | "claim_acquired" | "routing_failed" | "send_attempted" | "accepted" | "send_failed";
  modelWakeNotificationId?: string;
  modelWakeClaimedAt?: string;
  modelWakeAttemptedAt?: string;
  modelWakeAcceptedAt?: string;
  modelWakeDeliverySemantics?: "accepted" | "delivered";
  modelWakeCanonicalTerminal?: {
    status: "exited" | "failed" | "timed_out" | "killed";
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    stopReason?: StopReason;
    endedAt: string;
  };
  modelWakeErrorCode?: string;
  modelWakeError?: string;
}

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export type MonitorState =
  | "created"
  | "running"
  | "paused"
  | "triggered"
  | "succeeded"
  | "completed"
  | "failed"
  | "stopped"
  | "canceled"
  | "expired"
  | "archived";

export type MonitorOwner = {
  actor_id: string;
  actor_type: "agent" | "user" | "system" | "tool";
  session_id?: string;
  root_session_id?: string;
  workspace_id?: string;
};

export type TimerCheckSpec = { type: "timer" };

export type CommandCheckSpec = {
  type: "command";
  command: string;
  cwd?: string;
  mode?: "stream" | "exit";
  shell?: boolean;
  timeout_ms?: number;
  event_throttle_ms?: number;
  max_lines_per_turn?: number;
  tail_bytes?: number;
};

export type FileCheckSpec = {
  type: "file";
  path: string;
  mode: "exists" | "missing" | "modified_since_start" | "contains";
  pattern?: string;
  encoding?: "utf8";
};

export type CheckSpec = TimerCheckSpec | FileCheckSpec | CommandCheckSpec;

export type ScheduleSpec = {
  start_at?: string;
  delay_ms?: number;
  interval_ms?: number;
  deadline_at?: string;
  max_runs?: number;
  timeout_ms?: number;
  backoff?: {
    strategy: "none" | "linear" | "exponential";
    initial_ms?: number;
    max_ms?: number;
  };
};

export type ConditionSpec =
  | { type: "always" }
  | { type: "observation_status"; equals: "matched" | "not_matched" | "error" | "timeout" }
  | { type: "text_contains"; path: string; text: string; case_sensitive?: boolean }
  | { type: "and"; conditions: ConditionSpec[] }
  | { type: "or"; conditions: ConditionSpec[] }
  | { type: "not"; condition: ConditionSpec };

export type AttentionSpec = {
  notify?: boolean;
  wake_agent?: boolean;
  message?: string;
  throttle_ms?: number;
};

export type AttentionDelivery = {
  message: string;
  severity: "info" | "warning" | "error";
  notify_attempted: boolean;
  notify_delivered: boolean;
  notify_error?: string;
  wake_attempted: boolean;
  wake_delivered: boolean;
  wake_error?: string;
  target_session_id?: string;
  target_root_session_id?: string;
  delivered_at?: string;
};

export type RetentionSpec = {
  max_results?: number;
  max_events?: number;
  ttl_ms?: number;
};

export type MonitorRecord = {
  monitor_id: string;
  version: number;
  owner: MonitorOwner;
  scope: "session" | "root_session" | "workspace";
  name?: string;
  description?: string;
  state: MonitorState;
  check: CheckSpec;
  schedule: ScheduleSpec;
  condition?: ConditionSpec;
  attention: AttentionSpec;
  retention: RetentionSpec;
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
  next_run_at?: string;
  last_triggered_at?: string;
  failure_count: number;
  consecutive_failure_count: number;
  run_count: number;
  lease_id?: string;
  lease_expires_at?: string;
};

export type MonitorResultStatus = "matched" | "not_matched" | "error" | "timeout";

export type MonitorResult = {
  result_id: string;
  monitor_id: string;
  status: MonitorResultStatus;
  observation?: unknown;
  condition_matched: boolean;
  triggered: boolean;
  created_at: string;
  acked_at?: string;
  error_message?: string;
  attention_delivery?: AttentionDelivery;
};

export type MonitorEventType =
  | "created"
  | "started"
  | "paused"
  | "resumed"
  | "stopped"
  | "triggered"
  | "failed"
  | "succeeded"
  | "completed"
  | "ack"
  | "expired"
  | "archived";

export type MonitorEvent = {
  event_id: string;
  monitor_id: string;
  type: MonitorEventType;
  payload?: unknown;
  created_at: string;
};

export type MonitorListFilter = {
  states?: MonitorState[];
  scope?: "session" | "root_session" | "workspace";
  labels?: Record<string, string>;
  include_archived?: boolean;
  limit?: number;
};

export type ResultQuery = {
  limit?: number;
  before?: string;
  after?: string;
  acked?: boolean;
};

export type EventFilter = {
  monitor_id?: string;
  types?: MonitorEventType[];
  limit?: number;
};

export type MonitorPatch = Partial<
  Omit<MonitorRecord, "monitor_id" | "version" | "owner" | "created_at"> & { version: number }
>;

export type LeaseSpec = {
  lease_id: string;
  ttl_ms: number;
};

export type PruneSummary = {
  results_removed: number;
  events_removed: number;
  monitors_archived: number;
};

export type AgentMode = "oneshot" | "interactive";
export type AgentStatus = "created" | "running" | "done" | "error" | "blocked" | "stopped" | "unknown";
export type OrchestrationPolicy = "none" | "cli" | "tools" | "auto";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ResultParser = "pi-json" | "claude-stream-json" | "plain";

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
  exitCode?: number | null;
  summary?: string;
  parentRunDir?: string;
  resultFile?: string;
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
}

export interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  resultParser?: ResultParser;
}

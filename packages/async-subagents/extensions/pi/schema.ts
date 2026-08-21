import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { EVENT_TYPES, PARENT_MESSAGE_TYPES, THINKING_LEVELS } from "../../src/schemas.js";

export const schemaVersion = 1;

const Attachment = Type.Object({
  kind: Type.String(),
  path: Type.Optional(Type.String()),
  uri: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});

export const subagentStartSchema = Type.Object({
  agent: Type.String({ description: "Agent definition name, such as scout, reviewer, or worker." }),
  variant: Type.Optional(Type.String({ description: "Optional agent variant name that overlays model/config while keeping the same agent prompt." })),
  task: Type.String({ description: "Bounded task for the child agent." }),
  taskId: Type.Optional(Type.String({ description: "Optional parent-owned milestone id to associate with this child run for traceability. Milestone status is updated separately with task_update." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current Pi session cwd." })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Prompt-enforced write scope for the child: exact file paths, directory roots, or globs (* within a segment, ** across segments). Prefer scoping by ownership boundary (a package or module root) plus `protect` for files that must stay untouched, over exhaustively enumerating files. Entries must be non-empty single-line strings. This is not OS sandboxing." })),
  protect: Type.Optional(Type.Array(Type.String(), { description: "Prompt-enforced protected paths the child must never create, edit, or delete even when they match the write scope (specs, ledgers, reference files). Reading stays allowed. Entries must be non-empty single-line strings." })),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Additional skill names to enable for this child run, merged with the agent definition skills. Children do not inherit parent-session skills automatically. Pass skill names only; path-like values are rejected." })),
  attachments: Type.Optional(Type.Array(Attachment)),
  notifyOn: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]), { description: "Which ATTENTION events wake you for this child: question, blocked, liveness, progress. Terminal results are always delivered and cannot be filtered out — a lane ending is not optional news. Defaults to everything; narrow it only to cut progress noise." })),
  maxSubagentDepth: Type.Optional(Type.Number({ description: "Depth to record in the child task metadata." })),
  context: Type.Optional(StringEnum(["fresh", "fork"] as const, { default: "fresh" })),
  session: Type.Optional(StringEnum(["record", "none"] as const, { default: "record" })),
  allowFreshFallback: Type.Optional(Type.Boolean({ default: false })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Override the agent definition default Pi thinking level for this child run." })),
  fastTrack: Type.Optional(Type.Boolean({ description: "Request priority service tier for any eligible Codex-model child whose latency gates the plan, including scouts when a scout read is the bottleneck. Includes bravo-codex-balanced/*; requires /fast-track on or launch fails closed." })),
});

export const subagentMessageSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Target child run id." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  type: Type.Optional(StringEnum(PARENT_MESSAGE_TYPES, { default: "instruction" })),
  body: Type.String({ description: "Message body to append to the child inbox." }),
  files: Type.Optional(Type.Array(Type.String(), { description: "Additional prompt-enforced write-scope entries granted with this message (additive; existing scope is always retained). Use to answer a child's blocked scope-expansion request without pausing or restarting it. Runs without a specified scope reject widening." })),
  attachments: Type.Optional(Type.Array(Attachment)),
  requiresAck: Type.Optional(Type.Boolean()),
});

export const subagentInterruptSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Target child run id." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  action: StringEnum(["pause", "cancel"] as const),
  reason: Type.Optional(Type.String({ description: "Reason recorded in status/events and sent to the child inbox when useful." })),
  signal: Type.Optional(StringEnum(["SIGTERM", "SIGKILL"] as const, { default: "SIGTERM" })),
});

export const subagentContinueSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Target child run id." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  body: Type.Optional(Type.String({ description: "Optional instruction or answer to deliver while continuing the child." })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Additional prompt-enforced write approvals. Existing specified scope is always retained; runs without a specified scope reject file widening. Paths must be non-empty single-line strings. This is not OS sandboxing." })),
  type: Type.Optional(StringEnum(PARENT_MESSAGE_TYPES, { default: "instruction" })),
  attachments: Type.Optional(Type.Array(Attachment)),
  requiresAck: Type.Optional(Type.Boolean()),
  additionalRunSeconds: Type.Optional(Type.Number({ description: "Runtime budget seconds when resuming an explicitly paused live child or continuing a terminal run." })),
  notifyOn: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]), { description: "Which ATTENTION events wake you for this child: question, blocked, liveness, progress. Terminal results are always delivered and cannot be filtered out — a lane ending is not optional news. Defaults to everything; narrow it only to cut progress noise." })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Set the child's Pi thinking level while resuming, if the child-control extension is active." })),
});

export const subagentResultSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Run id to read result.json for." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  includeBody: Type.Optional(Type.Boolean({ default: true })),
  includeArtifacts: Type.Optional(Type.Boolean({ default: true })),
  maxBytes: Type.Optional(Type.Number({ description: "Maximum result body bytes returned in details." })),
});

export const subagentNamePackSchema = Type.Object({
  pack: Type.Optional(StringEnum(["default", "clones", "ct"] as const, { description: "Set the active display-name pack for future runs." })),
});

const TaskSpec = Type.Object({
  alias: Type.Optional(Type.String()),
  title: Type.String(),
  description: Type.String(),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  activeForm: Type.Optional(Type.String()),
});

export const taskCreateSchema = Type.Object({ tasks: Type.Array(TaskSpec) });
const TASK_STATUSES = ["open", "active", "blocked", "done", "failed", "cancelled"] as const;

export const taskListSchema = Type.Object({ states: Type.Optional(Type.Array(Type.String({ description: "Optional status/readiness filters. Default visibility hides done and cancelled history unless includeCompleted is true." }))), includeCompleted: Type.Optional(Type.Boolean({ default: false, description: "Include done and cancelled history rows. Defaults to false so task_list shows active milestone work." })), limit: Type.Optional(Type.Number({ default: 50 })) });
export const taskGetSchema = Type.Object({ taskId: Type.String(), view: Type.Optional(StringEnum(["status", "full"] as const, { description: "Omit for compact detail; use full to include recent task audit events." })) });
export const taskUpdateSchema = Type.Object({
  taskId: Type.String(),
  status: Type.Optional(StringEnum(TASK_STATUSES, { description: "Parent-authored milestone status." })),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  notes: Type.Optional(Type.String()),
  appendNotes: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
  addAttemptRunIds: Type.Optional(Type.Array(Type.String())),
  addReceiptPaths: Type.Optional(Type.Array(Type.String())),
  addArtifactPaths: Type.Optional(Type.Array(Type.String())),
  addEvidence: Type.Optional(Type.Array(Type.String())),
  force: Type.Optional(Type.Boolean()),
});
export const taskCancelSchema = Type.Object({ taskId: Type.String(), reason: Type.String() });
export const taskClearSchema = Type.Object({ reason: Type.String({ description: "Reason for bulk cancelling/clearing all non-done tasks." }) });

export const subagentStatusSchema = Type.Object({
  runIds: Type.Optional(Type.Array(Type.String())),
  runDirs: Type.Optional(Type.Array(Type.String())),
  parentRunId: Type.Optional(Type.String({ description: "Parent run id scope. Defaults to current root session parent id." })),
  includeEvents: Type.Optional(Type.Boolean({ default: false })),
  includeInbox: Type.Optional(Type.Boolean({ default: false })),
  maxEvents: Type.Optional(Type.Number({ default: 10 })),
});

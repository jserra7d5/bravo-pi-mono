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
  taskId: Type.Optional(Type.String({ description: "Optional durable task id to claim and execute. subagent_start is the canonical launch surface for task-owned child runs." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current Pi session cwd." })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Relevant files to mention in the child task prompt." })),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Additional skill names to enable for this child run, merged with the agent definition skills. Children do not inherit parent-session skills automatically. Pass skill names only; path-like values are rejected." })),
  attachments: Type.Optional(Type.Array(Attachment)),
  notifyOn: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]))),
  maxSubagentDepth: Type.Optional(Type.Number({ description: "Depth to record in the child task metadata." })),
  context: Type.Optional(StringEnum(["fresh", "fork"] as const, { default: "fresh" })),
  session: Type.Optional(StringEnum(["record", "none"] as const, { default: "record" })),
  allowFreshFallback: Type.Optional(Type.Boolean({ default: false })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Override the agent definition default Pi thinking level for this child run." })),
});

export const subagentMessageSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Target child run id." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  type: Type.Optional(StringEnum(PARENT_MESSAGE_TYPES, { default: "instruction" })),
  body: Type.String({ description: "Message body to append to the child inbox." }),
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
  type: Type.Optional(StringEnum(PARENT_MESSAGE_TYPES, { default: "instruction" })),
  attachments: Type.Optional(Type.Array(Attachment)),
  requiresAck: Type.Optional(Type.Boolean()),
  additionalRunSeconds: Type.Optional(Type.Number({ description: "Additional runtime budget seconds when resuming a paused/timed-out live child." })),
  notifyOn: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]))),
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
export const taskListSchema = Type.Object({ states: Type.Optional(Type.Array(Type.String({ description: "Optional status/derived-state filters. Default visibility still hides completed and cancelled history unless includeCompleted is true." }))), includeCompleted: Type.Optional(Type.Boolean({ default: false, description: "Include completed and cancelled history rows. Defaults to false so task_list shows the active queue." })), limit: Type.Optional(Type.Number({ default: 50 })) });
export const taskGetSchema = Type.Object({ taskId: Type.String(), view: Type.Optional(StringEnum(["status", "receipt", "full"] as const, { default: "status" })) });
export const taskAcceptResultSchema = Type.Object({ taskId: Type.String(), summary: Type.Optional(Type.String()) });
export const taskReopenSchema = Type.Object({ taskId: Type.String(), reason: Type.String(), activeForm: Type.Optional(Type.String()), force: Type.Optional(Type.Boolean()) });
export const taskCancelSchema = Type.Object({ taskId: Type.String(), reason: Type.String() });
export const taskClearSchema = Type.Object({ reason: Type.String({ description: "Reason for bulk cancelling/clearing all non-completed tasks." }) });
export const taskSubmitResultSchema = Type.Object({ summary: Type.String(), receipt: Type.Optional(Type.Any()), artifactPaths: Type.Optional(Type.Array(Type.String())), evidence: Type.Optional(Type.Array(Type.String())), commandsRun: Type.Optional(Type.Array(Type.String())), notes: Type.Optional(Type.String()) });
export const taskUpdateProgressSchema = Type.Object({ summary: Type.Optional(Type.String()), activeForm: Type.Optional(Type.String()) });
export const taskReportBlockedSchema = Type.Object({ summary: Type.String(), notes: Type.Optional(Type.String()) });

export const subagentStatusSchema = Type.Object({
  runIds: Type.Optional(Type.Array(Type.String())),
  runDirs: Type.Optional(Type.Array(Type.String())),
  parentRunId: Type.Optional(Type.String({ description: "Parent run id scope. Defaults to current root session parent id." })),
  includeEvents: Type.Optional(Type.Boolean({ default: false })),
  includeInbox: Type.Optional(Type.Boolean({ default: false })),
  maxEvents: Type.Optional(Type.Number({ default: 10 })),
});

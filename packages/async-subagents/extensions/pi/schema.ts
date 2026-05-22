import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { EVENT_TYPES, PARENT_MESSAGE_TYPES, THINKING_LEVELS } from "../../src/schemas.js";

export const schemaVersion = 1;

const Cursor = Type.Object({
  eventOffset: Type.Number({ description: "Byte offset in events.jsonl." }),
  lastEventId: Type.Optional(Type.String({ description: "Last event id seen at this cursor." })),
});

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
  mode: Type.Optional(StringEnum(["async", "sync"] as const, { default: "async" })),
  wait: Type.Optional(StringEnum(["none", "interesting", "terminal", "result"] as const, { default: "none" })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current Pi session cwd." })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Relevant files to mention in the child task prompt." })),
  attachments: Type.Optional(Type.Array(Attachment)),
  timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout for sync mode or requested wait behavior." })),
  notifyOn: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]))),
  maxSubagentDepth: Type.Optional(Type.Number({ description: "Depth to record in the child task metadata." })),
  context: Type.Optional(StringEnum(["fresh", "fork"] as const, { default: "fresh" })),
  session: Type.Optional(StringEnum(["record", "none"] as const, { default: "record" })),
  allowFreshFallback: Type.Optional(Type.Boolean({ default: false })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Override the agent definition default Pi thinking level for this child run." })),
});

export const subagentWaitSchema = Type.Object({
  runIds: Type.Optional(Type.Array(Type.String(), { description: "Run ids to wait on. Defaults to direct children of this root session." })),
  runDirs: Type.Optional(Type.Array(Type.String(), { description: "Reserved for recovery by run directory; runIds are preferred." })),
  parentRunId: Type.Optional(Type.String({ description: "Parent run id scope. Defaults to current root session parent id." })),
  mode: Type.Optional(StringEnum(["race", "all", "each"] as const, { default: "race" })),
  until: Type.Optional(StringEnum(["interesting", "terminal", "result", "event"] as const, { default: "interesting" })),
  eventTypes: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]))),
  since: Type.Optional(Type.Record(Type.String(), Cursor)),
  timeoutMs: Type.Optional(Type.Number({ description: "Milliseconds to wait. Defaults to 300000." })),
  includeStatus: Type.Optional(Type.Boolean({ default: true })),
  includeResult: Type.Optional(Type.Boolean({ default: true })),
  maxEvents: Type.Optional(Type.Number({ description: "Maximum events returned in details." })),
  maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes per result body returned in details." })),
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

export const subagentStatusSchema = Type.Object({
  runIds: Type.Optional(Type.Array(Type.String())),
  runDirs: Type.Optional(Type.Array(Type.String())),
  parentRunId: Type.Optional(Type.String({ description: "Parent run id scope. Defaults to current root session parent id." })),
  includeEvents: Type.Optional(Type.Boolean({ default: false })),
  includeInbox: Type.Optional(Type.Boolean({ default: false })),
  maxEvents: Type.Optional(Type.Number({ default: 10 })),
});

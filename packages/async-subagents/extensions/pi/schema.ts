import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { EVENT_TYPES, INBOX_MESSAGE_TYPES } from "../../src/schemas.js";

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
  task: Type.String({ description: "Bounded task for the child agent." }),
  name: Type.Optional(Type.String({ description: "Human-readable run name. Stored only as display metadata in v1." })),
  mode: Type.Optional(StringEnum(["async", "sync"] as const, { default: "async" })),
  wait: Type.Optional(StringEnum(["none", "interesting", "terminal", "result"] as const, { default: "none" })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current Pi session cwd." })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Relevant files to mention in the child task prompt." })),
  attachments: Type.Optional(Type.Array(Attachment)),
  timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout for sync mode or requested wait behavior." })),
  notifyOn: Type.Optional(Type.Array(StringEnum(EVENT_TYPES as readonly string[]))),
  maxSubagentDepth: Type.Optional(Type.Number({ description: "Depth to record in the child task metadata." })),
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
});

export const subagentMessageSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Target child run id." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  type: Type.Optional(StringEnum(INBOX_MESSAGE_TYPES as readonly string[], { default: "instruction" })),
  body: Type.String({ description: "Message body to append to the child inbox." }),
  attachments: Type.Optional(Type.Array(Attachment)),
  requiresAck: Type.Optional(Type.Boolean()),
});

export const subagentResultSchema = Type.Object({
  runId: Type.Optional(Type.String({ description: "Run id to read result.json for." })),
  runDir: Type.Optional(Type.String({ description: "Recovery path when the run index is unavailable." })),
  includeBody: Type.Optional(Type.Boolean({ default: true })),
  includeArtifacts: Type.Optional(Type.Boolean({ default: true })),
  maxBytes: Type.Optional(Type.Number({ description: "Maximum result body bytes returned in details." })),
});

export const subagentStatusSchema = Type.Object({
  runIds: Type.Optional(Type.Array(Type.String())),
  runDirs: Type.Optional(Type.Array(Type.String())),
  parentRunId: Type.Optional(Type.String({ description: "Parent run id scope. Defaults to current root session parent id." })),
  includeEvents: Type.Optional(Type.Boolean({ default: false })),
  includeInbox: Type.Optional(Type.Boolean({ default: false })),
  maxEvents: Type.Optional(Type.Number({ default: 10 })),
});

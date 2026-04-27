import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attentionStorePath,
  findAttentionRecord,
  getRecipientContext,
  isHandledForRecipient,
  listUnresolvedAttention,
  markAttentionState,
  markDelivered,
  markHandled,
  markLatestDoneHandled,
  markSeen,
  readAllAttentionRecords,
  shouldDeliverEvent,
  upsertAttentionFromEvent,
} from "./attention.js";
import type { TangoEvent } from "./events.js";
import { appendEvent } from "./events.js";

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.TANGO_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "tango-attention-test-"));
  process.env.TANGO_HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.TANGO_HOME;
  else process.env.TANGO_HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env.TANGO_RUN_ID;
  delete process.env.TANGO_RUN_DIR;
  delete process.env.TANGO_ROOT_SESSION_ID;
});

function makeEvent(status: string, overrides: Partial<TangoEvent> = {}): TangoEvent {
  return {
    schemaVersion: 1,
    eventId: `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "agent.status",
    time: new Date().toISOString(),
    agent: "agent-a",
    status: status as TangoEvent['status'],
    cwd: "/tmp",
    projectSlug: "tmp-abc123",
    runDir: "/tmp/run-a",
    ...overrides,
  };
}

describe("attention records", () => {
  it("upserts a new attention record from an event", () => {
    const event = makeEvent("done");
    const recipient = { runId: "parent_1" };
    const record = upsertAttentionFromEvent(event, recipient);
    assert.strictEqual(record.state, "new");
    assert.strictEqual(record.targetRunDir, event.runDir);
    assert.strictEqual(record.eventId, event.eventId);
    assert.strictEqual(record.recipientRunId, "parent_1");
  });

  it("updates an existing record on duplicate upsert", () => {
    const event = makeEvent("running");
    const recipient = { runId: "parent_1" };
    const first = upsertAttentionFromEvent(event, recipient);
    const updatedEvent = { ...event, status: "done" as TangoEvent['status'], summary: "finished" };
    const second = upsertAttentionFromEvent(updatedEvent, recipient);
    assert.strictEqual(second.attentionId, first.attentionId);
    assert.strictEqual(second.state, "new");
    assert.strictEqual(second.status, "done");
    assert.strictEqual(second.summary, "finished");
  });

  it("markDelivered transitions state to delivered", () => {
    const event = makeEvent("blocked");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    const updated = markDelivered(recipient, event.runDir, event.eventId);
    assert.strictEqual(updated?.state, "delivered");
  });

  it("markSeen transitions new -> seen", () => {
    const event = makeEvent("error");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    const updated = markSeen(recipient, event.runDir, event.eventId);
    assert.strictEqual(updated?.state, "seen");
  });

  it("markSeen is idempotent for already-handled records", () => {
    const event = makeEvent("error");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    markHandled(recipient, event.runDir, event.eventId);
    const updated = markSeen(recipient, event.runDir, event.eventId);
    assert.strictEqual(updated?.state, "handled");
  });

  it("markHandled prevents re-delivery of done events", () => {
    const event = makeEvent("done");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    markHandled(recipient, event.runDir, event.eventId);
    assert.strictEqual(shouldDeliverEvent(event, recipient), false);
    assert.strictEqual(isHandledForRecipient(event, recipient), true);
  });

  it("blocked/error remains deliverable after seen", () => {
    const event = makeEvent("blocked");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    markSeen(recipient, event.runDir, event.eventId);
    assert.strictEqual(shouldDeliverEvent(event, recipient), true);
    assert.strictEqual(isHandledForRecipient(event, recipient), false);
  });

  it("markLatestDoneHandled finds and handles the latest done record", async () => {
    const recipient = { runId: "parent_1" };
    const event1 = makeEvent("done", { runDir: "/tmp/run-b" });
    upsertAttentionFromEvent(event1, recipient);
    await new Promise((r) => setTimeout(r, 20));
    const event2 = makeEvent("done", { runDir: "/tmp/run-b" });
    upsertAttentionFromEvent(event2, recipient);
    const handled = markLatestDoneHandled(recipient, "/tmp/run-b");
    assert.ok(handled);
    assert.strictEqual(handled.eventId, event2.eventId);
    assert.strictEqual(handled.state, "handled");
  });

  it("per-recipient isolation: one recipient handles, another still sees", () => {
    const event = makeEvent("done");
    const recipientA = { runId: "parent_a" };
    const recipientB = { runId: "parent_b" };
    upsertAttentionFromEvent(event, recipientA);
    upsertAttentionFromEvent(event, recipientB);
    markHandled(recipientA, event.runDir, event.eventId);
    assert.strictEqual(shouldDeliverEvent(event, recipientA), false);
    assert.strictEqual(shouldDeliverEvent(event, recipientB), true);
  });

  it("per-recipient isolation by rootSessionId", () => {
    const event = makeEvent("done");
    const recipientA = { rootSessionId: "root_a" };
    const recipientB = { rootSessionId: "root_b" };
    upsertAttentionFromEvent(event, recipientA);
    upsertAttentionFromEvent(event, recipientB);
    markHandled(recipientA, event.runDir, event.eventId);
    assert.strictEqual(shouldDeliverEvent(event, recipientA), false);
    assert.strictEqual(shouldDeliverEvent(event, recipientB), true);
  });

  it("listUnresolvedAttention excludes handled/dismissed/superseded", () => {
    const recipient = { runId: "parent_1" };
    const eventDone = makeEvent("done");
    const eventBlocked = makeEvent("blocked");
    const eventError = makeEvent("error");
    upsertAttentionFromEvent(eventDone, recipient);
    upsertAttentionFromEvent(eventBlocked, recipient);
    upsertAttentionFromEvent(eventError, recipient);
    markHandled(recipient, eventDone.runDir, eventDone.eventId);
    const all = readAllAttentionRecords();
    const unresolved = listUnresolvedAttention(recipient);
    // Superseding semantics: older same recipient+target unresolved records are superseded
    assert.strictEqual(unresolved.length, 1);
    assert.ok(unresolved.some((r) => r.eventId === eventError.eventId));
    // done was handled, blocked was superseded by error, error is latest unresolved
    assert.ok(all.some((r) => r.eventId === eventDone.eventId && r.state === "handled"));
    assert.ok(all.some((r) => r.eventId === eventBlocked.eventId && r.state === "superseded"));
  });

  it("dismissed events are not deliverable", () => {
    const event = makeEvent("blocked");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    markAttentionState(recipient, event.runDir, event.eventId, "dismissed");
    assert.strictEqual(shouldDeliverEvent(event, recipient), false);
  });

  it("superseded events are not deliverable", () => {
    const event = makeEvent("done");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    markAttentionState(recipient, event.runDir, event.eventId, "superseded");
    assert.strictEqual(shouldDeliverEvent(event, recipient), false);
  });

  it("getRecipientContext reads env vars", () => {
    process.env.TANGO_RUN_ID = "run_1";
    process.env.TANGO_RUN_DIR = "/tmp/run";
    process.env.TANGO_ROOT_SESSION_ID = "root_1";
    const ctx = getRecipientContext();
    assert.strictEqual(ctx.runId, "run_1");
    assert.strictEqual(ctx.runDir, "/tmp/run");
    assert.strictEqual(ctx.rootSessionId, "root_1");
    delete process.env.TANGO_RUN_ID;
    delete process.env.TANGO_RUN_DIR;
    delete process.env.TANGO_ROOT_SESSION_ID;
  });

  it("readAllAttentionRecords dedupes by key", () => {
    const event = makeEvent("running");
    const recipient = { runId: "parent_1" };
    upsertAttentionFromEvent(event, recipient);
    markHandled(recipient, event.runDir, event.eventId);
    const all = readAllAttentionRecords();
    const matching = all.filter((r) => r.eventId === event.eventId);
    assert.strictEqual(matching.length, 1);
    assert.strictEqual(matching[0].state, "handled");
  });

  it("findAttentionRecord matches by shared rootSessionId when runId differs", () => {
    const event = makeEvent("done");
    const recipient = { rootSessionId: "root_1" };
    upsertAttentionFromEvent(event, recipient);
    const found = findAttentionRecord({ rootSessionId: "root_1" }, event.runDir, event.eventId);
    assert.ok(found);
    const notFound = findAttentionRecord({ rootSessionId: "root_2" }, event.runDir, event.eventId);
    assert.strictEqual(notFound, undefined);
  });

  it("same rootSessionId but different runId does not match", () => {
    const event = makeEvent("done");
    const recipientA = { rootSessionId: "root_1", runId: "run_a" };
    const recipientB = { rootSessionId: "root_1", runId: "run_b" };
    upsertAttentionFromEvent(event, recipientA);
    const foundA = findAttentionRecord(recipientA, event.runDir, event.eventId);
    assert.ok(foundA);
    const foundB = findAttentionRecord(recipientB, event.runDir, event.eventId);
    assert.strictEqual(foundB, undefined);
  });

  it("same rootSessionId but different runDir does not match", () => {
    const event = makeEvent("done");
    const recipientA = { rootSessionId: "root_1", runDir: "/tmp/run-a" };
    const recipientB = { rootSessionId: "root_1", runDir: "/tmp/run-b" };
    upsertAttentionFromEvent(event, recipientA);
    const foundA = findAttentionRecord(recipientA, event.runDir, event.eventId);
    assert.ok(foundA);
    const foundB = findAttentionRecord(recipientB, event.runDir, event.eventId);
    assert.strictEqual(foundB, undefined);
  });

  it("markLatestDoneHandled creates handled record from event log when no attention record exists", () => {
    const targetRunDir = "/tmp/run-c";
    const event: TangoEvent = {
      schemaVersion: 1,
      eventId: `te_${Date.now()}_evtid`,
      type: "agent.status",
      time: new Date().toISOString(),
      agent: "agent-c",
      status: "done",
      cwd: "/tmp",
      projectSlug: "tmp-abc123",
      runDir: targetRunDir,
    };
    appendEvent(event);

    const recipient = { runId: "parent_1" };
    const handled = markLatestDoneHandled(recipient, targetRunDir);
    assert.ok(handled);
    assert.strictEqual(handled.eventId, event.eventId);
    assert.strictEqual(handled.state, "handled");
    assert.strictEqual(handled.recipientRunId, "parent_1");
  });

  it("supersedes older unresolved records for same recipient+target on newer event", () => {
    const recipient = { runId: "parent_1" };
    const event1 = makeEvent("blocked", { runDir: "/tmp/run-d" });
    const event2 = makeEvent("done", { runDir: "/tmp/run-d" });
    upsertAttentionFromEvent(event1, recipient);
    upsertAttentionFromEvent(event2, recipient);
    const all = readAllAttentionRecords();
    const r1 = all.find((r) => r.eventId === event1.eventId);
    const r2 = all.find((r) => r.eventId === event2.eventId);
    assert.strictEqual(r1?.state, "superseded");
    assert.strictEqual(r2?.state, "new");
  });

  it("superseded event that was previously delivered is not deliverable", () => {
    const recipient = { runId: "parent_1" };
    const event1 = makeEvent("blocked", { runDir: "/tmp/run-e" });
    const event2 = makeEvent("done", { runDir: "/tmp/run-e" });
    upsertAttentionFromEvent(event1, recipient);
    markDelivered(recipient, event1.runDir, event1.eventId);
    upsertAttentionFromEvent(event2, recipient);
    assert.strictEqual(shouldDeliverEvent(event1, recipient), false);
    assert.strictEqual(shouldDeliverEvent(event2, recipient), true);
  });

  it("coalescing by target runDir keeps only latest unresolved event", () => {
    const recipient = { runId: "parent_1" };
    const event1 = makeEvent("blocked", { runDir: "/tmp/run-f" });
    const event2 = makeEvent("error", { runDir: "/tmp/run-f" });
    const event3 = makeEvent("done", { runDir: "/tmp/run-f" });
    upsertAttentionFromEvent(event1, recipient);
    upsertAttentionFromEvent(event2, recipient);
    upsertAttentionFromEvent(event3, recipient);
    assert.strictEqual(shouldDeliverEvent(event1, recipient), false);
    assert.strictEqual(shouldDeliverEvent(event2, recipient), false);
    assert.strictEqual(shouldDeliverEvent(event3, recipient), true);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import {
  createSubscription,
  deliveryKeyForMetadata,
  listSubscriptionsForRecipient,
  markSubscriptionHandled,
  markSubscriptionNotified,
  readAllSubscriptions,
} from "./subscriptions.js";
import type { AgentMetadata } from "./types.js";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tango-subscriptions-test-"));
  process.env.TANGO_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TANGO_HOME;
});

describe("parent subscriptions", () => {
  test("creates and lists active subscriptions by stable recipient", () => {
    const recipient = { rootSessionId: "r1", workstreamId: "w1", cwd: "/tmp/project" };
    const sub = createSubscription({ recipient, target: { runId: "run_1", runDir: "/tmp/project/.tango/run_1", name: "child" } });
    assert.equal(sub.state, "active");
    assert.equal(listSubscriptionsForRecipient(recipient).length, 1);
  });

  test("dedupes by recipient and target independent of owner", () => {
    const recipient = { rootSessionId: "r1", workstreamId: "w1", cwd: "/tmp/project" };
    const a = createSubscription({ recipient, target: { runId: "run_1", runDir: "/tmp/project/.tango/run_1" } });
    markSubscriptionNotified(a.subscriptionId, "done:run_1:t1", "owner_old");
    const b = createSubscription({ recipient, target: { runId: "run_1", runDir: "/tmp/project/.tango/run_1" } });
    assert.equal(b.subscriptionId, a.subscriptionId);
    assert.equal(readAllSubscriptions().length, 1);
    assert.equal(b.lastNotifiedOwnerId, "owner_old");
  });

  test("new owner can see notified subscriptions after reload", () => {
    const recipient = { rootSessionId: "r1", workstreamId: "w1", cwd: "/tmp/project" };
    const sub = createSubscription({ recipient, target: { runId: "run_1", runDir: "/tmp/project/.tango/run_1" } });
    markSubscriptionNotified(sub.subscriptionId, "done:run_1:t1", "owner_old");
    const active = listSubscriptionsForRecipient(recipient);
    assert.equal(active.length, 1);
    assert.equal(active[0].state, "notified");
    assert.equal(active[0].lastNotifiedOwnerId, "owner_old");
  });

  test("marks matching run handled", () => {
    const recipient = { rootSessionId: "r1", workstreamId: "w1", cwd: "/tmp/project" };
    createSubscription({ recipient, target: { runId: "run_1", runDir: "/tmp/project/.tango/run_1" } });
    const handled = markSubscriptionHandled({ runId: "run_1" }, recipient, "test");
    assert.equal(handled.length, 1);
    assert.equal(readAllSubscriptions()[0].state, "handled");
  });

  test("delivery key requires result readiness for done", () => {
    const base: AgentMetadata = {
      name: "child", harness: "pi", mode: "oneshot", status: "done", cwd: "/tmp/project", task: "x",
      runDir: "/tmp/run", homeDir: "/tmp/home", tmuxSocket: "s", tmuxSession: "t", createdAt: "c", updatedAt: "u", runId: "run_1",
    };
    assert.equal(deliveryKeyForMetadata(base), undefined);
    assert.equal(deliveryKeyForMetadata({ ...base, resultFinalizedAt: "f" }), "done:run_1:f");
    assert.equal(deliveryKeyForMetadata({ ...base, status: "blocked", needs: "input" }), "blocked:run_1:u:input:");
  });
});

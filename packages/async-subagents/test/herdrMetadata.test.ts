import test from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE,
  HERDR_ASYNC_SUBAGENTS_METADATA_TTL_MS,
  asyncSubagentsCustomStatus,
  buildHerdrAsyncSubagentsMetadataRequest,
  herdrMetadataEnabled,
  reportHerdrAsyncSubagentsMetadata,
} from "../extensions/pi/herdrMetadata.js";
import { __reportHerdrMetadataStateForTest, __resetHerdrMetadataSchedulerForTest, __setHerdrMetadataReporterForTest } from "../extensions/pi/index.js";

test("Herdr metadata is enabled only inside a Herdr-managed pane", () => {
  assert.equal(herdrMetadataEnabled({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" }), true);
  assert.equal(herdrMetadataEnabled({ HERDR_ENV: "0", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" }), false);
  assert.equal(herdrMetadataEnabled({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), false);
  assert.equal(herdrMetadataEnabled({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }), false);
});

test("Herdr async metadata request overlays Pi presentation without taking lifecycle authority", () => {
  const request = buildHerdrAsyncSubagentsMetadataRequest(
    { active: true, blocked: false, activeCount: 2, message: "working" },
    { paneId: "w1:p1", seq: 42, requestIdSuffix: "test" },
  );

  assert.equal(request.method, "pane.report_metadata");
  assert.equal(request.params.pane_id, "w1:p1");
  assert.equal(request.params.source, HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE);
  assert.equal(request.params.agent, "pi");
  assert.equal(request.params.applies_to_source, "herdr:pi");
  assert.equal(request.params.custom_status, "async working (2 subagents)");
  assert.deepEqual(request.params.state_labels, {
    idle: "async working (2 subagents)",
    working: "async working (2 subagents)",
    blocked: "async working (2 subagents)",
  });
  assert.equal(request.params.ttl_ms, HERDR_ASYNC_SUBAGENTS_METADATA_TTL_MS);
  assert.equal(request.params.seq, 42);
});

test("Herdr async metadata request marks blocked child state visibly", () => {
  assert.equal(asyncSubagentsCustomStatus({ active: true, blocked: true, activeCount: 1 }), "async blocked (1 subagent)");
  assert.equal(asyncSubagentsCustomStatus({ active: true, blocked: true, activeCount: 3 }), "async blocked (3 subagents)");
});

test("Herdr async metadata clear request removes only async-subagents presentation", () => {
  const request = buildHerdrAsyncSubagentsMetadataRequest(
    { active: false, blocked: false, activeCount: 0 },
    { paneId: "w1:p1", seq: 43, requestIdSuffix: "clear" },
  );

  assert.equal(request.method, "pane.report_metadata");
  assert.equal(request.params.source, HERDR_ASYNC_SUBAGENTS_METADATA_SOURCE);
  assert.equal(request.params.custom_status, undefined);
  assert.equal(request.params.clear_custom_status, true);
  assert.equal(request.params.clear_state_labels, true);
  assert.equal(request.params.ttl_ms, undefined);
});

test("Herdr async metadata reporter is opportunistic and uses the active pane env", async () => {
  const sent: Array<{ socketPath: string; request: unknown }> = [];
  await reportHerdrAsyncSubagentsMetadata(
    { active: true, blocked: false, activeCount: 1 },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" },
    async (socketPath, request) => {
      sent.push({ socketPath, request });
      return true;
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.socketPath, "/tmp/herdr.sock");
  const request = sent[0]?.request as { method?: string; params?: { pane_id?: string; custom_status?: string } };
  assert.equal(request.method, "pane.report_metadata");
  assert.equal(request.params?.pane_id, "w1:p1");
  assert.equal(request.params?.custom_status, "async working (1 subagent)");
});

test("Herdr async metadata reporter returns false for socket failures", async () => {
  const delivered = await reportHerdrAsyncSubagentsMetadata(
    { active: true, blocked: false, activeCount: 1 },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" },
    async () => {
      throw new Error("socket down");
    },
  );
  assert.equal(delivered, false);
});

test("Herdr metadata scheduler sends a forced inactive clear after an in-flight active report", async () => {
  __resetHerdrMetadataSchedulerForTest();
  let releaseFirst: ((delivered: boolean) => void) | undefined;
  const seen: unknown[] = [];
  const restore = __setHerdrMetadataReporterForTest(async (state) => {
    seen.push(state);
    if (seen.length === 1) {
      return new Promise<boolean>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return true;
  });

  try {
    __reportHerdrMetadataStateForTest({ active: true, blocked: false, activeCount: 1 }, { force: true });
    __reportHerdrMetadataStateForTest({ active: false, blocked: false, activeCount: 0 }, { force: true });
    assert.deepEqual(seen, [{ active: true, blocked: false, activeCount: 1 }]);
    releaseFirst?.(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [
      { active: true, blocked: false, activeCount: 1 },
      { active: false, blocked: false, activeCount: 0 },
    ]);
  } finally {
    restore();
    __resetHerdrMetadataSchedulerForTest();
  }
});

test("Herdr metadata scheduler drains a forced inactive clear after an in-flight active failure", async () => {
  __resetHerdrMetadataSchedulerForTest();
  let releaseFirst: ((delivered: boolean) => void) | undefined;
  const seen: unknown[] = [];
  const restore = __setHerdrMetadataReporterForTest(async (state) => {
    seen.push(state);
    if (seen.length === 1) {
      return new Promise<boolean>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return true;
  });

  try {
    __reportHerdrMetadataStateForTest({ active: true, blocked: false, activeCount: 1 }, { force: true });
    __reportHerdrMetadataStateForTest({ active: false, blocked: false, activeCount: 0 }, { force: true });
    releaseFirst?.(false);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [
      { active: true, blocked: false, activeCount: 1 },
      { active: false, blocked: false, activeCount: 0 },
    ]);
  } finally {
    restore();
    __resetHerdrMetadataSchedulerForTest();
  }
});

test("Herdr metadata scheduler does not cache failed inactive clears as delivered", async () => {
  __resetHerdrMetadataSchedulerForTest();
  const seen: unknown[] = [];
  const restore = __setHerdrMetadataReporterForTest(async (state) => {
    seen.push(state);
    return false;
  });

  try {
    __reportHerdrMetadataStateForTest({ active: false, blocked: false, activeCount: 0 }, { force: false });
    await new Promise((resolve) => setImmediate(resolve));
    __reportHerdrMetadataStateForTest({ active: false, blocked: false, activeCount: 0 }, { force: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [
      { active: false, blocked: false, activeCount: 0 },
      { active: false, blocked: false, activeCount: 0 },
    ]);
  } finally {
    restore();
    __resetHerdrMetadataSchedulerForTest();
  }
});

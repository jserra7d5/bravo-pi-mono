import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFastTrack, readFastTrackState, writeFastTrackState } from "../src/fastTrack.js";

test("fast-track state persists per root session", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-subagents-fast-track-"));
  try {
    assert.equal(readFastTrackState(dir, "root-a").enabled, false);
    writeFastTrackState(dir, "root-a", true);
    assert.equal(readFastTrackState(dir, "root-a").enabled, true);
    assert.equal(readFastTrackState(dir, "root-b").enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fast-track policy fails closed when disabled and gates scout/ineligible models", () => {
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: false, agentName: "worker", model: "openai-codex/gpt-5.5" }), {
    requested: true,
    enabled: false,
    applied: false,
    reason: "disabled",
  });
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "scout", model: "openai-codex/gpt-5.5" }).reason, "scout");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "google-gemini/gemini-2.5-pro" }).reason, "ineligible_model");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "google-gemini/gpt-5.5" }).reason, "ineligible_model");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "notcodex/gpt-5.5" }).reason, "ineligible_model");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "fake-codex-provider/gpt-5.5" }).reason, "ineligible_model");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "codex-unknown/gpt-5.5" }).reason, "ineligible_model");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "openai-codex/gpt-5.4-mini" }).reason, "ineligible_model");
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "bravo-codex-balanced/gpt-5.4-mini" }).applied, true);
  assert.deepEqual(evaluateFastTrack({ requested: true, enabled: true, agentName: "worker", model: "bravo-codex-balanced/gpt-5.5" }), {
    requested: true,
    enabled: true,
    applied: true,
    serviceTier: "priority",
  });
});

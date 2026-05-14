import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireRootSessionLease, ownsRootSessionLease } from "../src/leases.js";

test("latest non-expired root-session lease owns wake-up delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-lease-"));
  const leasesDir = join(root, ".subagents", "leases");
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_a", ownerId: "owner_a", leasesDir, nowMs: 1_000, ttlMs: 10_000 });
  assert.equal(ownsRootSessionLease({ cwd: root, rootSessionId: "root_a", ownerId: "owner_a", leasesDir, nowMs: 2_000 }), true);
  acquireRootSessionLease({ cwd: root, rootSessionId: "root_a", ownerId: "owner_b", leasesDir, nowMs: 3_000, ttlMs: 10_000 });
  assert.equal(ownsRootSessionLease({ cwd: root, rootSessionId: "root_a", ownerId: "owner_a", leasesDir, nowMs: 4_000 }), false);
  assert.equal(ownsRootSessionLease({ cwd: root, rootSessionId: "root_a", ownerId: "owner_b", leasesDir, nowMs: 4_000 }), true);
  assert.equal(ownsRootSessionLease({ cwd: root, rootSessionId: "root_a", ownerId: "owner_b", leasesDir, nowMs: 20_000 }), false);
});

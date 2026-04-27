import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import { acquireRootOwnerLease, currentRootOwnerLease, ownsRootLease } from "./leases.js";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tango-leases-test-"));
  process.env.TANGO_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TANGO_HOME;
});

describe("root owner leases", () => {
  test("latest owner wins for a stable root/workstream/cwd", () => {
    const input = { rootSessionId: "r1", workstreamId: "w1", cwd: "/tmp/project" };
    acquireRootOwnerLease({ ...input, ownerId: "owner_a", nowMs: 1000, ttlMs: 10_000 });
    acquireRootOwnerLease({ ...input, ownerId: "owner_b", nowMs: 2000, ttlMs: 10_000 });
    assert.equal(currentRootOwnerLease(input)?.ownerId, "owner_b");
    assert.equal(ownsRootLease({ ...input, ownerId: "owner_a", nowMs: 3000 }), false);
    assert.equal(ownsRootLease({ ...input, ownerId: "owner_b", nowMs: 3000 }), true);
  });

  test("expired lease is not owned", () => {
    const input = { rootSessionId: "r1", workstreamId: "w1", cwd: "/tmp/project" };
    acquireRootOwnerLease({ ...input, ownerId: "owner_a", nowMs: 1000, ttlMs: 1000 });
    assert.equal(ownsRootLease({ ...input, ownerId: "owner_a", nowMs: 2500 }), false);
  });
});

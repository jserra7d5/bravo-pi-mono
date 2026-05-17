import test from "node:test";
import assert from "node:assert/strict";
import { readParentPiSessionRef } from "../src/piSession.js";

test("readParentPiSessionRef extracts Pi session file and leaf id from extension context", () => {
  const ref = readParentPiSessionRef({
    sessionManager: {
      getSessionFile() {
        return "/tmp/session.jsonl";
      },
      getLeafId() {
        return "leaf_123";
      },
    },
  });
  assert.deepEqual(ref, { sessionFile: "/tmp/session.jsonl", leafId: "leaf_123" });
});

test("readParentPiSessionRef returns null for in-memory or pre-leaf parent sessions", () => {
  assert.equal(
    readParentPiSessionRef({
      sessionManager: {
        getSessionFile() {
          return undefined;
        },
        getLeafId() {
          return "leaf_123";
        },
      },
    }),
    null,
  );
  assert.equal(
    readParentPiSessionRef({
      sessionManager: {
        getSessionFile() {
          return "/tmp/session.jsonl";
        },
        getLeafId() {
          return null;
        },
      },
    }),
    null,
  );
});

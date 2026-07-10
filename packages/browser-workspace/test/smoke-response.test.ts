import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarkerResponse } from "../src/smoke-response.js";

const marker = "BWS_123456789abc";

test("live smoke requires marker in a row after the echoed prompt", () => {
  assert.equal(classifyMarkerResponse([` hello; reply with exactly ${marker}`, ` ${marker}`], marker).state, "answer");
});

test("live smoke rejects obvious errors after the prompt", () => {
  assert.equal(classifyMarkerResponse([` hello; reply with exactly ${marker}`, " Error: No API key"], marker).state, "error");
});

test("echoed marker alone does not pass", () => {
  assert.equal(classifyMarkerResponse([` hello; reply with exactly ${marker}`, " ⠋ Working..."], marker).state, "pending");
});

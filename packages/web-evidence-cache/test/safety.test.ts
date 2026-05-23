import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, testInternals } from "../src/safety.js";
import { WebToolError } from "../src/errors.js";

test("canonicalizeUrl rejects unsupported protocols and credentials", () => {
  assert.throws(() => canonicalizeUrl("file:///etc/passwd"), WebToolError);
  assert.throws(() => canonicalizeUrl("https://user:pass@example.com"), WebToolError);
});

test("URL safety internals classify local/private/metadata addresses as blocked", () => {
  assert.equal(testInternals.hostLooksLocal("localhost"), true);
  assert.equal(testInternals.hostLooksLocal("metadata.google.internal"), true);
  assert.equal(testInternals.isBlockedIp("127.0.0.1"), true);
  assert.equal(testInternals.isBlockedIp("10.0.0.1"), true);
  assert.equal(testInternals.isBlockedIp("172.16.0.1"), true);
  assert.equal(testInternals.isBlockedIp("192.168.1.1"), true);
  assert.equal(testInternals.isBlockedIp("169.254.169.254"), true);
  assert.equal(testInternals.isBlockedIp("::1"), true);
  assert.equal(testInternals.isBlockedIp("8.8.8.8"), false);
});

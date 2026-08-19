import test from "node:test";
import assert from "node:assert/strict";
import { applyInstall, planInstall, InstallApplyError, type InstallerFs } from "../src/installer.js";

test("installer preflights every conflict before mutation", () => {
  const paths = new Map<string, "source" | "symlink" | "conflict">([["s1", "source"], ["s2", "source"], ["d1", "symlink"], ["d2", "conflict"]]);
  let mutations = 0;
  const fs: InstallerFs = {
    exists: (path) => paths.has(path),
    lstat: (path) => ({ isSymbolicLink: () => paths.get(path) === "symlink", isDirectory: () => paths.get(path) === "conflict" }),
    readlink: () => "old", ensureDir: () => mutations++, symlink: () => mutations++, rename: () => mutations++, remove: () => mutations++,
  };
  assert.throws(() => planInstall([{ name: "one", source: "s1", destination: "d1", type: "dir" }, { name: "two", source: "s2", destination: "d2", type: "dir" }], false, fs), /exists and is not a symlink/);
  assert.equal(mutations, 0);
});

for (const operation of ["ensureDir", "symlink", "rename"] as const) test(`installer reports precise ${operation} failure metadata`, () => {
  const existing = new Set(["s"]); let renameCount = 0;
  const fs: InstallerFs = {
    exists: (path) => existing.has(path), lstat: () => { throw new Error("absent"); }, readlink: () => "",
    ensureDir: () => { if (operation === "ensureDir") throw new Error("ensure boom"); },
    remove: () => undefined,
    symlink: () => { if (operation === "symlink") throw new Error("link boom"); },
    rename: () => { renameCount++; if (operation === "rename") throw new Error("rename boom"); },
  };
  const plan = planInstall([{ name: "target", source: "s", destination: "/dest/target", type: "dir" }], false, fs);
  let failure: InstallApplyError | undefined; try { applyInstall(plan, fs); } catch (error) { failure = error as InstallApplyError; }
  assert.ok(failure instanceof InstallApplyError); assert.equal(failure.result.failure?.operation, operation); assert.equal(failure.result.failure?.name, "target");
  assert.equal(failure.result.failure?.path, operation === "ensureDir" ? "/dest" : operation === "symlink" ? `/dest/target.tmp-${process.pid}` : "/dest/target");
  assert.deepEqual(failure.result.results, []); if (operation !== "rename") assert.equal(renameCount, 0);
});

test("later failure preserves and reports a healthy pre-existing link", () => {
  const kinds = new Map([["s1", "source"], ["s2", "source"], ["d1", "healthy"]]); const removed: string[] = [];
  const fs: InstallerFs = {
    exists: (path) => kinds.has(path), lstat: (path) => { if (path === "d2") throw new Error("absent"); return { isSymbolicLink: () => kinds.get(path) === "healthy", isDirectory: () => false }; }, readlink: () => "s1",
    ensureDir: () => undefined, remove: (path) => removed.push(path), symlink: () => { throw new Error("later link failure"); }, rename: () => undefined,
  };
  const plan = planInstall([{ name: "healthy", source: "s1", destination: "d1", type: "dir" }, { name: "later", source: "s2", destination: "d2", type: "dir" }], false, fs);
  let failure: InstallApplyError | undefined; try { applyInstall(plan, fs); } catch (error) { failure = error as InstallApplyError; }
  assert.deepEqual(failure?.result.results, [{ name: "healthy", from: "d1", to: "s1", action: "unchanged" }]);
  assert.equal(failure?.result.failure?.name, "later"); assert.equal(removed.includes("d1"), false);
});

test("installer reports completed links when a later filesystem operation fails", () => {
  const existing = new Set(["s1", "s2"]); const calls: string[] = [];
  const fs: InstallerFs = {
    exists: (path) => existing.has(path), lstat: () => { throw new Error("absent"); }, readlink: () => "",
    ensureDir: (path) => calls.push(`dir:${path}`), remove: (path) => calls.push(`remove:${path}`), symlink: (_source, path) => calls.push(`link:${path}`),
    rename: (from, to) => { calls.push(`rename:${to}`); if (to === "b") throw new Error("later failure"); existing.add(to); },
  };
  const plan = planInstall([{ name: "one", source: "s1", destination: "a", type: "dir" }, { name: "two", source: "s2", destination: "b", type: "dir" }], false, fs);
  let failure: InstallApplyError | undefined;
  try { applyInstall(plan, fs); } catch (error) { failure = error as InstallApplyError; }
  assert.ok(failure instanceof InstallApplyError);
  assert.deepEqual(failure.result.results.map((item) => item.name), ["one"]);
  assert.deepEqual(failure.result.failure, { name: "two", path: "b", operation: "rename", message: "later failure" });
  assert.ok(existing.has("a"));
  assert.ok(calls.includes("rename:a"));
});

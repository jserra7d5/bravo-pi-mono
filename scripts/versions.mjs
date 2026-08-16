/**
 * One version for the whole repo.
 *
 * This monorepo ships as a single pi package: `pi install git:...` registers the root
 * `pi.extensions` bundle, and nothing consumes a workspace independently. So per-package
 * versions carry no information, and letting them drift meant a release tag could claim
 * anything — tags reached v0.2.1 while all 17 packages still reported 0.1.0.
 *
 * The root `package.json` version is the single truth. `check` enforces every workspace
 * matches it, and the Release workflow refuses to publish a tag that disagrees.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Semver core plus an optional prerelease/build tail, which is all a tag ever carries here. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function assertValidVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`not a valid version: ${JSON.stringify(version)} (expected e.g. 0.2.2)`);
  }
  return version;
}

/**
 * Every package.json the repo owns, root first.
 *
 * Read from the filesystem rather than a hardcoded list so a new package cannot be added
 * without inheriting the version rule — the failure mode this whole file exists to stop is
 * a manifest nobody remembered to update.
 */
export function manifestPaths() {
  const packagesDir = join(REPO_ROOT, "packages");
  const workspaces = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "package.json"))
    .filter((path) => existsQuietly(path));
  return [join(REPO_ROOT, "package.json"), ...workspaces.sort()];
}

function existsQuietly(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function rootVersion() {
  return readManifest(join(REPO_ROOT, "package.json")).version;
}

export function relativePath(path) {
  return path.slice(REPO_ROOT.length + 1);
}

/**
 * Rewrite the `version` field in place.
 *
 * Targeted string replacement rather than a JSON round-trip: re-serializing would reorder
 * or reformat keys across 18 manifests and bury the one-line change in noise.
 */
export function writeVersion(path, version) {
  const source = readFileSync(path, "utf8");
  const updated = source.replace(/^(\s*)"version":\s*"[^"]*"/m, `$1"version": "${version}"`);
  if (updated === source) throw new Error(`no version field to update in ${relativePath(path)}`);
  writeFileSync(path, updated);
}

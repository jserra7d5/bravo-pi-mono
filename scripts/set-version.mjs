/**
 * Set one version across the root and every workspace.
 *
 *   npm run version:set -- 0.2.2
 *
 * This is the only supported way to change the version: hand-editing one manifest is what
 * produced the drift in the first place.
 */

import { assertValidVersion, manifestPaths, readManifest, relativePath, writeVersion } from "./versions.mjs";

const requested = process.argv[2];
if (requested === undefined) {
  process.stderr.write("usage: npm run version:set -- <version>\n");
  process.exit(2);
}

const version = assertValidVersion(requested);
const paths = manifestPaths();
let changed = 0;

for (const path of paths) {
  if (readManifest(path).version === version) continue;
  writeVersion(path, version);
  changed++;
  process.stdout.write(`  ${relativePath(path)}\n`);
}

process.stdout.write(
  changed === 0
    ? `already at ${version} (${paths.length} manifests)\n`
    : `set ${version} across ${changed} of ${paths.length} manifests\n\nNext: commit, then tag v${version}.\n`,
);

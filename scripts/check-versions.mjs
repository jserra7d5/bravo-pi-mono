/**
 * Fail `npm run check` when any workspace version drifts from the root, or when a
 * workspace depends on a sibling by version rather than by path.
 *
 * Runs on every check so drift is caught while you are working, not at the moment you
 * tag — by then the mislabeled release is one push from being published.
 */

import { assertValidVersion, manifestPaths, readManifest, relativePath, rootVersion } from "./versions.mjs";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const expected = assertValidVersion(rootVersion());
const mismatched = [];
const registryPinned = [];

for (const path of manifestPaths()) {
  const manifest = readManifest(path);
  if (manifest.version !== expected) {
    mismatched.push(`  ${relativePath(path)}: ${manifest.version ?? "(missing)"}`);
  }
  // Nothing under @bravo/ is published, so a sibling named by version resolves to the
  // local workspace only while that version happens to match — and silently becomes a
  // registry lookup the moment version:set moves past it. `npm install` on a clean
  // clone then 404s, which is how a coworker discovers it, not how we do.
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith("@bravo/") || typeof spec !== "string" || spec.startsWith("file:")) continue;
      registryPinned.push(`  ${relativePath(path)}: ${field}["${name}"] = "${spec}"`);
    }
  }
}

if (registryPinned.length > 0) {
  process.stderr.write(
    `internal dependencies must be referenced by path, not version:\n${registryPinned.join("\n")}\n\n` +
      `No @bravo/* package is published, so a version spec falls through to the npm\n` +
      `registry and 404s on a clean install. Use "file:../<package>" instead.\n`,
  );
  process.exit(1);
}

if (mismatched.length > 0) {
  process.stderr.write(
    `version drift: the root package.json says ${expected}, but:\n${mismatched.join("\n")}\n\n` +
      `This repo ships as one pi package, so every workspace carries the root version.\n` +
      `Fix with:  npm run version:set -- ${expected}\n`,
  );
  process.exit(1);
}

process.stdout.write(`versions: ${expected} across ${manifestPaths().length} manifests\n`);

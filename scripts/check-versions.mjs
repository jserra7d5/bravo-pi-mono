/**
 * Fail `npm run check` when any workspace version drifts from the root.
 *
 * Runs on every check so drift is caught while you are working, not at the moment you
 * tag — by then the mislabeled release is one push from being published.
 */

import { assertValidVersion, manifestPaths, readManifest, relativePath, rootVersion } from "./versions.mjs";

const expected = assertValidVersion(rootVersion());
const mismatched = [];

for (const path of manifestPaths()) {
  const manifest = readManifest(path);
  if (manifest.version !== expected) {
    mismatched.push(`  ${relativePath(path)}: ${manifest.version ?? "(missing)"}`);
  }
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

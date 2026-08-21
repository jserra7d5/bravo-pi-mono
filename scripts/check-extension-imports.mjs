#!/usr/bin/env node
/**
 * Fail `npm run check` when a pi extension imports a build artifact.
 *
 * pi loads extensions straight from TypeScript through jiti, and `pi update` wipes every
 * `dist/` before reinstalling. An installed copy then builds only the bundle set (see
 * scripts/prepare-install.mjs — tango is excluded because its vite dashboard toolchain is a
 * devDependency that `--omit=dev` strips), so anything an extension pulls from `dist/` is
 * simply absent on a coworker's machine:
 *
 *   Failed to load extension: Cannot find module '../../dist/leases.js'
 *
 * Import the source instead; jiti compiles it on load. Extensions are the one place this
 * matters, so the rule is scoped to them rather than the whole repo.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, "packages");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const DIST_IMPORT = /\bfrom\s+["'][^"']*\bdist\/[^"']*["']|\brequire\(\s*["'][^"']*\bdist\/[^"']*["']\s*\)|\bimport\(\s*["'][^"']*\bdist\/[^"']*["']\s*\)/g;

function* sourceFiles(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) yield path;
  }
}

const offenders = [];
for (const pkg of readdirSync(packagesDir)) {
  for (const file of sourceFiles(join(packagesDir, pkg, "extensions"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DIST_IMPORT)) {
      const line = text.slice(0, match.index).split("\n").length;
      offenders.push(`  ${relative(root, file)}:${line}: ${match[0].trim()}`);
    }
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    `pi extensions must not import build artifacts:\n${offenders.join("\n")}\n\n` +
      `\`pi update\` removes every dist/ and an installed copy builds only the bundle set, so\n` +
      `these resolve to nothing on an installed machine. Import from src/ — jiti compiles it.\n`,
  );
  process.exit(1);
}

process.stdout.write("extension imports: no dist/ references\n");

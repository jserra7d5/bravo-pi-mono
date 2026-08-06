#!/usr/bin/env node
// Fail the build when the pi-ai this package type-checks against is not the
// pi-ai its extension will actually RUN against.
//
// pi loads extensions through its own loader, which aliases every
// "@earendil-works/pi-ai*" specifier to the copy bundled with the installed pi
// and resolves it via jiti. jiti's CJS interop degrades a missing named export
// to `undefined` at the call site instead of raising an ESM link error, so an
// entrypoint that upstream has emptied type-checks clean here and fails
// silently in production. That is exactly how the balancer shipped a dead
// `@earendil-works/pi-ai/oauth` import: repo devDep 0.74.1 still had the
// export, the host's 0.81.1 did not, and every token refresh threw a TypeError
// for ten days until the access token finally expired.
//
// Comparing the two versions at build time turns that into a build failure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const declared = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')).devDependencies?.['@earendil-works/pi-ai'];

function resolveInstalledPiDir() {
  // `pi` on PATH is a symlink into the installed package's dist/.
  let binary;
  try {
    binary = execFileSync('command', ['-v', 'pi'], { encoding: 'utf8', shell: '/bin/bash' }).trim();
  } catch {
    return undefined;
  }
  if (!binary) return undefined;
  let real;
  try {
    real = execFileSync('readlink', ['-f', binary], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
  // .../@earendil-works/pi-coding-agent/dist/cli.js -> .../pi-coding-agent
  const marker = `${path.sep}dist${path.sep}`;
  const index = real.lastIndexOf(marker);
  return index === -1 ? undefined : real.slice(0, index);
}

const piDir = resolveInstalledPiDir();
if (!piDir || !existsSync(path.join(piDir, 'package.json'))) {
  console.warn('[pi-ai-drift] no `pi` on PATH — skipping host drift check');
  process.exit(0);
}

let hosted;
try {
  const require = createRequire(path.join(piDir, 'package.json'));
  // pi-ai blocks "./package.json" in its exports map, so read it off disk.
  hosted = JSON.parse(readFileSync(path.join(path.dirname(require.resolve('@earendil-works/pi-ai')), '..', 'package.json'), 'utf8')).version;
} catch {
  try {
    hosted = JSON.parse(readFileSync(path.join(piDir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), 'utf8')).version;
  } catch {
    console.warn('[pi-ai-drift] could not resolve the installed pi\'s pi-ai — skipping');
    process.exit(0);
  }
}

if (declared !== hosted) {
  const piVersion = JSON.parse(readFileSync(path.join(piDir, 'package.json'), 'utf8')).version;
  console.error(
    `\n✗ pi-ai drift: this package declares ${declared}, but the installed pi (${piVersion}) bundles ${hosted}.\n` +
    `  Extensions run against the HOST copy, so type-checking against ${declared} proves nothing.\n` +
    `  Set "@earendil-works/pi-ai" to "${hosted}" in packages/codex-auth-balancer/package.json,\n` +
    `  reinstall, and fix whatever the type-checker then reports.\n`,
  );
  process.exit(1);
}

console.log(`[pi-ai-drift] ok — repo and installed pi both on pi-ai ${hosted}`);

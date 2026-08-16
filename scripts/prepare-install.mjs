#!/usr/bin/env node
// npm `prepare` hook.
//
// This exists for `pi install git:github.com/jserra7d5/bravo-pi-mono#release`. pi clones the
// repo, runs `npm install --omit=dev` inside it, and then loads the extensions named in the
// root `pi.extensions`. Extensions themselves are TypeScript and load through jiti, so they
// would survive without a build — but async-subagents spawns its detached supervisor as
// `node dist/src/cli.js` and refuses to start when that file is missing. So an installed copy
// has to be built, and `prepare` is the only lifecycle hook pi's install path runs.
//
// It builds the bundle set only, never `npm run build` across all workspaces: tango's build
// includes a vite dashboard whose toolchain is a devDependency, which `--omit=dev` strips.
// Building everything here would fail the install on a package the bundle does not ship.
//
// Set BRAVO_SKIP_PREPARE=1 to skip (CI does this when it builds and tests explicitly).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.env.BRAVO_SKIP_PREPARE === "1") {
  console.log("[prepare] BRAVO_SKIP_PREPARE=1 — skipping bundle build");
  process.exit(0);
}

// A source checkout without node_modules cannot build yet; npm runs prepare after install, so
// this only trips in odd states (a bare clone someone ran `npm run prepare` in by hand).
if (!existsSync(join(root, "node_modules"))) {
  console.log("[prepare] no node_modules yet — skipping bundle build");
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build:bundle"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

if (result.status !== 0) {
  console.error(
    [
      "",
      "[prepare] bundle build failed.",
      "",
      "async-subagents cannot run unbuilt: it launches its supervisor as `node dist/src/cli.js`.",
      "If this ran during `pi install`, the installed copy is not usable. Check that the pi on",
      "PATH matches the pin in package.json — packages/codex-auth-balancer/scripts/check-pi-ai-drift.mjs",
      "fails the build when they diverge.",
      "",
    ].join("\n"),
  );
  process.exit(result.status ?? 1);
}

const supervisor = join(root, "packages", "async-subagents", "dist", "src", "cli.js");
if (!existsSync(supervisor)) {
  console.error(`[prepare] build reported success but ${supervisor} is missing — async-subagents would refuse to start`);
  process.exit(1);
}

console.log("[prepare] bundle built");

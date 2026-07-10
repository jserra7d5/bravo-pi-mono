import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfigV1 } from "../src/config.js";
test("strict config rejects unknown keys", () => { const executable = process.execPath, workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bw-config-")); const value = { schemaVersion: 1, workspace, listenHost: "127.0.0.1", listenPort: 7681, tmuxSocketName: "browser", tmuxSessionName: "workspace", tailscaleHttpsPort: 8443, executables: { ttyd: executable, tmux: executable, tailscale: executable }, extra: true }; assert.throws(() => parseConfigV1(value), /Unknown config key/); fs.rmSync(workspace, { recursive: true }); });

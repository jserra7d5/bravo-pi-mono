import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import { discoverExecutable } from "../src/discovery.js";
import type { BrowserWorkspaceConfigV1 } from "../src/contracts.js";
import { TmuxWorkspaceManager } from "../src/tmux.js";
import { TtydSupervisor } from "../src/ttyd.js";

async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0)); }); }); }

test("Chromium through ttyd writes an exact file and reload preserves tmux", { timeout: 45_000 }, async t => {
  const ttyd = discoverExecutable("ttyd"), tmux = discoverExecutable("tmux"), tailscale = discoverExecutable("tailscale");
  if (!ttyd || !tmux || !tailscale || !fs.existsSync(chromium.executablePath())) return t.skip("real ttyd/tmux/tailscale/Chromium prerequisites are not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-browser-")), file = path.join(dir, "exact.txt"), nonce = `browser-${Date.now()}`;
  const config: BrowserWorkspaceConfigV1 = { schemaVersion: 1, workspace: dir, listenHost: "127.0.0.1", listenPort: await freePort(), tmuxSocketName: `bw-test-${process.pid}-${Date.now()}`, tmuxSessionName: "workspace", tailscaleHttpsPort: 8443, executables: { ttyd, tmux, tailscale } };
  const manager = new TmuxWorkspaceManager(config), supervisor = new TtydSupervisor(config); let browser;
  try {
    const before = await manager.prepareDetached(); await supervisor.start(); browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${config.listenPort}/`); const input = page.locator(".xterm-helper-textarea"); await input.waitFor({ state: "attached" }); await input.focus();
    await page.keyboard.type(`printf %s '${nonce}' > '${file}'`); await page.keyboard.press("Enter");
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(file, "utf8"), nonce); await page.reload(); await input.waitFor({ state: "attached" }); assert.deepEqual(await manager.inspectExact(), before);
  } finally { await browser?.close(); await supervisor.stop().catch(() => {}); await manager.cleanupTestNamespace().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

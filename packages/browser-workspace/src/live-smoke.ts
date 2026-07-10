#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { loadConfig, resolveConfigPath } from "./config.js";
import { WorkspaceError, Exit } from "./errors.js";
import { classifyMarkerResponse } from "./smoke-response.js";
const url = process.argv[2];
if (!url || new URL(url).hostname === "localhost" || new URL(url).hostname === "127.0.0.1") throw new WorkspaceError("TAILNET_URL_REQUIRED", "Usage: npm run smoke:live -- https://<tailnet-host>:<port>/ [config]", Exit.USAGE);
const config = loadConfig(resolveConfigPath(process.argv[3]));
if (!config.executables.pi) throw new WorkspaceError("PI_REQUIRED", "Config must contain an absolute Pi executable path", Exit.DEPENDENCY);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  const input = page.locator(".xterm-helper-textarea"); await input.waitFor({ state: "attached", timeout: 15_000 }); await input.focus();
  await page.keyboard.type(`'${config.executables.pi.replaceAll("'", "'\\''")}'`); await page.keyboard.press("Enter"); await page.waitForTimeout(3000);
  const readTerminal = () => page.evaluate(() => {
    type Line = { translateToString(trimRight?: boolean): string };
    type Terminal = { buffer?: { active?: { length: number; getLine(index: number): Line | undefined } } };
    const active = (globalThis as typeof globalThis & { term?: Terminal }).term?.buffer?.active;
    return active ? Array.from({ length: active.length }, (_, index) => active.getLine(index)?.translateToString(true) ?? "") : [];
  });
  const marker = `BWS_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await input.focus(); await page.keyboard.type(`hello; reply with exactly ${marker}`); await page.keyboard.press("Enter");
  let passed = false;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    await page.waitForTimeout(250); const result = classifyMarkerResponse(await readTerminal(), marker);
    if (result.state === "error") throw new WorkspaceError("PI_RESPONSE_ERROR", `Pi displayed an error after hello: ${result.message}`, Exit.RUNTIME);
    if (result.state === "answer") { passed = true; break; }
  }
  if (!passed) throw new WorkspaceError("PI_RESPONSE_TIMEOUT", "No stable browser-visible Pi response followed hello", Exit.RUNTIME);
  console.log("PASS: Pi was launched and produced a stable browser-visible response after hello");
} finally { await browser.close(); }

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupLaunch, prepareLaunch, syncBack } from './index.js';

const CONFIG_ENTRIES = [
  'AGENTS.md',
  'APPEND_SYSTEM.md',
  'SYSTEM.md',
  'keybindings.json',
  'models.json',
  'npm',
  'git',
  'prompts',
  'settings.json',
  'skills',
  'themes',
  'tools',
  'extensions',
];

function defaultPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

function linkIfPresent(source: string, dest: string): void {
  if (!existsSync(source) || existsSync(dest)) return;
  symlinkSync(source, dest, lstatSync(source).isDirectory() ? 'dir' : 'file');
}

function mirrorAgentConfig(sourceAgentDir: string, piAgentDir: string): void {
  mkdirSync(piAgentDir, { recursive: true, mode: 0o700 });
  for (const entry of CONFIG_ENTRIES) linkIfPresent(path.join(sourceAgentDir, entry), path.join(piAgentDir, entry));
}

function spawnPi(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_BALANCED_PI_BIN || 'pi', args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

async function main(): Promise<void> {
  if (process.env.BRAVO_PI_BALANCED === '1') throw new Error('refusing nested pi-balanced launch');
  const sourceAgentDir = defaultPiAgentDir();
  const runRoot = process.env.PI_BALANCED_RUN_ROOT || path.join(os.tmpdir(), 'pi-balanced-');
  const isolatedDir = await mkdtemp(runRoot);
  let selectedSlot: string | undefined;
  let retain = false;
  try {
    const prepared = await prepareLaunch(isolatedDir, { reservationTtlMs: 24 * 60 * 60_000 });
    selectedSlot = prepared.selected_slot;
    mirrorAgentConfig(sourceAgentDir, prepared.pi_agent_dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...prepared.env,
      BRAVO_PI_BALANCED: '1',
      PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR || path.join(sourceAgentDir, 'sessions'),
    };
    if (process.env.PI_CODING_AGENT_DIR) env.PI_BALANCED_SOURCE_AGENT_DIR = sourceAgentDir;
    process.stderr.write(`[pi-balanced] Codex account slot ${selectedSlot}\n`);
    const code = await spawnPi(process.argv.slice(2), env);
    const sync = await syncBack(isolatedDir, { slot: selectedSlot });
    if (sync.ok) await cleanupLaunch(isolatedDir);
    else {
      retain = true;
      process.stderr.write(`[pi-balanced] sync-back conflict; retained ${isolatedDir}\n`);
    }
    process.exitCode = code ?? 1;
  } catch (error) {
    process.stderr.write(`[pi-balanced] ${error instanceof Error ? error.message : String(error)}\n`);
    if (selectedSlot) {
      try {
        const sync = await syncBack(isolatedDir, { slot: selectedSlot });
        if (sync.ok) await cleanupLaunch(isolatedDir);
        else retain = true;
      } catch {
        retain = true;
      }
    } else {
      try { await rm(isolatedDir, { recursive: true, force: true }); } catch { retain = true; }
    }
    process.exitCode = 1;
  } finally {
    if (!retain) return;
    process.stderr.write(`[pi-balanced] retained ${isolatedDir}\n`);
  }
}

await main();

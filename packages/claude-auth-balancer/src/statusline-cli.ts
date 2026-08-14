#!/usr/bin/env node
// Statusline entry point.
//
// Deliberately separate from cli.ts. This runs on every turn of every session,
// and cli.ts pulls in the proxy and the SQLite metrics store — which costs
// startup time on the hot path and makes node print an ExperimentalWarning for
// a command that never touches a database. This module's import graph reaches
// only the account state, the affinity leases, and the renderer.
//
// It also must never throw and never hang. A statusline that fails does not
// fail once; it fails on every turn until someone notices and edits settings.

import { writeFileSync } from 'node:fs';

import { gather, parsePayload } from './statusline.js';
import { ASCII_GLYPHS, UNICODE_GLYPHS, configureWidth, render } from './statusline-render.js';

/** Bounded, because a stdin nobody closes would freeze the status bar. */
const STDIN_TIMEOUT_MS = 1000;

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    // Unreffing the timer is not enough to bound the PROCESS: the stdin
    // listeners keep that handle referenced, so a writer that never closes the
    // pipe leaves node alive long after the line has been printed — one stuck
    // process per turn, forever. Detach stdin explicitly when we stop caring.
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      // `pause()` alone is not enough — it stops the reads but leaves the
      // handle referenced, so the event loop stays alive and the process hangs
      // after having already printed its line. Measured: output at 1s, process
      // still resident at 8s. Destroy the handle outright; we are done with it.
      process.stdin.pause();
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    process.stdin.on('data', c => chunks.push(c as Buffer));
    process.stdin.on('end', done);
    // Partial input still renders something useful, so an error resolves rather
    // than rejecting.
    process.stdin.on('error', done);
  });
}

/**
 * stdout is a pipe here, so it has no `columns`. stderr is still attached to the
 * real terminal, which is the only place the true width can be read.
 */
function terminalWidth(argv: string[]): number {
  const flagIndex = argv.indexOf('--width');
  if (flagIndex >= 0) {
    const explicit = Number(argv[flagIndex + 1]);
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  }
  for (const candidate of [process.stdout.columns, process.stderr.columns, Number(process.env.COLUMNS)]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }
  // 80, not 100. The failure is asymmetric: guessing 100 on a 160-column
  // terminal costs a narrower bar, but guessing 100 on an 80-column terminal
  // overflows and wraps, which destroys the row alignment the layout is built
  // on. Guess low.
  return 80;
}

/** The terminal's declared locale, most specific variable first. */
function locale(): string | undefined {
  return process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const raw = await readStdin(STDIN_TIMEOUT_MS);

  if (process.env.CLAUDE_AUTH_BALANCER_STATUSLINE_DUMP) {
    try {
      writeFileSync(process.env.CLAUDE_AUTH_BALANCER_STATUSLINE_DUMP, raw);
    } catch {
      /* diagnostics only, never fatal */
    }
  }

  const color = !argv.includes('--no-color') && process.env.NO_COLOR === undefined;

  // Node writes UTF-8 bytes whatever the terminal's locale says. On a non-UTF-8
  // terminal each block glyph arrives as three garbage characters, so a 12-cell
  // bar draws 36 columns and every line wraps — worse than no bar at all.
  const lc = locale();
  configureWidth(lc);
  const utf8 = lc !== undefined && /utf-?8/i.test(lc);
  const glyphs = argv.includes('--ascii') || !utf8 ? ASCII_GLYPHS : UNICODE_GLYPHS;

  const model = gather(parsePayload(raw), { ellipsis: glyphs.ellipsis });
  emit(render(model, { width: terminalWidth(argv), color, glyphs }));
}

/**
 * Write the line and leave.
 *
 * The exit is explicit and deliberately waits for the flush callback: stdout is
 * a pipe here, so `process.exit()` on its own can truncate a line that is still
 * buffered. Anything still holding the event loop after this — a stray handle, a
 * future import with a timer — would otherwise leave one resident process per
 * turn of every session, which is the kind of leak nobody notices until the box
 * is out of PIDs.
 */
function emit(line: string): void {
  process.stdout.write(`${line}\n`, () => process.exit(0));
}

main().catch(error => {
  // Last resort: one plain line, so the bar shows a cause instead of vanishing.
  // Through `emit` as well, so the failure path cannot be the one that leaks a
  // process on every turn.
  emit(`claude-auth-balancer: ${error instanceof Error ? error.message : 'statusline failed'}`);
});

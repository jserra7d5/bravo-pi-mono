# Agent Prompt: Pure TUI Visual Design for Pi Background Bash

You are designing the terminal UI surfaces for the planned Pi Background Bash extension. This is a **pure visual design task**: do not implement TypeScript, do not change package code, and do not revise architecture. Produce design artifacts that an implementer can translate into Pi extension renderers later.

## Source material

Read first:

- `docs/specs/pi-background-bash/design.md`
- `docs/specs/pi-background-bash/implementation-plan.md`
- `.agents/skills/tui-design/SKILL.md`

Follow the TUI design skill strictly.

## Goal

Design clean, concise, high-signal TUI renderings for the background bash tool calls/results and task controls.

The user explicitly does **not** want ugly raw JSON/tool-call dumps, full command args, or full output by default. The default UI should show high-level diagnostics only, with progressive disclosure for details.

## Surfaces to design

Design visual treatments for:

1. `bash` foreground call/result preservation
   - mostly preserve Pi's existing built-in bash look;
   - only specify how the override avoids visual regression.

2. `bash({ run_in_background: true })` call/result
   - start card / pending state;
   - successful start result;
   - failed-to-start result.

3. Background task terminal states
   - running;
   - completed/exited;
   - failed;
   - killed/stopped;
   - timed out;
   - blocked on likely interactive prompt;
   - output cap exceeded;
   - orphaned/unknown after reload/restart.

4. Auxiliary tool cards
   - `background_task_list`;
   - `background_task_status`;
   - `background_task_stop`;
   - optional `background_task_output` tail view.

5. `/tasks` command views
   - compact list;
   - show/detail view;
   - bounded tail view;
   - stop confirmation/result.

6. Widget/status/footer indicator
   - normal state, e.g. `BG 2 running`;
   - attention state, e.g. `BG 1 failed`, `BG 1 blocked`;
   - narrow-width behavior.

## Visual requirements

Use repo design conventions from `tui-design`:

- Use semantic glyphs consistently:
  - `◐` running;
  - `?` waiting/input/blocked prompt;
  - `⚠` warning/blocked/orphaned;
  - `✓` completed;
  - `✗` failed;
  - `→` transition/start;
  - `·` separators.
- Use existing semantic colors and identity palette; do not invent a new palette.
- Use container chrome for structured task/status cards.
- Use bookend chrome only for log/tail payload views where the content is the payload.
- Assume implementation will use `renderShell: "self"` where custom cards would otherwise sit inside Pi's default green/red tool box.
- Design for ANSI-aware width math and responsive truncation.
- Do not rely on `process.stdout.columns`; designs must work with render-provided width.

## Progressive disclosure policy

Default cards should show only:

- short task id;
- status glyph/label;
- elapsed runtime and max runtime if set;
- one-line truncated command summary;
- shortened output path;
- exit code/signal when terminal;
- warning badges for blocked/timed-out/output-cap/orphaned/failed;
- one concise next-action hint.

Hide by default:

- full command;
- full path;
- pid/pgid;
- env details;
- raw metadata JSON;
- full stdout/stderr;
- large log tails.

Expose details only in expanded/detail views or `/tasks show`, `/tasks tail`, or normal `read`.

## Deliverables

Write all output under:

`docs/specs/pi-background-bash/tui-design.md`

The file should include:

1. Visual design principles for this extension.
2. State/glyph/color mapping table.
3. Mockups for each surface listed above.
4. Narrow-width variants at approximately 80, 60, and 44 columns.
5. Progressive-disclosure rules: default vs expanded/detail content.
6. Renderer guidance for implementers:
   - which surfaces use container chrome;
   - which use bookend chrome;
   - where `renderShell: "self"` is required;
   - truncation rules for commands, task ids, and paths;
   - update throttling expectations.
7. Anti-patterns to avoid, especially raw JSON, full arg dumps, full output dumps, and per-output-chunk repainting.

Optional but useful: create a disposable mockup script under `/tmp/pi-bg-bash-tui-mockup.mjs` that renders sample cards at several widths. If you create it, mention the path in `tui-design.md`. Do not commit or write implementation code outside the spec file.

## Stop condition

Stop when `docs/specs/pi-background-bash/tui-design.md` is complete enough for an implementer to build the renderers without asking what the UI should look like.

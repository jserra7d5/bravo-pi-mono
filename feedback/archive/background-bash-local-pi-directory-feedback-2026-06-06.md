# Background bash runtime state should not be written inside the active repo

Date: 2026-06-06

## Issue

Pi creates `.pi/background-bash/...` runtime state under the current working directory when background bash is used. When the current directory is a project repository, this leaves untracked `.pi/` files inside the user's worktree.

Observed in `Quantiiv-Agent-Gateway` after agent work:

- `.pi/background-bash/registry.json`
- `.pi/background-bash/bg_*/metadata.json`
- `.pi/background-bash/bg_*/output.log`

These files are harness/operator state, not project artifacts.

## Why this is a problem

- Pollutes application repos with agent runtime files.
- Creates confusing untracked git status noise.
- Risks accidental commits unless every repo adds `.pi/` to `.gitignore`.
- Blurs ownership: project directories should contain project source, tests, docs, and intentional local dev files—not Pi process bookkeeping.

## Expected behavior

Background bash metadata and logs should be stored in a global Pi-controlled state directory, not inside the active worktree. For example:

- `~/.pi/background-bash/...`
- or another configured global/session state root

The stored records can include the original cwd as metadata without placing files in that cwd.

## Suggested fix

Move background bash registry/log storage out of the working directory by default. If repo-local storage is ever needed, make it explicit opt-in rather than the default.

Migration/compat note: existing `.pi/background-bash` directories can be ignored or garbage-collected; no project should need to track them.

# Project-local Pi extensions

This directory contains Pi extensions that are auto-discovered when running `pi` from this repository. Reload them in a live interactive session with `/reload`.

## Codex accounts footer + model speed

`codex-usage.ts` owns the custom two-line footer, the interactive `/fast` command, and cache-only Codex account usage display.

When the selected model is Codex-backed, the footer reads account/usage state from `authswap codex --usage --json`. Footer rendering and normal startup/turn refreshes are cache-only: they do not call the live ChatGPT usage endpoint, mutate global auth files, or probe accounts. Invalid, stale, or unavailable cache output renders as unknown/stale instead of guessing.

Use `/codex-accounts status` to show the cached account state. Use `/codex-accounts refresh` to explicitly run the isolated authswap refresh path (`authswap codex --refresh-usage --json --isolated-dir ... --all`) and then reread the cache.

### `/fast`

Use `/fast on|off|status` in an interactive Pi session.

- `/fast on` persists project-local fast mode and shows `speed fast` in the footer.
- `/fast off` persists normal speed and removes the footer indicator.
- `/fast status` reports the current mode.

Fast mode is intentionally UI-scoped: the extension only applies the request override when `ctx.hasUI` is true. Async subagents and noninteractive child Pi launches therefore stay normal by default, even when the sticky interactive setting is on.

Current provider mapping:

- `openai-codex` / `openai-codex-responses` + fast enabled -> provider payload `service_tier: "priority"`
- all other providers -> no payload change

The naming is intentionally general (`model speed` / `fast`) so additional providers can add their own mapping later without changing the user-facing command.

### Persistent state

The sticky setting is stored at `.pi/model-speed.json`. That runtime state file is gitignored; the extension code and tests are tracked.

### Validation

Run the standalone extension tests with:

```bash
node --experimental-strip-types --test .pi/extensions/__tests__/codex-usage.test.ts
```

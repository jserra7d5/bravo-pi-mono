# Project-local Pi extensions

This directory contains project-local Pi extension files that are auto-discovered when running `pi` from this repository. Project-local Pi packages are configured in `.pi/settings.json`. Reload extension/package changes in a live interactive session with `/reload`.

## Project Pi packages

`.pi/settings.json` installs `../packages/dynamic-skills` as a project-local Pi package. That package provides read-triggered dynamic subtree skill discovery; see `packages/dynamic-skills/README.md` and `docs/specs/pi-dynamic-skill-discovery/design.md`.

## Codex accounts footer + model speed

`codex-usage.ts` owns the custom two-line footer, the interactive `/fast` command, and cache-only Codex account usage display.

When the selected model is Codex-backed, the footer reads normalized account/usage state from `@bravo/codex-auth-balancer`. Footer rendering and normal startup/turn refreshes are cache-only: they do not mutate global auth files or probe accounts. Invalid, stale, or unavailable cache output renders as unknown/stale instead of guessing.

Use `/codex-accounts status` to show the cached account state. Use `/codex-accounts refresh` to explicitly refresh through the Codex auth balancer package and then reread the cache.

For interactive account balancing, use the `bravo-codex-balanced/*` provider models with the Codex balanced provider extension loaded. `pi-balanced` is the convenience launcher while this is piloted; it should load the provider path rather than relying on Pi/Codex auth-home swapping. Bare `pi` with `openai-codex/*` still uses `~/.pi/agent/auth.json` directly.

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

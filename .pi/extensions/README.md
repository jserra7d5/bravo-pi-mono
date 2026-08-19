# Project-local Pi extensions

This directory contains project-local Pi extension files that are auto-discovered when running `pi` from this repository. Project-local Pi packages are configured in `.pi/settings.json`. Reload extension/package changes in a live interactive session with `/reload`.

## Project Pi packages

`.pi/settings.json` installs `../packages/dynamic-skills` as a project-local Pi package. That package provides read-triggered dynamic subtree skill discovery; see `packages/dynamic-skills/README.md` and `docs/specs/pi-dynamic-skill-discovery/design.md`.

## Codex accounts footer + model speed

`codex-usage.ts` owns the custom two-line footer, the interactive `/fast` command, and cache-only Codex account usage display.

When the selected model is Codex-backed, the footer reads normalized account/usage state from `@bravo/codex-auth-balancer`. Footer rendering and normal startup/turn refreshes are cache-only: they do not mutate global auth files or probe accounts. Invalid, stale, or unavailable cache output renders as unknown/stale instead of guessing.

Codex usage-window labels come from the API's normalized `windowMinutes`, not from primary/secondary position. Canonical values render as `5h` (300 minutes) and `wk` (10,080 minutes); other exact whole-minute/hour/day/week durations use similarly concise labels. If duration metadata is absent or invalid, the footer uses neutral positional labels `pri`/`sec` and never guesses `5h`/`wk`. Percentages remain **remaining quota**, and reset countdowns retain their existing semantics.

The footer rides the shared `@bravo/render-clock` (imported by relative path from `../../packages/render-clock/src/index.ts`) instead of owning timers. It keeps a cached `FooterRenderState` behind the `setFooter()` component, refreshes that cache on real state changes (startup/turn refresh, usage cache changes, branch changes, `/fast` changes), and the component's `render()` path formats only the cached state. The live reset countdown derives from a clock-supplied `now` and requests a render only when the rendered reset-bucket signature changes, so an unchanged minute is byte-identical and idle ticks repaint nothing. The 5-minute Codex usage poll is a separate non-render clock subscriber whose render stays gated by the existing semantic cache-change check.

Use `/codex-accounts status` to show the cached account state. Use `/codex-accounts refresh` to explicitly refresh through the Codex auth balancer package and then reread the cache.

### Credential expiry

Usage percentages say nothing about whether a credential is still alive: a slot at 100% remaining is dead if its refresh token was revoked. Two surfaces cover that.

The account chip gains an `exp <duration>` segment — amber inside 3 days, red inside 24 hours, and **absent above 3 days**. It sits on the identity head rather than the usage segment, so it survives every narrow-width degradation step down to identity-only (below ~48 columns the whole codex chip is dropped to protect the context/cost prefix). The balancer refreshes proactively with 4 days of headroom, so a visible chip means proactive refresh is failing, not merely that time is passing.

At session start the extension also notifies for any slot that is inside the expiry window or can no longer refresh itself, including the reason the last proactive refresh failed.

`/reauth <slot>` needs a local browser and must not be used over SSH — it runs `codex logout` first, revoking the refresh token server-side, and then cannot complete its localhost callback login. Headless: run `CODEX_HOME=~/.bravo/codex-auth-balancer/accounts/<slot> codex exec --skip-git-repo-check "say ok"` to force a refresh (no browser needed while the refresh token is live), and only if that reports the token revoked, `CODEX_HOME=<slotDir> codex login --device-auth`.

For interactive account balancing, use the `bravo-codex-balanced/*` provider models with the Codex balanced provider extension loaded. `pi-balanced` is the convenience launcher while this is piloted; it should load the provider path rather than relying on Pi/Codex auth-home swapping. Bare `pi` with `openai-codex/*` still uses `~/.pi/agent/auth.json` directly.

### `/fast`

Use `/fast on|off|status` in an interactive Pi session.

- `/fast on` persists project-local fast mode and shows `speed fast` in the footer.
- `/fast off` persists normal speed and removes the footer indicator.
- `/fast status` reports the current mode.

The footer renders package-level `setStatus()` values generically from Pi's live extension-status map, preserving producer styling and insertion order. Async-subagents exclusively owns its `tasks:on` / `tasks:off` status; the footer does not read or duplicate task runtime state.

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

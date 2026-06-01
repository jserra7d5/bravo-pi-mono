# Codex Balanced Provider Implementation Plan

## Summary

Implement Codex account balancing as an explicit package-owned Pi provider extension in `@bravo/codex-auth-balancer`, with provider id `bravo-codex-balanced` and model ids such as `bravo-codex-balanced/gpt-5.5`. The provider must lease per request through balancer APIs, wrap Pi's Codex Responses stream, fail closed, and leave normal `openai-codex` and `PI_CODING_AGENT_DIR` behavior unchanged. Async subagents should opt in by selecting the balanced model and loading the package extension explicitly.

## Architectural invariants

- Provider ownership lives in `packages/codex-auth-balancer/extensions/pi/`, not in project-local `.pi/extensions/codex-usage.ts`.
- Register a new explicit provider, `bravo-codex-balanced`; do not hijack or override `openai-codex`.
- Use a custom `streamSimple` wrapper around Pi's exported Codex Responses transport; do not reimplement the Codex API.
- Do not use `PI_CODING_AGENT_DIR` as the auth-selection boundary for the new path.
- Keep `.pi/extensions/codex-usage.ts` as footer/status UI only for now.
- Async subagents use explicit extension/model selection, not environment-level auth swapping.
- Existing `codexAuthBalancer` process-env mode remains disabled by default and legacy/transitional.

## Non-goals

- No upstream Pi source changes.
- No implicit fallback from `bravo-codex-balanced` to global `~/.pi/agent/auth.json`.
- No automatic migration of all `openai-codex/*` users to balanced models.
- No provider/auth lifecycle logic in `.pi/extensions/codex-usage.ts`.
- No long-lived process-wide token lease for interactive sessions.
- No UI redesign beyond any small docs/status references needed for the rollout.

## Plan

### Phase 0 — Confirm Pi extension and transport interfaces

1. Inspect installed `@earendil-works/pi-ai` exports used by Pi extensions:
   - provider/model registration API;
   - `getModels("openai-codex")` metadata shape;
   - `streamSimpleOpenAICodexResponses()` signature and expected model/provider fields;
   - stream event, abort, and error lifecycle contracts.
2. Prove the critical auth seam before implementation proceeds: a custom provider must be able to invoke the Codex Responses transport with a caller-supplied bearer token while global `~/.pi/agent/auth.json` is absent, unreadable, or contains a sentinel invalid credential. If this fails, stop and request an upstream provider-auth override; do not continue with profile/auth swapping.
3. Prove a minimal local extension can register a synthetic model and appear in `pi --no-extensions -e <extension> --list-models`.
4. Record any type gaps in comments/tests near the extension implementation rather than adding compatibility shims.

Likely touched areas: `packages/codex-auth-balancer/extensions/pi/`, package TypeScript config if needed for extension compilation.

### Phase 1 — Add package lease API

1. Add exported types and functions in `packages/codex-auth-balancer/src/index.ts`:
   - `StartTokenLeaseInput`, `TokenLease`, `FinishTokenLeaseInput`, `FinishTokenLeaseResult`;
   - `startTokenLease(input): Promise<TokenLease>`;
   - `finishTokenLease(input): Promise<FinishTokenLeaseResult>`.
2. Required start input fields:
   - `provider: "bravo-codex-balanced"`;
   - `model: string`;
   - `purpose: "pi-provider-request" | "async-child-preflight" | "manual" | "command-backed-token"`;
   - `expected_runtime_ms: number`;
   - `ttl_safety_buffer_ms: number`;
   - optional `lease_key`, `preferred_slot`, `session_affinity_key`, and `abort_signal`.
3. Required finish input fields:
   - `lease_id`, `reservation_id`, `launch_id`;
   - `status: "completed" | "failed" | "aborted" | "preflight_failed" | "expired"`;
   - optional redacted `error_kind`.
4. Reuse the existing account loading, policy, reservation DB, and refresh/sync primitives instead of creating a second scheduler.
5. Start behavior:
   - opportunistically mark expired/stale leases terminal before selection;
   - atomically choose/reserve a slot using existing policy;
   - honor `preferred_slot` / `session_affinity_key` for multi-turn Pi session affinity;
   - enforce required TTL = expected request/runtime duration plus safety buffer;
   - refresh slot credentials before returning when TTL is insufficient;
   - persist refreshed credentials through balancer state only;
   - return only `access_token` plus redacted metadata: `lease_id`, `slot`, optional `label`, `expires_at`, optional `account_id_hash`, `reservation_id`, `launch_id`, and optional `session_affinity_key`.
6. Finish behavior:
   - idempotently mark reservation terminal with `completed`, `failed`, `aborted`, `preflight_failed`, or `expired`;
   - do not claim token leases create auth-copy temp directories; any command-backed lease metadata files are separate `0600` state and are removed/reaped by lease key/TTL;
   - retain only redacted diagnostics on conflict/safety failure.
7. Add `redactForJson` coverage for all lease fields and error paths.
8. Rollout gate: unit tests show lease acquisition never reads/writes active Pi auth, honors slot affinity, expires stale reservations, and fails closed when no usable slot exists.

Likely touched files: `packages/codex-auth-balancer/src/index.ts`, `packages/codex-auth-balancer/test/index.test.ts`.

### Phase 2 — Add command-backed token lease CLI

1. Extend `packages/codex-auth-balancer/src/cli.ts` with:
   - `codex-auth-balancer token --provider bravo-codex-balanced --lease-key <key>`;
   - `codex-auth-balancer token-finish --lease-key <key> --status completed|failed|aborted|preflight_failed`;
   - optional JSON/debug commands only if they can avoid printing secrets.
2. Treat `expired` as an internal/reaper status, not a user-supplied `token-finish` status.
3. Require `--lease-key` to be unique per command-backed token request, preferably a UUID; reject or safely fail on active key collisions.
4. Print only the bearer access token to stdout for `token`; store finish metadata in a `0600` lease file keyed by `--lease-key`.
5. Use a short default TTL for command-backed token leases, for example five minutes, so abandoned command leases are quickly reclaimable.
6. Keep all logs on stderr redacted.
7. Support bounded timeout behavior and nonzero exit on lease/refresh failure.
8. Update package capability/version output to advertise token lease support.
9. Rollout gate: CLI tests verify stdout contains only a token-shaped value and stderr/errors/lease files contain no token, refresh token, auth JSON, full email, generation id, or raw hashes.

Likely touched files: `packages/codex-auth-balancer/src/cli.ts`, `packages/codex-auth-balancer/test/index.test.ts`.

### Phase 3 — Implement the Pi provider extension

1. Create `packages/codex-auth-balancer/extensions/pi/index.ts`.
2. Register provider id `bravo-codex-balanced` with display name `Bravo Codex Balanced`.
3. Mirror built-in Codex models from `getModels("openai-codex")`:
   - model ids rewritten to `bravo-codex-balanced/<model>`;
   - `api: "openai-codex-responses"`;
   - same base URL, context window, max tokens, modalities, costs, and thinking map.
4. Implement custom `streamSimple`:
   - derive or receive a Pi session affinity key and request the previously pinned slot on subsequent turns in that session;
   - acquire a token lease before starting the stream;
   - assert the returned token is non-empty and valid-shaped before calling the underlying transport;
   - pass the token into Pi's Codex Responses transport through the supported auth/key seam;
   - call `streamSimpleOpenAICodexResponses()` with an internal model object whose provider is rewritten to `openai-codex` only if required for Codex replay compatibility;
   - rewrite emitted assistant/message metadata back to `provider: "bravo-codex-balanced"` and the public balanced model id before forwarding, so session history restore does not bypass the balanced provider;
   - finish/release the lease through an idempotent finalizer in `try/finally` covering setup failure, transport error, consumer cancellation/early return, abort, and normal completion.
5. Fail closed on lease acquisition, empty token, refresh, stream setup, stream error before completion, abort cleanup, and redaction uncertainty. Treat finish failure after response emission as an audit/diagnostic failure with redacted warning/error where Pi allows.
6. Add extension build/package wiring:
   - update `packages/codex-auth-balancer/tsconfig.json` or a dedicated extension tsconfig so `extensions/**/*.ts` is compiled;
   - import package APIs through package exports, e.g. `@bravo/codex-auth-balancer`, not fragile relative imports into `src/`;
   - add TypeScript path mapping if needed so self-referential package imports resolve to `./src/index.ts` during clean builds before `dist/` exists;
   - declare Pi package peer/dev dependencies needed by the extension, such as `@earendil-works/pi-ai` and Pi extension API types, instead of relying on ambient transitive availability;
   - define canonical dev and built paths, e.g. source path for repo tests and `node_modules/@bravo/codex-auth-balancer/dist/extensions/pi/index.js` or equivalent for installed use;
   - include extension source/dist in package publish/install output;
   - either document manual `-e` only for this release or add a gate proving package metadata discovery works;
   - avoid making extension auto-loaded globally.
7. Rollout gate: `pi -e <dev-or-built-extension-path> --list-models` lists at least one `bravo-codex-balanced/*` model discovered from installed Codex metadata.

Likely touched files: `packages/codex-auth-balancer/extensions/pi/index.ts`, `packages/codex-auth-balancer/package.json`, `packages/codex-auth-balancer/tsconfig.json`, package tests.

### Phase 4 — Provider tests and safety regression coverage

1. Add unit tests for:
   - expected model mirroring and provider id/display name using discovered installed Codex models, not a mandatory hard-coded model id;
   - lease start/finish on successful stream;
   - finish on setup error, stream error, abort, and consumer cancellation/early return;
   - lease acquisition failure and empty-token return do not call the underlying transport and do not fall back to global auth;
   - token TTL refresh behavior;
   - stale/crashed leases are marked expired and slots become reusable;
   - multi-turn session slot affinity requests the same slot after turn 1;
   - emitted session metadata is restored to `bravo-codex-balanced` and does not leak internal `openai-codex` provider identity;
   - refresh failure is terminal;
   - redaction in thrown errors, logs, launch metadata, retained markers, command lease files, and JSON outputs using golden fixtures for fake access token, refresh token, full email, auth hash, generation id, and auth JSON.
2. Add integration tests where practical with fake Pi transport hooks before using live Codex.
3. Add live/manual smoke script documentation for:
   - list mirrored models and select one discovered model;
   - tiny prompt through that discovered `bravo-codex-balanced/<model>`;
   - prove global Pi auth is absent/unreadable/sentinel-invalid and not used as fallback;
   - unchanged `~/.pi/agent/auth.json` after balanced request;
   - concurrent requests reserve/release according to policy.
4. Rollout gate: no balanced-provider test requires real secrets unless explicitly marked manual.

Likely touched files: `packages/codex-auth-balancer/test/*`, optional `packages/codex-auth-balancer/README.md` or spec notes.

### Phase 5 — Async subagents explicit model/extension integration

1. Keep `codexAuthBalancer.mode: "process-env"` disabled by default and document it as legacy for `openai-codex/*` only.
2. Add balanced provider variants or examples to async agent definitions rather than changing default agents immediately, for example:
   - `model: bravo-codex-balanced/<discovered-or-configured-model>`;
   - `extensions: [<repo>/packages/codex-auth-balancer/extensions/pi/index.ts]` in dev or the canonical built extension path after build/install.
3. Ensure `buildPiCommand()` continues to launch children with `--no-extensions` plus explicit `-e` paths.
4. Ensure preflight checks the exact child command with the balanced provider extension loaded and fails before spawn if the model is unavailable.
5. Avoid invoking `prepareLaunch()`/process-env auth swapping for `bravo-codex-balanced/*`; update `isCodexModel()` or `prepareCodexBalancer()` so the `codex` substring in `bravo-codex-balanced` cannot trigger the legacy parent-level balancer.
6. If async config resolves a custom balancer `stateDir`, propagate it to child processes through a non-secret environment variable such as `CODEX_AUTH_BALANCER_HOME`, since the provider extension now owns leasing inside the child.
7. Rollout gate: a child using a balanced variant passes model preflight and a child without the extension fails with the existing provider-extension hint.

Likely touched files: `packages/async-subagents/agents/*.md`, `packages/async-subagents/README.md`, `packages/async-subagents/src/config.ts`, `packages/async-subagents/src/start.ts`, async tests.

### Phase 6 — Update `pi-balanced` as a convenience launcher

1. Change `packages/codex-auth-balancer/src/pi-balanced.ts` from whole-profile auth isolation as the primary path to launching normal `pi` with the balanced provider extension loaded.
2. Optionally default `--model` to a configured `bravo-codex-balanced/<model>` when the user did not pass `--model`.
3. Leave `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` untouched unless the user explicitly set/passed them.
4. Retain current whole-profile isolation only behind an explicit legacy flag/env for migration and diagnostics.
5. Rollout gate: nested `pi-balanced` protection remains, normal Pi config/session behavior is preserved, and no fake Pi home is created in extension-provider mode.

Likely touched files: `packages/codex-auth-balancer/src/pi-balanced.ts`, package CLI tests/docs.

### Phase 7 — Documentation, migration, and rollout

1. Document user-facing migration:
   - interactive: run `pi-balanced` or `pi -e <codex-balancer-extension> --model bravo-codex-balanced/<model>`;
   - async: select a balanced variant/model and include the extension path;
   - legacy: `codexAuthBalancer.process-env` remains off by default for `openai-codex/*` only.
2. Document operational commands:
   - list accounts/usage;
   - inspect reservations;
   - run a safe model preflight;
   - clean retained diagnostics.
3. Update security docs with redaction and file-mode requirements.
4. Rollout gates:
   - gate 1: unit tests only;
   - gate 2: local Pi list-models preflight;
   - gate 3: one manual tiny prompt;
   - gate 4: one async child using balanced provider;
   - gate 5: concurrent children and reservation release audit;
   - gate 6: enable examples for broader users.
5. Keep default behavior unchanged until gates 1-5 pass.

Likely touched files: package READMEs, `docs/specs/codex-balanced-provider/*`, async README/agent examples.

## Validation

Run with fail-fast timeouts and no interactive prompts where applicable:

- `timeout 60s npm run check --workspace @bravo/codex-auth-balancer`
- `timeout 120s npm test --workspace @bravo/codex-auth-balancer`
- `timeout 60s npm run check --workspace @bravo/async-subagents`
- `timeout 120s npm test --workspace @bravo/async-subagents`
- `timeout 30s pi --no-extensions -e packages/codex-auth-balancer/extensions/pi/index.ts --list-models` and select an actual mirrored `bravo-codex-balanced/*` model from output.
- Manual/live only: `timeout 120s pi --no-extensions -e packages/codex-auth-balancer/extensions/pi/index.ts --model <discovered-bravo-codex-balanced-model> --mode text -p 'Reply exactly: OK'`
- Verify global auth non-use/immutability around live/manual smoke: run once with global auth absent/unreadable or sentinel-invalid to prove caller-supplied token is the only auth path, and checksum or copy `~/.pi/agent/auth.json` before and after.
- Verify reservation lifecycle: `codex-auth-balancer reservations --json` before/during/after concurrent prompts.
- Verify launch logs and retained diagnostics contain no tokens, refresh tokens, raw auth JSON, raw hashes, full emails, generation ids, or secret-bearing env values.

## Risks / Unknowns

- Pi may not export enough of the Codex Responses transport/auth seam; if so, stop and request an upstream provider-auth override rather than adding `PI_CODING_AGENT_DIR` auth swapping.
- Exact Pi extension registration API and package metadata support need confirmation against installed `@earendil-works/pi-ai`.
- OAuth token expiry/refresh fields may differ between Codex CLI and Pi auth payloads; TTL enforcement must be proven with fixtures before live use.
- Per-request leasing in interactive sessions could increase reservation churn; slot affinity reduces account hopping but may concentrate usage in long sessions. Observe DB contention and add only minimal backoff if tests show real conflicts.
- Codex Responses account-bound state may require stronger session affinity than the first implementation can infer from Pi context. If no stable session key is available to the provider wrapper, stop and define one before live rollout.
- Async default model migration is intentionally deferred; switching built-ins from `openai-codex/*` to balanced models needs a separate rollout decision.
- Command-backed token mode is secret-bearing on stdout; shell history, debug logging, and launch metadata must not capture it.

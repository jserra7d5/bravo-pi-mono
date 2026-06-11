# Codex Balanced Provider Design

## Goal

Provide Codex account balancing for Pi and async subagents without modifying upstream Pi and without using `PI_CODING_AGENT_DIR` as an auth-selection boundary.

The balanced path should be explicit, opt-in, auditable, fail-closed, and reusable outside this repo.

## Problem

Pi currently exposes two unsuitable seams for account selection:

- `--api-key <value>` is too narrow. It can carry a Codex OAuth access token, but not refresh credentials or slot metadata.
- `PI_CODING_AGENT_DIR` is too broad. It controls `auth.json`, `settings.json`, `models.json`, tools, skills, prompt templates, themes, and other agent config. Using it to swap accounts creates brittle fake Pi homes and breaks nested subagents.

The missing ideal upstream seam would be a provider-auth path override. Until that exists, the best no-source-change design is a package-owned Pi provider extension.

## Direction

Add a package-owned Pi extension under `@bravo/codex-auth-balancer` that registers a new provider, for example:

- Provider id: `bravo-codex-balanced`
- Display name: `Bravo Codex Balanced`
- Model names: mirror the built-in `openai-codex` model ids, e.g. `bravo-codex-balanced/gpt-5.5` and `bravo-codex-balanced/gpt-5.4-mini`

Do not hijack or override `openai-codex`. The balanced provider is explicit opt-in and leaves normal Pi behavior unchanged.

## Extension placement

Primary implementation lives with the package that owns auth state:

```text
packages/codex-auth-balancer/extensions/pi/index.ts
```

`packages/codex-auth-balancer/package.json` should advertise the extension through package metadata once supported by the local install flow.

The existing project-local `.pi/extensions/codex-usage.ts` should not own provider auth or stream lifecycle logic. It can remain a footer/status UI and may later be renamed or replaced by a package extension UI layer. Provider leasing belongs in `@bravo/codex-auth-balancer`.

## Provider implementation

The extension registers a custom provider using Pi's extension API. It should reuse Pi's Codex Responses transport rather than reimplementing the API.

Preferred strategy:

1. Import the built-in Codex model metadata from `@earendil-works/pi-ai` with `getModels("openai-codex")`.
2. Register `bravo-codex-balanced` models copied from those entries with:
   - `api: "openai-codex-responses"`
   - `baseUrl` matching the built-in Codex base URL
   - matching context window, max tokens, input modalities, costs, and thinking map
3. Provide a custom `streamSimple` wrapper.
4. In the wrapper, create a leased token, then call Pi's exported `streamSimpleOpenAICodexResponses()` with an internal model object whose provider is rewritten to `openai-codex` if needed for Codex tool-call replay compatibility.
5. Rewrite emitted assistant/message metadata back to the public balanced provider identity before forwarding, so persisted session history keeps `provider: "bravo-codex-balanced"` and the balanced model id. The internal `openai-codex` provider rewrite must not leak into Pi session restore state.
6. Finish/release the lease with an idempotent finalizer in `try/finally` around stream setup and event forwarding. The finalizer must handle setup failure before first event, transport error, consumer cancellation/early return, `AbortSignal` abort, and normal completion.

The provider must fail closed. If a lease cannot be acquired, or if the returned access token is empty/falsy/invalid-shaped, the request fails before calling the underlying Codex transport. It must not silently fall back to `~/.pi/agent/auth.json`, environment API keys, or any parent/global auth source.

## Lease contract

Add package-level lease APIs and CLI commands. The provider extension can call the TypeScript API directly when running in this repo/package, and a command-backed mode can be kept for external use.

Required operations:

```ts
type TokenLeasePurpose = "pi-provider-request" | "async-child-preflight" | "manual" | "command-backed-token";

type TokenLeaseStatus = "completed" | "failed" | "aborted" | "preflight_failed" | "expired";

type StartTokenLeaseInput = {
  provider: "bravo-codex-balanced";
  model: string;
  purpose: TokenLeasePurpose;
  expected_runtime_ms: number;
  ttl_safety_buffer_ms: number;
  lease_key?: string;
  preferred_slot?: string;
  session_affinity_key?: string;
  abort_signal?: AbortSignal;
};

type TokenLease = {
  schema_version: 1;
  lease_id: string;
  slot: string;
  label?: string;
  access_token: string;
  expires_at: number;
  account_id_hash?: string;
  reservation_id: string;
  launch_id: string;
  session_affinity_key?: string;
};

type FinishTokenLeaseInput = {
  lease_id: string;
  reservation_id: string;
  launch_id: string;
  status: TokenLeaseStatus;
  error_kind?: string;
};

startTokenLease(input: StartTokenLeaseInput): Promise<TokenLease>;

finishTokenLease(input: FinishTokenLeaseInput): Promise<{
  ok: boolean;
  warning?: string;
}>;
```

Token leases do not normally create isolated auth directories or copy Pi/Codex auth files. Any filesystem state created for command-backed lease metadata must be `0600`, redacted, TTL-bound, and explicitly cleaned or reaped.

Start responsibilities:

- Atomically choose and reserve a slot using existing balancer policy.
- Honor `preferred_slot` / `session_affinity_key` when continuing an existing Pi session, because Codex Responses state such as `previous_response_id` may be account-bound.
- Refresh OAuth before returning if access-token TTL is below the required runtime/request buffer.
- Persist refreshed slot credentials through the balancer, not through Pi global auth.
- Return only the bearer access token and redacted lease metadata.

Finish responsibilities:

- Mark reservation terminal.
- Record status: completed, failed, aborted, preflight_failed, or expired.
- Clean temporary state if any was created.
- Retain diagnostic directories only for conflict/safety failures, with redacted markers.

CLI shape for command-backed auth experiments:

```bash
codex-auth-balancer token --provider bravo-codex-balanced --lease-key <key>
codex-auth-balancer token-finish --lease-key <key> --status completed|failed|aborted|preflight_failed
```

`token` prints only the access token to stdout. Lease metadata needed by `token-finish` is stored in a `0600` lease file keyed by `--lease-key`, never printed alongside the token. Command-backed leases use a short default TTL, for example five minutes, so abandoned command leases are automatically reclaimable. `expired` is an internal/reaper status, not a user-supplied `token-finish` status. Logs and stderr must not include secrets.

## Token lifetime policy

A token lease is acceptable for bounded requests and async subagents because Codex OAuth access-token TTL is typically longer than child runtime. The balancer must still enforce TTL explicitly:

- Required TTL = expected max runtime/request duration + safety buffer.
- If TTL is insufficient, refresh before lease start.
- If refresh fails, **fail over before failing closed**. A lease-acquisition failure (refresh failed, no usable token, TTL still insufficient) is not terminal: the stream wrapper returns a `lease-failed` outcome and the rotation policy moves to the next slot. The turn only fails closed once every slot has been tried, and the terminal error then surfaces the genuine lease error rather than a synthesized "all accounts rate limited" message. A hard refresh failure additionally marks that slot `broken` (see auth-balancer design) so it is skipped on subsequent selections.
- Every lease has `expires_at`; lease acquisition opportunistically marks stale reservations expired before selecting a slot. A reaper path must make slots reusable after crashes, SIGKILL, or abandoned command-backed leases.

Top-level interactive sessions are less bounded, so the provider should lease per provider request rather than once per process. Pi's command-backed provider key resolution and/or the custom stream wrapper make this possible without relying on a single startup token.

## Async subagents integration

Async subagents should use the balanced provider as a model/provider selection, not an environment-level auth swap.

Target behavior:

- GPT/Codex agent definitions or variants select `bravo-codex-balanced/<model>`.
- The async launch includes the package provider extension path because child Pi runs with `--no-extensions` and explicit `-e` paths.
- The old `codexAuthBalancer` process-env mode remains disabled by default and retained only as a transitional legacy path for `openai-codex` models.
- Async start logic must explicitly skip parent-level `prepareLaunch()` / process-env auth swapping for `bravo-codex-balanced/*`, even though the provider name contains `codex`.
- If async config supplies a custom balancer `stateDir`, the child environment must include the corresponding non-secret state-dir variable, e.g. `CODEX_AUTH_BALANCER_HOME`, so the provider extension uses the intended database.
- Model preflight runs against the exact child command with the balanced provider extension loaded.

This avoids fake child `PI_CODING_AGENT_DIR` homes and preserves normal subagent config, tools, settings, and session behavior.

## `pi-balanced` behavior

`pi-balanced` should become a convenience launcher rather than the core balancing mechanism.

End-state behavior:

- Launch normal `pi` with the balanced provider extension loaded.
- Optionally default the model to a configured `bravo-codex-balanced/<model>`.
- Leave `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` alone unless the user explicitly passes them.

The current whole-profile isolation mode can remain only as a migration/pilot path and should not be used for async subagent balancing.

## Footer/status UI

Keep UI and provider concerns separate:

- Provider extension owns account lease and stream lifecycle.
- Footer/status extension displays account state and reservations from package APIs.

The existing `.pi/extensions/codex-usage.ts` can continue to show usage and active account information. A future cleanup can move that UI into `packages/codex-auth-balancer/extensions/pi/` and rename it to a broader Codex Balancer extension, but provider correctness should not depend on that rename.

## Security and redaction

Hard rules:

- Never log access tokens, refresh tokens, full auth JSON, raw auth hashes, generation IDs, or full emails.
- Do not include secrets in `launch.json`, async status/events, tool outputs, footer text, diagnostics, or retained markers.
- If a token is passed through a command-backed `apiKey`, stdout is secret-bearing and must be consumed directly; stderr must be redacted.
- Lease directories, if used, are `0700`; token/auth files are `0600`.
- Reservation/lease observability may expose only redacted fields: slot label/id as configured safe, status, provider/model, created/updated/expires timestamps, lease/reservation/launch ids, and non-secret error kind. No token-bearing fields.
- Fail closed on lease acquisition, refresh, stream setup, token validation, cleanup, or redaction uncertainty. Post-stream finish failures are audit/diagnostic failures after output may already have been emitted; record and surface a redacted warning/error where Pi allows, but do not claim the already-emitted response was prevented.

## Validation plan

Unit tests:

- Provider registers expected mirrored Codex models discovered from the installed `getModels("openai-codex")`; tests must not require a hard-coded model id unless that id is present.
- `streamSimple` starts and finishes a lease on success.
- Lease finish runs on setup error, transport error, consumer cancellation, and abort.
- Lease failure or empty token does not call the underlying transport and does not fall back to global auth.
- Session metadata emitted by the wrapper uses `bravo-codex-balanced`, not leaked internal `openai-codex` identity.
- Multi-turn requests in one session preserve slot affinity.
- Stale leases are reaped/opportunistically expired and their slots become reusable.
- Redaction excludes tokens from logs/events/errors using golden fixtures for fake access tokens, refresh tokens, emails, auth hashes, generation ids, and diagnostic files.
- TTL policy refreshes near-expired credentials and fails closed when refresh fails.

Integration tests:

- `pi -e packages/codex-auth-balancer/extensions/pi --list-models` lists at least one balanced model mirrored from installed Codex metadata; smoke tests select an actual discovered model.
- A tiny prompt succeeds through a discovered `bravo-codex-balanced/<model>`.
- Prove the custom provider can invoke Codex transport with caller-supplied bearer auth while global Pi auth is absent, unreadable, or contains a sentinel invalid credential. If this cannot be proven, stop and request an upstream provider-auth seam.
- Global `~/.pi/agent/auth.json` is not read as fallback and is not modified by balanced-provider requests.
- Concurrent child launches reserve according to policy and release reservations.
- Async child preflight passes with the balanced provider extension loaded.

Regression tests:

- Normal `openai-codex` behavior remains unchanged when the extension is not loaded.
- Normal subagents work with async balancer disabled.
- Gemini/non-Codex children are unaffected.

## Rollout

1. Implement the provider extension behind explicit `bravo-codex-balanced/*` model names.
2. Add package CLI/API token lease commands.
3. Add async-subagents config examples/variants using the balanced provider extension.
4. Update `pi-balanced` to prefer extension-provider mode.
5. Keep process-env whole-profile balancing disabled by default and document it as legacy/transitional.

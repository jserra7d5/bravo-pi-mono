# Codex Auth Balancer Implementation Plan

## Scope and invariant

Implement the V1 process-launch balancer described in `design.md`. The implementation must not do live global auth mutation as the primary path. Every balanced Pi process or async subagent receives isolated auth homes through environment variables:

```bash
PI_CODING_AGENT_DIR=/absolute/path/to/isolated/pi-agent
CODEX_HOME=/absolute/path/to/isolated/codex
```

Non-negotiable invariants:

- No mid-stream, websocket-continuation, or in-process provider auth swap in V1.
- No token, refresh token, raw account id, or complete auth file content in TUI, logs, events, or errors.
- Footer rendering reads cache only unless a user explicitly invokes a refresh command.
- Launch balancing is fail-closed by default for configured balanced launches; optional warn-and-current-auth fallback is controlled by config.
- Isolated auth directories are per launch/run and are never shared mutable process homes.

## Concrete module and file touchpoints

## Authswap binary discovery and adapter contract

Repo consumers must call authswap through a small adapter, not ad hoc shell-outs. Discovery order is:

1. Explicit config/CLI path (`authswapPath`) when supported by the caller.
2. `AUTHSWAP_BIN` environment variable.
3. `authswap` found on `PATH` via non-interactive executable lookup.

The adapter must validate the binary before first use by running:

```bash
authswap --version --json
```

Required version contract:

- `schema_version: 1` in the version response.
- `name: "authswap"`.
- `version` semver `>= 0.4.0` (first version with V1 Codex launch isolation and sync-back contracts).
- `capabilities.codex_usage_json: 1`, `capabilities.codex_refresh_usage_json: 1`, `capabilities.codex_prepare_launch_json: 1`, and `capabilities.codex_sync_back_json: 1`.

Old-binary behavior is fail-closed for configured balanced launches: if the binary is missing, non-executable, returns non-JSON, has an unsupported schema version, or is below the minimum version/capabilities, consumers must not launch with partial balancer env. Optional warn-and-current-auth fallback is allowed only when the caller explicitly configured `failClosed: false`; the warning must name the adapter failure class without including paths to auth files or token material.

The adapter owns process execution timeouts, stdout/stderr size limits, JSON parsing, schema validation, and exit-code mapping. Consumers must not trust any authswap stdout until the adapter validates exact JSON schema and confirms stdout contains only one JSON document.

Adapter failure mapping:

| Failure | Adapter classification | Retryable | Consumer behavior |
|---|---|---:|---|
| Binary missing/not executable | `AUTHSWAP_UNAVAILABLE` | no | fail closed unless explicit warn fallback |
| Version below minimum/capability absent | `AUTHSWAP_UNSUPPORTED_VERSION` | no | fail closed; instruct upgrade |
| Unsupported `schema_version` in stdout/stderr | `AUTHSWAP_SCHEMA_MISMATCH` | no | fail closed; do not use env |
| Malformed JSON, multiple JSON docs, banner/progress on stdout | `AUTHSWAP_MALFORMED_JSON` | no | fail closed for launch; footer renders warning/stale |
| Command timeout/kill | `AUTHSWAP_TIMEOUT` | yes | retry only within caller budget; otherwise fail closed |
| Exit `2` no usable/configured account | `NO_USABLE_CODEX_ACCOUNT` | no | fail closed or warn fallback |
| Exit `4` invalid/missing auth files | `CODEX_AUTH_INVALID` | no | fail closed |
| Exit `5` isolated dir/copy failure | `ISOLATION_PREP_FAILED` | maybe | retry with new isolated dir if safe |
| Exit `6` lock timeout | `AUTHSWAP_LOCK_TIMEOUT` | yes | jittered retry within timeout budget |
| Exit `8` missing/unsafe isolated dir | `UNSAFE_ISOLATED_DIR` | no | caller bug; fail closed |
| Exit `3` usage cache absent/invalid/stale | `USAGE_CACHE_UNAVAILABLE` | no | render stale/warning; explicit refresh required |
| Exit `7` malformed input/schema mismatch | `AUTHSWAP_INPUT_OR_SCHEMA_ERROR` | no | fail closed; caller/config bug unless unsupported schema |
| Exit `9` stdout contract violation | `AUTHSWAP_STDOUT_CONTRACT` | no | fail closed; reject output |
| Exit `10` sync conflict | `SYNC_BACK_CONFLICT` | no | do not overwrite newer slot; retain dir/marker for explicit inspection or cleanup |
| Exit `124` timeout | `AUTHSWAP_TIMEOUT` | yes | same as command timeout |


### Authswap repository touchpoints

Authswap source is outside this repository at `/home/joe/Documents/misc/authswap` and should expose a stable machine contract consumed here.

- `/home/joe/Documents/misc/authswap/authswap`
  - Add or verify CLI parsing for cache-only `authswap codex --usage --json` and explicit probe `authswap codex --refresh-usage --json`.
  - Add or verify CLI parsing for `authswap codex --prepare-launch --json --isolated-dir DIR [--slot SLOT]`; omission of `--isolated-dir` must fail for repo V1 consumers.
  - Add `authswap pi launch -- ...` or equivalent wrapper entrypoint if implementing first-class launcher there.
- `/home/joe/Documents/misc/authswap/src/authswap_codex.py`
  - Implement selection, isolated directory creation, JSON output, locking, redaction-safe errors.
  - Reuse existing slot inventory, probing, usage scoring, token refresh, and reauth detection.

### Pi footer extension touchpoints

- `.pi/extensions/codex-usage.ts`
  - Add authswap cache reader helpers or import extracted local helpers.
  - Extend footer rendering to show account slots and usage windows when the current model is Codex.
  - Add `/codex-accounts`, `/codex-accounts refresh`, `/codex-accounts switch <slot>`, and `/codex-accounts launch-mode on|off|status` command handlers if extension command APIs support them.
  - Preserve existing `/fast` command and service-tier payload behavior.
- `.pi/extensions/__tests__/codex-usage.test.ts`
  - Add rendering, parser, width degradation, redaction, stale cache, and command parsing tests.

### Async subagents touchpoints

- `packages/async-subagents/src/config.ts`
  - Extend `AsyncSubagentsConfig` with `codexAuthBalancer`.
  - Update config validation allowed keys.
- `packages/async-subagents/src/start.ts`
  - Before model preflight and `buildPiCommand`, decide whether the requested model/provider is Codex/OpenAI Codex.
  - Invoke the authswap prepare-launch command with bounded timeout and run-local isolated dir.
  - Merge the returned env into the child `PiCommand.extraEnv`.
  - Add non-secret selection metadata to launch logs and supervisor input where useful.
- `packages/async-subagents/src/piHarness.ts`
  - Ensure `writeLaunchLogWithMetadata` redacts `PI_CODING_AGENT_DIR` and `CODEX_HOME` only if required by policy; these paths are not secrets but may disclose usernames. Prefer logging basename/run-relative form plus selected slot metadata.
  - Continue redacting any env key containing `TOKEN`, `SECRET`, `KEY`, `AUTH`, or matching configured sensitive keys.
- `packages/async-subagents/src/schemas.ts` and CLI/tool schema files, only if public config schema is generated there.
  - Do not expose arbitrary child env to agents. Balancing must be internal to launch path.

### Optional Pi CLI launcher touchpoints

- `scripts/pi-balanced` or package bin if this repo owns the wrapper.
  - Small supervisor wrapper that calls authswap prepare-launch, spawns `pi "$@"` as a child with returned env, propagates signals, waits, runs sync-back and cleanup/retention, then returns the child status.
- Authswap-owned launcher is preferred if authswap is the source of account state: `authswap pi launch -- pi ...`.

### `/new` touchpoints

Investigate Pi core before implementing:

- If `/new` spawns a new process, inject the same prepare-launch env into that spawned process.
- If `/new` is in-process session reset, defer V1 support and render an explicit unsupported message.

No `/new` implementation should proceed until the process boundary is proven.

## Data contracts

### Account slot model

Internal TypeScript shape:

```ts
export type CodexAccountStatus = "ok" | "limited" | "broken" | "unknown";

export interface UsageWindow {
  name: "primary" | "secondary" | string;
  label: string;
  remainingPercent?: number;
  resetAt?: number;
  resetInSeconds?: number;
  stale?: boolean;
}

export interface CodexAccountSlot {
  slot: string;
  label?: string;
  email?: string;
  authPath: string;
  piAuthPath?: string;
  accountIdHash?: string;
  activePi: boolean;
  activeCodex: boolean;
  status: CodexAccountStatus;
  usage?: {
    primary?: UsageWindow;
    secondary?: UsageWindow;
    updatedAt?: number;
    source?: "cache" | "probe" | "unknown";
  };
  problem?: {
    code: string;
    message: string;
  };
}
```

Raw `accountId` may be used inside authswap for comparison but must not cross into rendered/logged contracts except as `account_id_hash`. The hash contract is deterministic on the same machine/user and non-reversible for display correlation: `base64url(sha256("codex-auth-balancer-v1:" + salt + ":" + account_id))` truncated to 32 characters, using RFC 4648 base64url without padding. The salt is a stable per-machine/user random value generated once and stored with mode `0600` under `$AUTHSWAP_HOME/providers/openai/account-id-hash-salt` (or equivalent authswap state file) and never logged. Do not use a global unsalted hash; never use the hash as an authentication secret or for cross-machine correlation.

### `authswap codex --usage --json` schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AuthswapCodexUsageV1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "generated_at", "accounts"],
  "properties": {
    "schema_version": { "const": 1 },
    "generated_at": { "type": "integer", "minimum": 0 },
    "cache_path": { "type": "string" },
    "stale_after_ms": { "type": "integer", "minimum": 0 },
    "accounts": {
      "type": "array",
      "items": { "$ref": "#/$defs/account" }
    }
  },
  "$defs": {
    "account": {
      "type": "object",
      "additionalProperties": false,
      "required": ["slot", "active_pi", "active_codex", "status"],
      "properties": {
        "slot": { "type": "string", "pattern": "^[A-Za-z0-9_.-]+$" },
        "label": { "type": "string", "maxLength": 64 },
        "email": { "type": "string", "maxLength": 320 },
        "account_id_hash": { "type": "string", "maxLength": 64 },
        "active_pi": { "type": "boolean" },
        "active_codex": { "type": "boolean" },
        "status": { "enum": ["ok", "limited", "broken", "unknown"] },
        "usage": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "primary": { "$ref": "#/$defs/window" },
            "secondary": { "$ref": "#/$defs/window" },
            "updated_at": { "type": "integer", "minimum": 0 },
            "source": { "enum": ["cache", "probe", "unknown"] }
          }
        },
        "problem": {
          "type": "object",
          "additionalProperties": false,
          "required": ["code", "message"],
          "properties": {
            "code": { "type": "string", "pattern": "^[A-Z0-9_]+$" },
            "message": { "type": "string", "maxLength": 300 }
          }
        }
      }
    },
    "window": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "label"],
      "properties": {
        "name": { "type": "string", "maxLength": 64 },
        "label": { "type": "string", "maxLength": 32 },
        "remaining_percent": { "type": "number", "minimum": 0, "maximum": 100 },
        "reset_at": { "type": "integer", "minimum": 0 },
        "reset_in_seconds": { "type": "integer", "minimum": 0 },
        "stale": { "type": "boolean" }
      }
    }
  }
}
```

### `authswap codex --prepare-launch --json --isolated-dir <dir>` schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AuthswapCodexPrepareLaunchV1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "selected_slot", "reason", "status", "pi_agent_dir", "codex_home", "env", "metadata"],
  "properties": {
    "schema_version": { "const": 1 },
    "selected_slot": { "type": "string", "pattern": "^[A-Za-z0-9_.-]+$" },
    "label": { "type": "string", "maxLength": 64 },
    "reason": { "type": "string", "maxLength": 200 },
    "status": { "enum": ["ok", "limited", "unknown"] },
    "primary_remaining_percent": { "type": "number", "minimum": 0, "maximum": 100 },
    "secondary_remaining_percent": { "type": "number", "minimum": 0, "maximum": 100 },
    "isolated_dir": { "type": "string" },
    "pi_agent_dir": { "type": "string" },
    "codex_home": { "type": "string" },
    "env": {
      "type": "object",
      "additionalProperties": false,
      "required": ["PI_CODING_AGENT_DIR", "CODEX_HOME"],
      "properties": {
        "PI_CODING_AGENT_DIR": { "type": "string" },
        "CODEX_HOME": { "type": "string" }
      }
    },
    "metadata": {
      "type": "object",
      "additionalProperties": false,
      "required": ["metadata_path", "expected_generation", "auth_hash"],
      "properties": {
        "metadata_path": { "type": "string" },
        "expected_generation": { "type": "string", "minLength": 1, "maxLength": 200 },
        "auth_hash": { "type": "string", "minLength": 16, "maxLength": 128 },
        "usage_updated_at": { "type": "integer", "minimum": 0 },
        "cache_stale": { "type": "boolean" },
        "selection_lock_wait_ms": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

Failure JSON should be emitted to stderr and contain no secrets:

```json
{
  "schema_version": 1,
  "error": {
    "code": "NO_USABLE_CODEX_ACCOUNT",
    "message": "no account has usable primary quota",
    "retryable": false
  }
}
```

## Effective configuration precedence

| Setting | Highest precedence | Then | Then | Default |
|---|---|---|---|---|
| Enabled | explicit CLI flag/command option | config `codexAuthBalancer.enabled` | `CODEX_AUTH_BALANCER_ENABLED` | `false` for repo consumers |
| Authswap binary | explicit CLI/config `authswapPath` | `AUTHSWAP_BIN` | `PATH` lookup | none; fail adapter validation |
| Mode | explicit CLI/config | `CODEX_AUTH_BALANCER_MODE` | - | `process-env` |
| Timeout | explicit CLI/config `timeoutMs` | `CODEX_AUTH_BALANCER_TIMEOUT_MS` | - | `10000` |
| Fail closed | explicit CLI/config `failClosed` | - | - | `true` when enabled |
| Slot | explicit `--slot`/command option | caller request metadata | authswap scorer | best usable slot |
| Isolated dir | caller-created run dir | - | - | no default for repo V1; required |

CLI/config values are parsed and validated before env fallbacks. Unknown config keys fail validation. User-provided child env must not override balancer-produced `PI_CODING_AGENT_DIR` or `CODEX_HOME` while balancing is enabled.

## Environment variable contracts

### Inputs

- `AUTHSWAP_HOME`
  - Optional. Defaults to `~/.authswap`.
  - Used only by authswap and wrapper invocations.
- `CODEX_AUTH_BALANCER_ENABLED`
  - Optional override: `1|true|yes|on` enables, `0|false|no|off` disables.
  - Config takes precedence unless CLI explicitly overrides.
- `CODEX_AUTH_BALANCER_TIMEOUT_MS`
  - Optional bounded prepare-launch timeout. Default `10000`; max accepted `60000`.
- `CODEX_AUTH_BALANCER_MODE`
  - `process-env` for V1. Unknown values are config errors.

### Outputs into launched processes

- `PI_CODING_AGENT_DIR`
  - Absolute path to isolated `pi-agent` directory containing required `auth.json` plus opportunistic `settings.json`/`models.json` copies when source files exist.
- `CODEX_HOME`
  - Absolute path to isolated Codex home containing `auth.json`. The implementation must verify Codex actually honors `CODEX_HOME=<dir>` for auth lookup and token refresh; if the upstream layout differs, implementation must stop at the validation gate and update this contract before rollout.

No bearer tokens, refresh tokens, cookies, or account IDs may be exported as env vars.

## CLI contracts

### Usage view

```bash
authswap codex --usage --json [--max-age-ms 300000]
```

`--usage --json` is cache-only, non-mutating, and must not perform network I/O, token refresh, browser reauth, slot mutation, or cache writes. It may read account metadata and the usage cache only. If cache data is absent, stale beyond the requested policy, malformed, or unreadable, it must fail or report stale state rather than probing.

- Exit `0`: valid JSON on stdout.
- Exit `2`: no configured accounts or invalid authswap state.
- Exit `3`: usage cache invalid/unreadable/stale and no probe was requested.
- Exit `9`: stdout contract violation detected internally before output, if applicable.
- Exit `124`: timeout.

### Explicit usage refresh/probe

```bash
authswap codex --refresh-usage --json --isolated-dir /abs/run/auth/codex-balancer [--all|--slot SLOT] [--timeout-ms 15000]
```

`--refresh-usage` is the only V1 command allowed to perform live usage probing/network I/O. It is separate from `--usage` so render/startup paths remain cache-only. The command must run through isolated auth homes, never by mutating global current auth. `--isolated-dir` is required and must pass the same safe-path checks as prepare-launch; for `--slot`, authswap prepares/uses only that slot's isolated auth, and for `--all` it probes accounts one at a time under per-slot locks. It must not run browser reauth.

Cache writes are protected by the cache write lock, written via temp file + fsync + atomic rename, and mode `0600`. Stdout schema is a separate `AuthswapCodexRefreshUsageV1` object: it must include every field required by `AuthswapCodexUsageV1` and additionally permits `refreshed_slots: string[]` and `failures: { slot: string, code: string, retryable: boolean }[]`. Strict validators must not reuse the `AuthswapCodexUsageV1` schema unchanged because that schema has `additionalProperties: false`. No token material or raw account IDs may appear. Timeout applies to the whole command and to each network probe with a bounded per-slot budget.

- Exit `0`: refreshed cache written and valid JSON emitted.
- Exit `2`: no configured/usable account to probe.
- Exit `4`: selected slot auth invalid.
- Exit `5`: isolated dir/cache write failure.
- Exit `6`: lock timeout.
- Exit `7`: malformed input, unsupported schema requested, or schema mismatch.
- Exit `8`: required `--isolated-dir` missing or unsafe.
- Exit `9`: stdout contract violation detected internally before output, if applicable.
- Exit `124`: timeout.

### Launch preparation

```bash
authswap codex --prepare-launch --json --isolated-dir /abs/run/auth/codex-balancer [--slot SLOT] [--fail-closed]
```

`--isolated-dir` is required for all repo V1 consumers. Authswap must reject omission with exit `8`; repo callers must never depend on an authswap-created default directory. Prepare-launch must write `<isolated-dir>/balancer-metadata.json` with selected slot, expected slot generation and/or auth hash, copied-file manifest, and redacted creation metadata; the same `metadata_path`, `expected_generation`, and `auth_hash` must also appear in stdout so sync-back can conflict-detect even if stdout is the only persisted launch record.

- Creates at minimum:

```text
<isolated-dir>/
  pi-agent/auth.json
  pi-agent/settings.json   # optional copy when source exists
  pi-agent/models.json     # optional copy when source exists
  codex/auth.json
```

`settings.json` and `models.json` are opportunistic support files, not required auth material. Authswap copies each file only when present in the source Pi coding-agent home. The source home is the selected slot Pi home when available, otherwise `PI_CODING_AGENT_DIR` from the parent environment when set, otherwise the default Pi coding-agent home. Missing optional files must not fail prepare-launch; validation must instead prove Pi starts and resolves Codex models with only the required isolated auth plus any optional files that exist. The launch layout is not constrained to exactly four files: authswap may also write metadata, marker, or implementation-private files, but callers must validate only the required contract paths and safe containment.

- Exit `0`: valid prepare-launch JSON on stdout.
- Exit `2`: no usable accounts.
- Exit `4`: selected slot auth files missing or invalid.
- Exit `5`: failed to create isolated dirs or atomic copy.
- Exit `6`: lock timeout.
- Exit `7`: malformed input, unsupported schema requested, or schema mismatch.
- Exit `8`: required `--isolated-dir` missing or unsafe.
- Exit `9`: stdout contained non-JSON, extra stdout around JSON, or multiple JSON documents.
- Exit `124`: command timeout.

### Refreshed-token sync-back

Isolated runs may refresh OAuth tokens inside `PI_CODING_AGENT_DIR` or `CODEX_HOME`. Before cleanup, wrappers and async-subagents must sync refreshed tokens back to authswap slot storage:

```bash
authswap codex --sync-back --json --isolated-dir /abs/run/auth/codex-balancer --slot SLOT
```

Equivalent authswap-internal API signature: `sync_back_codex(isolated_dir: Path, slot: str, expected_generation?: str, expected_auth_hash?: str) -> SyncBackResultV1`. Repo consumers use the CLI adapter only. Sync-back exits: `0` synced or no refreshed token, `4` invalid isolated/slot auth, `6` lock timeout, `7` schema/input mismatch, `8` unsafe isolated dir, `10` conflict with newer slot state, `124` timeout. Sync-back must:

- Acquire the selected slot lock before reading isolated auth files or writing slot storage.
- Validate isolated auth JSON and copy back only recognized refreshed OAuth fields; never copy unrelated settings or attacker-added keys.
- Consume `<isolated-dir>/balancer-metadata.json` and/or explicit expected generation/hash from the prepare-launch stdout record. Detect conflicts by comparing the captured slot generation/mtime and refresh-token/auth hash with current slot storage before writing. If slot storage changed independently, preserve the newer valid refresh token and return exit `10` with non-retryable conflict JSON unless authswap can merge deterministically without overwriting a newer token.
- Write with temp file + fsync + atomic rename and `0600` mode.
- Emit only validated JSON on stdout and redacted failure JSON on stderr.

Wrappers must not launch Pi before prepare-launch completes, and cleanup code must not remove the isolated auth directory before sync-back has succeeded, reported a non-retryable no-op/conflict, or exhausted bounded retries. Pure `exec pi` fallback is forbidden because it cannot guarantee post-exit sync-back/cleanup; wrapper launchers must keep a parent supervisor/trap process rather than replacing the only process.

### Pi wrapper

```bash
pi-balanced [pi args...]
authswap pi launch -- [pi args...]
```

Wrapper behavior:

1. Create a private temp or run-local isolated dir with `0700` permissions.
2. Call prepare-launch with timeout.
3. Export only `PI_CODING_AGENT_DIR` and `CODEX_HOME` from the JSON env object.
4. Log only selected slot, label, reason, and quota percentages.
5. Do not provide a pure `exec` fallback. The wrapper must remain as a tiny supervisor: spawn Pi as a child, forward SIGINT/SIGTERM/SIGHUP, wait for child exit, run sync-back and cleanup/retention, then exit with Pi's status (or signal-derived status).
6. Do not launch Pi until prepare-launch JSON is validated.

## Async-subagents integration contract

Config shape in `~/.async-subagents/config.json`:

```json
{
  "version": 1,
  "defaultExtensions": [],
  "codexAuthBalancer": {
    "enabled": true,
    "provider": "authswap",
    "authswapPath": "/optional/absolute/path/to/authswap",
    "mode": "process-env",
    "timeoutMs": 10000,
    "failClosed": true,
    "onlyForProviders": ["openai-codex", "openai-codex-responses"]
  }
}
```

Validation rules:

- `provider` must be `authswap`.
- `authswapPath`, when present, must be an absolute path to an executable and has precedence over `AUTHSWAP_BIN`/`PATH`.
- `mode` must be `process-env`.
- `timeoutMs` integer `1000..60000`.
- `failClosed` defaults to `true`.
- Unknown keys fail validation.

Launch algorithm in `startSubagent`:

1. Resolve effective child model before model preflight.
2. If balancer disabled or model is not Codex, do nothing.
3. Create run-local isolated dir: `<runDir>/auth/codex-balancer` with `0700` permissions.
4. Spawn `authswap codex --prepare-launch --json --isolated-dir <dir>` with timeout and non-interactive env.
5. Validate stdout against `AuthswapCodexPrepareLaunchV1` before trusting paths.
6. Require `pi_agent_dir` and `codex_home` to be inside the requested isolated dir.
7. Verify `PI_CODING_AGENT_DIR` contains `auth.json` and `CODEX_HOME` contains `auth.json` before launching. Treat `settings.json` and `models.json` as optional opportunistic copies; when present validate containment and file mode, and rely on implementation validation/smoke tests to prove missing optional files do not break required Codex startup/model resolution.
8. Merge env into `buildPiCommand({ extraEnv })` without allowing user-provided `input.env` to override these two variables unless balancing is disabled.
9. After the child exits, call `authswap codex --sync-back --json --isolated-dir <dir> --slot <selected_slot>` before cleanup; bounded retries are allowed for lock timeout/timeout only. Sync-back conflict (`10`) is non-retryable and must not overwrite newer slot state. Cleanup follows the retention contract.
10. Add launch metadata:

```json
{
  "codexAuthBalancer": {
    "enabled": true,
    "provider": "authswap",
    "mode": "process-env",
    "selectedSlot": "2",
    "label": "B",
    "reason": "highest primary quota",
    "status": "ok",
    "primaryRemainingPercent": 91,
    "secondaryRemainingPercent": 76
  }
}
```

The metadata must never include token material, raw account IDs, auth file paths unless path logging is explicitly enabled, or complete env dumps.

## Footer rendering contract

Footer source priority:

1. Footer rendering and startup polling are cache-only. No live wham/current-account usage fetch may run during render or startup polling.
2. Current account and multi-account state both come from cached authswap usage (`authswap codex --usage --json` or direct cache read) unless the user invokes an explicit refresh command.
3. If cache is stale, absent, or invalid, render stale/unknown markers rather than probing.

Compact format:

```text
acct A● 5h 82% 7d 61% | B 5h 18% 7d 90%
```

Rules:

- `●` marks `active_pi` for the current process.
- Labels use `label` or `slot`, never raw account IDs.
- `limited`, `broken`, `?`, or `stale` states are explicit and compact.
- On narrow terminals, drop from right to left:
  1. secondary window percent;
  2. primary window percent;
  3. window labels;
  4. non-active accounts;
  5. entire account segment if still too narrow.
- Rendering must be pure and deterministic for a given account list and width.
- The footer must not display email unless the user opts in; if shown, mask local/domain portions.

## Locking and concurrency contracts

Authswap locks:

- Global selection lock: `$AUTHSWAP_HOME/providers/openai/locks/codex-selection.lock`.
  - Protects scoring against simultaneous slot refresh side effects.
  - Timeout default `5000ms`.
- Per-slot refresh lock: `$AUTHSWAP_HOME/providers/openai/accounts/<slot>/.lock`.
  - Protects token refresh and copying refreshed tokens back to slot storage.
- Cache write lock: `$AUTHSWAP_HOME/providers/openai/cache/usage.lock`.
  - Protects atomic `usage.json` writes.

Isolation rules:

- `<isolated-dir>` must be caller-provided, absolute, non-root, and either nonexistent or owned by the current user.
- Authswap creates dirs with `0700` and files with `0600`.
- Writes use temp file + fsync + atomic rename.
- Selection fairness uses reservation records under `$AUTHSWAP_HOME/providers/openai/reservations/` with TTL `120000ms`: after selecting a slot, authswap records a short-lived reservation so simultaneous launches round-robin among equally healthy slots instead of stampeding one account. Expired reservations are ignored and cleaned opportunistically.
- Concurrent prepare-launch calls may select the same account only when quota/fairness scoring chooses it after considering active reservations; they must always create distinct isolated dirs.
- Lock acquisition retries use jittered backoff (50-250ms) until the configured timeout. Lock timeout returns exit `6` with redacted retryable error JSON.

Async-subagents concurrency:

- Each run has a unique runDir; use runDir-local isolated auth homes.
- Never share one prepared auth dir between siblings.
- Parent process env remains unchanged.

## Isolated auth directory retention and cleanup

- Default retention after successful sync-back is immediate secure cleanup by deleting the run-local isolated auth directory tree.
- If sync-back fails with retryable lock/timeout, retain the directory `0700` for up to 24 hours and write a redacted marker file containing slot, reason code, and next retry time; never include token material. Sync-back conflict is non-retryable: retain with a conflict marker for inspection/explicit cleanup, but do not auto-retry it.
- If sync-back fails non-retryably because isolated auth is invalid, retain for at most 1 hour for diagnostics unless `keepFailedAuthDirs` is explicitly enabled.
- Cleanup must refuse to delete paths outside the caller-provided isolated dir, symlink targets, home directories, root, or global authswap storage.
- Async-subagents own cleanup during run finalization and must also scan/process retained retry markers on subsequent authswap-enabled invocations. Wrapper supervisors own cleanup before returning Pi's exit status and must process retry markers at startup and after child exit. Authswap must also expose an explicit cleanup/retry command for cron/manual recovery, e.g. `authswap codex --cleanup --json [--isolated-dir DIR|--all]`, which retries eligible sync-back markers, deletes expired retained dirs, and reports redacted counts. Retention deletion: successful sync-back deletes immediately; retryable retained dirs expire and are deleted after 24 hours; non-retryable invalid-auth diagnostic dirs expire after 1 hour unless explicit keep config is enabled; sync conflicts are retained up to 24 hours for inspection but are not retried automatically.

## Security and redaction contracts

Sensitive material includes:

- `auth.json` content.
- `access_token`, `refresh_token`, `id_token`, cookies, bearer headers.
- Raw `account_id`, ChatGPT account id claims, organization ids when unique.
- Any env var name containing `TOKEN`, `SECRET`, `PASSWORD`, `COOKIE`, `AUTH`, or `KEY`.

Required controls:

- JSON schemas have `additionalProperties: false` for public contracts.
- Authswap stdout for JSON commands must contain exactly one UTF-8 JSON object and no banners, logging, progress text, ANSI escapes, or trailing non-whitespace. Diagnostics go to stderr as redacted JSON lines only. Consumers reject malformed JSON, multiple JSON documents, schema-version mismatch, unexpected keys, and oversized output.
- All external command invocations use explicit argument arrays, not shell interpolation.
- All timeouts are fail-fast and non-interactive (`GIT_TERMINAL_PROMPT=0` where relevant; no browser reauth in launch path).
- Error messages may include slot label and status code, not token-derived identifiers.
- Launch logs redact sensitive env and omit auth file contents.
- Isolated dirs should be under run temp dirs, not world-readable locations.

## Adversarial test matrix

| Area | Adversarial case | Expected result |
|---|---|---|
| Binary discovery | Missing/old authswap or unsupported `--version --json` | Adapter fails closed before launch; warn fallback only if configured. |
| Usage cache-only | `--usage --json` attempts network/probe/write | Test fake network/cache write hooks fail; command returns cache-only result or exit `3`. |
| Prepare launch | `--isolated-dir` omitted by repo consumer | Consumer test fails; authswap exits `8`. |
| Prepare launch | `settings.json`/`models.json` absent in source home | Prepare succeeds; smoke test proves Pi startup/model lookup works or blocks implementation if files are actually required. |
| Prepare launch | Parent `PI_CODING_AGENT_DIR` set with optional files | Authswap uses it as source when slot-specific source is absent; copied files remain contained in isolated dir. |
| Prepare launch | `balancer-metadata.json` missing expected generation/hash | Consumer/sync-back fails closed before unsafe copy-back. |
| CODEX_HOME layout | Codex ignores `CODEX_HOME` or stores auth elsewhere | Validation gate fails; rollout stops until layout contract is corrected. |
| Sync-back | Isolated run refreshes OAuth token | Wrapper syncs back under slot lock before cleanup. |
| Sync-back | Slot changed since prepare | Non-retryable conflict exit `10`; no overwrite of newer token. |
| Cleanup | Retryable sync-back lock/timeout failure | Isolated dir retained 0700 with redacted marker and bounded TTL; later invocation/cleanup command processes marker. |
| Cleanup | Retention TTL expires | Explicit cleanup/subsequent invocation deletes retained dir safely and reports redacted count. |
| Fairness | 20 simultaneous launches with equal quota | Reservations distribute selections without corrupting locks. |
| Precedence | CLI disables but env enables | CLI/config precedence wins deterministically. |
| account_id_hash | Same account id on same machine/user | Produces same 32-char unpadded base64url sha256 prefix with stored salt; raw id absent. |
| account_id_hash | Same account id on different salt | Produces different hash; salt file is mode `0600` and never logged. |
| JSON stdout | Authswap prints banner before JSON | Consumer rejects as stdout contract violation. |
| Exit mapping | Exit `3`, `7`, `9`, timeout, malformed JSON | Adapter maps to documented failure classes and retryability; sync conflict is non-retryable. |
| JSON usage | Authswap emits extra key | Consumer rejects schema and renders `acct ?`/warning without crashing. |
| JSON usage | Negative or >100 percent | Consumer rejects or clamps only after validation policy; no misleading quota. |
| JSON usage | Malformed JSON | Footer command reports parse failure; no render crash. |
| JSON usage | Raw account id appears | Test fails; renderer/log sanitizer catches forbidden pattern. |
| Prepare launch | `pi_agent_dir` outside isolated dir | Async launch fails closed. |
| Prepare launch | Missing `CODEX_HOME` | Async launch fails closed. |
| Prepare launch | Authswap hangs | Timeout kills child process and returns bounded error. |
| Prepare launch | Lock timeout | Exit/code mapped to retryable launch failure; no fallback unless configured. |
| Prepare launch | Concurrent 20 subagent starts | All get unique isolated dirs; no auth file corruption. |
| Prepare launch | Selected slot auth refreshed during copy | Per-slot lock ensures copied auth is complete and valid JSON. |
| Prepare launch | Symlink in isolated dir points to global auth | Authswap rejects or replaces safely; no global overwrite. |
| Prepare launch | Isolated dir is `/` or home dir | Authswap rejects unsafe target. |
| Async env | User input env tries to override `CODEX_HOME` | Balancer env wins when enabled; launch log records policy. |
| Async env | Non-Codex model | No authswap command invoked. |
| Async env | Balancer disabled | Existing launch behavior unchanged. |
| Async env | Authswap unavailable | Fail closed or configured warning fallback; no partial env. |
| Launch log | Env contains token-like key | Value rendered as `<redacted>`. |
| Launch log | Metadata contains account id | Test fails forbidden-field assertion. |
| Footer width | Terminal width 20 | Output remains valid and no wrapping/overflow panic. |
| Footer stale | Usage cache older than threshold | Shows stale marker; does not probe. |
| Footer render/startup | Live wham/current-account fetch hook is called | Test fails; current account usage must come from cache unless explicit refresh command. |
| Refresh CLI | `--refresh-usage --json --isolated-dir DIR --slot A` | Runs isolated probe, locks cache write, writes valid cache JSON, maps failures without mutating global auth. |
| Footer broken account | Slot auth invalid | Renders `broken` compactly without stack trace. |
| Footer labels | Label has control chars/ANSI | Sanitized before render. |
| Footer email | Email present | Hidden by default or masked if opt-in. |
| Commands | `/codex-accounts refresh` during active stream | Defers or runs isolated probe only; no live auth swap. |
| Commands | `/codex-accounts switch B` mid-stream | Refuses current-process switch; says next launch only. |
| CLI wrapper | Pi exits 130 | Supervisor forwards signals, runs sync-back/cleanup, and returns 130/pass-through status. |
| CLI wrapper | Pure exec fallback requested or code path exists | Test fails; wrapper must supervise child so sync-back/cleanup always run after exit. |
| CLI wrapper | Prepare fails | Pi is not launched in fail-closed mode. |
| Security | Error includes bearer token | Redaction test fails. |
| Security | Cache file world-readable | Authswap fixes mode or refuses with actionable error. |
| Regression | Existing `/fast` command | Existing tests still pass. |
| Regression | Existing async-subagents fake child | No authswap required unless Codex model configured. |

## Validation plan

- Unit tests for authswap JSON schema validation and redaction helpers.
- Unit tests for footer account formatting at representative widths: 120, 80, 50, 30, 20.
- Unit tests for async-subagents config validation, including unknown-key rejection.
- Integration test with fake `authswap` binary returning prepare-launch JSON and asserting `buildPiCommand` env and launch metadata.
- Adapter tests for binary discovery, min version, capability/schema mismatch, malformed JSON, extra stdout, timeout, and documented exit-code mapping.
- Smoke test that isolated `PI_CODING_AGENT_DIR`/`CODEX_HOME` required auth files are sufficient for Pi/Codex startup and model resolution; run both with optional `settings.json`/`models.json` present and absent, and fail the implementation gate if the assumed `CODEX_HOME` auth layout is not honored.
- Refresh CLI tests for `--refresh-usage --json --isolated-dir`, cache-write locking, timeout/failure mapping, and proof that `--usage`/footer render/startup do not probe.
- Sync-back tests for metadata consumption, refreshed token copy, slot lock contention, non-retryable conflict handling, retry exhaustion for lock/timeout only, and cleanup/retention marker processing by later invocations and explicit cleanup.
- Concurrency integration test spawning many fake prepare-launch calls against temp authswap home.
- Security snapshot tests scanning logs and footer strings for token-like values and raw account ids.
- Manual smoke:

```bash
authswap codex --usage --json | jq .
authswap codex --refresh-usage --json --isolated-dir /tmp/codex-balancer-refresh --slot A | jq .
authswap codex --prepare-launch --json --isolated-dir /tmp/codex-balancer-smoke | jq .
CODEX_AUTH_BALANCER_ENABLED=1 async-subagents start ...
pi-balanced --version
```

## Rollout sequence and PR gates

Split rollout into worker-sized tickets with merge gates:

1. Authswap adapter contract: binary discovery, `--version --json`, min version/capability checks, JSON stdout parser, exit-code mapping. Gate: fake-binary tests for old/missing/malformed/timeout cases.
2. Authswap cache-only usage command. Gate: tests prove no network, no mutation, no cache writes for `--usage --json`.
3. Prepare-launch isolation. Gate: required `--isolated-dir`, safe path rejection, metadata generation, required auth copies, opportunistic settings/models copies, schema validation, and smoke test using only isolated dirs including the `CODEX_HOME` layout validation gate.
4. Fair selection and locking. Gate: reservation/fairness concurrency test and lock timeout/retry tests.
5. Explicit usage refresh. Gate: isolated `--refresh-usage` probe, cache-write lock, timeout/failure mapping, and no live fetch in `--usage`/footer startup/render paths.
6. Sync-back and cleanup. Gate: metadata-based copy-back, non-retryable conflict handling, retryable retention for lock/timeout, marker ownership by subsequent invocations/cleanup command, and safe deletion tests.
7. Async-subagents consumer integration. Gate: fake authswap prepare/sync tests, precedence tests, fail-closed behavior, no child env override, and retry-marker processing on subsequent invocations.
8. Footer cached display. Gate: cache-only usage adapter, width/redaction/stale tests, no render-time/startup probes including current-account usage.
9. Wrapper launcher. Gate: pure exec path absent; supervisor propagates signals, sync-back runs before cleanup, retry markers are processed, and wrapper exits with Pi status.
10. `/new` investigative ticket only: determine whether `/new` crosses a process boundary. No implementation in this rollout unless a follow-up design update explicitly approves the safe process-launch path.
11. Provider-native balancing remains future-only after V1 process-launch isolation proves stable; do not implement in this plan.

## Open implementation decisions

- Whether footer should shell out to cache-only `authswap codex --usage --json` on startup or read `~/.authswap/providers/openai/cache/usage.json` directly. Prefer shell-out if fast enough because it preserves one parser; either path must not probe.
- Where repo-owned launcher lives if authswap does not own `authswap pi launch`.

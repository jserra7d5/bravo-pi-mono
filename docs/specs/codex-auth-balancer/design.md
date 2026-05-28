# Codex Auth Balancer

## Summary

Build a Pi/authswap integration that makes multiple OpenAI Codex subscription accounts visible in the Pi TUI and uses account quota state to choose the best account for new Pi processes and async subagents.

The safe V1 boundary is **process launch**, not live global auth mutation. Each new child/session should receive an isolated auth directory through environment variables:

```bash
PI_CODING_AGENT_DIR=/path/to/isolated/pi-agent
CODEX_HOME=/path/to/isolated/codex-home
```

This lets parent Pi, child Pi processes, and standalone CLI sessions use different accounts concurrently without stomping `~/.pi/agent/auth.json` or `~/.codex/auth.json`.

## Goals

- Show all configured authswap OpenAI/Codex account slots in the Pi footer/TUI.
- Show primary and secondary Codex usage windows per account, using authswap's cached/probed usage data.
- Choose the best account before launching:
  - a fresh `pi` CLI process via wrapper/launcher;
  - an async subagent child Pi process;
  - a `/new` session only when `/new` crosses a safe process/session boundary.
- Avoid mutating global auth files during concurrent Pi work.
- Reuse authswap's account inventory, probing, usage scoring, token refresh, and reauth behavior where practical.
- Keep tokens and account IDs out of TUI output and launch logs.

## Non-goals

- No mid-stream auth swapping.
- No global `~/.pi/agent/auth.json` or `~/.codex/auth.json` mutation as the primary balancing mechanism.
- No footer-driven background probing loop.
- No provider-native per-request balancing in V1.
- No automatic browser reauth from Pi without an explicit user command.

## Existing evidence

### Pi auth directory override

Pi source supports an agent-dir env override:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/config.ts`
  - `ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`
  - for Pi this is `PI_CODING_AGENT_DIR`
  - `getAuthPath() => join(getAgentDir(), "auth.json")`

Pi's auth storage reads OAuth credentials from `auth.json` under that agent dir and refreshes under file lock.

### Codex home override

Authswap already probes slots by setting `CODEX_HOME` to a temporary directory containing a slot-local `auth.json`, then running Codex CLI commands against that isolated home.

### Async subagent env injection

`packages/async-subagents/src/piHarness.ts` already has `extraEnv`, and `packages/async-subagents/src/start.ts` passes `input.env` into preflight and launch. The public Pi tool schema does not expose env directly, so balancing should be implemented inside the async-subagents launch path rather than asking agents to pass env manually.

### Current footer

`.pi/extensions/codex-usage.ts` already renders Codex usage from `https://chatgpt.com/backend-api/wham/usage`, using `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`. It also owns the project-local footer and `/fast` command.

### Authswap source

Authswap source lives at:

- `/home/joe/Documents/misc/authswap/authswap`
- `/home/joe/Documents/misc/authswap/src/authswap_codex.py`

Relevant authswap storage:

```text
~/.authswap/providers/openai/accounts/<slot>/auth.json
~/.authswap/providers/openai/accounts/<slot>/pi-openai-codex.json
~/.authswap/providers/openai/cache/usage.json
```

Authswap can probe slots in isolated temp homes, infer usage from Codex logs/rollouts, choose the best slot, and switch global auth as a legacy foreground workflow.

## Architecture

### Components

1. **Authswap account reader**
   - Reads configured OpenAI/Codex slots.
   - Reads usage cache.
   - Determines active account by comparing live Pi/Codex token signatures where needed.
   - Never exposes secrets to render output.

2. **Pi footer account display**
   - Extends `.pi/extensions/codex-usage.ts` or extracts shared helpers.
   - Shows compact multi-account usage state.
   - Reads cache opportunistically.
   - Does not run expensive probes on every render.

3. **Launch balancer**
   - Selects best slot before spawning a new process.
   - Creates an isolated per-process auth home.
   - Copies selected slot credentials into that isolated home.
   - Sets `PI_CODING_AGENT_DIR` and `CODEX_HOME` for the launched process.
   - Records selected slot metadata in launch logs without secrets.

4. **Authswap CLI JSON contract**
   - Adds or standardizes machine-readable output for usage and selection.
   - Pi integration should prefer this contract over reimplementing every authswap parser internally.

## Account model

```ts
type CodexAccountSlot = {
  slot: string;
  label?: string;
  email?: string;
  authPath: string;
  piAuthPath?: string;
  accountId?: string; // internal only; never render raw
  activePi: boolean;
  activeCodex: boolean;
  status: "ok" | "limited" | "broken" | "unknown";
  usage?: {
    primary?: UsageWindow;   // usually 5h
    secondary?: UsageWindow; // usually 7d
    updatedAt?: number;
  };
};

type UsageWindow = {
  name: "primary" | "secondary" | string;
  label: string; // e.g. "5h", "7d"
  remainingPercent?: number;
  resetAt?: number;
  resetInSeconds?: number;
};
```

## Footer UX

Example compact rendering:

```text
acct A● 5h 82% 7d 61% | B 5h 18% 7d 90%
```

Example richer rendering:

```text
acct A● 5h ▰▰▰▱ 82% 7d ▰▰▱▱ 61% | B 5h ▱▱▱▱ 18% limited
```

Rules:

- `●` marks the active Pi account for the current process.
- Use stable slot labels, not raw account IDs.
- On narrow terminals, drop detail from right to left.
- Show stale/unknown state explicitly but compactly.
- Never render tokens, refresh tokens, or full account IDs.
- Prefer cached usage. Manual commands may trigger probes.

## Commands

Potential Pi commands:

```text
/codex-accounts
/codex-accounts refresh
/codex-accounts switch <slot>
/codex-accounts launch-mode on|off|status
```

V1 command behavior:

- `refresh`: call authswap seed/verify with timeout; update cache; rerender.
- `switch`: only allowed when idle. Prefer changing future launch selection; if in-process switching is unsupported, tell user to start a new balanced session.
- `launch-mode`: toggles whether async subagents and CLI wrappers use automatic slot selection.

## Authswap JSON contract

Add if missing:

```bash
authswap codex --usage --json
authswap codex --prepare-launch --json --isolated-dir <dir>
```

`--isolated-dir` is required for repo V1 consumers. Authswap must reject omitted or unsafe isolated directories rather than creating an implicit default location.

Selection output:

```json
{
  "schema_version": 1,
  "selected_slot": "2",
  "reason": "highest primary quota",
  "status": "ok",
  "primary_remaining_percent": 91,
  "secondary_remaining_percent": 76,
  "pi_agent_dir": "/tmp/authswap/pi-slot-2/agent",
  "codex_home": "/tmp/authswap/pi-slot-2/codex",
  "env": {
    "PI_CODING_AGENT_DIR": "/tmp/authswap/pi-slot-2/agent",
    "CODEX_HOME": "/tmp/authswap/pi-slot-2/codex"
  },
  "metadata": {
    "metadata_path": "/tmp/authswap/pi-slot-2/balancer-metadata.json",
    "expected_generation": "slot-generation-value",
    "auth_hash": "redacted-stable-auth-hash"
  }
}
```

`metadata` is required so post-run sync-back can detect conflicts before copying refreshed OAuth tokens back into authswap slot storage.

The isolated-dir preparation should create:

```text
<dir>/
  pi-agent/
    auth.json
    models.json?       # optional; only if needed
  codex/
    auth.json
```

## Swap-state table

| State / event | Swap? | Mechanism | Scope | Risk |
|---|---:|---|---|---|
| Fresh `pi` CLI startup | Yes | Wrapper selects slot and sets `PI_CODING_AGENT_DIR` / `CODEX_HOME` before spawning supervised Pi | Whole process | Low |
| `authswap pi launch -- pi ...` | Yes | First-class authswap launcher | Whole process | Low |
| Async subagent start | Yes | Parent selects slot, creates run-local auth dirs, launches child with env | One child process | Low |
| Multiple subagents starting concurrently | Yes, with lock | Selection lock plus per-child isolated auth dirs | Each child process | Low/medium |
| `/new` that spawns a new Pi process | Yes | Inject selected env into spawned process | New process | Low |
| `/new` that resets state in same process | Maybe | Needs Pi core hook or provider/auth reload | Same process | Medium |
| Before first model request in a session | Maybe | Only if auth registry can reload cleanly before request | Same process | Medium |
| Between user turns, idle | Maybe | Provider/auth-layer reload or controlled session-level switch | Same process | Medium/high |
| During active streaming response | No | Do not swap | N/A | High |
| During Codex websocket continuation | No | Do not swap | N/A | High |
| During OAuth token refresh | No | Let lock/refresh finish first | N/A | High |
| Footer usage refresh | No auth swap | Read cache or probe isolated slots only | Display only | Low |
| Manual `/codex-accounts switch <slot>` | Guarded | Only idle; otherwise affect next launch or require restart | Current/future process | Medium |
| Manual `/codex-accounts refresh` | No live swap | Probe slot in temp `CODEX_HOME`; update cache | Cache only | Low |
| Account exhausted mid-turn | No immediate swap | Finish/fail current turn; choose better slot next boundary | Later boundary | Medium |
| Account exhausted before subagent start | Yes | Pick non-exhausted slot before spawn | Child process | Low |
| Parent active while child launches | Yes for child only | Child isolated env; parent unchanged | Child process | Low |
| Global `~/.pi/agent/auth.json` mutation | Avoid | Legacy fallback only with global launch lock | Machine-global | High |
| Global `~/.codex/auth.json` mutation | Avoid | Legacy fallback only with global launch lock | Machine-global | High |
| Provider-native per-request balancing | Later | Select credential inside provider request builder | One request | Medium, clean if designed |
| New terminal/tmux helper | Yes | Shell function/wrapper exports isolated env before `pi` | Whole process | Low |
| Reauth/browser login | No balancing swap | Authenticate target slot directly, update slot/cache | Slot storage | Medium |
| Usage seeding/probing | No live swap | Probe slot in temp home and copy refreshed token back to slot | Slot storage | Low/medium |

## Implementation phases

### Phase 1: Authswap machine contract

- Add/verify `--usage --json`.
- Add/verify `--prepare-launch --json --isolated-dir <dir>`; bare prepare-launch without an isolated directory is invalid for repo V1 consumers.
- Add isolated-dir output mode that prepares `pi-agent/auth.json` and `codex/auth.json` without mutating global auth.
- Add locking around selection/preparation so concurrent launchers do not corrupt per-slot refreshed tokens.

### Phase 2: TUI monitoring

- Extract or add authswap account reader helpers.
- Extend `.pi/extensions/codex-usage.ts` to render all slots.
- Add manual refresh command with timeout.
- Add tests for width, stale cache, redaction, and multi-account layout.

### Phase 3: Async subagent launch balancing

- Add async-subagents config:

```json
{
  "codexAuthBalancer": {
    "enabled": true,
    "provider": "authswap",
    "mode": "process-env"
  }
}
```

- In `startSubagent`, before preflight/build command:
  1. detect Codex/OpenAI model/provider;
  2. ask authswap for selected isolated env;
  3. pass env into `buildPiCommand` as `extraEnv`;
  4. include selected slot in launch metadata;
  5. do not expose env secrets.

### Phase 4: CLI launcher

Provide one of:

```bash
pi-balanced [pi args...]
authswap pi launch -- [pi args...]
```

The launcher:

1. selects best slot;
2. creates isolated auth dir;
3. exports `PI_CODING_AGENT_DIR` and `CODEX_HOME`;
4. spawns Pi as a supervised child;
5. forwards signals, waits for exit, syncs refreshed tokens back to authswap slot storage, cleans up/retains the isolated auth dir according to policy, and exits with Pi's status.

A pure `exec pi` launcher is not acceptable for V1 because it cannot guarantee post-exit token sync-back or cleanup.

### Phase 5: `/new`

Investigate Pi `/new` implementation.

- If `/new` spawns/execs a new process, inject the same env selection.
- If `/new` resets in-process, defer V1 support unless Pi core gets a safe pre-session-service hook or provider auth reload API.

### Phase 6: Provider-native balancing, optional

Only after V1 proves useful, add a provider/auth abstraction that can select credentials per request without mutating global files.

This would support true runtime load balancing but requires careful token refresh, account-id header construction, request consistency, and websocket continuation rules.

## Safety rules

- Never swap global auth during active streaming, websocket continuation, or token refresh.
- Never render or log secrets.
- Footer reads cache; probes are explicit user actions or launch-time bounded checks.
- Isolated auth dirs are per process/run, not shared mutable state.
- If isolated launch preparation fails, either fall back to current auth with an explicit warning or fail closed depending on config.

## Open questions

- Does Pi need `models.json` copied into isolated `PI_CODING_AGENT_DIR`, or can children rely on project extensions/default models?
- What exact JSON shape should authswap expose for usage and selection?
- Should the footer call authswap directly or read only `usage.json` for maximum responsiveness?
- Where should persistent balancer config live: `.pi/codex-balancer.json`, authswap config, or async-subagents config?
- Should top-level `pi` startup balancing be implemented as a wrapper only, or should Pi core learn a pre-auth-startup hook?

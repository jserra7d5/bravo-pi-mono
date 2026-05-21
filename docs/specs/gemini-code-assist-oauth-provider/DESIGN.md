# Gemini Code Assist OAuth Provider Design

Date: 2026-05-20
Status: implementation design
Package: `@bravo/gemini-code-assist`
Provider ID: `gemini-code-assist`
Initial model: `gemini-3.5-flash`

## Objective

Implement a narrowly scoped Bravo Pi custom provider that calls the Gemini Code Assist backend using the operator's existing Gemini CLI Google OAuth credentials. The first deliverable is a headless, text-only spike that proves direct Code Assist generation works before building the full Pi provider.

The provider must not use a Gemini API key, must not shell out to the `gemini` binary per request, and must not silently fall back to another model or API. If `gemini-3.5-flash` is rejected by Code Assist, the implementation fails with a clear diagnostic.

## V1 scope

V1 is a spike-first implementation with these constraints:

- Headless text-only request/response path.
- Package name: `@bravo/gemini-code-assist`.
- Target model: `gemini-3.5-flash` only.
- Credentials: file-backed Gemini CLI OAuth cache at `~/.gemini/oauth_creds.json` by default.
- Transport: direct HTTPS request to Gemini Code Assist.
- Response handling: parse Code Assist SSE and print/stream text deltas.
- No silent fallback to public Gemini API, Vertex, older Gemini models, or API-key providers.

Deferred until later phases:

- Full Pi provider registration and `streamSimple` integration beyond the spike.
- Tool/function calling.
- Thinking output/config mapping.
- Multimodal/image input.
- Encrypted/keychain Gemini CLI credential storage.
- Broader model catalog or fallback models.

## Package layout

Planned package location:

```text
packages/gemini-code-assist/
  package.json
  src/
    spike.ts
    credentials.ts
    headers.ts
    code-assist-client.ts
    sse.ts
  test/
    helpers.test.ts
```

`spike.ts` is the first executable target. A Pi `extension.ts` remains out of the critical path until the direct Code Assist call is proven.

## Credential design

The provider reads Gemini CLI's file-backed credential cache:

```text
~/.gemini/oauth_creds.json
```

The path may later be configurable, but the default must match Gemini CLI storage. Expected credential fields:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "scope": "...",
  "token_type": "Bearer",
  "expiry_date": 1234567890000
}
```

If the access token is missing, expired, or close to expiry, refresh it using the same Gemini CLI OAuth installed-app client constants and scopes from Gemini CLI `packages/core/src/code_assist/oauth2.ts`:

```text
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

Refresh failures are fatal and must preserve enough context for the operator to re-run Gemini CLI login. Missing file-backed credentials are also fatal in V1; encrypted/keychain credential support is explicitly deferred.

## Code Assist request

The spike sends a single text prompt to:

```text
https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

The request body uses the Code Assist envelope:

```json
{
  "model": "gemini-3.5-flash",
  "project": "<optional-google-cloud-project>",
  "user_prompt_id": "<uuid>",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "Say hello from Code Assist OAuth." }]
      }
    ],
    "generationConfig": {},
    "session_id": "<generated-session-id>"
  }
}
```

Project resolution order:

1. Explicit package configuration when added.
2. `GOOGLE_CLOUD_PROJECT`.
3. `GOOGLE_CLOUD_PROJECT_ID`.
4. Omit `project` if unavailable.

Before generation, the spike calls `loadCodeAssist` with Gemini CLI-compatible metadata to resolve the account's Code Assist project/tier. This is the minimum setup path needed for this authenticated environment; full onboarding remains deferred unless `loadCodeAssist` reports no current tier.

The implementation must surface Code Assist error bodies directly enough to distinguish auth, quota, onboarding, project, and unsupported-model failures.

## Header design

Requests must preserve Gemini CLI-compatible headers as closely as practical:

```text
Content-Type: application/json
Authorization: Bearer <fresh-access-token>
User-Agent: GeminiCLI/<version>/<model> (<platform>; <arch>)
```

`GEMINI_CLI_CUSTOM_HEADERS` must be honored with Gemini CLI-compatible parsing semantics. Request header precedence intentionally mirrors Gemini CLI where practical: `Content-Type` is set first, custom headers may override it, `User-Agent` is protected to match the Gemini CLI identity format, and `Authorization` is protected so the OAuth token cannot be replaced by a custom header. The spike should compare emitted headers against Gemini CLI behavior before provider work proceeds.

## Setup/onboarding boundary

Gemini CLI calls `setupUser()` before generation. The spike ports only the safe read-only setup subset: `loadCodeAssist` with Gemini CLI metadata, using the returned `cloudaicompanionProject` for generation. If `loadCodeAssist` indicates account validation, no eligible tier, or onboarding is required, that is a stop condition for V1. Do not guess additional onboarding calls without a follow-up design.

## Future phases

1. **Text-only Pi provider**: register `gemini-code-assist/gemini-3.5-flash`, wire the proven client into Pi streaming, and expose clear diagnostics.
2. **Tools**: map Pi tools to Gemini function declarations and Code Assist function calls back to Pi tool calls.
3. **Thinking**: add thinking config/output mapping only after `gemini-3.5-flash` Code Assist behavior is verified.
4. **Multimodal**: add image/file parts after text and tools are stable.
5. **Credential hardening**: support encrypted/keychain Gemini CLI storage or a documented migration only if file-backed credentials are insufficient.

## Validation commands

Run bounded checks once implementation files exist:

```bash
npm run check --workspace @bravo/gemini-code-assist
npm test --workspace @bravo/gemini-code-assist
```

Run the live spike only in an authenticated environment:

```bash
GEMINI_CLI_CUSTOM_HEADERS="$GEMINI_CLI_CUSTOM_HEADERS" \
GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" \
npm run spike --workspace @bravo/gemini-code-assist -- \
  --model gemini-3.5-flash \
  --prompt "Say hello from Code Assist OAuth."
```

Manual validation outcomes required before proceeding past the spike:

- Credentials load from `~/.gemini/oauth_creds.json`.
- Expired credentials refresh successfully using Gemini CLI OAuth constants/scopes.
- `loadCodeAssist` resolves the account project/tier.
- Request uses the Code Assist endpoint and envelope.
- `GEMINI_CLI_CUSTOM_HEADERS` are parsed and sent compatibly with Gemini CLI.
- Code Assist accepts `gemini-3.5-flash`.
- SSE text chunks are parsed and emitted.
- No fallback path is invoked.

Current local spike result: OAuth credentials and `loadCodeAssist` work, and an explicit diagnostic run with `GEMINI_CODE_ASSIST_ALLOW_UNVERIFIED_MODEL=1 --model gemini-3-flash-preview` returns streamed text. The required target `gemini-3.5-flash` currently returns Code Assist `HTTP 404 NOT_FOUND`, so provider work must not proceed until model availability is resolved or the target model decision changes.

Reasoning-continuity eval results for `gemini-3-flash-preview`: multi-turn replay works when preserving raw model parts, `thoughtSignature` is observed, and tool/function-call turns include `thoughtSignature` on the function call. Stripping signatures did not fail in the current live eval, but it changed token accounting; therefore signatures should still be preserved exactly for provider history replay. Live usage metadata includes `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `trafficType`, modality token details, and `thoughtsTokenCount`; no cache-token fields were returned in these evals.

Alternative `agy` CLI angle: `agy -p` works headlessly and local logs show it routing to `daily-cloudcode-pa.googleapis.com` with model label `Gemini 3.5 Flash (High)`. This is promising for accessing 3.5 Flash, but `agy --continue`/conversation resume timed out in a quick follow-up probe and `--print` has no documented structured JSON stream. Treat it as a separate subprocess-wrapper spike, not the primary provider path yet.

## Risks

- Code Assist `v1internal` may change without notice.
- `gemini-3.5-flash` may not currently be accepted by Code Assist.
- `setupUser()`/onboarding may be mandatory before generation and would block V1.
- Header differences from Gemini CLI may affect routing, quota, or policy.
- File-backed credentials may be unavailable when Gemini CLI uses encrypted storage.
- OAuth refresh behavior must match Gemini CLI closely enough to avoid invalidating operator credentials.

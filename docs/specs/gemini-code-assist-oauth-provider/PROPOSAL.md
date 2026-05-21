# Gemini Code Assist OAuth Provider for Pi

Date: 2026-05-20
Status: proposal
Scope: Add a Pi custom provider extension that reuses Gemini CLI Google OAuth credentials to call the Gemini Code Assist backend from Pi, initially targeting `gemini-3.5-flash`.

## Goal

Build a Bravo Pi package that lets `pi` use the same Google OAuth login already established by Gemini CLI, without requiring a Gemini API key. The intended provider should appear as a normal Pi model provider, e.g. `gemini-code-assist/gemini-3.5-flash`, while authenticating through the operator's local Gemini CLI credential cache.

This is expected to be an extension-level provider, not a `models.json`-only configuration, because Gemini CLI's OAuth mode uses the Gemini Code Assist backend and request envelope rather than the public Gemini Developer API request shape.

## Source references

Local Gemini CLI source inspected at:

```text
/home/joe/Documents/misc/gemini-cli
```

Key upstream files:

- `packages/core/src/core/contentGenerator.ts`
  - `AuthType.LOGIN_WITH_GOOGLE = 'oauth-personal'`
  - constructs Gemini CLI request headers, including `User-Agent` and `GEMINI_CLI_CUSTOM_HEADERS`
  - routes `LOGIN_WITH_GOOGLE` and `COMPUTE_ADC` to Code Assist instead of `GoogleGenAI`
- `packages/core/src/code_assist/oauth2.ts`
  - OAuth client ID/secret/scopes
  - cached credential loading from `~/.gemini/oauth_creds.json` and `GOOGLE_APPLICATION_CREDENTIALS`
  - token validation, refresh, and userinfo lookup
- `packages/core/src/config/storage.ts`
  - `Storage.getOAuthCredsPath()` -> `~/.gemini/oauth_creds.json`
  - `google_accounts.json`, `installation_id`, and related Gemini CLI state files
- `packages/core/src/code_assist/codeAssist.ts`
  - `createCodeAssistContentGenerator()` wires OAuth client, setup flow, and `CodeAssistServer`
- `packages/core/src/code_assist/server.ts`
  - `CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'`
  - `CODE_ASSIST_API_VERSION = 'v1internal'`
  - streaming calls use `:streamGenerateContent` with `alt=sse`
- `packages/core/src/code_assist/converter.ts`
  - wraps normal Gemini request data as `{ model, project, user_prompt_id, request }`
  - converts Code Assist responses back to Gemini `GenerateContentResponse`
- `packages/core/src/config/models.ts`
  - Gemini CLI model IDs and aliases; the proposal intentionally adds the newer target `gemini-3.5-flash` once confirmed accepted by Code Assist.

Relevant Pi extension docs:

- `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- `/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`

## Non-goals

- Do not modify upstream Pi source.
- Do not shell out to Gemini CLI for every model request.
- Do not attempt to bypass Google/Gemini quota, account, or licensing rules.
- Do not replace Pi's existing `google` API-key or `google-vertex` ADC providers.
- Do not initially support Gemini CLI encrypted/keychain credential storage unless the file-backed path proves insufficient.

## Why a custom provider extension is required

Pi's built-in `google` provider speaks the public Google Generative AI API through `@google/genai` with an API key and base URL like:

```text
https://generativelanguage.googleapis.com/v1beta
```

Gemini CLI's Google OAuth path instead sends authenticated requests to:

```text
https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

The request body is Code Assist-specific:

```json
{
  "model": "gemini-3.5-flash",
  "project": "<optional-google-cloud-project>",
  "user_prompt_id": "<uuid>",
  "request": {
    "contents": [],
    "systemInstruction": {},
    "tools": [],
    "toolConfig": {},
    "generationConfig": {},
    "session_id": "<pi-session-or-generated-id>"
  }
}
```

This cannot be represented cleanly with `~/.pi/agent/models.json`, because it needs custom OAuth credential handling, Code Assist request wrapping, SSE parsing, and response conversion.

## Proposed package shape

Create a new package:

```text
packages/gemini-code-assist/
  package.json
  src/
    extension.ts
    credentials.ts
    code-assist-client.ts
    convert-context.ts
    convert-response.ts
    sse.ts
  extensions/pi/index.ts   # optional thin re-export, if following package convention
```

Suggested package name:

```text
@bravo/gemini-code-assist
```

Suggested Pi provider ID:

```text
gemini-code-assist
```

Initial model registration:

```ts
pi.registerProvider("gemini-code-assist", {
  name: "Gemini Code Assist",
  api: "gemini-code-assist", // custom streamSimple handles this
  models: [
    {
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash (Code Assist OAuth)",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  streamSimple,
});
```

The exact context window and max output should be verified against the model metadata accepted by Code Assist. Cost should likely remain zero/unknown for OAuth subscription usage unless reliable billing metadata is available.

## Credential strategy

### Phase 1: file-backed Gemini CLI credentials

Read Gemini CLI's default OAuth cache:

```text
~/.gemini/oauth_creds.json
```

Expected fields are Google OAuth `Credentials`-style values:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "scope": "...",
  "token_type": "Bearer",
  "expiry_date": 1234567890000
}
```

If `access_token` is missing or expired, refresh with Google's token endpoint using the Gemini CLI installed-app OAuth client constants found in `packages/core/src/code_assist/oauth2.ts`.

Required scopes from Gemini CLI:

```text
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

### Phase 2: optional encrypted/keychain storage

Gemini CLI can also use `OAuthCredentialStorage` / `HybridTokenStorage` when encrypted storage is forced. Support for this can be deferred unless the operator's active install stores credentials only through that path.

Options:

1. Implement the same storage lookup logic in TypeScript.
2. Provide a one-time migration/helper that exports Gemini CLI credentials into file-backed storage.
3. Ask the user to keep Gemini CLI file-backed credentials for this provider.

## Header fidelity requirement

When building this out, preserve Gemini CLI's Code Assist request headers as closely as possible.

Gemini CLI constructs base headers in `packages/core/src/core/contentGenerator.ts`:

```ts
const userAgent = `GeminiCLI/${version}/${model} (${process.platform}; ${process.arch})`;
const customHeadersMap = parseCustomHeaders(process.env['GEMINI_CLI_CUSTOM_HEADERS']);

const baseHeaders = {
  ...customHeadersMap,
  'User-Agent': userAgent,
};
```

Code Assist requests then add:

```ts
{
  'Content-Type': 'application/json',
  ...httpOptions.headers,
}
```

The extension should therefore send, at minimum:

```text
Content-Type: application/json
User-Agent: GeminiCLI/<detected-or-configured-version>/<model> (<platform>; <arch>)
Authorization: Bearer <fresh-access-token>
```

And it should honor `GEMINI_CLI_CUSTOM_HEADERS` with the same parsing semantics as Gemini CLI. This matters because Code Assist may use client identity and custom enterprise headers for routing, quota, or policy. Header behavior should be tested against Gemini CLI's `contentGenerator.test.ts` expectations before widening usage.

Open question: if using raw `fetch` rather than `google-auth-library`'s `AuthClient.request`, confirm whether Google auth library adds any additional headers for Code Assist. The implementation should compare captured request headers from Gemini CLI and the extension during the spike.

## Request flow

1. Resolve target model, initially `gemini-3.5-flash`.
2. Load Gemini CLI OAuth credentials.
3. Refresh if `expiry_date` is missing or near expiry.
4. Build Gemini CLI-compatible headers.
5. Convert Pi context into Gemini/Code Assist request parts.
6. POST to:

   ```text
   https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
   ```

7. Parse `data: ...` SSE events.
8. Convert Code Assist/Gemini response chunks into Pi assistant stream events.
9. Preserve usage metadata when available.
10. Surface auth, quota, project, and model errors without swallowing Code Assist diagnostics.

## Conversion requirements

### Pi context to Code Assist

Map Pi context to Gemini request fields based on Gemini CLI's `converter.ts` behavior:

- system prompt -> `request.systemInstruction`
- user/assistant messages -> `request.contents`
- text parts -> Gemini `text` parts
- images -> Gemini `inlineData` or `fileData` when available
- tool declarations -> Gemini `tools.functionDeclarations`
- tool choice -> Gemini `toolConfig.functionCallingConfig`
- tool results -> Gemini `functionResponse` parts
- thinking signatures -> preserve only if compatible; otherwise omit safely

### Code Assist response to Pi stream

Map streamed response chunks into Pi events:

- text parts -> `text_start` / `text_delta` / `text_end`
- thought parts -> `thinking_start` / `thinking_delta` / `thinking_end` when Code Assist returns thoughts and Pi thinking is enabled
- `functionCall` parts -> Pi `toolCall` content blocks
- finish reason -> Pi stop reason (`stop`, `length`, `toolUse`, `error`, etc.)
- usage metadata -> Pi usage/cost structure

## Gemini 3.5 Flash target

The initial provider should expose `gemini-3.5-flash` because that is the desired new model target. Implementation should validate two things before declaring support complete:

1. Code Assist accepts `model: "gemini-3.5-flash"` on `streamGenerateContent`.
2. The model's thinking config behavior is known:
   - whether thinking can be disabled,
   - whether `thinkingLevel` is accepted,
   - whether `thinkingBudget` is accepted,
   - whether hidden thinking should be suppressed from Pi output.

If Code Assist rejects `gemini-3.5-flash`, the extension should fail clearly and optionally expose a temporary verified fallback only behind explicit config. Do not silently downgrade.

## Configuration

Suggested environment variables:

```text
GEMINI_CODE_ASSIST_CREDENTIALS_PATH    # default ~/.gemini/oauth_creds.json
GEMINI_CODE_ASSIST_PROJECT             # optional; fallback GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID
GEMINI_CODE_ASSIST_ENDPOINT            # default https://cloudcode-pa.googleapis.com
GEMINI_CODE_ASSIST_API_VERSION         # default v1internal
GEMINI_CODE_ASSIST_USER_AGENT_VERSION  # optional override when Gemini CLI package version cannot be detected
GEMINI_CLI_CUSTOM_HEADERS              # match Gemini CLI behavior
```

Pi usage example:

```bash
pi --provider gemini-code-assist --model gemini-3.5-flash
```

or:

```bash
pi --model gemini-code-assist/gemini-3.5-flash
```

## Spike plan

Before creating the full Pi extension, write a narrow local spike script that does exactly one text-only request.

Inputs:

- `~/.gemini/oauth_creds.json`
- optional `GOOGLE_CLOUD_PROJECT`
- model `gemini-3.5-flash`
- prompt `Say hello from Code Assist OAuth.`

Success criteria:

- credentials load and refresh if needed
- request uses Gemini CLI-compatible headers
- Code Assist returns SSE chunks
- text response is printed
- request works without invoking the `gemini` binary

If this fails, inspect whether Gemini CLI's `setupUser()` / onboarding flow must also be ported before generation.

## Implementation phases

### Phase 0: evidence capture

- Capture Gemini CLI request URL, method, headers, and body shape from a local authenticated run.
- Confirm whether `Authorization` comes only from `AuthClient.request` or whether additional Google headers are present.
- Confirm `gemini-3.5-flash` works through Code Assist.

### Phase 1: text-only provider

- Register Pi provider and model.
- Implement credential loading and refresh.
- Implement Code Assist SSE request.
- Implement text-only response streaming.
- No tools, images, or thinking yet.

### Phase 2: Pi tool support

- Convert Pi tool schemas to Gemini function declarations.
- Convert Code Assist function calls to Pi tool calls.
- Convert Pi tool results back to Gemini `functionResponse` parts.
- Add tests for duplicate/missing function call IDs.

### Phase 3: thinking, multimodal, and robustness

- Add thinking config mapping for Gemini 3.5 Flash once verified.
- Add image support.
- Preserve usage metadata.
- Normalize context-overflow errors so Pi compaction can recover.
- Add clear auth/quota/project/model diagnostics.

### Phase 4: credential storage hardening

- Support encrypted/keychain Gemini CLI storage if needed.
- Add safe migration or diagnostic instructions when credentials cannot be loaded.

## Validation plan

- Unit tests for:
  - credential loading and refresh decision
  - `GEMINI_CLI_CUSTOM_HEADERS` parsing compatibility
  - Code Assist request envelope construction
  - SSE parsing
  - response-to-Pi event conversion
  - tool call conversion
- Live smoke tests:
  - text-only prompt with `gemini-3.5-flash`
  - prompt with at least one Pi tool call
  - expired-token refresh path
  - missing credential diagnostic
  - invalid model diagnostic
- Repo checks:
  - `npm run check --workspace @bravo/gemini-code-assist`
  - package-specific tests once added

## Risks

- Code Assist is an internal-ish `v1internal` API and may drift without notice.
- Gemini CLI may perform setup/onboarding calls that are required before `streamGenerateContent`; direct generation must be proven in the spike.
- Gemini CLI encrypted credential storage may be harder to reuse than file-backed `oauth_creds.json`.
- Google may distinguish clients by `User-Agent` or other headers; header fidelity is explicitly required.
- `gemini-3.5-flash` may not be accepted by Code Assist immediately even if it exists elsewhere.
- Quota and billing semantics may differ from public Gemini API key and Vertex providers.

## Open questions

1. Does Code Assist accept `gemini-3.5-flash` today for OAuth users?
2. Is `setupUser()` mandatory for every new environment/session, or only first-time onboarding?
3. Are there extra headers from `google-auth-library` that must be mirrored when using raw `fetch`?
4. Should the package read Gemini CLI's installed version to build `User-Agent`, or use a pinned/configured compatible value?
5. Should the provider expose only `gemini-3.5-flash` initially, or also verified fallbacks for debugging?
6. Is file-backed `~/.gemini/oauth_creds.json` available in the target operator environment, or must encrypted storage be supported in v1?

## Recommendation

Proceed with a small direct-request spike before implementing the full package. If text-only `streamGenerateContent` works with `~/.gemini/oauth_creds.json`, this is a straightforward Pi custom provider extension. If the spike shows onboarding or hidden headers are required, port the minimum necessary Gemini CLI Code Assist setup path and keep the provider intentionally narrow around `gemini-3.5-flash` until the contract is stable.

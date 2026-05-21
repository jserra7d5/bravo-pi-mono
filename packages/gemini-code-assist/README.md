# Gemini Code Assist / Antigravity Code Assist

This package contains a headless Google Code Assist OAuth spike plus a Pi provider extension for Antigravity's Code Assist backend.

The practical provider exposed to Pi is:

```text
antigravity-code-assist/gemini-3.5-flash
antigravity-code-assist/gemini-3.5-flash-medium
```

`gemini-3.5-flash` is a friendly Pi-facing alias for Antigravity's server-side model id `gemini-3-flash-agent`, whose generation responses report:

```json
"modelVersion": "gemini-3-flash-a"
```

## What this is

Antigravity uses Google Code Assist's internal `v1internal` API at:

```text
https://daily-cloudcode-pa.googleapis.com
```

The provider reproduces the Antigravity request dialect directly, without launching or wrapping `agy`:

- OAuth bearer auth using Antigravity's OAuth client/scopes.
- `loadCodeAssist` setup with `metadata.ideType = "ANTIGRAVITY"`.
- `streamGenerateContent?alt=sse` generation.
- Outer model id set to Antigravity's model id.
- `userAgent = "antigravity"` and `requestType = "agent"`.

## Installed Pi usage

After the package is installed into Pi:

```bash
pi --list-models gemini-3.5-flash
```

Expected models:

```text
antigravity-code-assist  gemini-3.5-flash         1.0M  65.5K  yes  yes
antigravity-code-assist  gemini-3.5-flash-medium  1.0M  65.5K  yes  yes
```

Run Pi with Gemini 3.5 Flash:

```bash
pi --model antigravity-code-assist/gemini-3.5-flash
```

Non-interactive smoke test:

```bash
pi --model antigravity-code-assist/gemini-3.5-flash \
  --no-tools --no-session \
  -p 'Reply exactly PI_PROVIDER_OK'
```

## OAuth credentials

The direct provider can use Pi OAuth, but this package also supports a file-backed credential used during development:

```text
~/.gemini/antigravity_oauth_creds.json
```

To create or refresh that credential manually:

```bash
npm run antigravity:login --workspace @bravo/gemini-code-assist
```

The login flow opens a Google OAuth URL and saves the returned access/refresh token pair. Do not print, commit, or proxy-log the token values.

## Reasoning / thinking controls

Antigravity's backend accepts Gemini-style thinking controls under:

```json
request.generationConfig.thinkingConfig
```

The Pi extension maps Pi thinking levels to Antigravity values:

| Pi thinking | Antigravity thinkingConfig |
| --- | --- |
| unset / default | `{ includeThoughts: false, thinkingBudget: 0 }` |
| minimal | `{ includeThoughts: false, thinkingLevel: "MINIMAL" }` |
| low | `{ includeThoughts: false, thinkingLevel: "LOW" }` |
| medium | `{ includeThoughts: false, thinkingLevel: "MEDIUM" }` |
| high | `{ includeThoughts: false, thinkingLevel: "HIGH" }` |
| xhigh | `{ includeThoughts: false, thinkingLevel: "HIGH" }` |

Use:

```bash
pi --model antigravity-code-assist/gemini-3.5-flash --thinking high
```

Live proof showed higher settings return `thoughtsTokenCount`; disabled/minimal settings omit it or keep it near zero.

## Metadata available from the backend

`fetchAvailableModels` returns model metadata including:

- display name
- model id and internal model placeholder enum
- default agent model id
- context window (`1,048,576` tokens for these models)
- max output tokens (`65,536`)
- `supportsThinking`
- default and minimum thinking budgets
- `quotaInfo.remainingFraction`
- `quotaInfo.resetTime`
- supported MIME types
- API/model provider labels

Generation responses return:

- `modelVersion`, e.g. `gemini-3-flash-a`
- `responseId`
- `traceId`
- `usageMetadata.promptTokenCount`
- `usageMetadata.candidatesTokenCount`
- `usageMetadata.thoughtsTokenCount` when reasoning is active
- `usageMetadata.totalTokenCount`
- `thoughtSignature`

No server-side dollar cost, cumulative token ledger, or daily integer request usage endpoint has been found. The closest quota signal is model-level `quotaInfo.remainingFraction` and `resetTime`.

## Validation commands

```bash
npm run check --workspace @bravo/gemini-code-assist
npm test --workspace @bravo/gemini-code-assist
npm run antigravity:proof --workspace @bravo/gemini-code-assist -- --mode sweep
```

Pi provider smoke tests:

```bash
pi --no-extensions \
  -e $(pwd)/packages/gemini-code-assist/dist/extensions/pi/index.js \
  --model antigravity-code-assist/gemini-3.5-flash \
  --no-tools --no-session \
  -p 'Reply exactly PUBLIC_MODEL_OK'

pi --no-extensions \
  -e $(pwd)/packages/gemini-code-assist/dist/extensions/pi/index.js \
  --model antigravity-code-assist/gemini-3.5-flash \
  --thinking high \
  --no-tools --no-session \
  -p 'Reply exactly PI_THINKING_HIGH_OK'
```

## Security notes

- Never log Authorization headers or OAuth token JSON.
- The capture proxies used during discovery redacted tokens and were temporary.
- `recordCodeAssistMetrics` is telemetry upload, not a usage-read endpoint.
- The Pi provider intentionally avoids spawning `agy`; it talks directly to Code Assist.

## Related spec

See:

```text
docs/specs/gemini-code-assist-oauth-provider/DESIGN.md
```

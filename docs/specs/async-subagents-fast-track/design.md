# Async Subagents Fast Track Design

Status: proposed
Date: 2026-06-05
Package: `packages/async-subagents`

## Summary

Add a lead-session `/fast-track` policy for async subagents. When armed, the lead agent may explicitly launch selected critical-path implementation, planning, or gating-review children with Codex priority service tier. The goal is to shorten the critical pipeline path for heavy worker/planner/generalist/reviewer runs without making all children faster, noisier, or more expensive by default.

This belongs in `@bravo/async-subagents`, not a standalone `.pi` extension, because the policy is specifically about async child launch semantics, launch metadata, prompt guidance, and subagent TUI state.

## Background

Project-local `.pi/extensions/codex-usage.ts` already provides `/fast` for the interactive main Pi session. That extension intentionally applies only when `ctx.hasUI` is true, so noninteractive async child Pi launches stay normal by default.

Fast track is a different control:

- `/fast` changes the current interactive model request behavior.
- `/fast-track` authorizes selected async child launches to use priority service tier.

A standalone fast-track extension would need a side channel into async-subagents launch internals. That is brittle and would split the policy from the component that owns child process construction. Therefore fast-track should ship inside async-subagents.

## Goals

- Add `/fast-track [on|off|status]` as a lead-session command.
- Show a TUI badge when fast-track is armed.
- Add an explicit `fastTrack?: boolean` option to `subagent_start`.
- Apply fast-track only to explicitly marked launches while the policy is armed.
- Apply only to explicitly allowlisted Codex child launches: all `bravo-codex-balanced/*` models plus selected direct Codex GPT-5.5 providers.
- Make fast-track visible in launch cards, results/status details, and launch logs.
- Teach the lead agent to reserve fast-track for absolute critical-path implementation/planning/review runs.
- Keep scouts, broad fanout, Gemini variants, and non-Codex models normal by default; reviews may be fast-tracked when they are on the implementation critical path.

## Non-goals

- Do not make `/fast-track on` automatically affect every eligible child.
- Do not apply to scout retrieval lanes.
- Do not apply to routine reviewer lanes by default; review lanes may be fast-tracked when the review is gating further implementation on the critical path.
- Do not make the existing project-local `/fast` affect async children.
- Do not add compatibility shims or external side-channel extensions.
- Do not expose priority service tier for non-GPT-5.5 direct Codex models in v1, except all `bravo-codex-balanced/*` models are eligible because that is the normal subagent provider family in this repo.

## User contract

Command behavior:

```text
/fast-track            # status
/fast-track status     # status
/fast-track on         # arm policy for this async root session
/fast-track off        # disarm policy
```

Tool behavior:

```ts
subagent_start({
  agent: "worker",
  task: "Implement the critical-path slice...",
  fastTrack: true
})
```

`fastTrack: true` means: "this child is on the critical implementation/planning/review path and should use priority service tier if the current fast-track policy and model gate allow it."

If `fastTrack: true` is supplied while `/fast-track` is off, the launch should fail closed with a clear diagnostic or return a tool error. Silent downgrade would hide cost/latency intent from the operator.

If fast-track is armed but the selected child model is ineligible, the launch should proceed normally and report `fastTrack.applied: false` with a reason such as `ineligible_model`. The lead can decide whether to relaunch with a different agent/model.

## Eligibility policy

Apply fast-track only when all conditions are true:

1. The root session fast-track setting is armed.
2. `subagent_start` received `fastTrack: true`.
3. The resolved child model is explicitly allowlisted for fast-track:
   - all `bravo-codex-balanced/*` models
   - `openai-codex/gpt-5.5`
   - future provider/model patterns only after they are explicitly added to the allowlist
4. The resolved agent is not `scout`.
5. The selected variant is not a non-Codex provider such as Gemini.

Planner/worker/generalist and critical-path reviewers are the intended lanes. The runtime should not hard-code only those names because project/user definitions may rename implementation/planning/review roles. The hard gates should be model/provider + not scout; prompt guidance supplies the behavioral policy.

## Runtime design

### State

Persist fast-track setting under the async-subagents run root, scoped to the root session, for example:

```text
<runRoot>/session-fast-track/<rootSessionId>.json
```

Shape:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "updatedAt": "2026-06-05T00:00:00.000Z"
}
```

Root-session scope prevents one Pi session from accidentally arming priority launches for another concurrent lead in the same workspace.

### Launch plumbing

Add `fastTrack?: boolean` to:

- `subagentStartSchema`
- `StartSubagentInput`
- `SubagentStartResult`
- `RunStatus`
- `RunResult`
- launch log metadata

Recommended status/result shape:

```ts
type FastTrackLaunch = {
  requested: boolean;
  enabled: boolean;
  applied: boolean;
  reason?: "not_requested" | "disabled" | "scout" | "ineligible_model";
  serviceTier?: "priority";
};
```

### Provider hook

Async child Pi launches are isolated with `--no-extensions`; fast-track should inject an async-subagents-owned child extension only when `applied === true`.

The child extension registers a `before_provider_request` handler and returns:

```ts
{ ...event.payload, service_tier: "priority" }
```

Only inject this extension for applied launches. That avoids exposing priority behavior to children that do not need it and keeps launch logs easy to audit.

### TUI

Use the existing async-subagents widget, not a separate status line. Add one compact header segment when armed:

```text
⚡ fast-track
```

Color: amber/gold, not green. Fast-track means higher-speed/higher-cost capability is armed; it is not a success state.

Launch/result cards should add a compact speed marker on the model line:

```text
model      bravo-codex-balanced/gpt-5.5  ·  thinking low  ·  speed fast
```

### Prompt guidance

Update the async-subagents prompt module:

- `/fast-track on` is an operator greenlight, not a blanket instruction.
- Use `fastTrack: true` only for absolute critical-path implementation/planning/review children with heavy output-token usage where wall-clock latency controls total completion time.
- Reviews qualify when they gate further implementation on the critical path, for example review-before-remediate loops.
- Do not use fast-track for scouts, default fanout, routine non-gating reviews, status checks, or low-risk mechanical work.
- If unsure, leave fast-track off for that child.

## Failure behavior

- `fastTrack: true` while policy disabled: fail closed with actionable message: run `/fast-track on` first or remove `fastTrack`.
- Ineligible model: launch normally but report not applied, unless the user later asks for strict mode.
- Child provider hook failure: child launch should fail before spawn if the extension path is missing/unloadable; do not silently run a supposedly fast-tracked child without the hook.

## Validation

- Unit tests for command parsing/state persistence.
- Tool schema test confirming `fastTrack` is model-visible.
- Launch test confirming applied fast-track injects the child extension and launch metadata.
- Launch test confirming disabled fast-track fails closed.
- Launch test confirming scout/ineligible models do not receive the extension.
- Renderer tests for widget badge and launch/result card speed marker at narrow widths.
- Prompt module snapshot/string test for critical-path guidance.

Run:

```sh
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
```

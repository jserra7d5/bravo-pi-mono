# Agent Tool and Prompt Contracts

## Tool responsibility boundary

The native tool set stays small:

1. `ask_user_question` creates a request.
2. `wait_for_user_question` makes an existing pending request the blocking point.
3. `withdraw_user_question` removes an obsolete pending request.

There is no agent-facing list/status tool in v1. The creation receipt, answer event, and conversation transcript are sufficient; adding polling tools would increase choice ambiguity and invite loops.

## `ask_user_question`

### Purpose

Create one structured request containing 1–4 related user decisions. It either waits for explicit resolution or returns a durable pending receipt.

### Input

```ts
{
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      id?: string;          // service assigns a stable ID when omitted
      label: string;
      description?: string;
    }>;
    multiSelect: boolean;
  }>;
  delivery?: "blocking" | "non_blocking"; // default blocking
  urgency?: "low" | "normal" | "high";   // default normal
}
```

Question constraints: 1–4 questions, 2–4 options, headers up to 20 characters, concise labels, and no explicit Other option.

### Result

```ts
{
  request_id: string;
  state: "pending" | "answered" | "declined" | "withdrawn";
  delivery: "blocking" | "non_blocking";
  urgency: "low" | "normal" | "high";
  resolution?: {
    answers: Array<{
      question: string;
      selected_option_ids: string[];
      selected_labels: string[];
      free_text?: string;
    }>;
  };
}
```

The model-facing `content` is compact prose; `details` contains the structured envelope.

### Use when

- A meaningful user choice would change implementation, scope, or direction.
- The instruction is ambiguous among multiple valid approaches.
- A safety, cost, or irreversible boundary requires explicit preference.

### Avoid when

- The answer would not change behavior.
- Repository evidence can resolve the question directly.
- A routine reversible implementation detail can use the established default.
- The same pending request already exists; wait on it instead of asking again.

### Fallback

- Non-interactive mode returns a clear unsupported result and disables all user-question tools for that session.
- Invalid duplicate questions/options return a validation error without creating state.

## `wait_for_user_question`

### Purpose

Wait for the terminal resolution of an existing request when useful independent work can no longer continue.

### Input

```ts
{ request_id: string }
```

### Result

Same request envelope as `ask_user_question`.

### Use when

- A previously non-blocking answer is now required for the next meaningful action.
- Work has reached the decision boundary named by that request.

### Avoid when

- Independent work remains.
- The request is merely high urgency; urgency alone is not a reason to block.
- The agent does not possess a valid request ID.

### Invariants

- Escalation is idempotent.
- It does not alter urgency.
- A terminal request returns immediately.
- It never creates a second request.

## `withdraw_user_question`

### Purpose

Withdraw a pending request that has become obsolete so it no longer demands user attention.

### Input

```ts
{ request_id: string; reason?: string }
```

### Result

Same request envelope, normally with `state: "withdrawn"`.

### Use when

- Later evidence made the question irrelevant.
- The chosen implementation path removed the decision.
- The originating work is intentionally abandoned.

### Avoid when

- The agent merely wants to stop waiting; waiting and request validity are separate.
- The request has been answered or declined.

## Tool-coupled prompt module

The extension adds these concise guidelines while the tools are active:

> Use `ask_user_question` when a meaningful user decision would improve or unblock the work.
>
> - Choose `blocking` when the immediate next action cannot be taken safely without the answer, especially before irreversible, costly, or materially divergent work.
> - Choose `non_blocking` when independent work can continue and the answer can be incorporated later.
> - Urgency controls user attention, not whether execution blocks: `low` is a future refinement, `normal` is useful without an immediate deadline, and `high` is needed soon because work is approaching a decision boundary.
> - After creating a non-blocking request, continue useful independent work. Do not poll, repeat the question, or ask it again in prose.
> - If a pending answer becomes necessary, call `wait_for_user_question` once.
> - Withdraw requests that become obsolete.
> - Treat a delivered answer event as authoritative and do not re-ask it.
> - Batch related decisions into one request, keep labels concise, put a recommended option first, and do not include an Other option because the UI supplies free text.

## Examples

### Non-blocking preference

The agent can implement shared infrastructure while a cosmetic preference remains open. It creates a normal-urgency non-blocking request, records the returned `request_id`, and continues. It does not poll.

### Blocking safety boundary

The next operation is destructive and valid alternatives have different data-loss consequences. The agent creates a high-urgency blocking request before performing the operation.

### Promotion

A non-blocking deployment preference was created during setup. After completing independent validation, deployment cannot proceed without it. The agent calls `wait_for_user_question` with the existing ID instead of creating another question.

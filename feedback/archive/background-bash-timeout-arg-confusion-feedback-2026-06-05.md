# Background bash timeout argument confusion feedback — 2026-06-05

## Incident

While running a long-lived email matrix workload, the agent invoked the background bash tool with this effective shape:

```json
{
  "command": "cd /home/joe/Documents/Quantiiv/Quantiiv-Agent-Gateway && . .venv/bin/activate && ... python /tmp/run_durable_context_email_matrix.py ...",
  "run_in_background": true,
  "timeout": 1
}
```

The intent was: start the workload asynchronously and return control to the agent quickly.

The actual behavior was: `timeout: 1` became the background task maximum runtime, so the harness stopped the workload after ~1000ms:

```text
[background-bash] timeout after 1000ms; stopping task
[background-bash] exit code=null signal=SIGTERM
```

No emails were sent because the process was terminated almost immediately.

## Root cause

The same `timeout` argument is used for two different mental models:

1. foreground command timeout; and
2. background task maximum runtime.

For `run_in_background: true`, the agent incorrectly treated `timeout: 1` as a foreground/tool-call return timeout rather than the workload lifetime budget.

The tool description does say:

> Foreground timeout or background maximum runtime in seconds.

But this is easy to miss during live operation because many async APIs use a short client-side timeout while the background job keeps running.

## Suggested tool/API improvements

Prefer schema separation if possible:

- `foreground_timeout_s` for non-background calls.
- `background_max_runtime_s` for `run_in_background: true` calls.
- Reject or warn on `run_in_background: true` with very small `timeout` values, e.g. `< 30s`, unless an explicit escape hatch is provided.

If backwards compatibility requires keeping `timeout`, improve the description and validation:

- Rename/display it in UI/tool docs as `max_runtime_s` when `run_in_background: true`.
- Add a preflight warning/error such as:
  - `timeout=1 with run_in_background=true will kill the background process after 1s. Did you intend background_max_runtime_s?`
- Consider a separate `return_immediately: true` behavior that does not overload `timeout`.

## Suggested prompt/tooling instruction update

Add a hard rule to the agent instructions:

> When using `bash({run_in_background: true})`, `timeout` is the background process maximum runtime, not the client wait timeout. Set it to the full expected workload budget (e.g. tests/builds/email matrix: 1800–7200s), or omit it only if the default is appropriate. Never use `timeout: 1` just to return quickly.

## Why this matters

This failure is silent-looking from the user perspective: the agent said it had queued work, but the harness had already killed it. For live external actions like emails, deploys, migrations, and long tests, this can create false confidence and confusing audit trails.

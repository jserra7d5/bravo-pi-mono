# Monitor UX feedback — noisy command monitor output

Date: 2026-06-02

## Context

While watching a GitHub Actions deploy with a command monitor using:

```bash
gh run watch <run_id> --exit-status
```

the monitor repeatedly emitted large, mostly identical status blocks as user-visible wakeups. This made the conversation noisy and forced the agent to respond to duplicate monitor output as if it were user input.

## Problems observed

1. **Duplicate output spam**
   - `gh run watch` refreshes frequently.
   - The monitor surfaced repeated full status blocks even when no meaningful state changed.
   - This produced many user-visible messages showing the same step.

2. **Monitor wakeups are visually indistinguishable from user input pressure**
   - The transcript showed repeated `[Command monitor output batch]` messages in the user channel.
   - Even though instructions say to treat monitor wakeups as control-plane events, their placement still creates pressure to answer each one.

3. **Stopping/replacing a noisy monitor leaves stale queued output**
   - After stopping the noisy monitor and creating a quieter one, some old output batches from the stopped monitor still appeared.
   - This made it look like the stopped monitor was still active.

4. **One-shot command monitor with interval was non-obvious**
   - A command monitor configured with `schedule.interval_ms` ran `gh run view ...` once and completed instead of behaving like a repeating poller.
   - To get quiet polling, the agent had to create its own shell/Python loop inside a command monitor.

5. **No built-in state-change filtering**
   - The useful behavior was: emit only when current step changes, status changes, or terminal state is reached.
   - The monitor system did not provide an obvious first-class way to do that for command output.

## Desired improvements

- Add a monitor mode or option for **state-change-only output**.
- Allow command monitors to declare a JSON projection/key and only wake when that projection changes.
- Provide a built-in GitHub Actions monitor helper or documented pattern:
  - poll `gh run view --json status,conclusion,jobs`
  - emit current in-progress step
  - suppress duplicates
  - wake on failure/success
- Make stopped monitor output clearly marked as stale/drained, or suppress queued stale output after stop.
- Clarify docs/tool schema behavior for scheduled command monitors:
  - whether `interval_ms` reruns a finite command or whether command monitors are expected to be long-running processes.

## Workaround used

Replaced noisy `gh run watch` with a custom quiet Python loop that:

- polls `gh run view --json status,conclusion,jobs`
- prints only when `{status, conclusion, step, completed_count}` changes
- exits with nonzero on failed terminal state

This worked, but it should be easier and first-class.

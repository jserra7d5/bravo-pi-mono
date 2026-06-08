# Monitor tooling feedback — 2026-06-05

Context: During ROGER staging email QA, I used Pi monitors to poll Gmail reply status and watch Cloud Run error logs. Two monitor-specific UX issues surfaced.

## 1. Poll monitors default to `/bin/sh`, so common agent shell snippets fail

### What happened

I started a poll monitor with:

```sh
cd /home/joe/Documents/Quantiiv/ROGER-main && source .venv/bin/activate && python /tmp/monitor_roger_yourpie_overlay_retests_gmail.py
```

The monitor failed immediately:

```text
poll exit=127
/bin/sh: 1: source: not found
```

### Why this matters

Agents commonly write `source .venv/bin/activate` for Python repos. In normal Bash tool calls this works, but monitor commands appear to run under `/bin/sh` unless explicitly wrapped. The failure mode is technically correct but easy to miss because the command looks valid in the rest of the Pi environment.

### Suggested improvements

Any one of these would help:

- Document prominently that monitor commands run under `/bin/sh` by default.
- Add a monitor option such as `shell: "bash"` or `shell_executable: "/bin/bash"`.
- Emit a targeted hint when stderr contains `/bin/sh: .* source: not found`, e.g. “Use `. .venv/bin/activate` or wrap command with `bash -lc`.”
- Consider defaulting monitor command execution to Bash if Pi’s Bash tool is the dominant shell surface.

### Workaround used

```sh
bash -lc 'cd /home/joe/Documents/Quantiiv/ROGER-main && source .venv/bin/activate && python /tmp/monitor_roger_yourpie_overlay_retests_gmail.py'
```

## 2. Stream monitor woke on an empty result (`[]`)

### What happened

I started a stream monitor to watch Cloud Run ERROR logs:

```sh
gcloud logging read '(resource.type="cloud_run_revision" AND resource.labels.service_name=("roger-staging" OR "quantiiv-agent-gateway-staging") AND severity>=ERROR)' \
  --project=nad-nst --freshness=30m --format='json(...)' --limit=50
```

The monitor produced an event wakeup, but the output file contained only:

```json
[]
```

No actionable error existed.

### Why this matters

A wakeup on empty/no-op observer output creates false-positive control-plane noise. The agent has to inspect the monitor artifact just to discover that nothing happened.

### Suggested improvements

- Treat empty JSON arrays / empty output as “no event” for stream monitors by default, or provide an option like `suppress_empty_output: true`.
- For command monitors with `wake: "on_event"`, only wake when the projection/output contains non-empty actionable data.
- If empty output must wake, include that in the summary: “event captured but output is empty/no-op.”

## 3. JSON terminal projection ergonomics are unclear

### What happened

For Gmail reply polling, I wanted terminal behavior when `complete == total` from a JSON payload. I attempted to pass a projection object:

```json
{
  "complete_json_path": "complete",
  "total_json_path": "total",
  "terminal_when": "complete == total"
}
```

I was not confident whether this shape was supported. The monitor failure above happened before this could be proven, but the API surface does not make the supported projection DSL obvious from the tool schema.

### Suggested improvements

- Add examples for common monitor terminal conditions:
  - JSON field equality (`complete == total`)
  - JSON status field in terminal states (`status in ["done", "failed"]`)
  - non-empty array/object detection
- If arbitrary projection keys are ignored, validate/reject unsupported projection shapes instead of accepting silently.
- Include the evaluated projection state in monitor output/wakeups when present.

## 4. Monitor guidance should distinguish observer commands from shell workload commands with examples

The high-level distinction is good: monitor observes external state; background bash runs workloads. What would help is a few canonical examples in the docs/schema guidance:

- Poll GitHub Actions until status is completed.
- Poll Gmail/API state until `complete == total`.
- Watch Cloud Logging while suppressing empty reads.
- Watch file content for a pattern.

Each should include the correct shell wrapping, timeout fields, wake mode, and projection/terminal pattern.

## Net impact in this run

No product QA was blocked. The Gmail monitor was restarted with `bash -lc`, and the Cloud Run error wake was a harmless empty result. But both caused avoidable operator overhead during a live staging QA loop.

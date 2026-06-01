## 1. Question restated

Should Pi implement Claude-Code-like “background any script” support as:

1. **An override/extension of the built-in `bash` tool** with a parameter like `run_in_background`, preserving one model-facing shell tool; or
2. **Separate background task tools** such as `background_bash`, `background_output`, `background_list`, and `background_stop`, leaving Pi’s built-in `bash` unchanged?

The concrete implementation question is whether Pi extensions need a custom `bash` override, or whether extending/adding operations around existing built-in tool behavior is enough.

---

## 2. Points of agreement

Both sides agree on the core technical facts:

- **Built-in Pi `bash` cannot be backgrounded by operations alone.**
  - Current schema is only `{ command: string, timeout?: number }`.
  - `BashOperations.exec()` is synchronous: it returns only after command completion.
  - `spawnHook`/custom operations can mutate execution details but do not change the tool schema or async/background contract.
  - Therefore, adding a Claude-like `run_in_background` flag to the model-facing `bash` requires replacing/overriding the tool definition, not merely extending built-in operations.

- **A true background implementation needs more than spawning with `&`.**
  It needs:
  - task IDs,
  - process metadata,
  - output redirection to files,
  - status tracking,
  - kill/cleanup controls,
  - output size limits/pagination,
  - lifecycle handling on shutdown/reload,
  - completion notification policy.

- **Some auxiliary controls are needed either way.**
  Even if initiation is unified through `bash({ run_in_background: true })`, the agent still needs a way to inspect, list, and stop background jobs.

- **Overriding `bash` is feasible but risky.**
  Pi extensions can override built-in tools, but prompt metadata is not inherited. A custom `bash` must recreate built-in foreground behavior and prompt guidance.

- **Separate tools are safer architecturally but worse ergonomically.**
  They preserve the built-in `bash` contract, but introduce tool-selection/routing risk for the model.

---

## 3. Live disagreements and strongest case for each side

### A. Case for overriding/extending built-in `bash`

Strongest argument: **background execution is an execution mode of shell command execution, not a separate semantic action.**

Claude Code exposes this as one Bash tool with `run_in_background`, and the user explicitly wants Claude-like behavior. A unified model-facing contract is cleaner:

```ts
bash({
  command: string,
  timeout?: number,
  run_in_background?: boolean
})
```

Benefits:

- The model has one canonical way to run shell commands.
- Long-running-vs-short-running is expressed as a parameter, not a separate tool choice.
- It avoids the failure mode where the model accidentally uses normal `bash` for a server/watch/build command and blocks.
- Existing monitor infrastructure can still be used internally; the argument is about the public tool surface, not necessarily the backend.

Best architecture for this side:

- Override tool named `bash`.
- Foreground path delegates to built-in `createBashTool()` if possible, or faithfully reimplements it.
- Background path uses a durable monitor/process backend:
  - spawn detached process/process group,
  - redirect stdout/stderr to output file,
  - persist task metadata,
  - return `{ taskId, pid, outputPath, status }`,
  - send terminal-state notification later.
- Add auxiliary status/output/stop tools or commands.
- Rewrite bash prompt metadata, including “do not use `&`; use `run_in_background`.”

Main weakness:

- This has high blast radius. A bad override can break the agent’s most important tool.
- Prompt metadata drift is real: upstream improvements to built-in `bash` guidance will not be inherited.
- Return contract becomes polymorphic: foreground returns normal command output; background returns task metadata.

---

### B. Case for separate background tools

Strongest argument: **do not replace a core tool when an extension can add narrowly scoped async tools.**

Pi’s built-in `bash` is synchronous and stable. Background execution is stateful, async, and operationally different. Separate tools keep contracts clean:

```ts
background_bash({ command })
background_output({ taskId, offset?, limit? })
background_list()
background_stop({ taskId })
```

Benefits:

- Built-in `bash` remains unchanged.
- Existing prompt metadata and renderer behavior are preserved.
- Less risk of breaking ordinary command execution.
- Easier to bridge to durable monitor infrastructure.
- Cleaner separation between synchronous shell execution and managed background jobs.
- Easier rollout/rollback: disabling the extension only removes background tools, not core `bash`.

Best architecture for this side:

- Register `background_bash` as a semantic wrapper around existing durable monitor infrastructure where possible.
- Return task ID and output log path.
- Use normal file read for output where viable, or provide bounded `background_output`.
- Provide `background_list` and `background_stop`.
- Add prompt guidance:
  - use normal `bash` for quick commands,
  - use `background_bash` for servers, watchers, long builds, scripts, or commands needing later monitoring.

Main weakness:

- The model must choose between `bash` and `background_bash` up front.
- This can diverge from Claude Code’s interface.
- It may still block if the model misroutes a long-running command to normal `bash`.

---

## 4. Recommendation with assumptions and flip conditions

### Recommendation

For a Pi **extension**, prefer **separate background tools backed by durable monitor infrastructure**, not a full `bash` override, unless there is a hard product requirement to exactly match Claude Code’s `bash(run_in_background)` interface.

Reason: under Pi’s current extension constraints, overriding `bash` is not a small extension of built-in operations. Because the built-in schema and execute contract are synchronous, a Claude-like flag requires replacing the whole tool definition and prompt metadata. That creates avoidable blast radius around the most critical agent tool.

The recommended implementation map:

1. Keep built-in `bash` unchanged.
2. Add:
   - `background_bash`
   - `background_list`
   - `background_stop`
   - optionally `background_output`, unless output-file reading is sufficient.
3. Implement these using existing durable monitor infrastructure if it is package/runtime-appropriate.
4. Store task metadata durably:
   - task ID,
   - command,
   - cwd,
   - PID/PGID,
   - output path,
   - status,
   - exit code,
   - timestamps,
   - owning session.
5. Add lifecycle behavior:
   - on session start, reconcile persisted tasks with live PIDs/output files;
   - on shutdown, kill owned non-persistent tasks or clearly mark persistence policy.
6. Add prompt guidance instead of overriding `bash`:
   - “Use `bash` for short foreground commands.”
   - “Use `background_bash` for long-running scripts, servers, watchers, or commands requiring later monitoring.”
   - “Do not use shell `&`; use background tools.”

### Assumptions

This recommendation assumes:

- Exact Claude Code tool-schema compatibility is not mandatory.
- Pi extension safety/maintainability matters more than having one elegant model-facing shell tool.
- The model can be guided well enough to choose background tools for long-running commands.
- Durable monitor infrastructure is available or can be reasonably wrapped.

### Flip conditions

Choose the `bash` override design if any of these are true:

- Product requirement: Pi must expose Claude-compatible `bash({ run_in_background: true })`.
- Empirical testing shows the model frequently misroutes long-running commands to normal `bash` despite prompt guidance.
- Pi core provides a stable exported way to inherit/compose built-in `bash` schema, prompt metadata, renderer, and foreground behavior.
- The extension can delegate foreground execution to built-in `bash` with high fidelity and has regression tests proving compatibility.
- Downstream consumers already expect a single Bash tool with background mode.

If flipping to override, do not merely customize `BashOperations`; that is insufficient. Implement a custom tool named `bash` with an extended schema and an internal split between foreground delegation and background monitor-backed execution.

---

## 5. Gaps not debated

- Exact built-in `bash` renderer/session reconstruction compatibility.
- Permission/security model for arbitrary long-running commands.
- Windows behavior and process-tree cleanup semantics.
- Output-file location, retention, truncation, and privacy policy.
- Notification semantics: whether completion wakes the agent, only updates UI, or posts a user-visible message.
- Handling reload/restart when process handles are lost.
- Compatibility with `user_bash` / `!` interception.
- Test plan:
  - foreground bash parity,
  - timeout/abort behavior,
  - process-group kill,
  - large-output handling,
  - session shutdown cleanup,
  - restart reconciliation,
  - prompt/tool-selection accuracy.
- Whether current durable monitor tools are actually stable upstream Pi APIs or environment-specific tooling.

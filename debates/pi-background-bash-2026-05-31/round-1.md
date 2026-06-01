# Round 1 — Opening positions

## Debater A — @Harper — Override/extend built-in `bash`

**Strongest claim:** Pi should expose background execution as an extension of the existing model-facing `bash` tool (`run_in_background` / `background`) because “run a shell command” is one semantic action; splitting foreground and background execution across separate tools makes the model learn an artificial distinction, increases prompt/tool-selection complexity, and diverges from the Claude Code behavior the user explicitly wants to emulate.

**Evidence / reasoning from the brief:**

- Claude Code’s precedent is a single Bash tool with `run_in_background`, plus notification/output/status semantics around it.
- Pi extensions can override built-in tools by registering the same name, so this is feasible at the extension layer.
- The built-in Pi `bash` schema is currently `{ command, timeout? }`; since `BashOperations.exec()` is synchronous and cannot return a background task shape, true background support requires replacing the tool definition/schema anyway.
- Pi already supports extension state, lifecycle hooks, custom renderers/status UI, `sendMessage`, and arbitrary Node process management. Those are exactly the primitives needed to implement Claude-like background jobs.
- Prompt metadata is not inherited when overriding, but that is manageable: the extension should provide a new `bash` prompt description that preserves normal bash behavior and adds background guidance.

**Concrete extension architecture:**

Register an extension tool named `bash` with schema:

```ts
{
  command: string,
  timeout?: number,
  run_in_background?: boolean
}
```

Behavior:

1. **Foreground path**
   - Preserve existing behavior as closely as possible.
   - Ideally delegate to exported `createBashTool(cwd, options)` for non-background calls, or reimplement the same local spawn/accumulator/timeout/process-group behavior if delegation is awkward.

2. **Background path**
   - Spawn the command directly using Node `spawn`, with the same cwd/env/prefix semantics where applicable.
   - Assign a task ID.
   - Redirect stdout/stderr to durable output files.
   - Persist metadata: task ID, command, cwd, pid/process group, output path, start time, status, exit code, last output offset, ownership/session.
   - Return immediately with task ID, pid, output path, and instructions that completion will be reported later.

3. **Monitoring/control**
   - Use lifecycle hooks for cleanup/recovery.
   - Add auxiliary affordances without fragmenting the primary execution surface:
     - status/list/stop commands or tools,
     - renderer/status widget/footer,
     - output path readable by normal file read,
     - optional `bash` sub-actions only if needed.
   - Send completion notifications via `pi.sendMessage`, with debouncing/noise controls.

This preserves one canonical way for the model to run shell commands: call `bash`; choose foreground or background via a parameter.

**Risks and mitigations:**

- **High blast radius from overriding core `bash`:** mitigate by strict foreground compatibility tests and delegating to built-in behavior where possible.
- **Prompt metadata not inherited:** mitigate by explicitly copying/recreating the existing bash guidance and adding only the background-specific rules.
- **Lost process handles on reload/restart:** persist task metadata and output paths; on restore, reattach status by PID when possible, otherwise mark unknown/exited conservatively.
- **Runaway logs / interactive deadlocks:** cap output size, detect stalls/prompts, recommend not using `&`, and provide stop controls.
- **Process tree cleanup:** use process groups on Unix; define Windows behavior separately.
- **Notification noise:** send only terminal-state notifications and avoid recursive auto-turns unless explicitly requested.

**Assumption that would most weaken this position:**

The key assumption is that Pi can override `bash` while preserving enough of the built-in foreground behavior to avoid surprising existing model/tool use. If overriding `bash` materially degrades reliability, renderer behavior, permissions, or compatibility with existing prompt expectations, then separate background tools become safer despite their worse model-facing ergonomics.

---

## Debater B — @Drew — Separate background tools / monitor bridge

## 1. Strongest Claim
Implementing background execution via a dedicated tool suite (`background_bash`, `background_output`, `background_list`, `background_stop`) preserves the integrity of Pi's core execution model, prevents system prompt degradation, and leverages existing durable monitor infrastructure without introducing high-blast-radius changes to the built-in `bash` tool.

## 2. Evidence & Reasoning
*   **System Prompt & Metadata Isolation:** As established in the feasibility brief, when overriding a built-in tool in Pi, *prompt metadata is not inherited*. Overriding the core `bash` tool forces the extension to completely rewrite and maintain the prompt guidelines and rules for command execution. Separate tools keep the standard `bash` prompt metadata intact and allow self-contained, highly specific instructions for the background tools.
*   **Schema & Interface Cleanliness:** The built-in `bash` tool is designed for synchronous, one-shot execution with a strict schema (`{ command, timeout? }`) and a matching synchronous return contract. Forcing background capabilities (e.g., process tracking, pagination, status monitoring, termination) into a single overridden `bash` tool unnecessarily bloats the schema and complicates model tool-calling logic.
*   **Reusing Existing Infrastructure:** Pi already contains durable monitor tools (`monitor_start`, `monitor_output`, `monitor_stop`). Implementing separate background tools allows the extension to act as a lightweight, clean bridge to this existing, tested infrastructure rather than reimplementing process tracking and log redirection logic from scratch inside an overridden `bash` tool.

## 3. Concrete Extension Architecture
The separate-tool design consists of an extension state registry and four lightweight, specialized tools:

```
                  ┌────────────────────────────────────────┐
                  │           Pi Extension State           │
                  │  (Registry: taskId -> {PID, PGID, log}) │
                  └───────────────────┬────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│ background_bash │          │background_output│          │ background_stop │
│ Spawns detached │          │ Reads/tails log │          │ Kills process   │
│ log-redirected  │          │ with pagination │          │ group via PGID  │
│ process.        │          │ to prevent bloat│          │                 │
└─────────────────┘          └─────────────────┘          └─────────────────┘
```

1.  **State Registry:** A persistent key-value store mapping a unique `taskId` to runtime process metadata: PID, process group ID (PGID), command string, status (`running`, `completed`, `failed`), and output log filepath.
2.  **`background_bash({ command: string }) -> { taskId: string, status: string }`**
    *   Spawns the shell process detached (`detached: true`) so it runs in its own process group.
    *   Redirects `stdout` and `stderr` directly to a dedicated file (e.g., `/tmp/pi-bg/task_<id>.log`).
    *   Registers the task in the state registry and immediately returns the `taskId` to the agent.
3.  **`background_output({ taskId: string, limit?: number, offset?: number }) -> { output: string, status: string, exitCode?: number }`**
    *   Reads from the task's log file using pagination to protect context window limits.
4.  **`background_list() -> Array<TaskStatus>`**
    *   Lists all registered background tasks and their execution states.
5.  **`background_stop({ taskId: string }) -> { success: boolean }`**
    *   Terminates the entire process group (`process.kill(-pgid, 'SIGTERM')` falling back to `SIGKILL`) to prevent orphaned child processes.
6.  **Lifecycle Integration:** 
    *   `session_start`: Re-verifies running PIDs against the persisted registry.
    *   `session_shutdown`: Automatically cleans up running tasks unless explicitly flagged for session persistence.

## 4. Risks & Mitigations
*   **Risk 1: Token & Context Bloat from Log Polling.** If the agent repeatedly reads or polls large log files, it will exhaust the token budget.
    *   *Mitigation:* The `background_output` tool enforces a strict response size limit and supports offset-based pagination. Additionally, the extension UI (footer or status widget) displays task progress out-of-band to prevent unnecessary agent turns.
*   **Risk 2: Process Leaks and Orphaned Commands.** Background processes might outlive the Pi session or shell lifecycle.
    *   *Mitigation:* The extension registers a listener on `session_shutdown` to terminate all active process groups in the registry, enforcing an optional max lifetime (e.g., 60-minute TTL) watchdog on spawned tasks.
*   **Risk 3: Notification Storms.** Background completion events triggering agent actions can lead to infinite execution loops.
    *   *Mitigation:* Complete tasks update the session state quietly. Notifications are only sent to the user interface, avoiding injecting raw system turns that force the LLM to respond unless the user prompts it.

## 5. The One Weakening Assumption
This position relies on the assumption that **the LLM can reliably decide when to route commands to standard `bash` versus `background_bash` without suffering from tool confusion or selection overhead.** 

If this assumption is false—meaning the model regularly misroutes quick commands to the background (causing unnecessary latency/polling) or blocks the main session by running long-running commands in standard `bash`—then combining execution into a single, unified `bash` tool with a `run_in_background` boolean flag is superior. A single tool allows the runtime to dynamically determine routing or simplifies the model's cognitive task to adjusting a single parameter within a single tool context.

# Round 2 — Rebuttals

## Debater A — @Jordan — Defend overriding/extending `bash`

Debater B’s strongest argument is **blast radius and prompt-metadata loss**: overriding Pi’s built-in `bash` means replacing a core tool contract, not merely adding one option. Because prompt metadata is not inherited, the extension must faithfully recreate normal bash guidance, foreground behavior, renderer expectations, timeout/abort semantics, process-group cleanup, and user trust around a central tool. That is a real implementation and maintenance risk.

I concede that point. If the extension cannot preserve foreground `bash` behavior with high fidelity, or if Pi has downstream assumptions tied to the exact built-in schema/rendering, then separate background tools are the safer engineering choice.

But I think B overstates the conclusion.

The user’s target is explicitly **Claude-Code-like background Bash**, and Claude’s design is not “a separate background shell tool”; it is the same Bash tool with `run_in_background`. That matters because this is a model-facing affordance, not just an implementation detail. The model already reasons: “I need to run a command.” The foreground/background distinction is an execution mode of that command. Splitting it into `bash` vs `background_bash` introduces exactly the failure mode B admits: the model may choose the wrong tool and block on a long-running command, or background a command whose output it needed synchronously.

B’s “schema cleanliness” argument is also weaker than it sounds. Adding:

```ts
run_in_background?: boolean
```

does not meaningfully bloat `bash`. By contrast, adding `background_bash`, `background_output`, `background_list`, and `background_stop` expands the tool surface and forces routing decisions across multiple names. The control/read tools may still exist, but they should be auxiliary; the primary execution action should remain `bash`.

On infrastructure reuse: I agree existing monitor infrastructure is valuable, but it does not require a separate model-facing execution tool. The overridden `bash` can use that monitor backend internally for background calls. The debate is about the model/tool contract, not whether the implementation reuses monitors.

Updated position:

- Override `bash` only if foreground compatibility can be preserved tightly.
- Keep the model-facing execution surface unified:

```ts
bash({ command, timeout?, run_in_background? })
```

- Implement background mode by delegating to durable monitor/process infrastructure where possible.
- Add separate list/output/stop tools or commands only for lifecycle operations, not as the entry point for running commands.
- Explicitly rewrite bash prompt metadata, including “do not use `&`; use `run_in_background`.”

I have not changed my mind. B identifies the main risk correctly, but the cleaner user/model contract still favors extending `bash`, with strict compatibility tests and minimal schema expansion.

---

## Debater B — @Drew — Defend separate background tools / monitor bridge

### 1. Debater A’s Strongest Argument
Debater A’s strongest argument is the **cognitive routing and tool-selection ergonomics** of a unified interface. Under this view, running a command is a single semantic action. Splitting foreground and background execution across separate tools (`bash` vs. `background_bash`) forces the model to proactively evaluate execution duration at the invocation site, potentially leading to tool confusion, selection overhead, and diverging from the user-expected Claude Code design pattern.

### 2. Concessions
*   **Bifurcated Execution Path:** Debater A is correct that separate tools introduce a split decision point for the model before execution begins.
*   **Emulating Precedent:** A parameter-driven `run_in_background: boolean` is indeed the most direct way to replicate Claude Code's interface behavior.
*   **Prompt Rewrite Feasibility:** Overriding the system prompt for `bash` is technically feasible by duplicating the built-in instructions.

### 3. Rebuttal
While a single `bash` entry point is elegant in theory, it introduces severe architectural and operational issues in the context of Pi's extension system:

1.  **The Illusion of a "Single Tool" Interface:**
    Background execution is inherently stateful and asynchronous. Even if *initiation* is unified inside `bash(..., run_in_background: true)`, the model still requires mechanism interfaces to check status, read paginated logs, and terminate processes. 
    *   If we multiplex these actions into a single `bash` tool (e.g., adding `action: 'status' | 'stop' | 'output'`), the schema becomes bloated and heavily conditional, leading to greater tool-calling confusion and parameter hallucination.
    *   If we introduce separate tools for monitoring anyway, the model's cognitive load is not actually reduced—it must still learn auxiliary tools. A clean initiation separation (`background_bash` vs. `bash`) is logically consistent with this separate tool suite.

2.  **Upstream Prompt Synchronization Debt:**
    Because Pi does not inherit prompt metadata when a tool is overridden, overriding `bash` breaks the inheritance link. If the core Pi platform refines its standard `bash` safety rules, escaping logic, or system prompt heuristics, the extension will override and erase those improvements with outdated copy-pasted prompt guidelines.

3.  **High Blast Radius and Return Contract Drift:**
    *   `bash` is the single most critical tool in the agent. Replacing it entirely means the extension must perfectly emulate all synchronous streaming, abort signals, and platform-specific behaviors. A bug in the extension's execution wrapper would render the agent entirely non-functional.
    *   Standard `bash` operations return a string output or a synchronous exit code. Having it dynamically return a JSON task metadata object (e.g., `{ taskId: string }`) when run in the background disrupts standard parsing expectations unless the runtime and model are heavily tuned for both return types.

### 4. Sharpened Position
We firmly maintain that **separate background tools and a monitor bridge** are superior, but we sharpen our design to address the tool-routing concern:

*   **System Routing Heuristics:** To prevent tool confusion, the extension should append a small system prompt guideline (which *is* supported by Pi extensions without overriding the tool): 
    > *"Use standard `bash` for short-running, interactive commands (< 10s). Use `background_bash` for long-running scripts, servers, compilations, or commands that require background monitoring."*
*   **Durable Monitor Bridging:** Rather than writing custom process state registries from scratch, `background_bash` should act as a lightweight semantic alias wrapping the existing, tested durable monitor infrastructure (`monitor_start`/`monitor_stop`), minimizing runtime bugs.
*   **Direct File Reading Integration:** Instead of a bespoke `background_output` tool, we can instruct the model to use the standard built-in file reader on `/tmp/pi-bg/task_<id>.log` once the task ID is returned, further reducing the custom tool footprint.

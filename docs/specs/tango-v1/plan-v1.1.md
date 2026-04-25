# Tango v1.1 Plan — Pi Tool UX and Canonical Orchestration Prompts

Status: implemented  
Date: 2026-04-25  
Design: `docs/specs/tango-v1/design-v1.1.md`

## Objective

Implement the v1.1 design updates:

- keep the `tango` CLI as the sole orchestration implementation;
- make Pi tools the preferred orchestration surface wherever the Pi harness supports them;
- keep CLI as universal fallback and non-Pi recursion surface;
- inject canonical Tango orchestration instructions into parent Pi sessions;
- explicitly load Tango Pi tools into recursive Pi child agents;
- add custom terminal UI renderers for Tango tool calls/results;
- add a generic `tango_cli` escape-hatch tool.

## Research Summary

Relevant Pi extension/TUI APIs reviewed:

- `pi.registerTool()` supports custom `renderCall` and `renderResult` for terminal UI.
- Tool renderers return `@mariozechner/pi-tui` components such as `Text`, `Container`, `Box`, `Spacer`, and `Markdown`.
- Renderers receive `theme` and should use theme colors such as `success`, `warning`, `error`, `accent`, `muted`, and `dim`.
- Renderers receive an `expanded` flag; collapsed views should be compact and expanded views should show detailed metadata/output.
- Extensions can inject custom messages with `pi.sendMessage()` and render them with `pi.registerMessageRenderer()`.
- Extensions can set footer status with `ctx.ui.setStatus()`.
- Extensions can show widgets/overlays with `ctx.ui.setWidget()` and `ctx.ui.custom()`, but those should be deferred beyond v1.1.
- Custom tool output must be truncated to avoid context/UI overload.
- String enum schemas should use `StringEnum` from `@mariozechner/pi-ai`.

## Phase 1 — Documentation/Design Lock

1. Keep `design.md` and `plan.md` as v1.0 historical docs.
2. Add `design-v1.1.md` and `plan-v1.1.md`.
3. Add the CLI/tool invariant to docs:

   > The CLI is the only orchestration implementation. Pi tools shell out to `tango ... --json` and never mutate orchestration state directly.

4. Document the policy:

   ```txt
   Pi parent session: tools preferred, CLI fallback
   Pi recursive child: tools preferred, CLI fallback, extension loaded explicitly
   Non-Pi recursive child: CLI only
   Non-recursive child: no orchestration by default
   ```

Acceptance:

```bash
ls docs/specs/tango-v1/design-v1.1.md docs/specs/tango-v1/plan-v1.1.md
```

## Phase 2 — Split Canonical Orchestration Includes

Current file:

```txt
packages/tango/includes/orchestration.md
```

Add:

```txt
packages/tango/includes/orchestration-core.md
packages/tango/includes/orchestration-cli.md
packages/tango/includes/orchestration-pi-tools.md
```

Suggested contents:

### `orchestration-core.md`

- what Tango is;
- when to delegate;
- roles: scout, planner, worker, reviewer, team-lead;
- delegation best practices;
- avoid unnecessary child agents;
- inspect child outputs before summarizing.

### `orchestration-cli.md`

- `tango start <name> --role <role> "task"`;
- `tango list --json`;
- `tango look <name> --lines 200 --json`;
- `tango message <name> "message"`;
- `tango result <name>`;
- `tango status done "summary"`;
- prefer `--json` for parsing.

### `orchestration-pi-tools.md`

- prefer dedicated tools when available;
- `tango_start` wraps `tango start`;
- `tango_list` wraps `tango list`;
- `tango_look` wraps `tango look`;
- `tango_message` wraps `tango message`;
- `tango_stop` wraps `tango stop`;
- `tango_status` wraps `tango status`;
- `tango_result` wraps `tango result`;
- `tango_cli` is the escape hatch;
- raw CLI through shell is fallback/debugging.

Compatibility option:

- keep `orchestration.md` as an aggregator that says to prefer the split includes;
- or update role assembly to stop using `orchestration.md` directly.

Acceptance:

```bash
node packages/tango/dist/cli.js roles show team-lead
```

should show core + Pi tools + CLI + status protocol for a Pi recursive role.

## Phase 3 — Add Orchestration Policy to Role Schema

Add optional role field:

```yaml
orchestration: none | cli | tools | auto
```

Implementation updates:

1. Update `RoleConfig` in `src/types.ts`.
2. Parse `orchestration` in `src/roles.ts`.
3. Define default:

   ```txt
   recursive false -> none
   recursive true  -> auto
   ```

4. Update system prompt assembly to include orchestration includes based on harness + policy.

Proposed resolution:

```ts
function resolveOrchestration(role) {
  const policy = role.orchestration ?? (role.recursive ? "auto" : "none");
  if (policy === "none") return [];
  if (policy === "cli") return ["orchestration-core", "orchestration-cli"];
  if (policy === "tools") return ["orchestration-core", "orchestration-pi-tools", "orchestration-cli"];
  if (policy === "auto" && role.harness === "pi") return ["orchestration-core", "orchestration-pi-tools", "orchestration-cli"];
  return ["orchestration-core", "orchestration-cli"];
}
```

Acceptance:

```bash
tango roles show team-lead
```

or current dev equivalent:

```bash
node packages/tango/dist/cli.js roles show team-lead
```

shows tool-aware Tango instructions.

## Phase 4 — Parent Pi Prompt Injection

Update:

```txt
packages/tango/extensions/pi/index.ts
```

Add package include loading:

```ts
const includeRoot = join(packageRoot, "includes");
const parentPrompt = [
  readFileSync(join(includeRoot, "orchestration-core.md"), "utf8"),
  readFileSync(join(includeRoot, "orchestration-pi-tools.md"), "utf8"),
  readFileSync(join(includeRoot, "orchestration-cli.md"), "utf8"),
].join("\n\n---\n\n");
```

Inject into parent Pi system prompt:

```ts
pi.on("before_agent_start", async (event) => ({
  systemPrompt: `${event.systemPrompt}\n\n---\n\n${parentPrompt}`,
}));
```

Consider adding a future flag:

```bash
--no-tango-prompt
```

But v1.1 can inject by default.

Acceptance:

Run pi with the local extension and ask what Tango tools are available. The agent should know the canonical tool/CLI policy without relying on `AGENTS.md`.

## Phase 5 — Explicit Tango Extension Loading for Recursive Pi Children

Update Pi harness command construction in:

```txt
packages/tango/src/harnesses/pi.ts
```

Current behavior defaults to:

```bash
--no-extensions
```

v1.1 behavior:

- if role orchestration resolves to tools for Pi:

  ```bash
  --no-extensions -e <packageRoot>/extensions/pi/index.ts
  ```

- if role has explicit `extensions`, include those too;
- avoid ambient extension discovery;
- keep `--no-context-files`, `--no-skills`, `--no-prompt-templates` defaults.

Implementation details:

1. Add helper to resolve Tango extension path.
2. Add role field or computed launch option indicating Tango tools required.
3. Ensure `--no-extensions` remains present.
4. Ensure explicit role extensions still work.

Acceptance:

```bash
node packages/tango/dist/cli.js start dry-lead --role team-lead --dry-run --json "test"
```

The command args should contain:

```txt
--no-extensions
-e .../packages/tango/extensions/pi/index.ts
```

## Phase 6 — Add `tango_cli` Generic Wrapper Tool

Update Pi extension with a generic wrapper.

Schema:

```ts
parameters: Type.Object({
  args: Type.Array(Type.String(), {
    description: "Arguments passed to tango, excluding the tango binary."
  })
})
```

Safety:

- use `spawn(command, args, { shell: false })`;
- block `attach`;
- optionally allow only:

  ```txt
  start, list, look, message, stop, delete, status, result, roles
  ```

- auto-add `--json` for commands where it is safe/useful and absent.

Suggested allowed command handling:

```ts
const allowed = new Set(["start", "list", "look", "message", "stop", "delete", "status", "result", "roles"]);
if (!allowed.has(args[0])) throw new Error(...);
if (args[0] === "attach") throw new Error("Use tango attach manually in a terminal.");
```

Acceptance:

From Pi, the model can use `tango_cli` for a newly added CLI feature before a dedicated tool wrapper exists.

## Phase 7 — Add Missing Dedicated Tools

Currently implemented:

```txt
tango_start
tango_list
tango_look
tango_message
tango_stop
```

Add:

```txt
tango_status
tango_result
```

Optional later:

```txt
tango_delete
```

Each tool must call `runTango([...])` and never call internal orchestration modules.

Acceptance:

Each tool maps to a CLI command and returns parsed JSON details.

## Phase 8 — Custom Tool Renderers

Add custom `renderCall` and `renderResult` for each dedicated tool.

### Shared helpers

Create helpers inside `extensions/pi/index.ts` or split later:

```ts
statusIcon(status): string
statusColor(status): "success" | "warning" | "error" | "muted"
shortPath(path): string
firstLine(text): string
formatAgent(agent): string
```

Use TUI components:

```ts
import { Text, Container, Spacer, Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
```

### `tango_start`

Call:

```txt
tango start <name> as <role>
  <task preview>
```

Result collapsed:

```txt
⏳ Tango started repo-scout
  scout · oneshot/pi · running
```

Expanded:

- name;
- role;
- harness/mode;
- status;
- run dir;
- task;
- next action hint.

### `tango_list`

Collapsed:

```txt
Tango agents: 2 running · 1 done · 0 error
```

Expanded:

One line per agent.

### `tango_look`

Collapsed:

- agent name;
- first non-empty output line;
- truncation hint.

Expanded:

- metadata header;
- output rendered as Markdown when practical;
- fallback Text.

### `tango_message`

Collapsed:

```txt
→ Sent message to lead
```

Expanded:

- agent;
- message.

### `tango_stop`

Collapsed:

```txt
■ Stopped lead
```

Expanded:

- agent;
- run dir;
- final status.

### `tango_status`

Collapsed:

```txt
✓ Status done — summary
```

Expanded:

- agent;
- state;
- message.

### `tango_result`

Collapsed:

- agent;
- first result line.

Expanded:

- result as Markdown.

### `tango_cli`

Collapsed:

```txt
✓ tango list --json
```

Expanded:

- args;
- stdout/stderr;
- parsed JSON if available.

Acceptance:

Tool calls in parent Pi and recursive Pi subagents render as semantic Tango cards instead of plain JSON blobs.

## Phase 9 — Footer Status Updates

Implement opportunistic footer status.

On `session_start`:

```ts
ctx.ui.setStatus("tango", theme.fg("dim", "Tango ready"));
```

After list/start/stop/status tools:

- derive counts from `tango list --json` or current tool details;
- update:

```txt
Tango: 1 running · 2 done
```

Guard with:

```ts
if (ctx.hasUI) { ... }
```

Do not poll continuously in v1.1.

Acceptance:

Parent Pi footer shows a small Tango status after extension load/tool calls.

## Phase 10 — Extension Prompt/Tool Descriptions

Strengthen tool descriptions and prompt snippets/guidelines.

Each dedicated tool should say it wraps a CLI command.

Example:

```ts
description: "Start a Tango child agent. Wraps `tango start ... --json`. Prefer this tool in Pi sessions."
promptSnippet: "Start a named Tango child agent with a role and task."
promptGuidelines: [
  "Use tango_start instead of shelling out to `tango start` when Tango tools are available.",
  "Use tango_look to inspect child output before summarizing child work."
]
```

Avoid duplicating large orchestration instructions in every tool. The canonical prompt injection handles policy.

Acceptance:

`pi.getAllTools()`/system prompt has useful one-line tool descriptions without bloating every tool.

## Phase 11 — Testing

### CLI tests/manual checks

```bash
npm run build
node packages/tango/dist/cli.js roles list
node packages/tango/dist/cli.js roles show team-lead
node packages/tango/dist/cli.js start dry-lead --role team-lead --dry-run --clean --json "test"
```

Verify dry-run args for Pi recursive roles include explicit Tango extension loading.

### Generic harness smoke test

```bash
node packages/tango/dist/cli.js start test-one --harness generic --mode oneshot --clean --json "echo hello"
node packages/tango/dist/cli.js result test-one
node packages/tango/dist/cli.js delete test-one
```

### Extension typecheck

```bash
cd packages/tango
npx tsc --noEmit --ignoreConfig --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck extensions/pi/index.ts
```

### Pi extension smoke test

Direct extension load:

```bash
pi -e /home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts
```

Package install:

```bash
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

Then verify:

- top-level Pi session knows Tango tool policy;
- `tango_start` works;
- `tango_list` renders a compact list;
- `tango_look` renders output;
- recursive Pi `team-lead` dry-run includes Tango extension loading.

## Phase 12 — Cleanup and Docs

Update:

```txt
README.md
packages/tango/README.md
docs/specs/tango-v1/design.md or index note if desired
```

Add note:

```md
Tango v1.1 design lives in `design-v1.1.md`; v1.0 design is retained as historical context.
```

Do not add detailed orchestration instructions to `AGENTS.md`.

## Risks and Mitigations

### Risk: Tool wrappers drift from CLI

Mitigation:

- keep all tools shelling out to CLI;
- add `tango_cli` escape hatch;
- document the invariant;
- avoid importing internal orchestration modules into the extension.

### Risk: Prompt bloat

Mitigation:

- split includes;
- inject only environment-appropriate includes;
- keep tool descriptions concise.

### Risk: Ambient extension leakage in child Pi agents

Mitigation:

- keep `--no-extensions`;
- add only explicit `-e <tango extension>` when orchestration tools are required.

### Risk: `tango_cli` hangs on interactive commands

Mitigation:

- block `attach`;
- use timeouts where appropriate later;
- communicate that attach is human-terminal-only.

### Risk: UI renderers produce too much output

Mitigation:

- compact collapsed renderers;
- use expanded details for large output;
- truncate look/result outputs.

## v1.1 Acceptance Criteria

- `design-v1.1.md` and `plan-v1.1.md` exist.
- Orchestration includes are split and used consistently.
- Parent Pi session receives canonical Tango prompt injection from package includes.
- Recursive Pi child agents receive Tango extension tools explicitly.
- Non-Pi recursive agents continue to receive CLI instructions.
- `tango_cli` exists and wraps the CLI safely.
- Dedicated tools have custom renderers.
- Dedicated tools and `tango_cli` shell out to the CLI and do not implement orchestration logic.
- Existing CLI smoke tests still pass.

# Loom Usage Feedback

Date: 2026-04-26
Context: First live use of custom `loom` framework while coordinating review/integration work for the Quantiiv ROGER/QAS/Lib migration.

## Observed Issues

### 1. `loom` was not available on PATH

- Symptom: `which loom` and `loom --help` produced no usable command from the Quantiiv workspace.
- Workaround applied: created a wrapper at `/home/joe/.local/bin/loom` pointing to `/home/joe/Documents/projects/bravo-pi-mono/packages/loom/dist/src/cli.js`.
- UX note: installation/bootstrap should probably expose a stable `loom` binary automatically, or docs should make the setup command explicit.

### 2. Command help is too generic

- Symptom: `loom init --help` returned the same generic top-level help as `loom --help`.
- Impact: had to inspect `src/cli.ts` directly to discover usable flags like `--title`, `--name`, and `--workspace`.
- Suggestion: add command-specific help for at least `init`, `create`, `reference add`, `note`, `inbox`, `spawn`, and `dispatch`.

### 3. Multi-line YAML arrays created by Loom can break later Loom commands

- Repro path during live use:
  1. Ran `loom create ... --tag review --tag integration`.
  2. Loom wrote frontmatter as:
     ```yaml
     tags:
       - review
       - integration
     ```
  3. Later `loom reference add N-0001 ...` succeeded in updating the file but subsequent `loom note N-0001 ...` failed with:
     ```text
     Cannot read properties of undefined (reading '0')
     ```
- Root suspicion: the current minimal YAML parser/serializer handles arrays of objects in a narrow format and/or does not round-trip scalar arrays safely. The multiline `tags` array appears to poison later serialization.
- Workaround applied: manually changed `tags` to `tags: []`, after which `loom note` worked again.
- Severity: high for real usage, because normal Loom-generated frontmatter can make normal Loom commands fail.

### 4. `reference add` partially succeeded before surfacing an error

- Symptom: `loom reference add N-0001 ... --json` returned an error, but the `references:` block had in fact been added to the node file.
- Impact: confusing/unsafe because command output says failure while state mutates. This makes retries risky.
- Suggestion: commands should either complete successfully or roll back/avoid writing before the failure point. At minimum, error should indicate whether mutation occurred.

### 5. Error messages are too low-level

- Example:
  ```text
  Cannot read properties of undefined (reading '0')
  ```
- Impact: not actionable for an agent/user without reading implementation code.
- Suggestion: wrap parser/serializer exceptions with node ID/path and likely frontmatter field context.

## Positive Notes

- `loom init` worked cleanly once invoked via the node path.
- Registry resolution worked after initialization; `loom current` found the Loom from the Quantiiv working directory.
- Basic `create`, `decompose`, `tree`, and eventually `note` worked and provided useful durable structure quickly.

## Requested Follow-up

Keep appending feedback here as the ROGER/QAS/Lib review coordination proceeds, especially around agent spawning, inbox delivery, review-task ergonomics, and whether Loom helps or hinders integration-review workflow.

### 5. Agents Using Loom Analyze Skill when inappropriate

The Loom Analyze skill description needs to be more upfront
 with what it's actually supposed to be used for.
 It should be very clear that it's only when you are
 analyzing or auditing a Loom itself
 and not when you're doing like a review on a project using
 the Loom framework.
 It's distinctly different.
 There's one you're auditing and reviewing the Loom itself.
 There's another one where you're just using Loom to do
 reviews or audits.
### 6. Loom aliases do not resolve inside Tango agents with isolated HOME

- Symptom/risk: agents were initially instructed to use `loom -L roger-qas-playbook-migration-review ...`, but Tango starts agents with an isolated `HOME`, so Loom's registry alias may not exist for the child.
- Current mitigation: sent follow-up instructions to use cwd discovery or explicit path: `loom -L /home/joe/Documents/Quantiiv ...`. The Loom path is `/home/joe/Documents/Quantiiv/.loom`.
- UX suggestion: Loom/Tango integration should pass `LOOM_HOME`, `LOOM_DEFAULT`, or a stable absolute `-L` path automatically when spawning agents, or `loom init` should make project-local discovery the primary recommended command for agents in subdirectories.

### 7. Architectural smell: only one project-local Loom per workspace root

- Observation: `loom init` creates a single `.loom/` directory at the project root and refuses to initialize if `.loom` already exists. This means `/home/joe/Documents/Quantiiv` can only have one project-local Loom instance discoverable via upward cwd search.
- User feedback: this should not be a permanent architecture constraint. A real project folder should be able to host multiple Looms/workstreams under the same project-local `.loom` path, while the global Loom registry points to individual Loom instances.
- Why this matters: durable workstreams are not equivalent to one repo/project. A large workspace like Quantiiv may need simultaneous independent Looms for reviews, feature designs, incident investigations, release planning, etc. Forcing all unrelated efforts into one graph risks node clutter, weaker boundaries, naming collisions, and confusing agent context.
- Possible direction: make `.loom/` a container/root with multiple named Loom instances beneath it, e.g. `.loom/looms/<loom-id-or-slug>/...`, plus a project-local index/current selection. Keep a default/current Loom for cwd discovery, but allow `loom -L <alias|id|path>` to select among multiple local Looms.
- Related UX need: `loom current`, `loom list`, and `loom init --name ...` should make it clear whether they are creating/selecting a project-local Loom instance or the project-local Loom container.

### 8. No proactive parent notification when Tango agents finish or call `tango status done`

- Symptom: review agents completed and called `tango status done`, but the parent/root session received no proactive notification. Completion was only discovered by manually polling `tango list` across the relevant project cwd registries and then inspecting each agent with `tango look`.
- Impact: this is a significant coordination ergonomics issue. A root coordinator can incorrectly assume work is still running, miss blockers, or fail to synthesize completed work promptly. It also makes multi-agent review workflows feel unreliable unless the coordinator remembers to poll repeatedly.
- Related issue: because agents are partitioned by cwd/project registry, checking status required querying multiple cwd contexts (`ROGER`, `Quantiiv-Agent-Skills`, `Quantiiv-Lib`, and the workspace root) rather than one unified workstream view.
- Expected behavior: when a child agent updates status to `done`, `blocked`, or `error`, the parent/root coordinator should receive an explicit notification/message, or Tango should provide a project/workstream watcher that surfaces state changes automatically.
- Possible directions:
  - Have `tango status done|blocked|error` notify the parent run/agent if `parentRunDir` or parent identity is known.
  - Add a root-level `tango watch` / event stream for all agents in a workstream.
  - Integrate Loom inbox/subscriptions so agent completion writes both durable notes and a delivered parent notification.
  - Provide a cross-cwd/workstream `tango list` view so coordinator agents do not need to remember each repo-specific registry context.
- Severity: high for recursive/lead-agent workflows; polling-only completion discovery is easy to miss and undermines the purpose of delegated orchestration.

### 9. `loom note` ergonomics make shell quoting mistakes too easy

- Incident: while recording a Loom note containing inline backticked commands, the shell evaluated the backticks before `loom note` received the text. This executed fragments such as `import ...` as shell commands, invoked ImageMagick's `import` binary, and appended command-output garbage into the Loom node.
- Mitigation applied: manually repaired the corrupted note in `.loom/nodes/N-0006-...md` because the durable node content was polluted.
- UX concern: `loom note N-0001 "..."` encourages passing long prose through shell quoting, which is fragile for Markdown notes containing backticks, `$`, quotes, or shell snippets.
- Suggested improvements:
  - Support `loom note N-0001 --stdin` / default stdin when no message args are provided.
  - Document a safe heredoc pattern prominently.
  - Consider detecting suspiciously huge command output or shell-help text in notes and warning before write.
  - Provide `loom note edit` or `loom note replace-last` to correct accidental note corruption without manual `.loom` file edits.
- Severity: medium-high for agent workflows because agents often write Markdown with code fences/backticks; a single quoting mistake can corrupt durable context.

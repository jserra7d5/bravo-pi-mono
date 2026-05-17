# Workflow reference — mockup-first, agent-coordinated

This is the working pattern that produced every successful TUI redesign in this repo: async-subagents, footer, bravo-goals tool cards, showcase. Skip it and you'll do the work twice.

## The four-phase loop

```
1. Designer  →  mockup file in /tmp + tmux render
2. User      →  review, push back, confirm decisions
3. Implementer  →  translate mockup to code
4. Reviewer  →  catch deviations, fix code quality, fill test gaps
```

Each phase is a separate Opus agent (when delegating) or your own focused work pass. Boundaries matter — don't let one agent do all four.

## Phase 1 — design via mockup

A mockup is an executable Node script in `/tmp/<surface>-mockup.mjs` that uses raw ANSI escapes to render the proposed design. **It is the spec.** Code agents work from it. User signs off on it. Reviewers verify against it.

### Mockup structure

```
/tmp/<surface>-mockup.mjs           # canonical, signed-off design
/tmp/<surface>-stress.mjs           # edge cases that don't belong in the canonical view
```

Standard sections in the canonical file:

1. **Identity demo** — 4-8 different identities to show the palette spread
2. **Primary states** — every state the surface can be in (running, waiting, completed, failed, etc.)
3. **Edge cases (minimal)** — missing fields, $0 cost, unknown values
4. **BEFORE/AFTER** — current ugly rendering side-by-side with new design. Critical for selling the redesign.
5. **Responsive sweep** — same card at width 120/96/72/56/44 (or whatever your cutoffs are)

Standard sections in the stress file:

- Long content (titles, summaries, paths)
- Narrow extremes (down to 32 cells)
- Multi-line bodies
- Punctuation, quotes, special chars
- Identity collisions (different names hashing to same slot)
- Error cards / failure paths

### Mockup file template

```js
#!/usr/bin/env node
// <surface> tool — TUI redesign mockup
// <one-sentence design intent>

const R = "\x1b[0m";
const c = {
  dim: "\x1b[38;2;120;120;128m",
  text: "\x1b[38;2;220;220;221m",
  warn: "\x1b[38;2;229;181;72m",
  bad: "\x1b[38;2;232;111;111m",
  ok: "\x1b[38;2;126;201;145m",
  chrome: "\x1b[38;2;110;110;120m",
  id: [/* the 8 identity hues */],
  bold: "\x1b[1m",
};

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visWidth = (s) => stripAnsi(s).length;

function identityColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  return c.id[h % c.id.length];
}

// render functions per state/variant ...

// section banners
const banner = (title) => `\n${c.warn}━━ ${title} ━━${R}`;
const sub = (label, width) => `\n${c.dim}${label.padEnd(width, "·")}${R}`;

// SECTION 1 — identity
console.log(banner("IDENTITY"));
// ...
```

The structure mirrors what implementer briefs will reference. Keep it consistent across surfaces so reviewers and implementers don't have to relearn the navigation.

### Rendering in tmux

Use the `tui-showcase` tmux session as the standard fixture. If it doesn't exist:

```bash
tmux new-session -d -s tui-showcase -x 200 -y 50
```

Push the mockup to it:

```bash
tmux send-keys -t tui-showcase 'clear && node /tmp/<surface>-mockup.mjs' Enter
```

**Check the pane width before picking your mockup widths.** Real lesson from this repo — mockups at width 96 overflow on a 94-cell pane (last 2 cells wrap to next line, the user immediately notices, the design review is undermined). Get the pane width:

```bash
tmux display-message -t tui-showcase -p '#{pane_width}'
```

Then render at safely under that — typically pane_width - 4 or 6 cells of headroom.

### What to ask the user during design

Don't burn questions on things the mockup already shows. Use the user's attention for things the mockup CAN'T show:

- **Glyph style choices** when multiple options exist (bar `▰▱` vs `█░` vs `▮▯`) — render them all side-by-side and ask
- **Layout philosophy** — container chrome vs bookend chrome, single line vs two lines, etc.
- **Cost/identity opt-outs** — does it make sense to show $ here? Per-name identity color worth it?
- **Trade-off decisions** — at narrow widths, which info drops first?

Use `AskUserQuestion` with 2-4 mutually exclusive options. Mark recommended with `(Recommended)`.

## Phase 2 — user review

Render in tmux, wait. The user looks. They either:

1. **Approve as-is** — proceed to phase 3
2. **Request changes** — revise the mockup, re-render
3. **Ask design-decision questions** — answer them or fold into a revision

If they ask for changes mid-design (e.g., "use titles not IDs", "no side bars on content"), apply them to the mockup file BEFORE the implementer sees it. Revising a mockup is cheap; reworking implementation is expensive.

**Don't skip user review.** Even with high trust ("I trust you, just do it"), at least render the mockup in tmux so they CAN look if they want. They will, eventually. And they'll catch something.

## Phase 3 — implementation

Spawn an Opus agent with a self-contained brief. Reuse the template below.

### Implementer brief structure

```markdown
You are implementing the <surface> redesign. The user has approved a visual mockup;
your job is to translate it into working <renderCall/renderResult/Component>.

# Context
- Repo: /home/joe/Documents/projects/bravo-pi-mono
- Files to modify: <explicit paths>
- Visual ground truth: /tmp/<surface>-mockup.mjs and /tmp/<surface>-stress.mjs
- Run them with `node` to see what cards should look like.

# Locked design decisions (do NOT deviate)
1. <decision> — why
2. <decision> — why
...

# File scope
- MODIFY: <paths>
- ADD: <paths> (NEW)
- DO NOT TOUCH: <paths> (other agents in flight, or settled, or out of scope)

# Data plumbing
<exactly how each field is sourced — execute() returns, ctx access, etc.>

# House style
<TypeScript strict, no any, no compat shims, factory form Component>

# Validation
1. `npm run check --workspace <name>`
2. `npm test --workspace <name>`
3. Visual: write /tmp/verify-<surface>.mjs that imports your renderers and diffs against the mockup

# Do NOT
- DO NOT commit
- DO NOT use process.stdout.columns
- DO NOT touch files outside scope

# Report format
- Files changed
- Files added
- Tests added (count + what)
- Final test count + pass/fail
- Visual match: yes/no/partial
- Deviations + why
- Open questions for the reviewer
```

### File scope discipline

The most important section in the brief. Implementers WILL touch every file they think is relevant; you must constrain them.

**Conflicts come from:**
- Two agents editing the same file in parallel
- One agent's "fix this related thing" expanding into another's domain
- Cross-package imports causing untracked changes

**Prevention:**
- One agent per file. If two redesigns need to touch the same file, sequence them, don't parallelize.
- Explicit DON'T-TOUCH list with reasoning
- Different packages can run in parallel (they don't share files)

Example from this repo: when the async-subagents Opus implementer was rewriting `extensions/pi/*`, the cost-data-plumbing agent was scoped to `src/types.ts` + `src/lifecycle.ts` + new `src/cost.ts`. Display wiring was deliberately deferred to phase 4 so it didn't conflict.

## Phase 4 — review

A separate Opus agent. Same model, fresh context. Their job is to catch things the implementer missed or rationalized.

### Reviewer brief structure

```markdown
You are the reviewer for the <surface> redesign. The implementer just finished.
Your job: catch deviations from the mockups, fix code quality, fill test gaps.

# Context
- Visual ground truth: /tmp/<surface>-mockup.mjs and /tmp/<surface>-stress.mjs
- Use `git diff <package>/` and `git status` to see actual changes
- DO NOT read the implementer's transcript directly — overflows context

# Priority decisions the implementer flagged (decide them)
<list of open questions from implementer's report, with your decision for each>

# Standard review checklist
1. Mockup faithfulness — render mockup + impl side-by-side, list deltas
2. Code quality — no any, no // removed:, no dead exports, tight comments
3. Test coverage gaps — list cases the mockup exercises that tests don't
4. Pi extension API correctness — renderShell, factory form, no process.stdout.columns
5. Palette harmony — RGB triplets match the canonical set
6. Run validation — npm run check, npm test, visual diff
7. No conflicts with other in-flight work — explicit don't-touch list
8. House style — TypeScript strict, no scope creep

# Authority
- CAN edit any file in <package>/
- CANNOT touch <other packages, node_modules, .pi/extensions/>

# Do NOT
- DO NOT commit
- DO NOT redesign — enforce the existing mockup, don't propose alternatives
- DO NOT add features beyond fixing what's flagged

# Report format
- Files changed
- Decisions made (1, 2, 3 with the choice)
- Mockup deviations found + fixed
- Code quality issues found + fixed
- Tests added
- Final test count + pass/fail
- Remaining concerns / follow-ups
```

### The implementer's open questions

Every implementer brief asks for "open questions or follow-ups for the reviewer". The implementer is closer to the code than you are by the time they're done. Their flagged items are usually the right things to override.

For each one, take a position in the reviewer brief: "Decision X: ACCEPT" / "OVERRIDE: do Y instead". The reviewer has authority to make changes; give them the call.

## Agent coordination — running things in parallel

You can run multiple agents in parallel IF AND ONLY IF their file scopes are disjoint. Examples that worked:

| Agents | Files touched |
|---|---|
| async-subagents UI rewrite | `packages/async-subagents/extensions/pi/*` |
| Footer redesign | `.pi/extensions/codex-usage.ts` |
| Cost data plumbing | `packages/async-subagents/src/{types,lifecycle,cost}.ts` |
| Bravo-goals tool cards | `packages/bravo-goals/extensions/pi/*` |
| Showcase redesign | `packages/showcase/extensions/pi/*` |

All five could run simultaneously — no file overlap.

Examples that would conflict:

- Async-subagents impl + cost display wiring at the same time (both want `extensions/pi/liveWidget.ts`)
- Two implementers on the same package
- Implementer + reviewer for the same surface (reviewer needs the impl done)

If you spawn N agents in one message, you get N notifications when they finish. Don't poll output files — wait for the notifications.

## Sending in-flight changes

If the user gives feedback while an implementer is running, you have two options:

1. **Send a message to the agent** — `SendMessage(to: agentId, message: ...)`. The agent picks it up at its next tool round, folds into the same pass. Use when the change is small or scope-related ("also do X", "don't do Y after all").

2. **Wait, then have the reviewer handle it** — add the item to the reviewer brief checklist. Use when the change is mechanically distinct ("apply renderShell: self to all 7 tools") — the reviewer is already going to be in those files.

Don't try to redirect mid-implementation if it requires the agent to redo significant work. Cheaper to let it finish and have the reviewer adjust.

## Final cleanup

After all phases for all surfaces are done:

1. Triage every untracked file: commit or `.gitignore` each one
2. Commit per-package — one commit per redesign, descriptive messages
3. Final `git status` shows zero unstaged + zero untracked

User confirmation that there are no OTHER agents running concurrently is your green light to do the cleanup. Otherwise you risk stomping their work.

## Anti-patterns

- **Designing in code.** Always mockup first. Don't write the implementation and ask the user to react to the code — they can't read it as fast as the rendered output.
- **Skipping the stress file.** "It looks good at width 80" doesn't mean it works at 32. The stress file catches it before the user does.
- **One agent for everything.** Designer-implementer-reviewer in one agent loses the fresh-eyes pass. Use separate agents.
- **Polling agent output files.** The system tells you when an agent completes. Don't shell-read its output — you'll overflow your context.
- **Optimistic file scope.** "Probably doesn't touch X" is not the same as "won't touch X". Spell it out in the brief.
- **Committing piecemeal during the loop.** Wait until all surfaces are done. Mid-loop commits invite "I'm going to fix this small thing while I'm here" creep.

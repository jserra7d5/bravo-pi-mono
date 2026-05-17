# Pi extension API reference

The pi-coding-agent CLI exposes specific APIs for adding UI surfaces. This is what those APIs do, the patterns for using them correctly, and the gotchas that have already cost real debugging time.

## What pi gives extensions

Pi loads extensions from `.pi/extensions/*.ts` and `packages/*/extensions/pi/*.ts`. Each extension is a default-exported function that receives `pi: ExtensionAPI`. Through `pi.ui.*` you get:

| Method | Adds | Lifetime |
|---|---|---|
| `pi.ui.setStatus(key, text)` | One line in the footer status section | Until cleared |
| `pi.ui.setWidget(key, content, options)` | Multi-line block above/below editor | Until cleared |
| `pi.ui.setFooter(factory)` | REPLACES the entire pi footer | Until cleared |
| `pi.registerTool(definition)` | A tool the LLM can call, with custom rendering | Lifetime of extension |
| `pi.registerMessageRenderer(...)` | Custom rendering for specific message types | Lifetime of extension |

Pi tells you what to do via events:

```ts
pi.on("session_start", async (event, ctx) => { /* setup */ });
pi.on("model_select", async (event, ctx) => { /* model changed */ });
pi.on("turn_end", async (event, ctx) => { /* user turn done */ });
pi.on("agent_end", async (event, ctx) => { /* agent turn done */ });
pi.on("session_shutdown", async (event, ctx) => { /* cleanup */ });
```

`ctx` carries the live session state. **Capture it** in your event handler closures so factories can read it on every render.

## Surface selection: status vs widget vs footer

Decision tree:

- **Need to take over pi's standard footer?** → `setFooter`
- **Need multi-line, possibly rich content?** → `setWidget`
- **One-line summary in the existing footer?** → `setStatus`

**Don't double-display.** If your data shows up in both a widget AND a status segment, delete the status segment. Real user feedback from this repo: "I don't need that since we have the main status thing now." Pick one surface and own it.

## Tool rendering — `renderShell`, `renderCall`, `renderResult`

Every `defineTool({...})` for a tool that should render visually needs three things:

### 1. `renderShell: "self"`

```ts
defineTool({
  name: "my_tool",
  renderShell: "self",   // <-- without this, your card sits in a green box
  // ...
});
```

**Why:** pi's default `renderShell: "default"` wraps every tool call in a `Box` with one of three background colors:
- `toolPendingBg` (`#282832` dark / `#e8e8f0` light) while running
- `toolSuccessBg` (`#283228` dark / `#e8f0e8` light) on success — this is the GREEN
- `toolErrorBg` (`#3c2828` dark / `#f0e8e8` light) on failure

Your rounded chrome inside that box looks awful (you're a card inside a colored rectangle). `renderShell: "self"` swaps the `Box` for a plain `Container` — your card floats clean on the chat background.

**Gotcha:** if you add 7 tools and only 6 have `renderShell: "self"`, the 7th looks wrong. Add a test that asserts every tool has it (see `packages/async-subagents/test/piTools.test.ts` for the pattern).

### 2. `renderCall` — Component factory for the invocation

```ts
renderCall: (args, theme, context) => ({
  invalidate() {},
  dispose() {},
  render(width) {
    return renderMyCallCard({ width, args });
  },
}),
```

`renderCall` runs the moment the LLM invokes the tool, before `execute()` returns. You have `args` (the LLM's input) but no result yet. Render a "starting / handing off" card.

### 3. `renderResult` — Component factory for the completed call

```ts
renderResult: (result, options, theme, context) => ({
  invalidate() {},
  dispose() {},
  render(width) {
    if (result.isError) return renderFailureCard({ width, error: result });
    return renderResultCard({ width, details: result.details });
  },
}),
```

`renderResult` runs once `execute()` returns. You have `result.details` (the structured output you returned from execute) and `result.isError`. Always handle both success and error paths.

**Pattern: thread display data through `details`.** Don't do file IO inside `renderResult` — instead, have `execute()` resolve the data and put it on `details`. Example:

```ts
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const goal = await readGoalState(...);
  return {
    content: [{ type: "text", text: "Done" }],
    details: {
      ...params,
      title: goal.title,       // <-- resolved here so renderResult doesn't need to
      verdict: "pass",
    },
  };
}
```

Then `renderResult` reads `details.title` without touching disk.

For `renderCall` where you only have `args` and need a related field (e.g., a goal title from a goal_id arg), you have two options:
1. Synchronous fallback — read the data with sync helpers, fall back to showing `args.goal_id` on any failure
2. Show only `args.goal_id` — the result card will fill in the title when it arrives

Pick #1 only if the sync read is genuinely cheap (1-2 small file reads, well-bounded). Otherwise #2.

## Widget rendering — the factory form is non-negotiable

`pi.ui.setWidget(key, content, options)` has two overloads:

```ts
// Overload 1: string array
setWidget(key: string, content: string[], options?: ExtensionWidgetOptions): void;

// Overload 2: Component factory
setWidget(key: string, factory: (tui, theme) => Component & { dispose? }, options?: ExtensionWidgetOptions): void;
```

**Use overload 2.** Always. The string-array overload wraps each line in `Text(line, 1, 0)` at the line's intrinsic width — and that width is whatever you computed at registration time, NOT what pi has available at render time.

**The trap:** if you compute width from `process.stdout.columns`, you get the terminal's full width. Pi renders widgets in a container inside the editor area, which is narrower (margins, padding, possibly side panels). Your rows overflow pi's container by 2-3 cells, and each row's last cell wraps onto its own line. The chrome looks broken at every terminal width except the one you tested at.

The Component factory form gives you a `render(width)` method. Pi calls it with the ACTUAL container width on every redraw. Trust it.

```ts
ui.setWidget("my-widget",
  (tui, theme) => ({
    invalidate() {},
    dispose() {},
    render(width) {
      // recompute snapshot (or read from a closed-over cache)
      // use `width` directly — no clamping to process.stdout.columns
      return renderMyCard({ width, data });
    },
  }),
  { placement: "belowEditor" },
);
```

A safe `[min, max]` clamp inside the factory (e.g., `Math.max(28, Math.min(160, width))`) is fine — it's a floor for chrome integrity and a ceiling for over-rendering, NOT a substitute for trusting pi's width.

**Re-rendering:** pi calls `render` on its own redraw schedule (after key events, resize, etc.). If your data changes between redraws, call `invalidate()` if pi's Component supports it; otherwise just wait for the next frame.

## Footer replacement — `setFooter`

```ts
ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  dispose() {},
  render(width) {
    return renderMyFooter({ width, /* data from closed-over ctx */ });
  },
}));
```

The factory gets `(tui, theme, footerData)` — NOT `ctx`. Capture `ctx` in your `session_start` / `model_select` / `turn_end` / `agent_end` handler closures and let the factory close over it:

```ts
let currentCtx;
pi.on("session_start", async (_event, ctx) => {
  currentCtx = ctx;
  ui.setFooter((tui, theme, footerData) => ({
    render(width) {
      const ctx = currentCtx;   // live read
      const usage = ctx.getContextUsage();
      const cost = sumCost(ctx.sessionManager);
      // ...
    },
  }));
});
```

Data you can pull:
- `ctx.cwd` — working directory
- `ctx.model` — current model
- `ctx.sessionManager` — session entries for token/cost stats (walk entries; sum `entry.message.usage.cost.total` for assistant messages)
- `ctx.getContextUsage()` — `{ tokens, contextWindow, percent }`
- `ctx.modelRegistry.isUsingOAuth(model)` — subscription check
- `footerData.getGitBranch()` — current branch
- `footerData.getAvailableProviderCount()` — for the `(provider) model` formatting
- `footerData.getExtensionStatuses()` — other extensions' `setStatus` segments
- `footerData.onBranchChange(cb)` — subscribe to branch changes

Reference: `.pi/extensions/codex-usage.ts` is the working example. It takes over the whole footer and renders ctx bar + cost + codex rate-limit windows + provider/model/thinking with identity color.

## Component lifecycle

```ts
interface Component {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}
```

- `render(width)` — return an array of strings, one per row. Each string can contain ANSI escapes. Pi joins them with `\n` and displays.
- `invalidate()` — call to signal the component should re-render. Useful when external data changes.
- `dispose()` — pi calls when the widget/footer is being torn down. Unsubscribe listeners, clear timers.

## Theme tokens you'll encounter

Pi exposes its own theme, accessible via `theme.fg(name, text)` and `theme.bg(name, text)`. You don't usually need it — your extension brings its own palette via ANSI escapes. But know these exist so you can recognize them in pi core code:

- `dim`, `muted`, `accent`, `error`, `warning`, `success`
- `toolPendingBg`, `toolSuccessBg`, `toolErrorBg` (the green-box culprits)
- `toolTitle`, `toolOutput`
- `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`

If you're rendering inside a `renderShell: "self"` container, you control all colors. Use your own palette (the one in `references/design-language.md`).

## Event triggers — when to re-render

Subscribe to these and call your factory's `invalidate()` (or trigger pi's redraw mechanism):

| Event | When | Why re-render |
|---|---|---|
| `session_start` | Pi session starts | Initial state |
| `model_select` | User picks a different model | Identity color for model changes |
| `thinking_level_select` | User changes reasoning level | Footer's thinking indicator |
| `turn_end` | User's turn finishes | Context/cost stats updated |
| `agent_end` | Agent's turn finishes | Same |
| `session_shutdown` | Pi exiting | Dispose timers, unsubscribe |
| `footerData.onBranchChange` | Git branch changed | Footer branch display |

Don't subscribe to ones you don't need — every event subscription is overhead and a possible stale-data race.

## Common gotchas — checklist before shipping

A pre-flight checklist. If any of these is "no", fix before requesting review.

- [ ] `renderShell: "self"` on every tool definition that renders cards
- [ ] `setWidget` uses the factory form (returns a Component), NOT a string array
- [ ] No `process.stdout.columns` anywhere — width comes from `render(width)` parameter
- [ ] If clamping width, it's a `[floor, ceiling]` for safety, not the source of truth
- [ ] `dispose()` clears timers, unsubscribes listeners
- [ ] `renderResult` handles both success path AND `result.isError` path
- [ ] No `any` in component signatures except where interfacing untyped pi internals
- [ ] No double-display — if a widget surfaces the data, the status line is gone
- [ ] Identity palette RGBs match the canonical set in `packages/async-subagents/extensions/pi/renderers.ts`
- [ ] State glyphs match the canonical table in `references/design-language.md`
- [ ] Tests cover: identity color stability, threshold boundaries, layout cutoffs, chrome holding declared width
- [ ] Visual verification: mockup file at `/tmp/<surface>-mockup.mjs` matches actual rendered output

## Things pi DOES NOT support (no point trying)

- Mouse input
- Hyperlinks (OSC 8) — terminals support them but pi doesn't currently surface a clean API
- Sixel/Kitty image protocols
- Sub-cell positioning
- Direct buffer manipulation (you can only return string[] from render)
- Async rendering — `render(width)` must be sync

If you need any of these, propose a pi core change first; don't try to hack it in an extension.

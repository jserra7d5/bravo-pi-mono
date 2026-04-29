# Tango Claude Code Channel Integration

Status: parked / future work  
Date: 2026-04-29  
Scope: async Tango notifications for Claude Code sessions that use raw Tango CLI, without relying on Pi extensions.

## Context

Pi sessions can receive async Tango wake-ups through the Tango Pi extension: the extension polls inbox/board state and injects custom `tango-message` UI messages.

Plain Claude Code sessions using raw `tango` CLI do not currently have equivalent async ingress. If Claude Code runs:

```bash
tango start arch-review --role reviewer "review this"
```

and does not explicitly wait/follow/poll, it will not automatically receive a result/blocked/error notification in its conversation context.

## Tmux injection smoke test result

A Claude Code session running inside tmux tested whether a background shell process can inject a visible message back into the current pane.

Detected tmux identity:

- socket: `/tmp/tmux-1000/default`
- session: `claude-testing` / `$65`
- pane: `%65`

### What worked visually

Both approaches could make text visible in the Claude Code pane/input prompt:

| Method | Result |
| --- | --- |
| `load-buffer` from file + `paste-buffer` | Worked; message visible in input buffer |
| `send-keys -- "$MSG"` | Worked; message visible in input buffer |
| `set-buffer -b name` with leading `---` | Failed; tmux 3.4 parsed leading `---` as flags |
| `send-keys "$MSG"` without `--` | Failed for same leading-dash parsing reason |

For messages starting with `---BEGIN TANGO MESSAGE---`, delivery must avoid option parsing pitfalls, e.g. use `send-keys --` or load from a file.

### What did not work semantically

The injected message landed as an unsubmitted draft in the Claude Code input field. Claude did not receive it as a user/system message or conversation event.

It would require pressing Enter, or having the notifier send Enter, to submit the message.

### Risks

- Sending Enter would silently submit text as a user prompt/instruction. This is too risky as a default.
- Injection can corrupt or append to a user's partially typed input.
- Any same-UID process with access to the tmux socket can inject into panes.
- Visual-only tmux delivery is useful for humans, but not sufficient for reliable agent context ingestion.

## Conclusion from tmux test

`--tmux-current` is viable only as a fallback/human notification mechanism:

- `tmux display-message`
- paste without Enter
- write-to-file notification

It should not be the primary Claude Code async integration path, and it should not auto-submit by default.

## Claude Code Channels research finding

A delegated research agent reported that Claude Code has a mechanism called **Channels**:

- Channels are MCP servers declaring the `claude/channel` capability.
- They can push messages into an active Claude Code session as system-level `<channel>` tags.
- External events can trigger the MCP server: file watchers, webhooks, alerts, inbox polling, etc.
- Claude Code can receive these as real conversation context and react.
- The feature reportedly requires a `--channels` flag and may be research-preview.

This needs source-level verification before implementation, but it appears to be the correct native integration surface.

## Preferred future design

Build a small Tango Claude Code Channel MCP server.

Possible package location:

```text
packages/tango/integrations/claude-channel/
```

or inside Tango package:

```text
packages/tango/src/integrations/claude-channel.ts
```

### Runtime shape

```text
Claude Code --channels
  -> starts Tango channel MCP server
      -> watches Tango inbox/board/events
      -> emits notifications/claude/channel
      -> Claude receives channel messages in conversation context
```

### Channel payload examples

For result ready:

```text
Tango result ready
Agent: arch-review
Inbox: in_...
Run: run_...
Next: tango result --inbox in_...
```

For blocked:

```text
Tango agent blocked
Agent: implementation-worker
Inbox: in_...
Needs: input
Next: tango activity --run-id run_...
```

For error:

```text
Tango agent error
Agent: smoke-test
Inbox: in_...
Summary: test failed
Next: tango activity --run-id run_...
```

Structured tags may be better if Claude handles them predictably:

```xml
<channel name="tango">
Type: result
Agent: arch-review
Inbox: in_...
Run: run_...
Next: tango result --inbox in_...
</channel>
```

## Scope and filtering

The channel server should not dump all global Tango activity into Claude.

Default scope should be one of:

1. Runs started from the Claude Code session after the channel server starts.
2. Current cwd + root/workstream identity if configured.
3. Explicit watched runs or parent/child scopes.

Possible commands/config:

```bash
tango channel claude --scope local
tango channel claude --scope workstream
tango channel claude --watch-run run_...
tango channel claude --children-of run_...
```

If the channel server is launched by Claude Code as an MCP server, it can also persist a session-local watch set.

## Relationship to raw CLI and Pi integration

Use the native mechanism for each harness:

| Harness | Preferred async path |
| --- | --- |
| Pi | Tango Pi extension: tools, live widget, custom messages |
| Claude Code | Claude Code Channel MCP server |
| Generic tmux shell | `tango notify --tmux-current --delivery display|paste` fallback |
| Plain shell/CI | `tango wait`, `tango result --unread`, JSON polling |

Raw CLI still needs good semantics (`tango wait`, `tango result --unread`), but Claude Code async notifications should not depend on tmux text injection.

## Open questions

1. Where are the official Claude Code Channels docs/examples?
2. Is `notifications/claude/channel` stable enough to build against?
3. What exact MCP schema declares `claude/channel` capability?
4. Can channels include structured metadata/actions, or only text?
5. Can channel messages trigger autonomous continuation reliably, or do they only become context for the next user turn?
6. How should authentication/scoping work if multiple Claude Code sessions use the same `TANGO_HOME`?
7. Should the channel server watch `inbox.jsonl`, server SSE, `tango inbox --json`, or event logs?

## Parked implementation sketch

1. Verify Claude Code Channels API with official docs/examples.
2. Create minimal MCP channel server that emits a test channel message.
3. Add Tango inbox polling to the server.
4. Add session-local watch set and dedupe handled/dismissed inbox items.
5. Add install/run docs for Claude Code.
6. Validate with:
   - one-shot result agent;
   - interactive blocked agent;
   - handled/dismissed suppression;
   - unrelated Tango session not leaking.

## Current decision

Table this integration for later. Do not implement now. Focus current work on:

- raw CLI cleanup (`tango result`, `tango wait`);
- Pi live TUI widget/tools;
- board/inbox/tree projection semantics.

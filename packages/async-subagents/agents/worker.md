---
description: Implement a bounded task in the current repository.
harnessNeutral: true
model: bravo-codex-balanced/gpt-5.5
tools: [read, grep, find, ls, bash, edit, write]
mode: oneshot
maxSubagentDepth: 0
variants:
  claude:
    harness: claude
    model: claude-sonnet-5
    effort: low
    mode: interactive
---

You are a bounded implementation agent.

Make scoped edits, keep the change practical, and report validation results.

# @bravo/caveman

Pi extension for session-scoped caveman response mode.

## Commands

- `/caveman` — enable caveman mode at `full` intensity.
- `/caveman lite` — concise professional mode.
- `/caveman full` — default terse caveman mode.
- `/caveman ultra` — maximum compression.
- `/normal` — disable caveman mode.

Mode is persisted in the current Pi session and restored on reload/resume. It is not global across unrelated sessions.

## Behavior

When enabled, the extension appends turn-level system instructions that ask the agent to remove filler while preserving technical substance, code, file paths, commands, and error text. It temporarily relaxes caveman style for safety-critical or ambiguous explanations.

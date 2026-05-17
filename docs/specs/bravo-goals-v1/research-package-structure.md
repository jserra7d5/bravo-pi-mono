# Package Structure Research

Status: draft  
Date: 2026-05-17  
Scope: How to add Bravo Goals as a new package in this monorepo.

## Recommendation

Create a new workspace package:

```txt
packages/bravo-goals/
```

Package name:

```json
"name": "@bravo/goals"
```

Use a CLI-first core with a Pi extension wrapper. The package should be a real built/tested TypeScript workspace package, not an extension-only folder.

## Evidence From Existing Packages

### Async Subagents

Best package skeleton reference:

- `bin`
- `build`, `check`, `test`
- `pi.extensions`
- `tsconfig` covering `src`, `extensions`, and `test`
- Pi extension under `extensions/pi`

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/package.json:8`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/package.json:12`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/package.json:14`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/package.json:27`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/tsconfig.json:14`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/extensions/pi/index.ts:111`

### Tango

Useful if Bravo Goals later ships prompt/skill resources, but too large to copy wholesale.

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/package.json:10`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/package.json:38`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/tsconfig.json:14`

### Monitor

Good reference for a thin extension/runtime split.

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/monitor/package.json:24`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/monitor/src/extension.ts:32`

### Caveman

Good reference for tiny session state and command behavior, but too minimal for Bravo Goals.

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/caveman/package.json:10`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/caveman/package.json:21`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/caveman/extensions/pi/index.ts:69`

## Recommended Initial Layout

```txt
packages/bravo-goals/
  package.json
  tsconfig.json
  README.md

  src/
    index.ts
    cli.ts
    workspace.ts
    state.ts
    checker.ts
    runtime.ts
    receipts.ts
    judge-runner.ts
    phase-boundary.ts

  extensions/
    pi/
      index.ts
      commands.ts
      hud.ts
      renderers.ts
      judge-control.ts

  docs/
    templates/
      goal.md
      context.md
      state.yaml
      resume.md
      receipt-worker.md
      receipt-judge.md
      archive.md

  test/
    workspace.test.ts
    state.test.ts
    checker.test.ts
    receipts.test.ts
    phase-boundary.test.ts
    judge-runner.test.ts
    extension.test.ts
    cli.test.ts
```

## Package Scripts

Recommended `package.json` scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test dist/test/*.test.js"
  },
  "bin": {
    "bravo-goals": "./dist/src/cli.js"
  },
  "pi": {
    "extensions": ["./extensions/pi"]
  }
}
```

## Validation Commands

Package-local:

```txt
npm run check --workspace @bravo/goals
npm run build --workspace @bravo/goals
npm test --workspace @bravo/goals
```

Repo-level:

```txt
npm run check
npm run build
```

Manual Pi smoke:

```txt
pi -e packages/bravo-goals/extensions/pi/index.ts
```

## Packaging Decisions

Recommended v1 boundary:

- Core file/state/receipt/checker logic in `src/`.
- Process runner and Judge run contracts in `src/judge-runner.ts`.
- Pi commands and HUD in `extensions/pi/`.
- Templates in `docs/templates/`.

Avoid:

- copying Tango dashboard or role system;
- copying async-subagents as the Judge abstraction;
- shipping an extension-only package without tests;
- making prompt workflows a separate system before CLI/state contracts stabilize.


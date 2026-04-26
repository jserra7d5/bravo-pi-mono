# Tango Home Isolation and Tooling Home Plan

Date: 2026-04-26

## Implementation steps

1. Add common env contract to isolated harnesses:
   - `TANGO_REAL_HOME=<parent HOME>`
   - `TANGO_AGENT_HOME=<runDir>/home`
   - keep `HOME=<runDir>/home` for isolated runtime state.

2. Claude Code harness:
   - create `<runDir>/bin/tango-bash` wrapper;
   - prepend `<runDir>/bin` to `PATH`;
   - set `CLAUDE_CODE_SHELL_PREFIX=<runDir>/bin/tango-bash`;
   - wrapper exports `HOME=$TANGO_REAL_HOME` before execing real bash.

3. Pi harness:
   - add a small Pi extension loaded when the role enables `bash`;
   - extension registers a replacement bash tool from `createBashTool()`;
   - use `spawnHook` to set subprocess `HOME=$TANGO_REAL_HOME`;
   - keep `PI_CODING_AGENT_DIR` isolated under the run-local home.

4. Preserve generic harness inherited-home behavior.

5. Validate:
   - dry-run env includes `TANGO_REAL_HOME` and isolated `HOME`;
   - Claude wrapper exists and is executable;
   - Pi bash tool-home extension is included when `tools` contains `bash`;
   - `npm run check --workspace @bravo/tango`;
   - `npm run build --workspace @bravo/tango`.

## Manual smoke checks

For a Pi agent with bash:

```bash
printf 'echo $HOME; git config --global user.email; gh auth status' | agent bash tool
```

For a Claude agent:

```text
Use Bash to run: echo $HOME && git config --global user.email && gh auth status
```

Expected: Bash/tool commands report the real user home while command metadata still shows isolated process `HOME`.

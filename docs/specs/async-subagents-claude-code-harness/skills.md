# Harness-Aware Skills

Skills are logical capabilities resolved before launch for the selected harness. Claude Code 2.1.197 accepts run-local `.claude/skills/<name>/SKILL.md`, so Pi-style skill directories are usable as Claude skills when copied into Claude's skill directory.

## Skill package layout

A skill package may contain harness-specific entries:

```text
skills/<name>/
  skill.json              # optional metadata
  SKILL.md                # Pi-style and Claude-compatible entrypoint in v1
  pi/SKILL.md             # optional Pi-native override
  claude/SKILL.md         # optional Claude-native override
  claude/**               # optional extra files copied into Claude skill directory
```

Example `skill.json`:

```json
{
  "schemaVersion": 1,
  "name": "repo-navigation",
  "harnesses": ["pi", "claude"],
  "portableEntrypoint": false,
  "claude": {
    "entrypoint": "claude/SKILL.md"
  },
  "pi": {
    "entrypoint": "pi/SKILL.md"
  }
}
```

## Resolution rules

`skills: ["name"]` means a logical capability. `subagent_start.skills` rejects path-like values.

### Claude resolution order

1. approved explicit/user path only when path capability policy already allows it;
2. `~/.async-subagents/skills/<name>/claude/`;
3. `~/.async-subagents/skills/<name>/` when it contains `SKILL.md`;
4. `packages/async-subagents/skills/<name>/claude/`;
5. `packages/async-subagents/skills/<name>/` when it contains `SKILL.md`;
6. Pi skill roots discovered through existing Pi skill resolution (`.agents/skills/<name>`, `.pi/skills/<name>`, package skill entries) when they are directories containing `SKILL.md`;
7. otherwise fail before spawn with `SKILL_NOT_FOUND`.

### Pi resolution order

1. `skills/<name>/pi/SKILL.md` if present;
2. existing Pi skill resolution behavior;
3. fail clearly when missing.

## Compatibility posture

V1 treats directory skills containing `SKILL.md` as Claude-compatible because Claude Code hand-tests confirmed that shape works through `/skill-name`. No format conversion is needed: copy the directory to `<runDir>/home/.claude/skills/<name>/`.

Still fail closed for:

- path-like skill values passed through `subagent_start.skills`;
- files that are not skill directories;
- symlinks escaping approved roots;
- executable helpers or extra files that violate package policy;
- name collisions or ambiguous roots not resolved by precedence.

Record source/provenance so reviewers can tell whether a skill came from a Claude-native `claude/` dir or a Pi-style `SKILL.md` dir.

## Claude installation

Resolved Claude skills are copied into:

```text
<runDir>/home/.claude/skills/<skill-name>/
```

Installation rules:

- copy all needed files under the resolved Claude skill directory;
- preserve relative structure;
- reject symlinks that escape approved roots;
- reject path traversal and name collision;
- clean stale target directory before copy;
- enforce size/file-count limits with clear errors;
- launch fails if any requested skill cannot be installed.

The child must see only requested/resolved skills in run-local `.claude/skills`. Ambient operator `.claude/skills` are not copied and are not visible through `HOME` or shell-home.

## Skill observability

Record resolved skill metadata in `status.json`, `result.json` when relevant, and `logs/launch.json`:

```json
{
  "resolvedSkills": [
    {
      "name": "repo-navigation",
      "requestedBy": "variant",
      "harness": "claude",
      "source": "user",
      "sourcePath": "/home/joe/.async-subagents/skills/repo-navigation/claude",
      "targetPath": "<runDir>/home/.claude/skills/repo-navigation",
      "compatibility": "claude-native",
      "fallback": "none"
    }
  ],
  "skillResolutionWarnings": []
}
```

Normal successful launches should have no warnings. Non-empty warnings are visible in launch logs and tool result details.

## Required skill tests

- Claude-native and Pi-style `SKILL.md` skill dirs install into run-local `.claude/skills`.
- File-only skills requested by Claude fail pre-spawn.
- Directory skills without `SKILL.md` fail.
- Duplicate skill roots follow documented precedence and record selected source.
- Symlink/path traversal is rejected.
- Ambient operator `.claude/skills/<sentinel>` is not visible to fake/live Claude.
- Fake Claude proves skill loading by reading the copied skill from `$HOME/.claude/skills`, not by hardcoded sentinel output.

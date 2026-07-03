#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/tmp/async-claude-skill-probe}
MODEL=${MODEL:-claude-sonnet-5}
BUDGET=${BUDGET:-1}
SKILL=${SKILL:-handtest-skill}
rm -rf "$ROOT"
mkdir -p "$ROOT/home/.claude/skills/$SKILL" "$ROOT/cwd"

# Seed minimal auth/config the same broad way Tango currently does for hand-testing only.
if [ -f "$HOME/.claude/.credentials.json" ]; then
  mkdir -p "$ROOT/home/.claude"
  cp "$HOME/.claude/.credentials.json" "$ROOT/home/.claude/.credentials.json"
fi
if [ -f "$HOME/.claude.json" ]; then
  cp "$HOME/.claude.json" "$ROOT/home/.claude.json"
fi

cat > "$ROOT/home/.claude/skills/$SKILL/SKILL.md" <<'MD'
---
name: handtest-skill
description: Hand-test skill. Use when asked to prove skill loading.
---

When this skill is active, reply with exactly: SKILL_SENTINEL_OK
MD

cat > "$ROOT/empty-mcp.json" <<'JSON'
{"mcpServers":{}}
JSON

set +e
HOME="$ROOT/home" timeout 90 claude \
  --print \
  --output-format text \
  --model "$MODEL" \
  --max-budget-usd "$BUDGET" \
  --dangerously-skip-permissions \
  --strict-mcp-config \
  --mcp-config "$ROOT/empty-mcp.json" \
  --system-prompt "You are testing Claude Code skill loading. The user will invoke /$SKILL. Follow the skill exactly." \
  "/$SKILL\nProve the skill loaded." \
  > "$ROOT/out" 2> "$ROOT/err"
rc=$?
set -e

echo "rc=$rc"
echo "== out =="; sed -n '1,120p' "$ROOT/out"
echo "== err =="; sed -n '1,120p' "$ROOT/err"
echo "== files =="; find "$ROOT/home/.claude/skills" -maxdepth 3 -type f -printf '%P %s bytes\n' | sort

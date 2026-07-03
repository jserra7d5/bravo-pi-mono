#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/tmp/async-claude-mcp-handtest}
MODEL=${MODEL:-claude-sonnet-5}
BUDGET=${BUDGET:-1}
MODE=${MODE:-line}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVER="$SCRIPT_DIR/mcp-handtest-server.mjs"

rm -rf "$ROOT"
mkdir -p "$ROOT"

cat > "$ROOT/mcp-file.json" <<JSON
{"mcpServers":{"handtest":{"command":"node","args":["$SERVER"],"env":{"MCP_HANDTEST_LOG":"$ROOT/server-file.log","MCP_SEND_MODE":"$MODE"}}}}
JSON
INLINE=$(node -e "console.log(JSON.stringify({mcpServers:{handtest:{command:'node',args:['$SERVER'],env:{MCP_HANDTEST_LOG:'$ROOT/server-inline.log',MCP_SEND_MODE:'$MODE'}}}}))")

run_case() {
  local name=$1
  local config=$2
  echo "== $name =="
  set +e
  timeout 120 claude \
    --print \
    --output-format text \
    --model "$MODEL" \
    --max-budget-usd "$BUDGET" \
    --dangerously-skip-permissions \
    --strict-mcp-config \
    --mcp-config "$config" \
    --system-prompt 'You are testing MCP. Call the tool mcp__handtest__sentinel exactly once. Reply exactly with the tool result text.' \
    'Call mcp__handtest__sentinel now.' \
    > "$ROOT/$name.out" 2> "$ROOT/$name.err"
  local rc=$?
  set -e
  echo "rc=$rc"
  echo "-- out --"; sed -n '1,120p' "$ROOT/$name.out" || true
  echo "-- err --"; sed -n '1,120p' "$ROOT/$name.err" || true
}

run_case file "$ROOT/mcp-file.json"
run_case inline "$INLINE"

echo "== artifacts =="
find "$ROOT" -maxdepth 1 -type f -printf '%f %s bytes\n' | sort
for f in "$ROOT"/server-*.log; do
  [ -f "$f" ] || continue
  echo "== $(basename "$f") =="
  sed -n '1,260p' "$f"
done

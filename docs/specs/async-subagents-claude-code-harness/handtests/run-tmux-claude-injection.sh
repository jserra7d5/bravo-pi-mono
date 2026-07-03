#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/tmp/async-claude-tmux-injection}
MODEL=${MODEL:-claude-sonnet-5}
SESSION=${SESSION:-claude-injection-probe}
SOCKET=${SOCKET:-$ROOT/tmux.sock}
rm -rf "$ROOT"
mkdir -p "$ROOT"
cat > "$ROOT/empty-mcp.json" <<'JSON'
{"mcpServers":{}}
JSON

tmux -S "$SOCKET" new-session -d -s "$SESSION" \
  "cd '$PWD' && claude --no-chrome --model '$MODEL' --dangerously-skip-permissions --strict-mcp-config --mcp-config '$ROOT/empty-mcp.json'"
tmux -S "$SOCKET" pipe-pane -o -t "$SESSION" "cat >> '$ROOT/transcript.log'" || true
sleep 4

echo "== initial pane =="
tmux -S "$SOCKET" capture-pane -p -t "$SESSION" -S -120 | tee "$ROOT/initial-pane.log" || true

send_tango_style() {
  local msg=$1
  local b="probe-$(date +%s)-$RANDOM"
  tmux -S "$SOCKET" load-buffer -b "$b" - <<< "$msg"
  tmux -S "$SOCKET" paste-buffer -b "$b" -t "$SESSION"
  tmux -S "$SOCKET" delete-buffer -b "$b" || true
  sleep 0.15
  tmux -S "$SOCKET" send-keys -t "$SESSION" C-m
}

send_bracketed_style() {
  local msg=$1
  tmux -S "$SOCKET" send-keys -t "$SESSION" Escape '[200~'
  tmux -S "$SOCKET" load-buffer -b bracketed - <<< "$msg"
  tmux -S "$SOCKET" paste-buffer -b bracketed -t "$SESSION"
  tmux -S "$SOCKET" delete-buffer -b bracketed || true
  tmux -S "$SOCKET" send-keys -t "$SESSION" Escape '[201~'
  sleep 0.15
  tmux -S "$SOCKET" send-keys -t "$SESSION" C-m
}

send_tango_style "Reply INJECTED_TANGO_OK only."
sleep 12
echo "== after tango-style =="
tmux -S "$SOCKET" capture-pane -p -t "$SESSION" -S -160 | tee "$ROOT/after-tango.log" || true

send_bracketed_style "Reply INJECTED_BRACKETED_OK only."
sleep 12
echo "== after bracketed-style =="
tmux -S "$SOCKET" capture-pane -p -t "$SESSION" -S -200 | tee "$ROOT/after-bracketed.log" || true

tmux -S "$SOCKET" kill-session -t "$SESSION" || true

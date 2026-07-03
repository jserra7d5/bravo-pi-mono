#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/tmp/async-claude-tmux-paste-probe}
SESSION=${SESSION:-claude-paste-probe}
SOCKET=${SOCKET:-$ROOT/tmux.sock}
rm -rf "$ROOT"
mkdir -p "$ROOT"

cat > "$ROOT/reader.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'READY\n'
while IFS= read -r line; do
  printf 'LINE:%s\n' "$line"
  if [ "$line" = "STOP" ]; then exit 0; fi
done
SH
chmod +x "$ROOT/reader.sh"

tmux -S "$SOCKET" new-session -d -s "$SESSION" "bash $ROOT/reader.sh | tee -a $ROOT/transcript.log"
sleep 0.2

send_load_buffer() {
  local msg=$1
  local b="probe-$(date +%s)-$RANDOM"
  tmux -S "$SOCKET" load-buffer -b "$b" - <<< "$msg" || true
  tmux -S "$SOCKET" paste-buffer -b "$b" -t "$SESSION" || true
  tmux -S "$SOCKET" delete-buffer -b "$b" || true
  sleep 0.1
  tmux -S "$SOCKET" send-keys -t "$SESSION" C-m || true
}

send_bracketed() {
  local msg=$1
  tmux -S "$SOCKET" send-keys -t "$SESSION" Escape '[200~' || true
  tmux -S "$SOCKET" load-buffer -b bracketed - <<< "$msg" || true
  tmux -S "$SOCKET" paste-buffer -b bracketed -t "$SESSION" || true
  tmux -S "$SOCKET" delete-buffer -b bracketed || true
  tmux -S "$SOCKET" send-keys -t "$SESSION" Escape '[201~' || true
  sleep 0.1
  tmux -S "$SOCKET" send-keys -t "$SESSION" C-m || true
}

send_load_buffer "hello via load-buffer"
sleep 0.2
send_load_buffer $'multi-line A\nmulti-line B'
sleep 0.2
send_bracketed "hello via bracketed markers"
sleep 0.2
send_load_buffer "STOP"
sleep 0.5

set +e
tmux -S "$SOCKET" capture-pane -p -t "$SESSION" -S -200 > "$ROOT/pane.log" 2> "$ROOT/capture.err"
tmux -S "$SOCKET" kill-session -t "$SESSION" 2> "$ROOT/kill.err"
set -e

echo "== transcript =="; sed -n '1,120p' "$ROOT/transcript.log" || true
echo "== pane =="; sed -n '1,120p' "$ROOT/pane.log" || true
echo "== capture err =="; sed -n '1,40p' "$ROOT/capture.err" || true
echo "== kill err =="; sed -n '1,40p' "$ROOT/kill.err" || true

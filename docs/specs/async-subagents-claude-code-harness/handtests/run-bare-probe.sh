#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/tmp/async-claude-bare-probe}
BUDGET=${BUDGET:-0.001}
rm -rf "$ROOT"
mkdir -p "$ROOT"

cases=(
  "normal::"
  "bare::--bare"
  "dangerous::--dangerously-skip-permissions"
  "bare-dangerous::--bare --dangerously-skip-permissions"
)
for item in "${cases[@]}"; do
  name=${item%%::*}
  flags=${item#*::}
  echo "== $name ($flags) =="
  set +e
  # shellcheck disable=SC2086
  timeout 35 claude $flags --print --output-format text --max-budget-usd "$BUDGET" 'Say OK.' > "$ROOT/$name.out" 2> "$ROOT/$name.err"
  rc=$?
  set -e
  echo "rc=$rc"
  echo "out:"; sed -n '1,20p' "$ROOT/$name.out"
  echo "err:"; sed -n '1,20p' "$ROOT/$name.err"
  echo
done

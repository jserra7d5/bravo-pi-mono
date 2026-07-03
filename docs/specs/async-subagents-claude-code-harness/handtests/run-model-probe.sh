#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/tmp/async-claude-model-probe}
BUDGET=${BUDGET:-0.001}
rm -rf "$ROOT"
mkdir -p "$ROOT"
models=(claude-opus-4-8 opus claude-opus-4-5 claude-opus-4-5-20251101 claude-opus-4.8 opus-4.8 sonnet claude-sonnet-5 sonnet-5 fable)
for model in "${models[@]}"; do
  safe=${model//[^A-Za-z0-9_.-]/_}
  echo "== model $model =="
  set +e
  timeout 25 claude --print --output-format text --model "$model" --max-budget-usd "$BUDGET" 'Say model ok.' > "$ROOT/$safe.out" 2> "$ROOT/$safe.err"
  rc=$?
  set -e
  echo "rc=$rc"
  echo "out:"; sed -n '1,10p' "$ROOT/$safe.out"
  echo "err:"; sed -n '1,10p' "$ROOT/$safe.err"
  echo
done

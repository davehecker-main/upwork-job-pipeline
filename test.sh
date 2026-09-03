#!/usr/bin/env bash
# One entry point for everything that can be checked without a human.
#
#   ./test.sh            unit tests + secret scan
#   ./test.sh --eval     the above plus the live scoring eval (costs ~$0.04)
#
# Exit non-zero means do not run the pipeline.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAILED: %s\033[0m\n' "$1"; exit 1; }

step "1/2 unit tests"
npx vitest run || fail "unit tests"

step "2/2 secret scan"
if git grep -nIE 'sk-ant-api[0-9]|xoxb-[0-9]{8,}' -- . ':!*.example' ':!test.sh' 2>/dev/null; then
  fail "a live-looking secret is tracked in git"
fi
echo "no live secrets in tracked files"

if [[ " $* " == *" --eval "* ]]; then
  step "extra: scoring eval (live API)"
  node scripts/run-eval.mjs --yes "${@/--eval/}" || fail "eval"
fi

printf '\n\033[32mAll checks passed.\033[0m\n'

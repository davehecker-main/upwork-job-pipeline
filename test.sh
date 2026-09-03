#!/usr/bin/env bash
# One entry point for everything that can be checked without a human.
#
#   ./test.sh            unit tests, rebuild, artifact freshness, secret scan, drift
#   ./test.sh --eval     the above plus the live scoring eval (costs ~$0.04)
#   ./test.sh --eval --drafts 3   also drafts 3 proposals (costs ~$0.05 more)
#
# Exit non-zero means do not import anything into n8n.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAILED: %s\033[0m\n' "$1"; exit 1; }

step "1/5 unit tests"
npx vitest run || fail "unit tests"

step "2/5 rebuild workflow artifacts"
node scripts/build-workflow.mjs || fail "build"

step "3/5 artifacts are current and committed"
if [ -d .git ] && ! git diff --quiet -- workflows/ 2>/dev/null; then
  git --no-pager diff --stat -- workflows/
  fail "workflows/ changed after a rebuild. Commit the regenerated artifacts, then re-import them into n8n."
fi
echo "workflows/ matches the committed artifacts"

step "4/5 secret scan"
if git grep -nIE 'sk-ant-api[0-9]|xoxb-[0-9]{8,}|X-N8N-API-KEY: *[A-Za-z0-9]' -- . ':!*.example' ':!test.sh' 2>/dev/null; then
  fail "a live-looking secret is tracked in git"
fi
echo "no live secrets in tracked files"

step "5/5 live-workflow drift"
node scripts/pull-workflow.mjs || fail "drift check"

if [[ " $* " == *" --eval "* ]]; then
  shift_args=("$@")
  step "extra: scoring eval (live API)"
  node scripts/run-eval.mjs --yes "${shift_args[@]/--eval/}" || fail "eval"
fi

printf '\n\033[32mAll checks passed.\033[0m\n'

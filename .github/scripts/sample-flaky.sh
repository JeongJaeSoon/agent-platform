#!/usr/bin/env bash
# Runs a known-flaky spike suite <samples> times and reports how often it passed.
#
# The opposite of retry-flaky.sh: that one stops at the first pass because it
# wants a verdict, this one keeps going because it wants a rate. Sampling in one
# job is what keeps a flake hunt off the minute meter — one checkout, one
# install, one round-up to a whole minute, instead of one of each per sample.
#
# usage: sample-flaky.sh <samples> <label> <command> [args...]

set -uo pipefail

usage() {
  echo "usage: $0 <samples> <label> <command> [args...]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage

samples=$1
label=$2
shift 2

case "$samples" in
'' | *[!0-9]*) usage ;;
esac
[ "$samples" -ge 1 ] || usage

record() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# Same reasoning as retry-flaky.sh: the runner signals this wrapper, not the
# suite it launched, so the suite runs in the background and this script blocks
# in `wait`, which a signal does interrupt. A cancelled job must stop sampling
# rather than burn the rest of its budget.
cancelled=0
child=0

stop() {
  cancelled=1
  if [ "$child" -ne 0 ]; then
    kill -TERM "$child" 2>/dev/null
  fi
}
trap stop HUP INT TERM

run_once() {
  [ "$cancelled" -eq 0 ] || return 143

  "$@" &
  child=$!
  if [ "$cancelled" -ne 0 ]; then
    kill -TERM "$child" 2>/dev/null
  fi

  local result=0
  while :; do
    result=0
    wait "$child" || result=$?
    kill -0 "$child" 2>/dev/null || break
  done

  child=0
  return "$result"
}

passed=0
failed=0
taken=0
failures=''

for i in $(seq 1 "$samples"); do
  status=0
  run_once "$@" || status=$?

  interrupted=$cancelled
  case "$status" in
  129 | 130 | 137 | 143) interrupted=1 ;;
  esac
  [ "$interrupted" -eq 0 ] || break

  taken=$((taken + 1))
  if [ "$status" -eq 0 ]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    failures="${failures}${failures:+, }#${i} (exit ${status})"
    echo "::warning title=flake sample::${label} sample ${i}/${samples} failed (exit ${status})"
  fi
done

record "### flake samples — \`${label}\`"
record ""
record "| samples taken | passed | failed |"
record "| --- | --- | --- |"
record "| ${taken} / ${samples} | ${passed} | ${failed} |"
[ -z "$failures" ] || record ""
[ -z "$failures" ] || record "Failed samples: ${failures}"

if [ "$cancelled" -ne 0 ]; then
  record ""
  record "⛔ cancelled after ${taken} sample(s); the rate above is partial."
  exit 143
fi

# A rate of zero failures is the only clean result; anything else is the answer
# the hunt was after, and the step outcome is how it shows up on the run page.
[ "$failed" -eq 0 ] || exit 1

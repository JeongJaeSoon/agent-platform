#!/usr/bin/env bash
# Runs a known-flaky spike suite, retrying up to <attempts> times.
#
# A retry is never silent: every extra attempt lands in the workflow
# annotations and in the run summary, so "green after a retry" stays
# distinguishable from "green on the first try".
#
# usage: retry-flaky.sh <attempts> <label> <command> [args...]

set -uo pipefail

usage() {
  echo "usage: $0 <attempts> <label> <command> [args...]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage

attempts=$1
label=$2
shift 2

case "$attempts" in
'' | *[!0-9]*) usage ;;
esac
[ "$attempts" -ge 1 ] || usage

record() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "- $1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

attempt=1
while :; do
  # `if "$@"; then` would lose the exit code: a failed condition with no else
  # branch leaves $? at 0.
  status=0
  "$@" || status=$?

  if [ "$status" -eq 0 ]; then
    if [ "$attempt" -gt 1 ]; then
      echo "::warning title=flaky spike::${label} passed only on attempt ${attempt}/${attempts}"
      record "⚠️ \`${label}\` — flaky: passed on attempt ${attempt}/${attempts}"
    fi
    exit 0
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error title=spike failure::${label} failed all ${attempts} attempts (exit ${status})"
    record "❌ \`${label}\` — failed all ${attempts} attempts (exit ${status})"
    exit "$status"
  fi

  echo "::warning title=flaky spike::${label} attempt ${attempt}/${attempts} failed (exit ${status}); retrying"
  attempt=$((attempt + 1))
done

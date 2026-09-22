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

# Cancelling a workflow signals the whole process group, so this wrapper is
# signalled too. That, not the child's exit code, is what tells cancellation
# apart from a command that merely exits 128-255 on its own.
cancelled=0
note_signal() { cancelled=1; }
trap note_signal HUP INT TERM

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

  # Restarting the suite while something is trying to tear the job down would
  # fight the cancellation. The trap above is the reliable signal; the exit
  # codes are the narrow fallback for a child that was signalled alone, and are
  # limited to the ones that mean teardown (SIGHUP/SIGINT/SIGKILL/SIGTERM) so
  # that a command exiting 200 on its own is still treated as a normal failure.
  interrupted=$cancelled
  case "$status" in
  129 | 130 | 137 | 143) interrupted=1 ;;
  esac

  if [ "$interrupted" -eq 1 ]; then
    echo "::error title=spike cancelled::${label} was interrupted (exit ${status}); not retrying"
    record "⛔ \`${label}\` — interrupted (exit ${status}), not retried"
    exit "$status"
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error title=spike failure::${label} failed all ${attempts} attempts (exit ${status})"
    record "❌ \`${label}\` — failed all ${attempts} attempts (exit ${status})"
    exit "$status"
  fi

  echo "::warning title=flaky spike::${label} attempt ${attempt}/${attempts} failed (exit ${status}); retrying"
  attempt=$((attempt + 1))
done

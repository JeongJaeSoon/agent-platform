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

# The runner signals this wrapper, not the suite it launched, when a job is
# cancelled. Catching that is what tells cancellation apart from a command that
# merely exits 128-255 on its own.
cancelled=0
child=0

stop() {
  cancelled=1
  if [ "$child" -ne 0 ]; then
    kill -TERM "$child" 2>/dev/null
  fi
}
trap stop HUP INT TERM

# Runs "$@" so that a trapped signal is handled while it is still running. Bash
# defers a trap until a *foreground* command returns, so the command goes to the
# background and the script blocks in `wait`, which a signal does interrupt.
run_attempt() {
  # Nothing left to run once the job is going away, and the caller reads
  # `cancelled` regardless of what this returns.
  [ "$cancelled" -eq 0 ] || return 143

  "$@" &
  child=$!
  # Bash can run a pending trap between the fork above and the assignment, which
  # would leave `stop` with no pid to forward to and this wrapper sitting in
  # `wait` for the whole run. Re-check now that the pid is published.
  if [ "$cancelled" -ne 0 ]; then
    kill -TERM "$child" 2>/dev/null
  fi

  local result=0
  while :; do
    result=0
    wait "$child" || result=$?
    # An interrupted `wait` returns before the child does; only a reaped child
    # means `result` is really the command's status.
    kill -0 "$child" 2>/dev/null || break
  done

  child=0
  return "$result"
}

attempt=1
while :; do
  status=0
  run_attempt "$@" || status=$?

  # Checked before the success path: a suite that happened to finish cleanly
  # while the job was being torn down is still a cancellation, not a pass.
  interrupted=$cancelled
  case "$status" in
  129 | 130 | 137 | 143) interrupted=1 ;;
  esac

  if [ "$interrupted" -eq 1 ]; then
    [ "$status" -eq 0 ] && status=143
    echo "::error title=spike cancelled::${label} was interrupted (exit ${status}); not retrying"
    record "⛔ \`${label}\` — interrupted (exit ${status}), not retried"
    exit "$status"
  fi

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

#!/usr/bin/env bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED — runs after the last step of every job,
# including a cancelled one, which is the case that actually leaks.
#
# A cancelled job never reaches the runner's own teardown of the services it
# started, so its postgres and localstack keep running, its network keeps its
# subnet, and the next job inherits both. Everything below is per job and
# reversible; images are deliberately left alone (re-pulling localstack every
# run costs more than the disk it holds) and a weekly timer ages those out.
#
# Never fails the job: cleanup is best effort and the job is already over.

set -uo pipefail

note() { echo "[job-cleanup] $*"; }

# The runner reaps its own process tree, not what a step detached from it.
# Anything still rooted in _work after the job is a leak.
work=${RUNNER_WORKSPACE:-}
if [ -n "$work" ]; then
  root=${work%/*}
  leftovers=$(pgrep -f "^${root}/" 2>/dev/null || true)
  if [ -n "$leftovers" ]; then
    note "terminating leftover processes under ${root}"
    # shellcheck disable=SC2086
    kill -TERM $leftovers 2>/dev/null
    for _ in 1 2 3 4 5; do
      sleep 1
      pgrep -f "^${root}/" >/dev/null 2>&1 || break
    done
    # shellcheck disable=SC2086
    pgrep -f "^${root}/" >/dev/null 2>&1 && kill -KILL $leftovers 2>/dev/null
  fi
fi

command -v docker >/dev/null 2>&1 || exit 0
docker info >/dev/null 2>&1 || exit 0

# Service containers carry the job's id; a finished job owns none of them.
stale=$(docker ps -q --filter 'label=com.github.actions.job' 2>/dev/null || true)
if [ -n "$stale" ]; then
  note "stopping service containers left by this job"
  # shellcheck disable=SC2086
  docker rm -f $stale >/dev/null 2>&1
fi

# Anything still running after the job ends is an orphan by definition: this
# runner takes one job at a time, so nothing else is legitimately using Docker.
orphans=$(docker ps -q 2>/dev/null || true)
if [ -n "$orphans" ]; then
  note "stopping containers still running after the job"
  # shellcheck disable=SC2086
  docker rm -f $orphans >/dev/null 2>&1
fi

docker container prune -f >/dev/null 2>&1
docker network prune -f >/dev/null 2>&1
docker volume prune -f >/dev/null 2>&1

free=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
note "done; ${free:-?}GiB free on /"
exit 0

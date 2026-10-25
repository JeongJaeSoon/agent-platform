#!/usr/bin/env bash
# Tear down the stack up.sh started, and only that one: scripts/local.sh down
# under the run's own project, then a second compose down with --profile apps
# and the fake-model overlay (without both, app containers, fake-messages and
# the default network can survive), then the leftover check: no container
# and no network of the project or its installation.
# Evidence in <run>/evidence stays. Any failure keeps ports.yml so the same
# run can be torn down again once Docker answers.
#
#   down.sh <run id | run dir>    the run id up.sh printed; no default run,
#                                  without one it lists the runs and deletes nothing
#   down.sh <run> --keep-volumes  the same, but the volumes stay and so does the
#                                  run; a later down.sh <run> deletes them
set -uo pipefail

keep=${2:-}
case "$#:$keep" in
  [01]: | 2:--keep-volumes) ;;
  *) echo "usage: down.sh <run id | run dir> [--keep-volumes]" >&2; exit 2 ;;
esac

# shellcheck disable=SC1091
. "$(dirname "$0")/run.sh" "${1:-}" || exit 2
run=$VERIFY_RUN_DIR
# shellcheck disable=SC1091
. "$run/state.env" || exit 1
case "${COMPOSE_PROJECT_NAME:-}" in
  verify-ap-*) ;;
  *) echo "down.sh: $run/state.env names no verify-ap-* project; nothing was deleted" >&2; exit 1 ;;
esac
cd "$VERIFY_REPO" || exit 1

failed=0
if [ -f "$run/browser/pid" ]; then
  node "$VERIFY_REPO/.claude/skills/verify-agent-platform/scripts/browser.mjs" "$run" stop >&2 || failed=1
fi
# shellcheck disable=SC2086 # no argument when volumes go
"$VERIFY_REPO/scripts/local.sh" down $keep 2>&1 | tee "$run/evidence/down.log" >&2 || failed=1
down_args=(--remove-orphans --rmi local)
[ -n "$keep" ] || down_args+=(-v)
docker compose --profile apps --profile fake-model \
  -f compose.yaml -f "$run/ports.yml" -f infra/compose.fake-model.yml \
  down "${down_args[@]}" >>"$run/evidence/down.log" 2>&1 || failed=1

left=$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Names}}') || failed=1
workers=$(docker ps -a --filter "label=agent-platform.installation=$EXECUTION_INSTALLATION_ID" --format '{{.Names}}') || failed=1
networks=$(
  docker network ls --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Name}}' &&
    docker network ls --filter "label=agent-platform.installation=$EXECUTION_INSTALLATION_ID" --format '{{.Name}}'
) || failed=1
if [ "$failed" = 1 ]; then
  echo "down.sh: a teardown or leftover check failed (see $run/evidence/down.log); ports.yml kept, rerun down.sh $run${keep:+ $keep}" >&2
  exit 1
fi
{
  echo "\$ docker ps -a --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
  echo "${left:-(none)}"
  echo "\$ docker ps -a --filter label=agent-platform.installation=$EXECUTION_INSTALLATION_ID"
  echo "${workers:-(none)}"
  echo "\$ docker network ls --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME, then label=agent-platform.installation=$EXECUTION_INSTALLATION_ID"
  echo "${networks:-(none)}"
} | tee "$run/evidence/leftovers.txt"
if [ -n "$left$workers$networks" ]; then
  echo "down.sh: containers or networks left (above); ports.yml kept, rerun down.sh $run${keep:+ $keep}" >&2
  exit 1
fi
# Only this run's tags; layers another tag shares stay.
docker image rm "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" >>"$run/evidence/down.log" 2>&1 || true
if [ -n "$keep" ]; then
  echo "down.sh: volumes kept; the run stays listed until down.sh $run deletes them" >&2
  exit 0
fi
rm -f "$run/ports.yml" "$run/cookie" "$run"/cookie.*
rm -rf "$run/users" "$run/keys"

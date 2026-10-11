#!/usr/bin/env bash
# Tear down the stack up.sh started, and only that one: scripts/local.sh down
# under the run's own project, then a second compose down with --profile apps
# and the fake-model overlay (without both, app containers, fake-messages and
# the default network can survive), then the leftover check.
# Evidence in <run>/evidence stays.
#
#   down.sh [run dir]    default: the latest run
set -uo pipefail

root=${VERIFY_AP_ROOT:-$(t=${TMPDIR:-/tmp}; echo "${t%/}")/verify-agent-platform}
run=${1:-$(cat "$root/latest")}
# shellcheck disable=SC1091
. "$run/state.env"
cd "$VERIFY_REPO"

"$VERIFY_REPO/scripts/local.sh" down 2>&1 | tee "$run/evidence/down.log" >&2
docker compose --profile apps --profile fake-model \
  -f compose.yaml -f "$run/ports.yml" -f infra/compose.fake-model.yml \
  down -v --remove-orphans >>"$run/evidence/down.log" 2>&1

left=$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Names}}')
workers=$(docker ps -a --filter "label=agent-platform.installation=$EXECUTION_INSTALLATION_ID" --format '{{.Names}}')
{
  echo "\$ docker ps -a --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
  echo "${left:-(none)}"
  echo "\$ docker ps -a --filter label=agent-platform.installation=$EXECUTION_INSTALLATION_ID"
  echo "${workers:-(none)}"
} | tee "$run/evidence/leftovers.txt"
rm -f "$run/ports.yml" "$run/cookie"
[ -z "$left$workers" ]

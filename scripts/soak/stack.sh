#!/usr/bin/env bash
# The 94S-135 soak/campaign stack: the compose product stack built from this
# checkout, with the D2 gate overlay (scripts/d2-gate/compose.yml) and the
# soak overlay (scripts/soak/compose.yml), under a project and installation
# of its own so it never touches another card's stack.
#
#   scripts/soak/stack.sh up      build the images, start, create the fixture
#   scripts/soak/stack.sh reset   down (images kept) and up again: a clean
#                                 database, bucket and Gitea for a campaign
#   scripts/soak/stack.sh down    remove this project's containers, networks,
#                                 volumes and workers; SOAK_RMI=1 also the images
#   scripts/soak/stack.sh logs    write every service's log to $SOAK_STATE/compose.log
#
# Host ports are ephemeral and loopback-only, so the stack cannot collide
# with another; `up` writes the ones it got, the API key and the image tags
# to $SOAK_STATE/vars.sh (mode 0600), which soak.ts and campaigns.ts read.
#
# SOAK_PROJECT / SOAK_INSTALLATION default to soak135; SOAK_STATE to
# ${TMPDIR}/soak135-state. SOAK_SKIP_BUILD=1 reuses images already tagged.
# Removal is by this project's name and this installation's label only.
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

project="${SOAK_PROJECT:-soak135}"
state="${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}"
mkdir -p "$state"

export EXECUTION_INSTALLATION_ID="${SOAK_INSTALLATION:-soak135}"
export API_IMAGE="agent-platform-api:${project}"
export SCHEDULER_IMAGE="agent-platform-scheduler:${project}"
export WORKER_IMAGE="agent-platform-worker:${project}"
export EGRESS_PROXY_IMAGE="agent-platform-egress-proxy:${project}"
compose_files=(-f infra/docker-compose.yml -f scripts/d2-gate/compose.yml -f scripts/soak/compose.yml)
dc() { docker compose -p "$project" "${compose_files[@]}" --profile apps --profile worker "$@"; }

down() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  local label="agent-platform.installation=${EXECUTION_INSTALLATION_ID}"
  local ids
  ids="$(docker ps -aq --filter "label=${label}")"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  ids="$(docker network ls -q --filter "label=${label}")"
  [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
  ids="$(docker volume ls -q --filter "label=${label}")"
  [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
  if [ "${SOAK_RMI:-0}" = 1 ]; then
    docker image rm "$API_IMAGE" "$SCHEDULER_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" >/dev/null 2>&1 || true
  fi
}

up() {
  if [ "${SOAK_SKIP_BUILD:-0}" != 1 ]; then
    echo "== build (${project})" >&2
    dc build api scheduler worker egress-proxy >"$state/build.log" 2>&1
  fi
  echo "== stack (${project})" >&2
  dc up -d --wait postgres localstack secrets gitea fake-messages gate-chaos gate-messages egress-proxy >"$state/up.log" 2>&1
  dc up -d --wait api >>"$state/up.log" 2>&1

  port() { dc port "$1" "$2" | sed 's/.*://'; }
  local gitea_url
  gitea_url="http://127.0.0.1:$(port gitea 3000)"

  echo "== fixture" >&2
  # A throwaway login for this stack's own Gitea, gone with its volume.
  local gitea_login
  gitea_login="soak-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  dc exec -T -u git gitea gitea admin user create --username agent \
    --password "$gitea_login" --email agent@example.test \
    --must-change-password=false >"$state/fixture.log" 2>&1
  curl -fsS -u "agent:${gitea_login}" -X POST "${gitea_url}/api/v1/user/repos" \
    -H 'Content-Type: application/json' \
    -d '{"name":"gate-app","auto_init":true,"default_branch":"main","private":false}' \
    >>"$state/fixture.log"
  local key
  key="$(dc exec -T api bun run apps/api/src/keys.ts create soak-owner \
    --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover | tail -n 1)"

  dc up -d --wait scheduler >>"$state/up.log" 2>&1

  rm -f "$state/vars.sh"
  {
    echo "export SOAK_PROJECT='${project}'"
    echo "export SOAK_STATE='${state}'"
    echo "export SOAK_INSTALLATION='${EXECUTION_INSTALLATION_ID}'"
    # Campaigns recreate the scheduler through compose, which reads these.
    echo "export EXECUTION_INSTALLATION_ID='${EXECUTION_INSTALLATION_ID}'"
    echo "export SOAK_SCHEDULER_INTERVAL_SEC='${SOAK_SCHEDULER_INTERVAL_SEC:-5}'"
    echo "export SOAK_API_URL='http://127.0.0.1:$(port api 3000)'"
    echo "export SOAK_API_KEY='${key}'"
    echo "export SOAK_DATABASE_URL='postgres://postgres:dev@127.0.0.1:$(port postgres 5432)/sessions'"
    echo "export SOAK_S3_URL='http://127.0.0.1:$(port localstack 4566)'"
    echo "export SOAK_CHAOS_URL='http://127.0.0.1:$(port gate-chaos 8099)'"
    echo "export SOAK_MESSAGES_URL='http://127.0.0.1:$(port gate-messages 4011)'"
    echo "export SOAK_GITEA_URL='${gitea_url}'"
    echo "export SOAK_NETWORK='${project}_default'"
    echo "export SOAK_COMPOSE_FILES='${compose_files[*]}'"
    echo "export API_IMAGE='${API_IMAGE}'"
    echo "export SCHEDULER_IMAGE='${SCHEDULER_IMAGE}'"
    echo "export WORKER_IMAGE='${WORKER_IMAGE}'"
    echo "export EGRESS_PROXY_IMAGE='${EGRESS_PROXY_IMAGE}'"
    [ -z "${DOCKER_HOST:-}" ] || echo "export DOCKER_HOST='${DOCKER_HOST}'"
  } >"$state/vars.sh"
  echo "stack up: source $state/vars.sh" >&2
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset)
    down
    SOAK_SKIP_BUILD=1 up
    ;;
  logs) dc logs --no-color --timestamps >"${2:-$state/compose.log}" 2>&1 ;;
  compose)
    shift
    dc "$@"
    ;;
  *)
    echo "usage: $0 up|reset|down|logs [file]|compose <args>" >&2
    exit 2
    ;;
esac

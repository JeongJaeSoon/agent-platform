#!/usr/bin/env bash
# The local stack's lifecycle in one place (94S-422): the compose project
# `agent-platform` from compose.yaml, on the loopback ports docs/quickstart.md
# lists.
#
#   scripts/local.sh up [--real-model]   check Docker and ports, build, start, wait for /readyz
#   scripts/local.sh down                delete the stack AND ALL ITS DATA
#   scripts/local.sh reset [--real-model]
#                                        down, then up
#   scripts/local.sh status              containers and /readyz
#   scripts/local.sh key <owner> --scopes <scope>[,<scope>...]
#                                        print a new API key once (same CLI as `bun run keys create`)
#
# A local installation is volatile: LocalStack keeps S3 in memory, so any
# `down` or Docker restart loses every checkpoint object while postgres keeps
# the rows that point at them. `down` therefore deletes the volumes too, and
# the API refuses to start on a bucket emptied behind the database's back.
#
# --real-model (94S-431) adds infra/compose.real-model.yml, the overlay
# `tests/e2e/run.sh --real-model` runs: the catalog in config/real-model, the
# caller's exported ANTHROPIC_API_KEY handed by name to the API alone, and
# the e2e's cost limits (docs/real-claude.md). Without the key nothing is
# touched. The project is the same, so `down` deletes it like any other.
set -euo pipefail

cd "$(dirname "$0")/.."

API_URL=http://127.0.0.1:3000
PORTS="3000 5432 4566 4567 3001"
MIN_ENGINE_MAJOR=28
MIN_COMPOSE=2.24
# An overlay on compose.yaml's include; 2.24.0-2.24.5 reject it as a
# conflict with an imported resource.
MIN_COMPOSE_OVERLAY=2.24.6
READY_TIMEOUT_SEC=${LOCAL_READY_TIMEOUT_SEC:-180}
LABEL=agent-platform.installation=local

die() {
  echo "local.sh: $*" >&2
  exit 1
}

real_model=""
compose() {
  docker compose --profile apps \
    ${real_model:+-f compose.yaml -f infra/compose.real-model.yml} "$@"
}

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# The mode `up` and `reset` take, settled before either touches Docker.
mode() {
  case "$*" in
    "") ;;
    --real-model)
      if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        # Never a quiet fallback to the fake: that stack would look fine.
        echo "local.sh: --real-model needs ANTHROPIC_API_KEY exported (docs/real-claude.md); nothing was started" >&2
        exit 2
      fi
      real_model=1
      ;;
    *) usage ;;
  esac
}

# Is version $1 (like 28.3.2 or v2.39.1-desktop.1) at least $2 (like 2.24
# or 2.24.6)? A missing part counts as 0.
version_at_least() {
  local have=${1#v} want=$2 h w _
  for _ in 1 2 3; do
    h=${have%%[!0-9]*}
    w=${want%%[!0-9]*}
    [ "${h:-0}" -eq "${w:-0}" ] || { [ "${h:-0}" -gt "${w:-0}" ]; return; }
    have=${have#"$h"}
    have=${have#.}
    want=${want#"$w"}
    want=${want#.}
  done
}

preflight() {
  local engine compose_version ours port busy=""
  engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
    die "cannot reach the Docker daemon"
  version_at_least "$engine" "$MIN_ENGINE_MAJOR.0" ||
    die "Docker Engine $engine is too old; worker networks need $MIN_ENGINE_MAJOR or newer (gateway_mode_ipv4=isolated)"
  compose_version=$(docker compose version --short 2>/dev/null) ||
    die "docker compose (v2) is not installed"
  version_at_least "$compose_version" "$MIN_COMPOSE" ||
    die "docker compose $compose_version is too old; compose.yaml needs $MIN_COMPOSE or newer (include, env_file required)"
  [ -z "$real_model" ] || version_at_least "$compose_version" "$MIN_COMPOSE_OVERLAY" ||
    die "docker compose $compose_version is too old for --real-model; an overlay on compose.yaml's include needs $MIN_COMPOSE_OVERLAY or newer"
  # A port this stack already publishes is its own; any other listener is not.
  ours=$(compose ps --format '{{.Ports}}' 2>/dev/null || true)
  for port in $PORTS; do
    case "$ours" in *":$port->"*) continue ;; esac
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      busy="$busy $port"
    fi
  done
  [ -z "$busy" ] ||
    die "127.0.0.1 port(s)$busy already in use; stop whatever holds them (another stack?) and retry"
  echo "Docker Engine $engine, compose $compose_version" >&2
}

readyz() { curl -sS --max-time 3 "$API_URL/readyz" 2>/dev/null || true; }

up() {
  preflight
  if ! compose up -d --build; then
    echo "local.sh: the stack did not start; last API log lines:" >&2
    compose logs --no-color --tail 20 api >&2 || true
    exit 1
  fi
  local deadline=$((SECONDS + READY_TIMEOUT_SEC)) body
  while :; do
    body=$(readyz)
    case "$body" in
      *'"status":"ready"'*) echo "$body"; return 0 ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] ||
      die "API not ready after ${READY_TIMEOUT_SEC}s: ${body:-no answer from $API_URL/readyz}"
    sleep 2
  done
}

down() {
  echo "local.sh: deleting the local stack and ALL its data: sessions, checkpoints, keys, Gitea repositories" >&2
  compose down -v --remove-orphans
  # What the scheduler created is not compose's: worker containers, their
  # networks and workspace volumes carry the installation label instead.
  docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null
  docker network ls -q --filter "label=$LABEL" | xargs -r docker network rm >/dev/null
  docker volume ls -q --filter "label=$LABEL" | xargs -r docker volume rm >/dev/null
  echo "local.sh: deleted" >&2
}

status() {
  compose ps
  echo "readyz: $(readyz)"
}

key() {
  [ "$#" -ge 1 ] || die "usage: scripts/local.sh key <owner> --scopes <scope>[,<scope>...]"
  compose exec -T api bun run apps/control-host/src/api/keys.ts create "$@"
}

case "${1:-}" in
  up) shift; mode "$@"; up ;;
  down) down ;;
  reset) shift; mode "$@"; down && up ;;
  status) status ;;
  key) shift; key "$@" ;;
  *) usage ;;
esac

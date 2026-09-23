#!/usr/bin/env bash
# The D2 completion gate (94S-247), as one command:
#
#   scripts/d2-gate/run.sh
#
# Builds the api, scheduler and worker images from this checkout, starts the
# compose product stack under a project of its own with the gate overlay
# (scripts/d2-gate/compose.yml), creates the Gitea repository and an API key,
# then runs tests/d2-gate.e2e.test.ts against it. The report (JSON and
# Markdown) and every log land in D2_GATE_OUT (default: a fresh temp dir).
#
# D2_GATE_UP_ONLY=1 stops before the test and keeps the stack, writing the
# variables the test reads to $D2_GATE_OUT/vars.sh: source it and run
# `bun test tests/d2-gate.e2e.test.ts` to iterate against the same stack.
#
# Needs Docker Engine 28+ (the worker network's isolated gateway mode) and
# bun. Leaves nothing behind unless D2_GATE_KEEP=1: the compose project, the
# worker containers, networks and volumes the scheduler made for this run's
# installation id, and the three images are removed on exit.
set -euo pipefail
# vars.sh and the logs carry the run's API key.
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

run_id="$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"
project="d2gate-${run_id}"
out="${D2_GATE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/d2-gate.XXXXXX")}"
mkdir -p "$out"

export EXECUTION_INSTALLATION_ID="d2g${run_id}"
export API_IMAGE="agent-platform-api:${project}"
export SCHEDULER_IMAGE="agent-platform-scheduler:${project}"
export WORKER_IMAGE="agent-platform-worker:${project}"
compose_files=(-f infra/docker-compose.yml -f scripts/d2-gate/compose.yml)
dc() { docker compose -p "$project" "${compose_files[@]}" --profile apps --profile worker "$@"; }

cleanup() {
  local status=$?
  dc logs --no-color --timestamps >"$out/compose.log" 2>&1 || true
  if [ "${D2_GATE_KEEP:-0}" = 1 ]; then
    echo "kept: compose project ${project}, installation ${EXECUTION_INSTALLATION_ID}" >&2
  else
    # --rmi local: migrate's image, built under the project's default name.
    dc down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    local label="agent-platform.installation=${EXECUTION_INSTALLATION_ID}"
    local ids
    ids="$(docker ps -aq --filter "label=${label}")"
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
    ids="$(docker network ls -q --filter "label=${label}")"
    [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
    ids="$(docker volume ls -q --filter "label=${label}")"
    [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
    docker image rm "$API_IMAGE" "$SCHEDULER_IMAGE" "$WORKER_IMAGE" >/dev/null 2>&1 || true
  fi
  echo "report: $out" >&2
  exit "$status"
}
trap cleanup EXIT

echo "== build (${project})" >&2
dc build api scheduler worker >"$out/build.log" 2>&1

echo "== stack" >&2
dc up -d --wait postgres localstack secrets gitea fake-messages gate-chaos gate-messages egress-proxy >"$out/up.log" 2>&1
dc up -d --wait api >>"$out/up.log" 2>&1

port() { dc port "$1" "$2" | sed 's/.*://'; }
gitea_url="http://127.0.0.1:$(port gitea 3000)"

echo "== fixture" >&2
gitea_password="gate-$(openssl rand -hex 12)"
dc exec -T -u git gitea gitea admin user create --username agent \
  --password "$gitea_password" --email agent@example.test \
  --must-change-password=false >"$out/fixture.log" 2>&1
curl -fsS -u "agent:${gitea_password}" -X POST "${gitea_url}/api/v1/user/repos" \
  -H 'Content-Type: application/json' \
  -d '{"name":"gate-app","auto_init":true,"default_branch":"main","private":false}' \
  >>"$out/fixture.log"
api_key="$(dc exec -T api bun run apps/api/src/keys.ts create gate-owner \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover | tail -n 1)"

dc up -d --wait scheduler >>"$out/up.log" 2>&1

echo "== gate" >&2
export D2_GATE=1
export D2_GATE_OUT="$out"
export D2_GATE_PROJECT="$project"
export D2_GATE_COMMAND="scripts/d2-gate/run.sh"
export D2_GATE_API_URL="http://127.0.0.1:$(port api 3000)"
export D2_GATE_API_KEY="$api_key"
export D2_GATE_DATABASE_URL="postgres://postgres:dev@127.0.0.1:$(port postgres 5432)/sessions"
export D2_GATE_S3_URL="http://127.0.0.1:$(port localstack 4566)"
export D2_GATE_CHAOS_URL="http://127.0.0.1:$(port gate-chaos 8099)"
export D2_GATE_MESSAGES_URL="http://127.0.0.1:$(port gate-messages 4011)"
export D2_GATE_GITEA_URL="$gitea_url"
export D2_GATE_NETWORK="${project}_default"
# A fresh file, so a reused D2_GATE_OUT cannot hand the key an older mode.
rm -f "$out/vars.sh"
export -p | grep -E ' (D2_GATE(_[A-Z0-9_]*)?|DOCKER_HOST|EXECUTION_INSTALLATION_ID|[A-Z]+_IMAGE)=' |
  grep -vE ' D2_GATE_(UP_ONLY|KEEP)=' >"$out/vars.sh"
if [ "${D2_GATE_UP_ONLY:-0}" = 1 ]; then
  export D2_GATE_KEEP=1
  echo "stack up: source $out/vars.sh" >&2
  exit 0
fi
bun test tests/d2-gate.e2e.test.ts --timeout 1800000 2>&1 | tee "$out/test.log"

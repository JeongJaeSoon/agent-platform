#!/usr/bin/env bash
# Postgres restarts on a new address; the API must follow it (94S-343):
#
#   tests/e2e/db-restart.sh
#
# Starts the API (and what it depends on) from this checkout under a project
# of its own (tests/e2e/compose.yml's ephemeral loopback ports), warms every
# database path the API holds open — the request pool through GET /v1/limits,
# the probe pool through /readyz, the session event listener — then stops
# postgres, parks a placeholder container on its old address and starts it
# again, so the name `postgres` now resolves somewhere else and the old
# address refuses. Passes when /readyz and GET /v1/limits answer 200 within
# DBR_READY_DEADLINE_SEC (default 60) of the restart, the event listener has
# connected again, and no API log line after that still dials the old address.
#
# The record (tested SHA, both addresses, the recovery time, compose logs)
# lands in DBR_OUT (default: a fresh temp dir). DBR_KEEP=1 leaves the stack.
# Needs Docker and bun, like tests/e2e/run.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

run_id="$(date +%s | tail -c 7)$((RANDOM % 1000))"
project="dbr-${run_id}"
out="${DBR_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/db-restart.XXXXXX")}"
deadline_sec="${DBR_READY_DEADLINE_SEC:-60}"
mkdir -p "$out"
record="$out/record.txt"

export EXECUTION_INSTALLATION_ID="dbr${run_id}"
export API_IMAGE="agent-platform-api:${project}"
dc() {
  docker compose -p "$project" -f infra/docker-compose.yml -f tests/e2e/compose.yml \
    --profile apps "$@"
}

placeholder="${project}-old-address"
cleanup() {
  local status=$?
  dc logs --no-color --timestamps >"$out/compose.log" 2>&1 || true
  docker rm -f "$placeholder" >/dev/null 2>&1 || true
  if [ "${DBR_KEEP:-0}" = 1 ]; then
    echo "kept: compose project ${project}" >&2
  else
    dc down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    docker image rm "$API_IMAGE" >/dev/null 2>&1 || true
  fi
  echo "db-restart record: $out" >&2
  exit "$status"
}
trap cleanup EXIT

note() { printf '%s\n' "$*" | tee -a "$record" >&2; }
fail() { note "FAIL $*"; exit 1; }
pass() { note "PASS $*"; }

note "sha: $(git rev-parse HEAD)"
echo "== build + up api (${project})" >&2
dc up -d --build --wait api >"$out/up.log" 2>&1 || { tail -50 "$out/up.log" >&2; exit 1; }

api_url="http://127.0.0.1:$(dc port api 3000 | sed 's/.*://')"
api_key="$(dc exec -T api bun run apps/control-host/src/api/keys.ts create dbr-owner --scopes sessions:read)"
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true
}
limits() { status_of -H "authorization: Bearer ${api_key}" "${api_url}/v1/limits"; }
readyz() { status_of "${api_url}/readyz"; }
listener_connects() {
  dc logs --no-color api >"$out/api.log" 2>&1 || fail "could not read the API log"
  grep -c '"Session event listener connected"' "$out/api.log" || true
}

[ "$(readyz)" = 200 ] || fail "readyz before the restart"
[ "$(limits)" = 200 ] || fail "GET /v1/limits before the restart"
connects_before="$(listener_connects)"
[ "$connects_before" -ge 1 ] || fail "event listener never connected"

pg="$(dc ps -q postgres)"
net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$pg")"
address_of() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"${net}\").IPAddress}}" "$1"
}
old_address="$(address_of "$pg")"
note "postgres before: ${old_address} on ${net}"

echo "== restart postgres on a new address" >&2
docker stop -t 10 "$pg" >/dev/null
# Holds the old address, so dialing it is refused rather than reaching a
# postgres that happened to get the same one back.
docker run -d --name "$placeholder" --network "$net" --ip "$old_address" \
  --entrypoint sleep "$(docker inspect -f '{{.Config.Image}}' "$pg")" 3600 >/dev/null
docker start "$pg" >/dev/null
restarted_at="$(date +%s)"
new_address="$(address_of "$pg")"
note "postgres after: ${new_address}"
[ "$new_address" != "$old_address" ] || fail "postgres kept its address; the run proves nothing"

ready_after=""
while [ $(($(date +%s) - restarted_at)) -le "$deadline_sec" ]; do
  # Its own statement, so set -e ends the run when the log cannot be read.
  connects="$(listener_connects)"
  if [ "$(readyz)" = 200 ] && [ "$(limits)" = 200 ] &&
    [ "$connects" -gt "$connects_before" ]; then
    ready_after=$(($(date +%s) - restarted_at))
    break
  fi
  sleep 1
done
[ -n "$ready_after" ] ||
  fail "readyz, GET /v1/limits and the event listener not all back within ${deadline_sec}s (readyz $(readyz), limits $(limits))"
pass "readyz, GET /v1/limits and the event listener back ${ready_after}s after the restart (limit ${deadline_sec}s)"

# Nothing still dials the old address once the API has recovered.
sleep 3
since="$(date -u -r "$((restarted_at + ready_after))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
  date -u -d "@$((restarted_at + ready_after))" +%Y-%m-%dT%H:%M:%SZ)"
dc logs --no-color --since "$since" api >"$out/api-after.log" 2>&1 ||
  fail "could not read the API log"
if grep -q "${old_address}:5432" "$out/api-after.log"; then
  fail "API still dials ${old_address}:5432 after recovering"
fi
pass "no API connection to the old address after recovery"

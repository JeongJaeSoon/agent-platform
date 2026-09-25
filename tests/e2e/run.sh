#!/usr/bin/env bash
# The alpha e2e (94S-134), as one command:
#
#   tests/e2e/run.sh
#
# Builds the api, scheduler and worker images from this checkout, starts the
# product compose stack (`apps` profile — the one docs/quickstart.md starts)
# under a project of its own with ephemeral loopback ports
# (tests/e2e/compose.yml), issues an API key with the key CLI, then runs
# tests/e2e against the public HTTP API. The run record (command, tested
# SHA, image ids, SDK and Claude Code versions), the test output with its
# pass/skip list, compose logs and every worker container's log land in
# E2E_OUT (default: a fresh temp dir).
#
# E2E_UP_ONLY=1 stops before the tests and keeps the stack, writing the
# variables the suite reads to $E2E_OUT/vars.sh: source it and run
# `bun test ./tests/e2e/alpha-path.e2e.ts` to iterate against the same
# stack. The file is named outside Bun's `*.test.ts` rule so `bun run test`
# never collects it: without a stack it has nothing to talk to.
#
# Needs Docker Engine 28+ (the worker network's isolated gateway mode) and
# bun. Leaves nothing behind unless E2E_KEEP=1: the compose project, the
# worker containers, networks and volumes the scheduler made for this run's
# installation id, and the four images are removed on exit.
#
#   tests/e2e/run.sh --real-model
#
# The same stack against the real Messages API (94S-373): the API reads the
# catalog in config/real-model and, alone, the key from ANTHROPIC_API_KEY
# (infra/compose.real-model.yml, which also caps what the run can spend;
# `scripts/local.sh up --real-model` starts the same overlay), and
# tests/e2e/real-model.e2e.ts runs in place of the scripted suites. Without
# a key it stops before touching Docker, and it fails if the key's value
# turns up anywhere in E2E_OUT. Paid calls, so no CI job runs it;
# docs/real-claude.md gives the command and its cost.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

real_model=""
case "$*" in
  "") ;;
  --real-model) real_model=1 ;;
  *) echo "usage: tests/e2e/run.sh [--real-model]" >&2; exit 2 ;;
esac
if [ -n "$real_model" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  # Never a quiet fallback to the scripted fake: that run would pass and
  # prove nothing about the real model.
  echo "e2e --real-model: ANTHROPIC_API_KEY is unset or empty; nothing was started" >&2
  exit 2
fi

if [ -z "${DOCKER_HOST:-}" ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi

run_id="$(date +%s | tail -c 7)$((RANDOM % 1000))"
project="e2e-${run_id}"
out="${E2E_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/e2e.XXXXXX")}"
mkdir -p "$out/workers"

export EXECUTION_INSTALLATION_ID="e2e${run_id}"
export API_IMAGE="agent-platform-control-host:${project}"
export WORKER_IMAGE="agent-platform-worker:${project}"
export EGRESS_PROXY_IMAGE="agent-platform-egress-proxy:${project}"
label="agent-platform.installation=${EXECUTION_INSTALLATION_ID}"
# E2E_COMPOSE_OVERRIDE: one more overlay after ours; CI passes
# tests/e2e/compose.ci-mirror.yml to pull from its image mirror (94S-365).
dc() {
  docker compose -p "$project" -f infra/docker-compose.yml -f tests/e2e/compose.yml \
    ${real_model:+-f infra/compose.real-model.yml} \
    ${E2E_COMPOSE_OVERRIDE:+-f "$E2E_COMPOSE_OVERRIDE"} --profile apps "$@"
}

events_pid=""
cleanup() {
  local status=$?
  dc logs --no-color --timestamps >"$out/compose.log" 2>&1 || true
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "kept: compose project ${project}, installation ${EXECUTION_INSTALLATION_ID}" >&2
  else
    dc down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    local ids
    ids="$(docker ps -aq --filter "label=${label}")"
    [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
    ids="$(docker network ls -q --filter "label=${label}")"
    [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
    ids="$(docker volume ls -q --filter "label=${label}")"
    [ -z "$ids" ] || docker volume rm -f $ids >/dev/null 2>&1 || true
    docker image rm "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE" >/dev/null 2>&1 || true
  fi
  # Stopping the event stream ends the loop; each `docker logs -f` ends with
  # its container, which is gone by now unless the stack is kept.
  [ -z "$events_pid" ] || kill "$events_pid" 2>/dev/null || true
  [ "${E2E_KEEP:-0}" = 1 ] || wait 2>/dev/null || true
  if [ -n "$real_model" ]; then
    # The pattern goes in through a builtin and a pipe, never an argument,
    # and only file names come out.
    local leaked
    leaked="$(grep -rlF -D skip -f <(printf '%s\n' "$ANTHROPIC_API_KEY") "$out" || true)"
    if [ -n "$leaked" ]; then
      echo "e2e --real-model: ANTHROPIC_API_KEY's value is in the record:" >&2
      echo "$leaked" >&2
      [ "$status" != 0 ] || status=1
    fi
  fi
  echo "e2e record: $out" >&2
  exit "$status"
}
trap cleanup EXIT

docker_version="$(docker version --format '{{.Server.Version}}')"
echo "== docker engine ${docker_version} (28+ required)" >&2

# The scheduler removes a worker container when it exits, so its log goes
# with it; follow each one from the moment it starts (docs/quickstart.md
# shows the same for a local stack).
# Through a fifo so that killing `docker events` alone ends the loop too.
mkfifo "$out/.events"
docker events --filter "label=${label}" --filter type=container --filter event=start \
  --format '{{.Actor.ID}} {{index .Actor.Attributes "name"}}' >"$out/.events" &
events_pid=$!
while read -r id name; do
  docker logs -f --timestamps "$id" >"$out/workers/${name}.log" 2>&1 &
done <"$out/.events" &

echo "== build + up (${project})" >&2
# The command docs/quickstart.md gives, plus the overlay and project above.
dc up -d --build >"$out/up.log" 2>&1 || { tail -50 "$out/up.log" >&2; exit 1; }

echo "== key" >&2
api_key="$(dc exec -T api bun run apps/control-host/src/api/keys.ts create e2e-owner \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)"

image_id() { docker image inspect --format '{{.Id}}' "$1"; }
sha="$(git rev-parse HEAD)"
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
claude_version="$(dc logs --no-color worker 2>/dev/null | sed -n 's/.*| //p' | tail -1)"
sdk_version="$(sed -n 's/.*"@anthropic-ai\/claude-agent-sdk": "\([^"]*\)".*/\1/p' \
  packages/adapters/runtimes/claude/package.json)"
{
  echo "command: tests/e2e/run.sh${real_model:+ --real-model}"
  echo "tested_sha: ${sha} (uncommitted paths: ${dirty})"
  echo "docker_engine: ${docker_version}"
  echo "api_image: ${API_IMAGE} $(image_id "$API_IMAGE")"
  echo "worker_image: ${WORKER_IMAGE} $(image_id "$WORKER_IMAGE")"
  echo "egress_proxy_image: ${EGRESS_PROXY_IMAGE} $(image_id "$EGRESS_PROXY_IMAGE")"
  echo "claude_agent_sdk: ${sdk_version}"
  echo "claude_code: ${claude_version}"
  if [ -n "$real_model" ]; then
    echo "model: $(sed -n 's/^ *model: //p' config/real-model/profiles.yaml)"
    echo "provider_endpoint: $(sed -n 's/^ *endpoint: //p' config/real-model/profiles.yaml)"
    echo "session_cost_limit_usd: $(sed -n 's/^ *SESSION_COST_LIMIT_USD: "\(.*\)"$/\1/p' infra/compose.real-model.yml)"
  fi
} | tee "$out/record.txt" >&2

export E2E_API_URL="http://127.0.0.1:$(dc port api 3000 | sed 's/.*://')"
export E2E_API_KEY="$api_key"
export E2E_MESSAGES_URL="http://127.0.0.1:$(dc port fake-messages 4011 | sed 's/.*://')"
if [ "${E2E_UP_ONLY:-0}" = 1 ]; then
  export E2E_KEEP=1
  # Holds the API key, so only here and never in a CI artifact.
  export -p | grep -E ' (E2E_[A-Z_]*|DOCKER_HOST|EXECUTION_INSTALLATION_ID|[A-Z_]+_IMAGE)=' >"$out/vars.sh"
  echo "stack up: source $out/vars.sh" >&2
  exit 0
fi

echo "== tests/e2e" >&2
set +e
if [ -n "$real_model" ]; then
  suites=(./tests/e2e/real-model.e2e.ts)
else
  suites=(./tests/e2e/alpha-path.e2e.ts ./tests/e2e/pause-coverage.e2e.ts)
fi
# The suites drive the public API and never need the provider key.
env -u ANTHROPIC_API_KEY bun test "${suites[@]}" --timeout 900000 \
  --reporter=junit --reporter-outfile="$out/junit.xml" 2>&1 | tee "$out/test.log"
status="${PIPESTATUS[0]}"
set -e
# Bun exits 0 when every test skipped, which is what a missing variable
# looks like; so the run passes on the counts, not on the exit code alone.
count() { sed -n "s/^ *\([0-9][0-9]*\) $1\$/\1/p" "$out/test.log" | tail -1; }
pass="$(count pass)"
skip="$(count skip)"
fail="$(count fail)"
{
  echo "tests: pass=${pass:-?} skip=${skip:-0} fail=${fail:-?}"
  echo "skipped:"
  grep -E '^\(skip\)' "$out/test.log" || echo "  (none)"
  # Bun prints only failures when not on a terminal; the junit file names
  # every test that ran, with its time in seconds.
  echo "ran:"
  sed -n 's/.*<testcase name="\([^"]*\)" classname="\([^"]*\)" time="\([^"]*\)".*/  \2 > \1 (\3s)/p' \
    "$out/junit.xml" 2>/dev/null || true
} | tee -a "$out/record.txt" >&2
[ "$status" = 0 ] || exit "$status"
[ "${skip:-0}" = 0 ] || { echo "e2e: ${skip} test(s) skipped" >&2; exit 1; }
[ "${pass:-0}" -gt 0 ] || { echo "e2e: nothing passed" >&2; exit 1; }

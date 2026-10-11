#!/usr/bin/env bash
# Start a verification stack of its own: scripts/local.sh up --fake-model
# under a fresh compose project, with every host port ephemeral (loopback)
# and a bootstrap token this run chose. Prints the run directory on stdout
# and the run id on stderr; every later step names that run.
#
#   up.sh            new project verify-ap-<run id>
set -euo pipefail

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
root=${VERIFY_AP_ROOT:-$(t=${TMPDIR:-/tmp}; echo "${t%/}")/verify-agent-platform}
run_id=$(date +%Y%m%d-%H%M%S)-$$
run="$root/$run_id"
project="verify-ap-$(echo "$run_id" | tr -cd 'a-z0-9-')"
mkdir -p "$run/evidence"
chmod 700 "$run"

# The same overrides as tests/e2e/compose.yml: ephemeral loopback ports, so
# this stack never fights another one (this machine's 3000 may be taken).
# The token is a throwaway for this run's empty database only.
token=$(openssl rand -hex 24)
umask 077
cat >"$run/ports.yml" <<EOF
services:
  postgres:
    ports: !override
      - "127.0.0.1::5432"
  localstack:
    ports: !override
      - "127.0.0.1::4566"
  secrets:
    ports: !override []
  gitea:
    ports: !override
      - "127.0.0.1::3000"
  api:
    ports: !override
      - "127.0.0.1::3000"
    environment:
      BOOTSTRAP_TOKEN: "$token"
EOF

{
  printf 'VERIFY_RUN=%q\n' "$run"
  printf 'VERIFY_REPO=%q\n' "$repo"
  printf 'export COMPOSE_PROJECT_NAME=%q\n' "$project"
  printf 'export EXECUTION_INSTALLATION_ID=%q\n' "$project"
  printf 'export COMPOSE_FILE=%q\n' "$repo/compose.yaml:$run/ports.yml"
  # Per-run tags, as tests/e2e/run.sh does: the scheduler starts workers from
  # WORKER_IMAGE, so a shared :dev tag would let another stack's build
  # change what this one runs (and the reverse).
  printf 'export API_IMAGE=%q\n' "agent-platform-control-host:$project"
  printf 'export WORKER_IMAGE=%q\n' "agent-platform-worker:$project"
  printf 'export EGRESS_PROXY_IMAGE=%q\n' "agent-platform-egress-proxy:$project"
  printf 'VERIFY_BOOTSTRAP_TOKEN=%q\n' "$token"
  printf 'VERIFY_BUILT_FROM=%q\n' "$("$repo/.claude/skills/verify-agent-platform/scripts/tree-id.sh" "$repo")"
} >"$run/state.env"
echo "run: $run (project $project)" >&2
echo "run id: $run_id  (record it; later: lib.sh $run_id, doctor.sh $run_id, down.sh $run_id)" >&2

# shellcheck disable=SC1091
. "$run/state.env"
"$repo/scripts/local.sh" up --fake-model 2>&1 | tee "$run/evidence/up.log" >&2

api=$(docker compose --profile apps port api 3000 | head -n 1)
echo "VERIFY_API=http://127.0.0.1:${api##*:}" >>"$run/state.env"
echo "run id: $run_id" >&2
echo "$run"

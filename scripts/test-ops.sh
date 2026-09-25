#!/usr/bin/env bash
# The test-ops installation's lifecycle in one place (94S-432, docs/test-ops.md):
#
#   scripts/test-ops.sh preflight [<manifest>]  check host, checkout, settings, catalog, bucket and S3 key
#                                              (the deployed release when no manifest is named)
#   scripts/test-ops.sh deploy <manifest>       preflight, then start a release on an empty host
#   scripts/test-ops.sh upgrade <manifest> [--approve-sessions <file>]
#                                              preflight, then move to another release. A worker image
#                                              change is refused while any checkpoint is uncollected,
#                                              unless <file> lists exactly the affected sessions
#   scripts/test-ops.sh status                  containers, release, /readyz, scheduler and reconciler health, disk
#   scripts/test-ops.sh key create <owner> --scopes <scope>[,<scope>...] | key revoke <key_id>
#   scripts/test-ops.sh backup                  stop admissions and writers, scripts/backup.sh, reopen
#   scripts/test-ops.sh restore-drill <backup-dir> --bucket <new-empty-bucket> [--port-base 25432] [--keep]
#                                              restore into a new project and bucket, verify, tear the project down
#
# Settings come from one env file outside the checkout, $TEST_OPS_ENV_FILE
# (/etc/agent-platform/test-ops.env, mode 0600), which compose reads through
# --env-file; this script never sources it. State — the deployed manifest,
# upgrade approvals, backups, drill logs — goes to $TEST_OPS_STATE_DIR
# (/var/lib/agent-platform/test-ops). The compose project is
# $TEST_OPS_PROJECT (agent-platform-test-ops).
#
# Exit codes: 2 usage, 3 upgrade refused, 1 anything else.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

ENV_FILE="${TEST_OPS_ENV_FILE:-/etc/agent-platform/test-ops.env}"
STATE_DIR="${TEST_OPS_STATE_DIR:-/var/lib/agent-platform/test-ops}"
PROJECT="${TEST_OPS_PROJECT:-agent-platform-test-ops}"
CURRENT="${STATE_DIR}/current.json"
# The manifest of an upgrade that stopped the installation and did not finish.
PENDING="${STATE_DIR}/pending.json"
# project=… and installation=… of what deploy started; every later command
# must name the same.
IDENTITY="${STATE_DIR}/installation"
LOCK="${STATE_DIR}/lock"
HELPER="${REPO_ROOT}/scripts/lib/test-ops.ts"
API_URL=http://127.0.0.1:3000
MIN_ENGINE_MAJOR=28
# 2.24.6: the restore drill's overlay over an include (docker-compose.restore.yml).
MIN_COMPOSE=2.24.6
WAIT_TIMEOUT_SEC=600
EXIT_REFUSED=3

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

# --- arguments: all of them before anything touches the host ----------------
[ $# -ge 1 ] || usage
VERB="$1"
shift
MANIFEST=""
APPROVED=""
BACKUP_DIR=""
DRILL_BUCKET=""
PORT_BASE=25432
KEEP=0
case "$VERB" in
  preflight)
    [ $# -le 1 ] || usage
    MANIFEST="${1:-}"
    ;;
  deploy)
    [ $# -eq 1 ] || usage
    MANIFEST="$1"
    ;;
  upgrade)
    [ $# -ge 1 ] || usage
    MANIFEST="$1"
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --approve-sessions) [ $# -ge 2 ] || usage; APPROVED="$2"; shift 2 ;;
        *) usage ;;
      esac
    done
    ;;
  status|backup)
    [ $# -eq 0 ] || usage
    ;;
  key)
    [ $# -ge 1 ] || usage
    ;;
  restore-drill)
    while [ $# -gt 0 ]; do
      case "$1" in
        --bucket) [ $# -ge 2 ] || usage; DRILL_BUCKET="$2"; shift 2 ;;
        --port-base) [ $# -ge 2 ] || usage; PORT_BASE="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -*) usage ;;
        *) [ -z "$BACKUP_DIR" ] || usage; BACKUP_DIR="$1"; shift ;;
      esac
    done
    [ -n "$BACKUP_DIR" ] && [ -n "$DRILL_BUCKET" ] || usage
    case "$PORT_BASE" in ''|*[!0-9]*) usage ;; esac
    ;;
  *) usage ;;
esac
[ -z "$APPROVED" ] || [ -r "$APPROVED" ] || die "approval file $APPROVED not found"
case "$PROJECT" in
  ""|[!a-z0-9]*|*[!a-z0-9_-]*) die "TEST_OPS_PROJECT must match [a-z0-9][a-z0-9_-]*: '$PROJECT'" ;;
  agent-platform) die "TEST_OPS_PROJECT agent-platform is the local stack's project" ;;
esac
umask 077

# EXIT runs these last registered first: a reopen or a drill teardown before
# the lock goes. Each in a subshell, so one that dies skips none of the rest,
# but the command then fails: a backup whose reopen failed left the
# installation stopped.
CLEANUPS=()
on_exit() {
  local status=$? i failed=0
  for ((i = ${#CLEANUPS[@]} - 1; i >= 0; i--)); do (eval "${CLEANUPS[i]}") || failed=1; done
  if [ "$failed" = 1 ] && [ "$status" = 0 ]; then
    log "a cleanup step failed (above)"
    exit 1
  fi
}
trap on_exit EXIT

# One lifecycle command at a time per installation: a second backup or an
# upgrade would reopen the writers under a running backup. A lock left by a
# killed run names its pid; remove the directory once that run is gone.
take_lock() {
  mkdir "$LOCK" 2>/dev/null \
    || die "another test-ops command holds $LOCK ($(cat "$LOCK/pid" 2>/dev/null || echo "pid unknown")); if none runs, remove it"
  echo "$$" > "$LOCK/pid"
  CLEANUPS+=('rm -rf "$LOCK"')
}

# --- settings ------------------------------------------------------------------
check_env_file() {
  [ -f "$ENV_FILE" ] || die "env file $ENV_FILE not found (set TEST_OPS_ENV_FILE; docs/test-ops.md)"
  [ -r "$ENV_FILE" ] || die "env file $ENV_FILE is not readable by $(id -un)"
  [ -z "$(find "$ENV_FILE" -prune \( -perm -g=r -o -perm -g=w -o -perm -o=r -o -perm -o=w \))" ] \
    || die "env file $ENV_FILE is open to group or others; chmod 600 it"
  case "$(cd "$(dirname "$ENV_FILE")" && pwd -P)/" in
    "$(cd "$REPO_ROOT" && pwd -P)"/*) die "env file $ENV_FILE is inside the checkout; keep it outside" ;;
  esac
}

# Sets SOURCE_COMMIT, API_IMAGE, WORKER_IMAGE, EGRESS_PROXY_IMAGE and
# CATALOG_REVISION from a release manifest, refused unless every image is
# named by digest.
load_manifest() {
  local file="$1" out name value
  [ -r "$file" ] || die "manifest $file not found"
  out="$(bun_script "$HELPER" manifest "$file")" || die "manifest $file refused (above)"
  while IFS='=' read -r name value; do
    case "$name" in
      SOURCE_COMMIT|API_IMAGE|WORKER_IMAGE|EGRESS_PROXY_IMAGE|CATALOG_REVISION) printf -v "$name" '%s' "$value" ;;
    esac
  done < <(printf '%s\n' "$out")
}

load_current() {
  [ -r "$CURRENT" ] || die "no release is deployed ($CURRENT); deploy one first"
  if [ -e "$PENDING" ] && [ "$VERB" != status ] \
    && ! { [ "$VERB" = upgrade ] && cmp -s "$MANIFEST" "$PENDING"; }; then
    die "an upgrade to $PENDING did not finish and the installation may be stopped; rerun upgrade with that manifest"
  fi
  load_manifest "$CURRENT"
}

# The rendered installation is the one deploy started: same project, same
# installation id, whose label is how its workers are found.
check_identity() {
  local installation
  installation="$(rendered scheduler EXECUTION_INSTALLATION_ID)"
  [ -r "$IDENTITY" ] || die "$IDENTITY is missing; it is written by deploy"
  [ "$(printf 'project=%s\ninstallation=%s' "$PROJECT" "$installation")" = "$(cat "$IDENTITY")" ] \
    || die "project '$PROJECT' with installation '$installation' is not what was deployed ($(tr '\n' ' ' < "$IDENTITY")); EXECUTION_INSTALLATION_ID and TEST_OPS_PROJECT cannot change"
}

# compose on the installation's settings: the env file through --env-file,
# the release's images, and nothing else from the caller's environment,
# which compose would otherwise prefer to the env file.
ops_compose() {
  local pass=(PATH="$PATH" HOME="$HOME") name
  for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY; do
    [ -z "${!name:-}" ] || pass+=("${name}=${!name}")
  done
  env -i "${pass[@]}" API_IMAGE="$API_IMAGE" WORKER_IMAGE="$WORKER_IMAGE" EGRESS_PROXY_IMAGE="$EGRESS_PROXY_IMAGE" \
    docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" --profile apps \
    -f "${REPO_ROOT}/infra/compose.core.yml" -f "${REPO_ROOT}/infra/compose.test-ops.yml" "$@"
}

# The installation as its containers get it. Held in memory only: it
# carries the secrets.
render() {
  RENDER="$(ops_compose config --format json)" || die "compose refused the installation's settings (above)"
}

# One value a service gets, for the settings that are not secrets.
rendered() {
  printf '%s' "$RENDER" | jq -r --arg s "$1" --arg n "$2" '.services[$s].environment[$n] // empty'
}

# `with_render <command> [args]`: scripts/lib/test-ops.ts with the render on
# stdin. stdout goes through a file, as bun_script explains.
with_render() {
  local out status=0
  out="$(mktemp)"
  printf '%s' "$RENDER" | bun run "$HELPER" "$@" >"$out" 2> >(cat >&2) || status=$?
  cat "$out"
  rm -f "$out"
  return "$status"
}

# Runs a backup/restore script on the API's own S3 settings, AWS S3 itself:
# no endpoint, and no profile or session token of the caller's.
with_api_store() {
  local region key_id key
  region="$(rendered api AWS_REGION)"
  key_id="$(rendered api AWS_ACCESS_KEY_ID)"
  key="$(rendered api AWS_SECRET_ACCESS_KEY)"
  env -u AWS_ENDPOINT_URL -u AWS_SESSION_TOKEN -u AWS_PROFILE \
    AWS_REGION="$region" AWS_ACCESS_KEY_ID="$key_id" AWS_SECRET_ACCESS_KEY="$key" "$@"
}

# --- preflight -------------------------------------------------------------------
# Is version $1 (like 28.3.2, v2.39.1 or 2.24.6-desktop.1) at least $2 (x.y.z)?
version_at_least() {
  local IFS=. i have_part want_part
  # shellcheck disable=SC2206 # split on the dots
  local -a have=(${1#v}) want=($2)
  for i in 0 1 2; do
    have_part=${have[i]:-0}
    have_part=${have_part%%[!0-9]*}
    want_part=${want[i]:-0}
    [ "${have_part:-0}" -eq "$want_part" ] || { [ "${have_part:-0}" -gt "$want_part" ]; return; }
  done
}

# The loaded manifest against this host. The workspace quota itself is the
# scheduler's own probe at startup (deploy and upgrade wait for it).
preflight() {
  local head engine compose_version
  require_tools docker jq bun git curl
  head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [ "$head" = "$SOURCE_COMMIT" ] \
    || die "the checkout is at $head, the manifest's source_commit is $SOURCE_COMMIT; check that commit out first"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] \
    || die "the checkout has local changes; the compose files must be the release's"
  engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" || die "cannot reach the Docker daemon"
  version_at_least "$engine" "${MIN_ENGINE_MAJOR}.0.0" \
    || die "Docker Engine $engine is too old; worker networks need $MIN_ENGINE_MAJOR or newer (gateway_mode_ipv4=isolated)"
  compose_version="$(docker compose version --short 2>/dev/null)" || die "docker compose (v2) is not installed"
  version_at_least "$compose_version" "$MIN_COMPOSE" || die "docker compose $compose_version is too old; $MIN_COMPOSE or newer"
  render
  # Before the bucket is touched with what may be another installation's settings.
  [ ! -e "$IDENTITY" ] || check_identity
  with_render check-render --catalog-revision "$CATALOG_REVISION" >/dev/null \
    || die "the settings are not a test-ops installation's (above)"
  with_render probe-store || die "the bucket or the API's S3 key failed (above)"
  log "preflight: passed — Docker Engine $engine, compose $compose_version, source $SOURCE_COMMIT, catalog $CATALOG_REVISION"
}

# --- lifecycle -------------------------------------------------------------------
readyz() { curl -sS --max-time 3 "$API_URL/readyz" 2>/dev/null || true; }

# Starts what is not running and waits for every healthcheck, the
# scheduler's included: its first pass runs the network isolation and
# workspace quota probes.
start_apps() {
  if ! ops_compose up -d --wait --wait-timeout "$WAIT_TIMEOUT_SEC" "$@" api scheduler reconciler; then
    log "the installation did not become healthy; last scheduler and api log lines:"
    ops_compose logs --no-color --tail 30 scheduler api >&2 || true
    die "start failed; the scheduler's quota or network preflight is the usual cause (docs/test-ops.md)"
  fi
  log "readyz: $(readyz)"
}

# Admissions stop with the api, the only way in; the scheduler and the
# reconciler follow, then the workers the scheduler launched, which outlive
# it. backup.sh checks for itself that none is left.
stop_writers() {
  local installation workers
  installation="$(rendered scheduler EXECUTION_INSTALLATION_ID)"
  [ -n "$installation" ] || die "no EXECUTION_INSTALLATION_ID; cannot tell this installation's workers apart"
  log "stopping admissions and writers: api, scheduler, reconciler"
  ops_compose stop api scheduler reconciler
  workers="$(docker ps -q --filter "label=agent-platform.installation=${installation}")" \
    || die "docker ps failed; cannot tell whether workers of installation $installation run"
  if [ -n "$workers" ]; then
    log "stopping $(printf '%s\n' "$workers" | grep -c .) worker container(s) of installation $installation"
    printf '%s\n' "$workers" | xargs docker stop >/dev/null
  fi
}

# stop_writers stops every worker carrying the installation id, so a new
# installation must not share one with anything already on the daemon.
in_use_by_others() {
  local installation found
  installation="$(rendered scheduler EXECUTION_INSTALLATION_ID)"
  found="$(docker ps -aq --filter "label=agent-platform.installation=${installation}" \
    && docker ps -aq --filter "label=agent-platform.egress-proxy=${installation}")" \
    || die "docker ps failed; cannot tell whether installation id $installation is in use"
  [ -z "$found" ] \
    || die "containers on this daemon already carry installation id $installation; pick another EXECUTION_INSTALLATION_ID"
}

# What stop_writers stopped, started again as it was: nothing is recreated.
reopen() {
  log "reopening"
  start_apps --no-recreate
}

# Back to the release current.json names, after an upgrade stopped short.
reopen_current() {
  reopen
  rm -f "$PENDING"
}

record_release() {
  local file="$1" verb="$2"
  cp "$file" "${CURRENT}.new" && mv "${CURRENT}.new" "$CURRENT"
  printf '%s %s by %s: source %s worker %s catalog %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verb" "$(id -un)" \
    "$SOURCE_COMMIT" "$WORKER_IMAGE" "$CATALOG_REVISION" >> "${STATE_DIR}/history.log"
}

# Sessions with a checkpoint no collection has ended, one id per line.
uncollected_sessions() {
  ops_compose exec -T postgres psql -v ON_ERROR_STOP=1 -X -q -At \
    -U "$(rendered postgres POSTGRES_USER)" -d "$(rendered postgres POSTGRES_DB)" \
    -c "SELECT DISTINCT session_id FROM checkpoints WHERE collected_at IS NULL ORDER BY 1" </dev/null
}

deploy() {
  take_lock
  [ ! -e "$CURRENT" ] || die "a release is already deployed ($CURRENT); use upgrade"
  ! project_has_resources "$PROJECT" \
    || die "project '$PROJECT' already has containers, volumes or networks while $CURRENT names no release"
  load_manifest "$MANIFEST"
  preflight
  in_use_by_others
  printf 'project=%s\ninstallation=%s' "$PROJECT" "$(rendered scheduler EXECUTION_INSTALLATION_ID)" > "$IDENTITY"
  start_apps
  record_release "$MANIFEST" deploy
  log "deploy: done — issue a key with scripts/test-ops.sh key create <owner> --scopes sessions:read,sessions:write"
}

upgrade() {
  local from_worker from_catalog affected approved_list status=0
  take_lock
  load_current
  from_worker="$WORKER_IMAGE"
  from_catalog="$CATALOG_REVISION"
  load_manifest "$MANIFEST"
  [ -r "$IDENTITY" ] || die "$IDENTITY is missing; it is written by deploy"
  preflight
  affected="${STATE_DIR}/upgrade-$(date -u +%Y%m%dT%H%M%SZ).sessions"
  gate() {
    bun_script "$HELPER" upgrade-gate "$from_worker" "$WORKER_IMAGE" "$affected" ${APPROVED:+"$APPROVED"}
  }
  # First with the writers up, so a refusal costs no downtime.
  uncollected_sessions > "$affected" || die "could not list the sessions with uncollected checkpoints"
  gate >/dev/null || status=$?
  if [ "$status" = "$EXIT_REFUSED" ]; then
    log "upgrade: affected sessions are in $affected; after review, rerun with --approve-sessions <a file of exactly those ids>"
    exit "$EXIT_REFUSED"
  fi
  [ "$status" = 0 ] || die "upgrade gate failed"
  # From here until the new release is up and recorded, every command but
  # status and this same upgrade refuses: what runs may be neither release.
  cp "$MANIFEST" "$PENDING"
  if [ "$WORKER_IMAGE" != "$from_worker" ]; then
    # Again with no writer left: a checkpoint committed meanwhile, or by a
    # worker of the old image still running, is either on the approved list
    # or stops the upgrade.
    stop_writers
    uncollected_sessions > "$affected" || { reopen_current; die "could not list the sessions with uncollected checkpoints"; }
    status=0
    approved_list="$(gate)" || status=$?
    if [ "$status" != 0 ]; then
      log "upgrade: the affected sessions changed while writers stopped; reopening the current release"
      reopen_current
      exit "$EXIT_REFUSED"
    fi
  fi
  if [ -n "$approved_list" ]; then
    jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg operator "$(id -un)" \
      --arg from "$from_worker" --arg to "$WORKER_IMAGE" --arg file "$APPROVED" \
      --arg sessions "$approved_list" \
      '{at: $at, operator: $operator, from_worker: $from, to_worker: $to, approval_file: $file,
        sessions: ($sessions | split("\n"))}' \
      > "${STATE_DIR}/approvals/$(date -u +%Y%m%dT%H%M%SZ)-upgrade.json"
    log "upgrade: $(printf '%s\n' "$approved_list" | grep -c .) session(s) approved to become INCOMPATIBLE_CHECKPOINT; recorded in ${STATE_DIR}/approvals"
  fi
  start_apps
  # The API reads the catalog once at startup; a bind mount's new contents
  # recreate nothing on their own.
  [ "$CATALOG_REVISION" = "$from_catalog" ] \
    || ops_compose up -d --wait --wait-timeout "$WAIT_TIMEOUT_SEC" --force-recreate --no-deps api
  record_release "$MANIFEST" upgrade
  rm -f "$PENDING"
  log "upgrade: done"
}

status_report() {
  local role root
  load_current
  render
  check_identity
  ops_compose ps
  echo "release: $(jq -c . "$CURRENT")"
  [ ! -e "$PENDING" ] || echo "UNFINISHED upgrade to: $(jq -c . "$PENDING")"
  echo "readyz: $(readyz)"
  for role in scheduler reconciler; do
    if ops_compose exec -T "$role" bun run apps/control-host/src/main.ts "$role" --health </dev/null >/dev/null 2>&1; then
      echo "$role: healthy"
    else
      echo "$role: UNHEALTHY (docker compose logs $role)"
    fi
  done
  echo "sessions with uncollected checkpoints: $(uncollected_sessions | grep -c . || true)"
  root="$(docker info --format '{{.DockerRootDir}}')"
  df -h "$root"
}

key() {
  load_current
  render
  check_identity
  ops_compose exec -T api bun run apps/control-host/src/api/keys.ts "$@" </dev/null
}

backup() {
  local bucket
  take_lock
  load_current
  render
  check_identity
  bucket="$(rendered api S3_BUCKET)"
  CLEANUPS+=(reopen)
  stop_writers
  with_api_store "${REPO_ROOT}/scripts/backup.sh" --project "$PROJECT" --out "${STATE_DIR}/backups" \
    --bucket "$bucket" --object-store env
}

restore_drill() {
  local log_file status=0
  take_lock
  load_current
  render
  check_identity
  # Globals, not locals: the cleanup reads them at exit, and an empty
  # project name would make compose fall back to the local stack's.
  DRILL="${PROJECT}-drill-$(date -u +%Y%m%dt%H%M%Sz)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  ! project_has_resources "$DRILL" || die "project $DRILL already exists"
  log_file="${STATE_DIR}/restore-drills/${DRILL}.log"
  # restore.sh runs migrate from the local layer, which would build the
  # control-host image from this checkout. The released one, under the name
  # compose looks for first, is what this installation migrates with.
  MIGRATE_IMAGE="${DRILL}-migrate"
  docker tag "$API_IMAGE" "$MIGRATE_IMAGE"
  # With --keep the drill's containers still use it; the tag then stays.
  CLEANUPS+=('docker rmi "$MIGRATE_IMAGE" >/dev/null 2>&1 || true')
  [ "$KEEP" = 1 ] \
    || CLEANUPS+=('docker compose -p "$DRILL" -f "${REPO_ROOT}/infra/docker-compose.yml" down -v >/dev/null 2>&1')
  log "restore-drill: $BACKUP_DIR into project $DRILL and bucket $DRILL_BUCKET; log $log_file"
  {
    with_api_store "${REPO_ROOT}/scripts/restore.sh" "$BACKUP_DIR" --into "$DRILL" --object-store env \
      --bucket "$DRILL_BUCKET" --port-base "$PORT_BASE" \
      && with_api_store "${REPO_ROOT}/scripts/verify-restore.sh" --project "$DRILL" --object-store env \
        --bucket "$DRILL_BUCKET"
  } 2>&1 | tee "$log_file" || status=$?
  if [ "$status" = 0 ]; then
    echo "restore-drill: PASSED" | tee -a "$log_file"
  else
    echo "restore-drill: FAILED (exit $status)" | tee -a "$log_file"
  fi
  printf '%s restore-drill by %s: %s from %s into %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" \
    "$([ "$status" = 0 ] && echo passed || echo FAILED)" "$BACKUP_DIR" "$DRILL_BUCKET" "$log_file" \
    >> "${STATE_DIR}/history.log"
  [ "$KEEP" = 0 ] || log "restore-drill: kept project $DRILL; tear it down with docker compose -p $DRILL -f infra/docker-compose.yml down -v"
  return "$status"
}

check_env_file
case "$VERB" in
  deploy|upgrade|backup|restore-drill)
    mkdir -p "${STATE_DIR}/approvals" "${STATE_DIR}/backups" "${STATE_DIR}/restore-drills" \
      || die "cannot create the state directory $STATE_DIR (TEST_OPS_STATE_DIR)"
    ;;
esac
case "$VERB" in
  preflight)
    if [ -n "$MANIFEST" ]; then load_manifest "$MANIFEST"; else load_current; fi
    preflight
    ;;
  deploy) deploy ;;
  upgrade) upgrade ;;
  status) status_report ;;
  key) key "$@" ;;
  backup) backup ;;
  restore-drill) restore_drill ;;
esac

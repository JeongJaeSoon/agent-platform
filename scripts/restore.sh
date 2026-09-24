#!/usr/bin/env bash
# Restores a scripts/backup.sh bundle into a NEW compose project.
#
# The target project must not exist: no container, volume or network may carry
# its label, so an existing installation can never be overwritten. Ports are
# bound on loopback from --port-base (postgres, localstack, gitea http, gitea
# ssh = base, base+1, base+2, base+3).
#
# The objects go into a bucket that must be new as well: versioned, Object
# Lock, SSE-S3 by default, and without a single object version or delete
# marker. --object-store localstack (default) uses the new project's own
# LocalStack and the backup's bucket name, creating the bucket if its init
# did not. --object-store env uses the store the environment names
# (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL
# unless it is AWS S3) and needs --bucket; the new project then runs no
# LocalStack. A bucket the backup was taken from is refused there before
# anything else is looked at.
#
# Checkpoint objects get new VersionIds in the new bucket; every checkpoint
# is re-pinned to them and held, so the restored API runs `locked`.
#
# Refusals, by exit code: 2 usage, 3 schema mismatch (the backup's applied
# migrations are not exactly this checkout's), 4 target project or bucket
# not new. A failed re-pin exits 1 and leaves a target to tear down, not to
# retry.
#
# Usage: scripts/restore.sh <backup-dir> --into <project> [--port-base 25432] [--check-only]
#                           [--object-store localstack|env] [--bucket <name>]

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

BACKUP=""
INTO=""
PORT_BASE=25432
CHECK_ONLY=0
BUCKET=""

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --into) INTO="$2"; shift 2 ;;
    --port-base) PORT_BASE="$2"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --object-store) set_object_store "$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) log "unknown argument: $1"; usage ;;
    *) [ -z "$BACKUP" ] || usage; BACKUP="$1"; shift ;;
  esac
done
[ -n "$BACKUP" ] && [ -n "$INTO" ] || usage
[ -d "$BACKUP" ] || die "backup directory not found: $BACKUP"
BACKUP="$(cd "$BACKUP" && pwd)"
# Compose's own rule: lowercase alphanumerics, `_` and `-`, starting with a
# letter or digit.
case "$INTO" in
  ""|[!a-z0-9]*|*[!a-z0-9_-]*) die "project name must match [a-z0-9][a-z0-9_-]*: '$INTO'" ;;
esac
case "$PORT_BASE" in
  ''|*[!0-9]*) die "--port-base must be a number" ;;
esac
[ "$OBJECT_STORE" != env ] || [ -n "$BUCKET" ] || die "--object-store env needs --bucket, a new empty bucket"

require_tools docker jq bun

# --- preflight: never touch an existing installation -------------------------
log "restore: checking $BACKUP"
verify_checksums "$BACKUP" || die "SHA256SUMS mismatch in $BACKUP; the bundle is damaged or edited"
MANIFEST="$BACKUP/manifest.json"
schema_check "$MANIFEST" || exit "$EXIT_SCHEMA_MISMATCH"
BUCKET="${BUCKET:-$(jq -r '.objects.bucket' "$MANIFEST")}"

# `check_target [--create]`: the target bucket is new, empty and locked, or
# the restore stops with the CLI's reason; 4 when it is the source's own
# bucket or holds anything.
check_target() {
  local status=0
  object_store "$INTO" "$BUCKET" check-target "$@" || status=$?
  [ "$status" = 0 ] && return 0
  [ "$status" != "$EXIT_TARGET_NOT_EMPTY" ] || exit "$EXIT_TARGET_NOT_EMPTY"
  die "bucket $BUCKET cannot take this restore"
}
# The source's bucket, as the backup recorded it; an older backup has no
# endpoint, and then the name alone decides.
SOURCE_ARGS=(--source-bucket "$(jq -r '.objects.bucket' "$MANIFEST")")
SOURCE_ENDPOINT="$(jq -r '.objects.endpoint // empty' "$MANIFEST")"
[ -z "$SOURCE_ENDPOINT" ] || SOURCE_ARGS+=(--source-endpoint "$SOURCE_ENDPOINT")
# An outside store exists before the project does, so it is checked before
# docker is: a live bucket is refused without a container started.
[ "$OBJECT_STORE" != env ] || check_target "${SOURCE_ARGS[@]}"
if project_has_resources "$INTO"; then
  log "restore: project '$INTO' already has containers, volumes or networks; pick an unused name"
  exit "$EXIT_TARGET_NOT_EMPTY"
fi
# The check above is a look, not a reservation: two restores into one name
# could both pass it. `docker network create` refuses a duplicate name, so
# it doubles as a daemon-wide lock held until this run ends, by which time
# the compose resources themselves keep the name taken.
LOCK="${INTO}-restore-lock"
if [ "$CHECK_ONLY" != 1 ]; then
  if ! docker network create "$LOCK" >/dev/null 2>&1; then
    log "restore: another restore into '$INTO' is in progress (network $LOCK exists)"
    exit "$EXIT_TARGET_NOT_EMPTY"
  fi
  trap 'docker network rm "$LOCK" >/dev/null 2>&1 || true' EXIT
fi
[ "$INTO" != "$(jq -r '.source.project' "$MANIFEST")" ] \
  || log "restore: warning — target name equals the source project name; it is empty on this daemon, continuing"
if [ "$CHECK_ONLY" = 1 ]; then
  log "restore: checks passed (--check-only), nothing started"
  exit 0
fi

# The fresh postgres must create the database the dump was taken from, not
# whatever POSTGRES_DB/POSTGRES_USER the restoring shell happens to carry.
export POSTGRES_DB="$(jq -r '.db.name' "$MANIFEST")"
export POSTGRES_USER="$(jq -r '.db.user // "postgres"' "$MANIFEST")"
export RESTORE_POSTGRES_PORT="$PORT_BASE"
export RESTORE_LOCALSTACK_PORT="$((PORT_BASE + 1))"
export RESTORE_GITEA_HTTP_PORT="$((PORT_BASE + 2))"
export RESTORE_GITEA_SSH_PORT="$((PORT_BASE + 3))"

# --- fresh services ----------------------------------------------------------
SERVICES=(postgres gitea)
[ "$OBJECT_STORE" = env ] || SERVICES+=(localstack)
log "restore: starting ${SERVICES[*]} as project '$INTO' (ports ${RESTORE_POSTGRES_PORT}..${RESTORE_GITEA_SSH_PORT})"
compose_restore "$INTO" up -d --wait "${SERVICES[@]}"

# --- database ----------------------------------------------------------------
# The override dropped the init SQL mounts, so the database is empty apart
# from what the image creates; the dump carries schema, data and journal.
TABLES="$(psql_in "$INTO" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")"
[ "$TABLES" = "0" ] || die "fresh database already has $TABLES tables; the restore override did not apply"
psql_in "$INTO" --single-transaction < "$BACKUP/db.sql" >/dev/null
# The dump's journal must say what the manifest said, or the two were taken
# from different databases.
RESTORED_APPLIED="$(psql_in "$INTO" -Atc "SELECT hash || ' ' || created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")"
[ "$RESTORED_APPLIED" = "$(jq -r '.schema.applied[] | "\(.hash) \(.when)"' "$MANIFEST")" ] \
  || die "restored drizzle journal differs from manifest.json schema.applied"
log "restore: db.sql applied ($(psql_in "$INTO" -Atc "SELECT count(*) FROM sessions") sessions, $(psql_in "$INTO" -Atc "SELECT count(*) FROM checkpoints") checkpoints)"

# --- objects -----------------------------------------------------------------
# Every object gets a new VersionId here, and the checkpoints name the old
# ones. The manifests those rows name are left out of the sync and written
# once, re-pinned to the new versions, by `checkpoint_pins repin` below
# (docs/backup-restore.md, "checkpoint 객체의 version").
MANIFEST_KEYS="$(psql_in "$INTO" -Atc "SELECT DISTINCT manifest_ref FROM checkpoints WHERE collected_at IS NULL ORDER BY 1")"
SKIP_KEYS="$(mktemp)"
trap 'rm -f "$SKIP_KEYS"; docker network rm "$LOCK" >/dev/null 2>&1 || true' EXIT
printf '%s\n' "$MANIFEST_KEYS" > "$SKIP_KEYS"
# Checked again right before the first write: an outside bucket may have
# been written to since the preflight. The project's own LocalStack made the
# bucket at init, or gets it made here.
if [ "$OBJECT_STORE" = env ]; then
  check_target "${SOURCE_ARGS[@]}"
else
  check_target --create
fi
# Create-only: a key someone wrote meanwhile stops the upload.
object_store "$INTO" "$BUCKET" upload "$BACKUP/objects" "$SKIP_KEYS" >/dev/null \
  || die "objects could not be uploaded to $BUCKET; project '$INTO' is unusable — tear it down and restore into a fresh project and bucket"
# Nothing above can be undone once the re-pin starts writing: a refusal
# leaves a target that must be torn down, never promoted or retried.
checkpoint_pins "$INTO" "$BUCKET" repin "$BACKUP/objects" >/dev/null \
  || die "checkpoint re-pin failed; project '$INTO' is unusable — tear it down and restore into a fresh project"
EXPECTED_OBJECTS="$(jq -r '.objects.count' "$MANIFEST")"
RESTORED_OBJECTS="$(object_store "$INTO" "$BUCKET" count)" || die "could not count the objects in $BUCKET"
[ "$RESTORED_OBJECTS" = "$EXPECTED_OBJECTS" ] \
  || die "object count after sync and re-pin is $RESTORED_OBJECTS, manifest says $EXPECTED_OBJECTS"
log "restore: $RESTORED_OBJECTS objects in $BUCKET, $(printf '%s\n' "$MANIFEST_KEYS" | grep -c . || true) checkpoint manifests re-pinned and held"

# --- gitea -------------------------------------------------------------------
# Gitea wrote a fresh app.ini and gitea.db on first start; both are replaced
# with the backup's while it is stopped, then the bare repositories are
# recreated from their bundles and the hooks regenerated so pushes are seen.
GITEA_CID="$(compose_restore "$INTO" ps -q gitea)"
GITEA_VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$GITEA_CID")"
[ -n "$GITEA_VOLUME" ] || die "gitea container has no volume mounted at /data"
EMPTY_REPOS="$(jq -r '.repos.empty[] | "\(.name) \(.head)"' "$MANIFEST")"
BUNDLED_HEADS="$(jq -r '.repos.bundled[] | "\(.name) \(.head)"' "$MANIFEST")"
# Staged into the volume while the container runs (docker cp cannot create
# directories in a stopped one), then moved into place by a throwaway
# container on the same volume so nothing touches gitea.db while Gitea has
# it open.
compose_restore "$INTO" exec -T gitea mkdir -p "/data/restore-stage/repos" "/data/restore-stage/gitea"
docker cp "$BACKUP/repos/." "${GITEA_CID}:/data/restore-stage/repos/"
docker cp "$BACKUP/gitea/." "${GITEA_CID}:/data/restore-stage/gitea/"
compose_restore "$INTO" stop gitea >/dev/null
docker run --rm -v "${GITEA_VOLUME}:/data" alpine:3 sh -c "
  set -eu
  cp /data/restore-stage/gitea/gitea.db /data/gitea/gitea.db
  cp /data/restore-stage/gitea/app.ini /data/gitea/conf/app.ini
  chown -R 1000:1000 /data/gitea/gitea.db /data/gitea/conf/app.ini /data/restore-stage
" >/dev/null
compose_restore "$INTO" up -d --wait gitea >/dev/null
STAGE=/data/restore-stage
compose_restore "$INTO" exec -T -u git gitea sh -s -- "$STAGE" "$EMPTY_REPOS" "$BUNDLED_HEADS" <<'EOF'
set -eu
stage="$1"
empty="$2"
heads="$3"
# Empty repositories get their recorded HEAD below; this only silences the
# hint git prints for an init without one.
export GIT_CONFIG_PARAMETERS="'init.defaultBranch=main'"
mkdir -p /data/git/repositories
for bundle in "$stage"/repos/*/*.bundle; do
  [ -f "$bundle" ] || continue
  owner="$(basename "$(dirname "$bundle")")"
  name="$(basename "$bundle" .bundle)"
  target="/data/git/repositories/$owner/$name.git"
  [ ! -e "$target" ] || { echo "refusing to overwrite $target" >&2; exit 1; }
  mkdir -p "/data/git/repositories/$owner"
  git clone --quiet --mirror "$bundle" "$target"
  git -C "$target" bundle verify "$bundle" >/dev/null 2>&1
  # The clone's origin is the stage path, gone in a moment; the source
  # repository had no such remote either.
  git -C "$target" remote remove origin
  head="$(printf '%s\n' "$heads" | awk -v r="$owner/$name" '$1 == r { print $2 }')"
  case "$head" in
    ""|detached) ;;
    *) git -C "$target" symbolic-ref HEAD "$head" ;;
  esac
done
printf '%s\n' "$empty" | while read -r repo head; do
  [ -n "$repo" ] || continue
  target="/data/git/repositories/$repo.git"
  [ ! -e "$target" ] || { echo "refusing to overwrite $target" >&2; exit 1; }
  mkdir -p "$(dirname "$target")"
  git init --quiet --bare "$target"
  git -C "$target" symbolic-ref HEAD "$head"
done
gitea admin regenerate hooks >/dev/null
EOF
# /data itself is root-owned, so the stage directory goes away as root.
compose_restore "$INTO" exec -T gitea rm -rf "$STAGE"
compose_restore "$INTO" restart gitea >/dev/null
compose_restore "$INTO" up -d --wait gitea >/dev/null
# The override's GITEA__server__* rewrite is done by the image's entrypoint,
# not by this script; if it ever stops running, the restored Gitea would
# quietly hand out the source's clone URLs.
compose_restore "$INTO" exec -T gitea cat /data/gitea/conf/app.ini </dev/null \
  | gitea_address_is "$RESTORE_GITEA_HTTP_PORT" "$RESTORE_GITEA_SSH_PORT" \
  || die "restored gitea still names another address; its clone URLs would point at the source"
log "restore: gitea data and $(jq -r '.repos.bundled | length' "$MANIFEST") bundled + $(jq -r '.repos.empty | length' "$MANIFEST") empty repositories"

# --- migration state ---------------------------------------------------------
# The schema check already proved the dump's journal equals this checkout, so
# the migrator must find nothing to do; anything else means the dump and the
# journal disagree.
MIGRATE_LOG="$(compose_restore "$INTO" run --rm -T migrate 2>&1 | tail -n 20)"
printf '%s\n' "$MIGRATE_LOG" | grep -q 'db.migrate.noop' \
  || { printf '%s\n' "$MIGRATE_LOG" >&2; die "migrate did not report noop on the restored database"; }
log "restore: migrate reports noop"

if [ "$OBJECT_STORE" = env ]; then
  STORE_LINE="objects    bucket $BUCKET at ${AWS_ENDPOINT_URL:-AWS S3}"
else
  STORE_LINE="localstack http://127.0.0.1:${RESTORE_LOCALSTACK_PORT}  (bucket $BUCKET)"
fi
cat <<EOF
restore: done — project '$INTO'
  postgres   postgresql://${POSTGRES_USER}@127.0.0.1:${RESTORE_POSTGRES_PORT}/${POSTGRES_DB}
             (password: the POSTGRES_PASSWORD this shell started the project with; compose default otherwise)
  $STORE_LINE
  gitea      http://127.0.0.1:${RESTORE_GITEA_HTTP_PORT}
  verify     scripts/verify-restore.sh --project $INTO --object-store $OBJECT_STORE --bucket $BUCKET
  start again (always with the override; the base file alone rebinds the
  source's ports while Gitea keeps advertising these ones)
             RESTORE_POSTGRES_PORT=$RESTORE_POSTGRES_PORT RESTORE_LOCALSTACK_PORT=$RESTORE_LOCALSTACK_PORT \\
             RESTORE_GITEA_HTTP_PORT=$RESTORE_GITEA_HTTP_PORT RESTORE_GITEA_SSH_PORT=$RESTORE_GITEA_SSH_PORT \\
             POSTGRES_DB=$POSTGRES_DB POSTGRES_USER=$POSTGRES_USER \\
             docker compose -p $INTO -f infra/docker-compose.yml -f infra/docker-compose.restore.yml up -d ${SERVICES[*]}
  tear down  docker compose -p $INTO -f infra/docker-compose.yml down -v
EOF

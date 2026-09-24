#!/usr/bin/env bash
# Bundles one compose installation into backup-<ts>/:
#
#   db.sql          pg_dump of the sessions database (schema + data + journal)
#   objects/        every object in the bucket, key = path; a key a
#                   checkpoint pins holds the bytes of the pinned version
#   repos/<o>/<r>.bundle
#                   `git bundle create --all` of each Gitea bare repository
#   gitea/          gitea.db (sqlite online backup) and conf/app.ini — the
#                   bundles alone cannot tell Gitea which repositories exist
#   manifest.json   schema version (applied migrations), image digests,
#                   object and repository inventory
#   SHA256SUMS      over all of the above
#
# The source installation is only read. The writers — api, scheduler, the
# worker service and every worker container the scheduler launched — must be
# stopped: a checkpoint committed between pg_dump and the object copy has a
# pointer without its objects. The backup refuses to start while one runs;
# --allow-running-writers only warns instead.
#
# It is written to backup-<ts>.partial and renamed to backup-<ts> only once
# complete; a run that fails leaves backup-<ts>.failed.
#
# --object-store localstack (default) reads the project's LocalStack; env
# reads the store the environment names (AWS_REGION, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL unless it is AWS S3).
#
# Usage: scripts/backup.sh [--project agent-platform] [--out backups] [--bucket claude-sessions]
#                          [--object-store localstack|env] [--allow-running-writers]

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

PROJECT=agent-platform
OUT="${REPO_ROOT}/backups"
BUCKET=claude-sessions
ALLOW_RUNNING_WRITERS=0

usage() {
  sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --object-store) set_object_store "$2"; shift 2 ;;
    --allow-running-writers) ALLOW_RUNNING_WRITERS=1; shift ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
done

require_tools docker jq bun

STORES=(postgres gitea)
[ "$OBJECT_STORE" = env ] || STORES+=(localstack)
for service in "${STORES[@]}"; do
  [ -n "$(compose "$PROJECT" ps -q --status running "$service")" ] \
    || die "service '$service' of project '$PROJECT' is not running"
done
# pg_dump is consistent on its own; the objects and repositories are copied
# afterwards, so a checkpoint committed in between has a pointer without its
# object. api, scheduler and worker are found by compose's own labels, so
# a container outside the active profiles still counts. The scheduler's
# workers carry its installation label. With no scheduler container left,
# the installation cannot be named, so a running container of any
# installation counts.
service_containers() {
  local service="$1"
  shift
  docker ps -q "$@" --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=${service}"
}
WRITERS=""
for service in api scheduler worker; do
  running="$(service_containers "$service")" \
    || die "docker ps failed; cannot tell whether '$service' of project '$PROJECT' runs"
  [ -z "$running" ] || WRITERS="$WRITERS $service"
done
SCHEDULER="$(service_containers scheduler -a | head -n1)" || die "docker ps failed; cannot find the scheduler of project '$PROJECT'"
INSTALLATION=""
if [ -n "$SCHEDULER" ]; then
  INSTALLATION="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SCHEDULER" \
    | sed -n 's/^EXECUTION_INSTALLATION_ID=//p' | head -n1)" \
    || die "cannot read the installation id of the scheduler of project '$PROJECT'"
fi
if [ -n "$INSTALLATION" ]; then
  LABEL="agent-platform.installation=${INSTALLATION}"
  WORKERS_OF="installation ${INSTALLATION}"
else
  LABEL="agent-platform.installation"
  WORKERS_OF="any installation (project '$PROJECT' names none)"
fi
WORKERS="$(docker ps -q --filter "label=${LABEL}")" \
  || die "docker ps failed; cannot tell whether workers of ${WORKERS_OF} run"
[ -z "$WORKERS" ] || WRITERS="$WRITERS $(printf '%s\n' "$WORKERS" | grep -c .) worker container(s) of ${WORKERS_OF}"
if [ -n "$WRITERS" ]; then
  [ "$ALLOW_RUNNING_WRITERS" = 1 ] \
    || die "writers are running:${WRITERS}; stop them first (docs/backup-restore.md) or pass --allow-running-writers"
  log "backup: warning — writers are running:${WRITERS}; a checkpoint committed during the backup may be missing its objects"
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="${OUT}/backup-${TS}"
DEST="${FINAL}.partial"
umask 077
mkdir -p "$OUT"
[ ! -e "$FINAL" ] || die "refusing to overwrite existing $FINAL"
# A plain mkdir is the reservation: two backups started in the same second
# get the same name, and the one that loses the mkdir stops here instead of
# interleaving its files with the winner's.
mkdir "$DEST" 2>/dev/null || die "refusing to overwrite existing $DEST"
# Only a complete backup gets the plain name; whatever else ends this run
# leaves a name nobody can take for one.
trap 'status=$?
if [ "$status" -ne 0 ] && [ -d "$DEST" ] && [ ! -e "${FINAL}.failed" ]; then
  mv "$DEST" "${FINAL}.failed" && log "backup: failed; what it wrote is in ${FINAL}.failed"
fi' EXIT
mkdir "$DEST/objects" "$DEST/repos" "$DEST/gitea"
log "backup: project=$PROJECT store=$OBJECT_STORE -> $FINAL"

# --- database -------------------------------------------------------------
PG_USER="$(container_env "$PROJECT" postgres POSTGRES_USER)"
PG_DB="$(container_env "$PROJECT" postgres POSTGRES_DB)"
DUMP_AT="$(psql_in "$PROJECT" -Atc "SELECT clock_timestamp()")"
compose "$PROJECT" exec -T postgres pg_dump --no-owner --no-privileges -U "$PG_USER" "$PG_DB" > "$DEST/db.sql"
log "backup: db.sql $(wc -c < "$DEST/db.sql" | tr -d ' ') bytes"

# Applied migrations as the journal recorded them, for the schema check.
APPLIED_JSON="$(psql_in "$PROJECT" -Atc \
  "SELECT json_agg(json_build_object('hash', hash, 'when', created_at) ORDER BY created_at) FROM drizzle.__drizzle_migrations")"
[ -n "$APPLIED_JSON" ] && [ "$APPLIED_JSON" != "null" ] || die "drizzle.__drizzle_migrations is empty; this database was never migrated"
HEAD_WHEN="$(printf '%s' "$APPLIED_JSON" | jq -r '.[-1].when')"
HEAD_TAG="$(expected_migrations | awk -v w="$HEAD_WHEN" '$2 == w { print $3 }')"
CHECKOUT_HEAD="$(expected_migrations | tail -n1 | cut -d' ' -f3)"
if [ -z "$HEAD_TAG" ]; then
  log "backup: warning — applied head $HEAD_WHEN is not a migration this checkout knows; restore will refuse this bundle"
  HEAD_TAG="unknown-${HEAD_WHEN}"
elif [ "$HEAD_TAG" != "$CHECKOUT_HEAD" ]; then
  log "backup: warning — database head $HEAD_TAG is behind checkout head $CHECKOUT_HEAD; restore from this checkout will refuse it"
fi

# --- objects ---------------------------------------------------------------
object_store "$PROJECT" "$BUCKET" download "$DEST/objects" >/dev/null \
  || die "objects of bucket ${BUCKET} could not be downloaded"
ENDPOINT="$(object_store_endpoint "$PROJECT" "$BUCKET")"
# The download copied what each key holds now. A checkpoint names a version, and
# the key may have moved on (overwritten, delete-marked) since it committed;
# the backup must carry the bytes the checkpoint pinned, or refuse.
checkpoint_pins "$PROJECT" "$BUCKET" capture "$DEST/objects" >/dev/null \
  || die "checkpoint objects could not be backed up at the versions their checkpoints pin"
# Checkpoint GC marks a row collected_at, then deletes its objects. A row it
# marked after pg_dump's snapshot is unmarked in db.sql while its objects are
# missing from objects/, and restore's repin fails on it. The mark is one
# statement, so the minute before the dump started covers every mark the
# dump can have missed; checked after the copy, because each purge follows
# its mark.
COLLECTED="$(psql_in "$PROJECT" -Atc \
  "SELECT count(*) FROM checkpoints WHERE collected_at > timestamptz '$DUMP_AT' - interval '1 minute'")"
[ "$COLLECTED" = 0 ] \
  || die "checkpoint GC collected $COLLECTED checkpoint(s) while this backup ran, so db.sql names objects the backup lacks; back up again with checkpoint GC stopped"
OBJECT_COUNT="$(find "$DEST/objects" -type f | wc -l | tr -d ' ')"
log "backup: objects/ $OBJECT_COUNT objects from ${BUCKET} at ${ENDPOINT:-AWS S3}"

# --- gitea -----------------------------------------------------------------
# Per-process, so concurrent backups of one project do not share a stage.
STAGE="/tmp/ap-backup-${TS}-$$"
# One shell inside the container: sqlite's online backup for a consistent DB
# file, then one bundle per repository. Repositories without a single ref
# cannot be bundled (git refuses an empty bundle) and are listed instead so
# restore recreates them empty. Gitea stays up meanwhile, so the two snapshots
# are compared afterwards: a repository created, renamed or deleted between
# them shows up as a database/disk mismatch and fails the backup.
compose "$PROJECT" exec -T -u git gitea sh -s -- "$STAGE" <<'EOF'
set -eu
stage="$1"
rm -rf "$stage" && mkdir -p "$stage/repos" "$stage/gitea"
sqlite3 /data/gitea/gitea.db ".backup '$stage/gitea/gitea.db'"
cp /data/gitea/conf/app.ini "$stage/gitea/app.ini"
: > "$stage/gitea/empty-repos"
: > "$stage/gitea/bundled-repos"
for repo in /data/git/repositories/*/*.git; do
  [ -d "$repo" ] || continue
  owner="$(basename "$(dirname "$repo")")"
  name="$(basename "$repo" .git)"
  if [ -n "$(git -C "$repo" for-each-ref --count=1)" ]; then
    mkdir -p "$stage/repos/$owner"
    git -C "$repo" bundle create "$stage/repos/$owner/$name.bundle" --all >/dev/null 2>&1
    # A bundle carries HEAD as an object id only; the branch it names is
    # what a clone should point HEAD at when several branches share the tip.
    printf '%s/%s %s\n' "$owner" "$name" "$(git -C "$repo" symbolic-ref -q HEAD || echo detached)" >> "$stage/gitea/bundled-repos"
  else
    printf '%s/%s %s\n' "$owner" "$name" "$(git -C "$repo" symbolic-ref HEAD)" >> "$stage/gitea/empty-repos"
  fi
done
on_disk="$(cut -d' ' -f1 "$stage/gitea/bundled-repos" "$stage/gitea/empty-repos" | grep -v '\.wiki$' | sort)"
# Gitea keeps the owner's display casing in owner_name but lowercases the
# directory, so both sides are compared lowercased.
in_db="$(sqlite3 "$stage/gitea/gitea.db" "SELECT lower(owner_name) || '/' || lower_name FROM repository ORDER BY 1")"
if [ "$on_disk" != "$in_db" ]; then
  echo "gitea database and repository directories disagree (a repository changed during the backup?):" >&2
  echo "database: $in_db" >&2
  echo "on disk:  $on_disk" >&2
  exit 1
fi
EOF
compose "$PROJECT" cp "gitea:${STAGE}/repos/." "$DEST/repos/"
compose "$PROJECT" cp "gitea:${STAGE}/gitea/." "$DEST/gitea/"
compose "$PROJECT" exec -T -u git gitea rm -rf "$STAGE"
REPOS_JSON="$(jq -R 'split(" ") | {name: .[0], head: .[1]}' < "$DEST/gitea/bundled-repos" | jq -s 'sort_by(.name)')"
# An empty repository has no bundle, only a name and the branch HEAD points
# at, which Gitea's own metadata expects to find again after restore.
EMPTY_REPOS_JSON="$(jq -R 'split(" ") | {name: .[0], head: .[1]}' < "$DEST/gitea/empty-repos" | jq -s .)"
log "backup: repos/ $(printf '%s' "$REPOS_JSON" | jq length) bundled, $(printf '%s' "$EMPTY_REPOS_JSON" | jq length) empty"

# --- images ----------------------------------------------------------------
# api/worker/scheduler are null until the installation runs them. Restore
# does not need them; tests/e2e/restore-resume.sh compares the worker's here
# with the image of the worker that produced the checkpoint (94S-324).
IMAGES_JSON='{}'
for service in postgres localstack gitea egress-proxy api worker scheduler; do
  cid="$(compose "$PROJECT" ps -aq "$service" 2>/dev/null | head -n1 || true)"
  if [ -n "$cid" ]; then
    image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
    image_id="$(docker inspect -f '{{.Image}}' "$cid")"
    digests="$(docker image inspect -f '{{join .RepoDigests ","}}' "$image_id" 2>/dev/null || true)"
    entry="$(jq -n --arg image "$image" --arg id "$image_id" --arg digests "$digests" \
      '{status: "present", image: $image, id: $id, repo_digests: ($digests | split(",") | map(select(. != "")))}')"
  else
    # Left explicit rather than omitted: a later image build must not be
    # written back here as if it had produced this backup.
    entry='{"status": "not_built", "image": null, "id": null, "repo_digests": []}'
  fi
  IMAGES_JSON="$(printf '%s' "$IMAGES_JSON" | jq --arg s "$service" --argjson e "$entry" '. + {($s): $e}')"
done

# --- manifest --------------------------------------------------------------
jq -n \
  --argjson version "$BACKUP_MANIFEST_VERSION" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_project "$PROJECT" \
  --arg source_commit "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" \
  --argjson source_dirty "$([ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ] && echo false || echo true)" \
  --arg pg_version "$(compose "$PROJECT" exec -T postgres postgres --version | tr -d '\n')" \
  --arg gitea_version "$(compose "$PROJECT" exec -T gitea gitea --version | cut -d' ' -f1-3 | tr -d '\n')" \
  --arg head_tag "$HEAD_TAG" \
  --argjson applied "$APPLIED_JSON" \
  --arg pg_db "$PG_DB" \
  --arg pg_user "$PG_USER" \
  --arg store "$OBJECT_STORE" \
  --arg bucket "$BUCKET" \
  --arg endpoint "$ENDPOINT" \
  --argjson object_count "$OBJECT_COUNT" \
  --argjson repos "$REPOS_JSON" \
  --argjson empty_repos "$EMPTY_REPOS_JSON" \
  --argjson images "$IMAGES_JSON" \
  '{
    version: $version,
    created_at: $created_at,
    source: { project: $source_project, checkout_commit: $source_commit, checkout_dirty: $source_dirty },
    schema: { head_tag: $head_tag, applied: $applied },
    db: { name: $pg_db, user: $pg_user, file: "db.sql", server: $pg_version },
    gitea: { version: $gitea_version, dir: "gitea" },
    objects: { store: $store, bucket: $bucket, endpoint: $endpoint, count: $object_count, dir: "objects" },
    repos: { bundled: $repos, empty: $empty_repos, dir: "repos" },
    images: $images
  }' > "$DEST/manifest.json"
rm -f "$DEST/gitea/empty-repos" "$DEST/gitea/bundled-repos"

write_checksums "$DEST"
mv "$DEST" "$FINAL"
DEST="$FINAL"
log "backup: done -> $FINAL (schema head $HEAD_TAG, $OBJECT_COUNT objects)"
printf '%s\n' "$FINAL"

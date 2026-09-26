#!/usr/bin/env bash
# Shared by scripts/backup.sh, scripts/restore.sh and scripts/verify-restore.sh.
# PostgreSQL and git run inside the compose containers, so the host needs
# docker (compose v2.24.6+, for `!override` over an include), git, jq, a
# sha256 tool, and this checkout's bun: every S3 call goes through the
# production adapter on the host (`object_store`, `checkpoint_pins`), so the
# store can be the project's LocalStack or any S3-compatible one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"
RESTORE_OVERRIDE="${REPO_ROOT}/infra/docker-compose.restore.yml"
MIGRATIONS_DIR="${REPO_ROOT}/packages/db/migrations"
BACKUP_MANIFEST_VERSION=1

# Exit codes shared by the three scripts so a caller can tell refusals apart.
EXIT_USAGE=2
EXIT_SCHEMA_MISMATCH=3
EXIT_TARGET_NOT_EMPTY=4
EXIT_VERIFY_FAILED=5

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
  done
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# `compose <project> args...`: the base file only, for a running installation.
compose() {
  local project="$1"
  shift
  docker compose -p "$project" -f "$COMPOSE_FILE" "$@"
}

# Same, with the restore override layered on. Port and network variables come
# from the caller's environment (restore.sh exports them).
compose_restore() {
  local project="$1"
  shift
  docker compose -p "$project" -f "$COMPOSE_FILE" -f "$RESTORE_OVERRIDE" "$@"
}

# The value of one environment variable inside a running service container,
# so scripts never guess POSTGRES_USER/POSTGRES_DB from the host environment.
container_env() {
  local project="$1" service="$2" name="$3"
  # `exec -T` forwards the caller's stdin; without the redirect this would
  # swallow the dump a caller is about to feed to psql.
  compose "$project" exec -T "$service" sh -c "printf '%s' \"\$$name\"" </dev/null
}

psql_in() {
  local project="$1"
  shift
  local user db
  user="$(container_env "$project" postgres POSTGRES_USER)"
  db="$(container_env "$project" postgres POSTGRES_DB)"
  compose "$project" exec -T postgres psql -v ON_ERROR_STOP=1 -X -q -U "$user" -d "$db" "$@"
}

# The published host port of one service's container port, as a number.
published_port() {
  local project="$1" service="$2" port="$3" found
  found="$(compose "$project" port "$service" "$port" </dev/null)" || return 1
  printf '%s' "${found##*:}"
}

# Where the checkpoint objects live, for `with_object_store`: `localstack`,
# the compose project's own LocalStack, or `env`, the store the caller's
# environment names. Each script sets it from --object-store.
OBJECT_STORE=localstack

# `set_object_store <mode>`: validates and sets OBJECT_STORE.
set_object_store() {
  case "$1" in
    localstack|env) OBJECT_STORE="$1" ;;
    *) die "--object-store must be localstack or env, not '$1'" ;;
  esac
}

# The value of one environment variable a service container was created
# with, read from the daemon rather than from inside the container. Fails
# when the service has no container.
inspect_env() {
  local project="$1" service="$2" name="$3" cid
  cid="$(compose "$project" ps -aq "$service" </dev/null | head -n1)"
  [ -n "$cid" ] || return 1
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | sed -n "s/^${name}=//p" | head -n1
}

# `with_object_store <project> <bucket> <command> [args]`: runs the command
# with S3_BUCKET and the AWS_* settings of $OBJECT_STORE. `localstack` is the
# project's LocalStack on its published port, with the credentials the
# container was started with. `env` is the caller's own AWS_REGION,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_ENDPOINT_URL, the
# variables the API reads; no AWS_ENDPOINT_URL means AWS S3 itself.
with_object_store() {
  local project="$1" bucket="$2" name port region key_id key
  shift 2
  if [ "$OBJECT_STORE" = env ]; then
    for name in AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
      [ -n "${!name:-}" ] || die "--object-store env needs $name in the environment"
    done
    S3_BUCKET="$bucket" "$@"
    return
  fi
  port="$(published_port "$project" localstack 4566)" || die "localstack of '$project' publishes no port"
  region="$(inspect_env "$project" localstack AWS_DEFAULT_REGION)" || die "project '$project' has no localstack container"
  key_id="$(inspect_env "$project" localstack AWS_ACCESS_KEY_ID)" || die "project '$project' has no localstack container"
  key="$(inspect_env "$project" localstack AWS_SECRET_ACCESS_KEY)" || die "project '$project' has no localstack container"
  AWS_ENDPOINT_URL="http://127.0.0.1:${port}" AWS_REGION="$region" \
    AWS_ACCESS_KEY_ID="$key_id" AWS_SECRET_ACCESS_KEY="$key" \
    S3_BUCKET="$bucket" "$@"
}

# The endpoint `with_object_store` hands the CLIs, empty for AWS S3; recorded
# in the backup so a restore can refuse the source's own bucket.
object_store_endpoint() {
  with_object_store "$1" "$2" sh -c 'printf "%s" "${AWS_ENDPOINT_URL:-}"'
}

# `bun_script <script> [args]`: this checkout's bun on the host. bun leaves
# the pipes it wrote to non-blocking. Handed the caller's own stdout or
# stderr, and the caller merging them into one pipe (`2>&1 |`), the script's
# next write larger than the pipe has room for fails with EAGAIN and the
# whole run exits 1. So bun only ever gets descriptors of its own: a file for
# stdout, a pipe that cat drains for stderr.
bun_script() {
  local out status=0
  out="$(mktemp)"
  if bun run "$@" </dev/null >"$out" 2> >(cat >&2); then
    status=0
  else
    status=$?
  fi
  cat "$out"
  rm -f "$out"
  return "$status"
}

# `object_store <project> <bucket> <command> [args]`: one step of
# scripts/lib/object-store-cli.ts against the chosen store.
object_store() {
  local project="$1" bucket="$2"
  shift 2
  with_object_store "$project" "$bucket" bun_script "${REPO_ROOT}/scripts/lib/object-store-cli.ts" "$@"
}

# `checkpoint_pins <project> <bucket> <command> [args]`: runs
# scripts/lib/checkpoint-pins-cli.ts against the project's published
# postgres port, with the credentials that container was started with, and
# the chosen store. It is the one step that needs the production codec,
# which only this checkout's bun has.
checkpoint_pins() {
  local project="$1" bucket="$2"
  shift 2
  local pg_port pg_user pg_db pg_password
  pg_port="$(published_port "$project" postgres 5432)" || die "postgres of '$project' publishes no port"
  pg_user="$(container_env "$project" postgres POSTGRES_USER)"
  pg_db="$(container_env "$project" postgres POSTGRES_DB)"
  pg_password="$(container_env "$project" postgres POSTGRES_PASSWORD)"
  DATABASE_URL="postgresql://$(uri_escape "$pg_user"):$(uri_escape "$pg_password")@127.0.0.1:${pg_port}/$(uri_escape "$pg_db")" \
    with_object_store "$project" "$bucket" bun_script "${REPO_ROOT}/scripts/lib/checkpoint-pins-cli.ts" "$@"
}

# `image_runtime <image>`: the engine build a worker image runs, as the JSON
# its own code stamps checkpoints with (CLAUDE_RUNTIME_FINGERPRINT), read by
# running the image's bun with no network. The image has no label for it.
image_runtime() {
  docker run --rm --network none --entrypoint bun "$1" -e \
    'import { CLAUDE_RUNTIME_FINGERPRINT } from "./packages/adapters/runtimes/claude-codec/src/checkpoint-codec.ts"; console.log(JSON.stringify(CLAUDE_RUNTIME_FINGERPRINT))'
}

uri_escape() {
  jq -rn --arg value "$1" '$value | @uri'
}

# The migrations this checkout expects, one `<hash> <when> <tag>` per line in
# journal order. The hash is sha256 of the whole SQL file, which is what
# Drizzle's migrator records in drizzle.__drizzle_migrations (see
# packages/db/src/migration-head.ts), so it compares directly with a dump.
expected_migrations() {
  local journal="${MIGRATIONS_DIR}/meta/_journal.json"
  [ -r "$journal" ] || die "migration journal not found: $journal"
  jq -r '.entries[] | "\(.when) \(.tag)"' "$journal" | while read -r when tag; do
    printf '%s %s %s\n' "$(sha256_file "${MIGRATIONS_DIR}/${tag}.sql")" "$when" "$tag"
  done
}

# Refuses a backup whose applied migration list is not exactly this checkout's.
# Older backups are refused too: restore is meant to reproduce a known state,
# and running migrations against restored data is a separate, deliberate step
# (see docs/backup-restore.md). Prints the verdict; returns EXIT_SCHEMA_MISMATCH.
schema_check() {
  local manifest="$1"
  [ -r "$manifest" ] || die "manifest not found: $manifest"
  local version
  version="$(jq -r '.version // empty' "$manifest")"
  if [ "$version" != "$BACKUP_MANIFEST_VERSION" ]; then
    log "schema: manifest version '${version:-missing}' is not ${BACKUP_MANIFEST_VERSION}"
    return "$EXIT_SCHEMA_MISMATCH"
  fi
  local applied expected
  applied="$(jq -r '.schema.applied[] | "\(.hash) \(.when)"' "$manifest")"
  expected="$(expected_migrations | cut -d' ' -f1,2)"
  if [ "$applied" = "$expected" ]; then
    log "schema: backup matches checkout head $(jq -r '.schema.head_tag' "$manifest")"
    return 0
  fi
  log "schema: backup applied migrations differ from this checkout"
  log "schema: backup head = $(jq -r '.schema.head_tag // "?"' "$manifest") ($(printf '%s\n' "$applied" | grep -c . || true) applied)"
  log "schema: checkout head = $(expected_migrations | tail -n1 | cut -d' ' -f3) ($(expected_migrations | wc -l | tr -d ' ') expected)"
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$applied") >&2 || true
  return "$EXIT_SCHEMA_MISMATCH"
}

# `unbundle_chain <bare-repository> <commit> <bundle>...`: a checkpoint's
# bundles, oldest first, fetched into one empty repository the way a restore
# stacks them. An incremental bundle (94S-227) needs commits only an earlier
# one carries, so none after the first verifies on its own. The last bundle's
# refs/checkpoint/worktree, peeled, must be <commit>: that is what a restore
# checks out. It may be an annotated tag over a commit an earlier bundle
# carries, when the capture changed nothing (94S-374), so the bundle's header
# never lists <commit> itself. That is the worktree part of the rule finalize
# and a worker restore apply to the last bundle's refs, `checkpointBundleRefs`
# in packages/runtime-core/src/checkpoint-bundle.ts (94S-391); a bundle that
# rule refuses never commits. Paths must be absolute. Says on stdout which
# bundle git refused and fails.
unbundle_chain() {
  local repository="$1" commit="$2"
  shift 2
  local count=$# index=0 bundle worktree
  if [ "$count" -eq 0 ]; then
    echo "no bundle to verify"
    return 1
  fi
  for bundle in "$@"; do
    index=$((index + 1))
    if ! git -C "$repository" bundle verify "$bundle" >/dev/null 2>&1; then
      echo "bundle $index of $count: git bundle verify rejected it after the $((index - 1)) before it"
      return 1
    fi
    # No auto maintenance: it runs detached after the fetch and can still be
    # writing into the repository when the caller removes it.
    if ! git -C "$repository" -c fetch.fsckObjects=true -c maintenance.auto=false -c gc.auto=0 \
      fetch --quiet --no-write-fetch-head \
      "$bundle" "refs/*:refs/chain/$index/*" >/dev/null 2>&1; then
      echo "bundle $index of $count: git fetch refused it"
      return 1
    fi
  done
  if ! worktree="$(git -C "$repository" rev-parse --verify --quiet "refs/chain/$count/checkpoint/worktree^{commit}")"; then
    echo "the last bundle has no refs/checkpoint/worktree"
    return 1
  fi
  if [ "$worktree" != "$commit" ]; then
    echo "the last bundle's refs/checkpoint/worktree is $worktree, not $commit"
    return 1
  fi
}

# One section of an ini file on stdin as `key=value` lines, trimmed of the
# spaces Gitea's writer puts around `=`. A key of the same name in another
# section is not printed.
ini_section() {
  awk -v want="[$1]" '
    /^[[:space:]]*\[/ { line = $0; gsub(/[[:space:]]/, "", line); in_section = (line == want); next }
    /^[[:space:]]*[;#]/ { next }
    in_section && /=/ {
      key = $0; sub(/[[:space:]]*=.*/, "", key); sub(/^[[:space:]]*/, "", key)
      value = $0; sub(/^[^=]*=[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value)
      print key "=" value
    }'
}

# True when the Gitea app.ini on stdin gives the restored installation's own
# address (loopback, the given published ports) as its external one.
gitea_address_is() {
  local http_port="$1" ssh_port="$2" server want
  server="$(ini_section server)"
  for want in "ROOT_URL=http://127.0.0.1:${http_port}/" DOMAIN=127.0.0.1 SSH_DOMAIN=127.0.0.1 "SSH_PORT=${ssh_port}"; do
    if ! printf '%s\n' "$server" | grep -qxF "$want"; then
      log "gitea: app.ini [server] does not say $want"
      return 1
    fi
  done
}

# True when the compose project already owns any container, volume or network.
# Restore never reuses one: an existing project means existing data. A daemon
# that cannot be asked is a failure, not an empty project.
project_has_resources() {
  local project="$1" found
  found="$(docker ps -aq --filter "label=com.docker.compose.project=${project}")" || die "docker ps failed; cannot tell whether project '$project' exists"
  [ -z "$found" ] || return 0
  found="$(docker volume ls -q --filter "label=com.docker.compose.project=${project}")" || die "docker volume ls failed; cannot tell whether project '$project' exists"
  [ -z "$found" ] || return 0
  found="$(docker network ls -q --filter "label=com.docker.compose.project=${project}")" || die "docker network ls failed; cannot tell whether project '$project' exists"
  [ -z "$found" ] || return 0
  return 1
}

# Every regular file under $1 except the root SHA256SUMS itself (an S3 key
# may well be named SHA256SUMS), relative paths, sorted.
bundle_inventory() {
  (cd "$1" && find . -type f ! -path ./SHA256SUMS -print | sed 's#^\./##' | LC_ALL=C sort)
}

# Writes SHA256SUMS over the inventory, so a bundle that was copied around
# can be checked before restore.
write_checksums() {
  local dir="$1"
  bundle_inventory "$dir" | while read -r file; do
    printf '%s  %s\n' "$(sha256_file "${dir}/${file}")" "$file"
  done > "${dir}/SHA256SUMS"
}

# Every listed file must hash as listed, and the inventory must be exactly
# the listed paths: a file added after the fact (a bundle restore would
# clone, say) is as much a modification as a changed byte.
verify_checksums() {
  local dir="$1"
  [ -r "${dir}/SHA256SUMS" ] || die "SHA256SUMS missing in $dir"
  (
    cd "$dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum --quiet -c SHA256SUMS
    else
      shasum -a 256 -s -c SHA256SUMS
    fi
  ) || return 1
  local listed
  listed="$(sed 's/^[0-9a-f]*  //' "${dir}/SHA256SUMS" | LC_ALL=C sort)"
  if [ "$listed" != "$(bundle_inventory "$dir")" ]; then
    log "checksums: files present differ from SHA256SUMS"
    diff <(printf '%s\n' "$listed") <(bundle_inventory "$dir") >&2 || true
    return 1
  fi
}

#!/usr/bin/env bash
# Checks that a (restored) installation's checkpoint pointers still name the
# bytes they were committed against.
#
# For every row of `checkpoints`: the object at manifest_ref is downloaded and
# its sha256 compared with manifest_sha256; the manifest is then opened and
# every object it pins (workspace bundle, untracked files, transcript parts
# of root and subagents) is downloaded and compared the same way; the bundle is finally
# handed to `git bundle verify` and must offer workspace.gitCommit as a ref
# tip. Rows that are the session's current pointer (sessions.checkpoint_revision)
# are marked `pointer`.
#
# Exit 0 when every row passes, 5 when any fails. A database with no
# checkpoints passes with a warning: there was nothing to disagree.
#
# Usage: scripts/verify-restore.sh --project <project> [--bucket claude-sessions]

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-lib.sh"

PROJECT=""
BUCKET=claude-sessions

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) log "unknown argument: $1"; usage ;;
  esac
done
[ -n "$PROJECT" ] || usage
require_tools docker jq git

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git init --quiet --bare "$WORK/verify.git"

fetch_object() {
  compose "$PROJECT" exec -T localstack awslocal s3 cp "s3://${BUCKET}/$1" - 2>/dev/null
}

FAILED=0
PASSED=0
ROWS=0

fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$*"
}

# One pinned object: exists and hashes to what the manifest says.
check_ref() {
  local label="$1" key="$2" expected="$3" out="$4"
  # Presence is the fetch's exit status: a zero-byte object (an empty untracked
  # file, bytes: 0) is a valid artifact and still gets hashed.
  if ! fetch_object "$key" > "$out"; then
    fail "$label: object missing $key"
    return 1
  fi
  local actual
  actual="$(sha256_file "$out")"
  if [ "$actual" != "$expected" ]; then
    fail "$label: sha256 $actual != $expected ($key)"
    return 1
  fi
  return 0
}

QUERY="SELECT c.session_id, c.revision, c.manifest_ref, c.manifest_sha256,
              (s.checkpoint_revision IS NOT DISTINCT FROM c.revision)::int
       FROM checkpoints c JOIN sessions s ON s.id = c.session_id
       ORDER BY c.session_id, c.revision"
# Read the rows up front: a query that fails inside a process substitution
# would look like an empty database and let the run exit 0.
ROWS_TEXT="$(psql_in "$PROJECT" -Atc "$QUERY")" || die "could not read checkpoints from project '$PROJECT'"
while IFS='|' read -r session revision ref expected is_pointer; do
  [ -n "$session" ] || continue
  ROWS=$((ROWS + 1))
  tag="$session@$revision"
  [ "$is_pointer" = 1 ] && tag="$tag pointer"
  manifest="$WORK/manifest-$ROWS.json"
  ok=1
  check_ref "$tag manifest" "$ref" "$expected" "$manifest" || ok=0
  if [ "$ok" = 1 ]; then
    if ! jq -e '.version == 2 and .workspace.bundle.key and .transcripts.root.parts' "$manifest" >/dev/null 2>&1; then
      fail "$tag manifest: not a version-2 checkpoint manifest"
      ok=0
    # The product restore path refuses a manifest sealed for another session or
    # revision even when every byte checks out, so the verifier must too.
    elif ! jq -e --arg s "$session" --argjson r "$revision" '.sessionId == $s and .revision == $r' "$manifest" >/dev/null 2>&1; then
      fail "$tag manifest: sealed for $(jq -r '"\(.sessionId)@\(.revision)"' "$manifest"), not this row"
      ok=0
    fi
  fi
  if [ "$ok" = 1 ]; then
    # Transcript parts of the root and every subagent, then the bundle.
    # NUL-delimited: an object key may itself contain whitespace.
    while IFS= read -r -d '' key && IFS= read -r -d '' sha; do
      check_ref "$tag part" "$key" "$sha" "$WORK/part" || ok=0
    done < <(jq -j '(([.transcripts.root] + (.transcripts.subagents | to_entries | map(.value))) | .[].parts[]), .workspace.untracked[] | "\(.key)\u0000\(.sha256)\u0000"' "$manifest")
    bundle_key="$(jq -r '.workspace.bundle.key' "$manifest")"
    bundle_sha="$(jq -r '.workspace.bundle.sha256' "$manifest")"
    commit="$(jq -r '.workspace.gitCommit' "$manifest")"
    if check_ref "$tag bundle" "$bundle_key" "$bundle_sha" "$WORK/bundle"; then
      if ! git -C "$WORK/verify.git" bundle verify "$WORK/bundle" >/dev/null 2>&1; then
        fail "$tag bundle: git bundle verify rejected $bundle_key"
        ok=0
      elif ! git -C "$WORK/verify.git" bundle list-heads "$WORK/bundle" | grep -q "^${commit} "; then
        fail "$tag bundle: $commit is not a ref tip of $bundle_key"
        ok=0
      fi
    else
      ok=0
    fi
  fi
  if [ "$ok" = 1 ]; then
    PASSED=$((PASSED + 1))
    printf 'PASS %s (%s)\n' "$tag" "$expected"
  fi
done <<< "$ROWS_TEXT"

# The restored store must still refuse to replace an object: a scratch key is
# written once, then again with If-None-Match, which has to fail with 412.
SCRATCH="verify-restore/$(date -u +%s)-$$"
if compose "$PROJECT" exec -T localstack sh -c "
  set -eu
  printf one > /tmp/verify-one; printf two > /tmp/verify-two
  awslocal s3api put-object --bucket '$BUCKET' --key '$SCRATCH' --body /tmp/verify-one >/dev/null
  if awslocal s3api put-object --bucket '$BUCKET' --key '$SCRATCH' --if-none-match '*' --body /tmp/verify-two >/dev/null 2>&1; then
    awslocal s3 rm 's3://$BUCKET/$SCRATCH' --quiet; exit 1
  fi
  [ \"\$(awslocal s3 cp 's3://$BUCKET/$SCRATCH' -)\" = one ]
  awslocal s3 rm 's3://$BUCKET/$SCRATCH' --quiet
"; then
  echo "PASS create-only write refused on s3://$BUCKET (If-None-Match)"
else
  fail "create-only write was not refused on s3://$BUCKET"
fi

echo "SKIP resume continues the same native session — verified after 94S-129 (pause/resume)"
echo "SKIP worker image digest matches manifest.json images.worker — verified after 94S-125 (images)"
echo "checkpoints=$ROWS passed=$PASSED failed=$FAILED"
[ "$ROWS" -gt 0 ] || log "verify: warning — no checkpoint rows in project '$PROJECT'; nothing was compared"
[ "$FAILED" -eq 0 ] || exit "$EXIT_VERIFY_FAILED"

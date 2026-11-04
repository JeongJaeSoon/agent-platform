#!/usr/bin/env bash
# Retags a run's staged digests: `image-promote.sh <staged dir> <published dir>`.
#
# <staged dir> holds one JSON per image from the publish job. Which tags are
# written depends on what the run was started by, so a main run can never
# write a version or sha tag. A tag that already names a different digest fails
# the promotion before any tag is written, so one tag never mixes images from
# two build attempts. A half-promoted set (failure between repositories) is
# completed with "Re-run failed jobs" on the same run while its staged-digest
# artifacts still exist: the publish jobs are not rerun, and the tags written
# before the failure name exactly those digests. A full rerun builds again (the
# apt layer is not pinned) and is refused by design. The lookup fails closed:
# only a confirmed "not found" counts as absent. After tagging, every reference
# is read back and must name its candidate before <published dir> is written.
set -euo pipefail

staged="$1"
published="$2"
short="${GITHUB_SHA::12}"
case "$GITHUB_REF" in
  refs/tags/v*) tags=("$GITHUB_REF_NAME" "sha-${short}") ;;
  refs/heads/main) tags=("main-${short}") ;;
  *)
    echo "::error::nothing is promoted from ${GITHUB_REF}"
    exit 1
    ;;
esac

test "$(ls "$staged"/*.json | wc -l)" -eq 3

lookup_err="$(mktemp)"
trap 'rm -f "$lookup_err"' EXIT
lookup() {
  # Prints the digest the tag names, nothing when the registry confirms it
  # does not exist; any other failure exits non-zero.
  local ref="$1" out err status
  set +e
  out="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' 2>"$lookup_err")"
  status=$?
  set -e
  err="$(cat "$lookup_err")"
  if [ "$status" -eq 0 ]; then
    printf '%s' "$out" | tr -d '"'
    return 0
  fi
  case "$err" in
    *"not found"* | *MANIFEST_UNKNOWN* | *NAME_UNKNOWN*) return 0 ;;
  esac
  echo "::error::could not look up ${ref}: ${err}" >&2
  return 1
}

# Every lookup first, so a registry that cannot answer, or a tag that already
# names something else, aborts before any repository is touched. A tag that
# already names the candidate is a rerun.
for file in "$staged"/*.json; do
  name="$(jq -r .image "$file")"
  digest="$(jq -r .digest "$file")"
  test -n "$digest"
  for tag in "${tags[@]}"; do
    existing="$(lookup "${name}:${tag}")"
    if [ -n "$existing" ] && [ "$existing" != "$digest" ]; then
      echo "::error::${name}:${tag} already names ${existing}, refusing to move it to ${digest}; a new build of the same tag is not a rerun"
      exit 1
    fi
  done
done

for file in "$staged"/*.json; do
  name="$(jq -r .image "$file")"
  digest="$(jq -r .digest "$file")"
  targets=()
  for tag in "${tags[@]}"; do
    targets+=(-t "${name}:${tag}")
  done
  # The staged image is a single manifest (provenance off); without
  # --prefer-index=false buildx wraps it in a new index, the tag gets a digest
  # the readback below would reject, and the written tag then blocks every
  # rerun. Verified against registry:2.
  docker buildx imagetools create --prefer-index=false "${targets[@]}" "${name}@${digest}"
done

# Read back what the registry now says, and only then call it published. The
# record describes the tags, not the intention.
mkdir -p "$published"
for file in "$staged"/*.json; do
  app="$(jq -r .app "$file")"
  name="$(jq -r .image "$file")"
  digest="$(jq -r .digest "$file")"
  for tag in "${tags[@]}"; do
    actual="$(lookup "${name}:${tag}")"
    if [ "$actual" != "$digest" ]; then
      echo "::error::after promotion ${name}:${tag} names '${actual}', expected ${digest}"
      exit 1
    fi
  done
  jq '.promoted = true | .tags = $ARGS.positional' "$file" --args "${tags[@]}" \
    >"${published}/${app}.json"
  {
    echo "### ${app} (published)"
    echo
    echo '```json'
    cat "${published}/${app}.json"
    echo '```'
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
done

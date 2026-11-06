#!/usr/bin/env bash
# The release steps of the main-push Images run, one subcommand each, in the
# order the jobs run them: `release-auto.sh detect|ci|free|tag`.
#
#   detect  BEFORE and AFTER (the push's two commits): the one CHANGELOG.md
#           heading `## vX.Y.Z` that AFTER has and BEFORE lacks is the release
#           to make; none means an ordinary merge. Writes `tag=` to
#           GITHUB_OUTPUT. Anything that is not one clean new heading fails.
#   ci      waits for the ci.yml push run of GITHUB_SHA and requires success
#   free    TAG has no tag ref and no Release (also run again right before tagging)
#   tag     creates the annotated tag TAG at GITHUB_SHA and reads it back
#
# env: GH_REPO, GH_TOKEN, GITHUB_SHA; TAG for free/tag; BEFORE/AFTER for detect;
# GITHUB_RUN_ID for tag. CI_WAIT_SECONDS (default 5400) and CI_POLL_SECONDS
# (default 60) bound the wait in `ci`.
set -euo pipefail

repo="${GH_REPO:?}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

# Semver less build metadata, as chart-package.ts reads a tag: no leading zeros
# in a numeric part, and `+` cannot go in the helm.sh/chart label.
number='(0|[1-9][0-9]*)'
prerelease="(${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
version_pattern="^v${number}\\.${number}\\.${number}(-${prerelease}(\\.${prerelease})*)?\$"

headings() {
  # A commit with no CHANGELOG.md has no headings; that is not an error.
  { git show "$1:CHANGELOG.md" 2>/dev/null || true; } | sed -n 's/^## \(v[^[:space:]]*\).*/\1/p'
}

detect() {
  local before="${BEFORE:?}" after="${AFTER:?}" old new gone dup
  [[ "$before" =~ ^[0-9a-f]{40}$ && "$after" =~ ^[0-9a-f]{40}$ ]] \
    || fail "the push range is not two commits: ${before}..${after}"
  [[ ! "$before" =~ ^0+$ ]] || fail "the push has no previous commit, so no release can be read from it"
  git cat-file -e "${before}^{commit}" 2>/dev/null || fail "commit ${before} is not in the checkout"
  # A rewritten history compares unrelated trees, and every old heading would look new.
  git merge-base --is-ancestor "$before" "$after" \
    || fail "${before} is not an ancestor of ${after}; the history was rewritten"

  old="$(headings "$before" | sort -u)"
  new="$(headings "$after" | sort -u)"
  dup="$(headings "$after" | sort | uniq -d)"
  [ -z "$dup" ] || fail "CHANGELOG.md has more than one section for ${dup//$'\n'/, }"
  added="$(comm -13 <(printf '%s\n' "$old") <(printf '%s\n' "$new") | sed '/^$/d')"
  gone="$(comm -23 <(printf '%s\n' "$old") <(printf '%s\n' "$new") | sed '/^$/d')"

  tag=""
  if [ -n "$added" ]; then
    [ "$(printf '%s\n' "$added" | wc -l)" -eq 1 ] \
      || fail "this push adds more than one version section: ${added//$'\n'/, }"
    [ -z "$gone" ] || fail "${added} appears where ${gone//$'\n'/, } was: a renamed section is not a release"
    [[ "$added" =~ $version_pattern ]] \
      || fail "'${added}' is not v<major>.<minor>.<patch>[-<prerelease>]"
    [ "${#added}" -le 64 ] || fail "'${added}' is longer than 63 characters after the v"
    tag="$added"
    TAG="$tag" free
  fi
  echo "release tag: ${tag:-none}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "tag=${tag}" >>"$GITHUB_OUTPUT"
  fi
}

free() {
  local tag="${TAG:?}" out found
  if out="$(gh api "repos/${repo}/git/ref/tags/${tag}" 2>&1)"; then
    fail "tag ${tag} already exists; a version is never released twice"
  fi
  case "$out" in
    *"HTTP 404"*) ;;
    *) fail "could not look up tag ${tag}: ${out}" ;;
  esac
  # A draft Release holds a tag name without a tag.
  found="$(gh api --paginate "repos/${repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"${tag}\") | .id")" || fail "could not list releases"
  [ -z "$found" ] || fail "a Release for ${tag} already exists"
}

ci() {
  local sha="${GITHUB_SHA:?}" deadline line status conclusion url
  deadline=$((SECONDS + ${CI_WAIT_SECONDS:-5400}))
  while :; do
    line="$(gh api "repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=1" \
      --jq '.workflow_runs[0] | "\(.status) \(.conclusion // "none") \(.html_url)"')" \
      || fail "could not read the ci.yml runs of ${sha}"
    read -r status conclusion url <<<"$line"
    if [ "$status" = completed ]; then
      [ "$conclusion" = success ] || fail "ci.yml on ${sha} concluded ${conclusion}: ${url}"
      echo "ci.yml: green (${url})"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "ci.yml on ${sha} is still ${status:-absent} after ${CI_WAIT_SECONDS:-5400}s"
    sleep "${CI_POLL_SECONDS:-60}"
  done
}

tag() {
  local tag="${TAG:?}" sha="${GITHUB_SHA:?}" run="${GITHUB_RUN_ID:?}" obj peeled message
  message="$(printf '%s\n\nCreated by the Images run %s after the release approval' "$tag" "$run")"
  if obj="$(gh api "repos/${repo}/git/ref/tags/${tag}" --jq .object.sha 2>/dev/null)"; then
    # Only this run's own earlier attempt counts as done; any other tag at the
    # same commit is a second release of the version.
    existing="$(gh api "repos/${repo}/git/tags/${obj}" --jq .message 2>/dev/null)" || existing=""
    [[ "$existing" == *"Images run ${run} "* ]] \
      || fail "tag ${tag} already exists and was not made by this run"
  else
    free
    obj="$(gh api -X POST "repos/${repo}/git/tags" \
      -f tag="$tag" -f message="$message" -f object="$sha" -f type=commit \
      -f "tagger[name]=github-actions[bot]" \
      -f "tagger[email]=41898282+github-actions[bot]@users.noreply.github.com" \
      --jq .sha)" || fail "could not create the tag object for ${tag}"
    # 422 means another run made the ref first: nothing is overwritten.
    gh api -X POST "repos/${repo}/git/refs" -f ref="refs/tags/${tag}" -f sha="$obj" >/dev/null \
      || fail "could not create refs/tags/${tag}"
  fi
  peeled="$(gh api "repos/${repo}/git/tags/${obj}" --jq .object.sha)" || fail "could not read tag ${tag} back"
  [ "$peeled" = "$sha" ] || fail "tag ${tag} points at ${peeled}, not the approved ${sha}"
  echo "tagged ${tag} at ${sha}"
}

case "${1:-}" in
  detect) detect ;;
  ci) ci ;;
  free) free ;;
  tag) tag ;;
  *)
    echo "usage: release-auto.sh detect|ci|free|tag" >&2
    exit 2
    ;;
esac

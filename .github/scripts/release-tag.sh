#!/usr/bin/env bash
# The steps of release.yml, one subcommand each, in the order the workflow runs
# them: `release-tag.sh check|tag|dispatch`.
#
#   check     the inputs are well formed, the commit is on main, the tag and its
#             Release do not exist, CI and Images are green on that commit, and
#             the commit's images.yml opens the tag path for a dispatch
#   tag       creates the annotated tag at the commit
#   dispatch  starts Images on the tag ref; its `publish` job then waits for
#             the one `release` approval
#
# env: VERSION (vX.Y.Z[-pre]), SHA (40 hex), GH_REPO, GH_TOKEN. `tag` also
# reads RUN_URL and ACTOR for the tag message; DISPATCH_WAIT is the pause in
# seconds between dispatch attempts (default 5).
set -euo pipefail

version="${VERSION:?}"
sha="${SHA:?}"
repo="${GH_REPO:?}"

# The string images.yml's tag-path jobs carry. A commit that predates it would
# take a dispatch and skip every publish job without failing, so check reads
# the commit's own file for it.
tag_gate="contains(fromJSON('[\"push\",\"workflow_dispatch\"]'), github.event_name) && startsWith(github.ref, 'refs/tags/v')"

fail() {
  echo "::error::$*" >&2
  exit 1
}

# Semver less build metadata, as chart-package.ts reads a tag: no leading zeros
# in a numeric part, and `+` cannot go in the helm.sh/chart label.
number='(0|[1-9][0-9]*)'
prerelease="(${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
version_pattern="^v${number}\\.${number}\\.${number}(-${prerelease}(\\.${prerelease})*)?\$"

check_inputs() {
  # A job `if` would show a skipped, green run; a failing step says why.
  # A branch can carry an edited copy of this workflow, only main's may tag.
  [ "${GITHUB_REF:-}" = refs/heads/main ] \
    || fail "run this workflow from main, not from ${GITHUB_REF:-an unknown ref}"
  [[ "$version" =~ $version_pattern ]] \
    || fail "version '${version}' is not v<major>.<minor>.<patch>[-<prerelease>]"
  # The chart label limit chart-package.ts enforces on the version part.
  [ "${#version}" -le 64 ] || fail "version '${version}' is longer than 63 characters after the v"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "sha must be 40 lowercase hex characters"
}

check_on_main() {
  local status
  status="$(gh api "repos/${repo}/compare/main...${sha}" --jq .status)" \
    || fail "could not compare ${sha} with main (unknown commit?)"
  # behind: main is ahead of the commit, so the commit is an ancestor of main.
  case "$status" in
    behind | identical) ;;
    *) fail "${sha} is not on main (compare status: ${status})" ;;
  esac
}

check_tag_absent() {
  local out
  if out="$(gh api "repos/${repo}/git/ref/tags/${version}" 2>&1)"; then
    fail "tag ${version} already exists; a tag is never moved or reused. If its publish stopped, re-run that Images run or dispatch Images on the tag ref"
  fi
  case "$out" in
    *"HTTP 404"*) ;;
    *) fail "could not look up tag ${version}: ${out}" ;;
  esac
  # A draft Release holds a tag name without a tag.
  local found
  found="$(gh api --paginate "repos/${repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"${version}\") | .id")" \
    || fail "could not list releases"
  [ -z "$found" ] || fail "a Release for ${version} already exists"
}

# The newest push run of a workflow on the commit must have completed green. A
# queued or running run is not green yet, and a commit with no push run was
# merged inside a later push (see check-main-push-run.sh): pick that later one.
check_green() {
  local workflow="$1" line status conclusion
  line="$(gh api "repos/${repo}/actions/workflows/${workflow}/runs?event=push&branch=main&head_sha=${sha}&per_page=1" \
    --jq '.workflow_runs[0] | "\(.status) \(.conclusion // "none") \(.html_url)"')" \
    || fail "could not read the ${workflow} runs of ${sha}"
  read -r status conclusion _ <<<"$line"
  if [ -z "$status" ] || [ "$status" = null ]; then
    fail "${workflow} has no push run on ${sha}; pick a commit that went through main's CI"
  fi
  [ "$status" = completed ] || fail "${workflow} on ${sha} is ${status}; wait for it to finish"
  [ "$conclusion" = success ] || fail "${workflow} on ${sha} concluded ${conclusion}: ${line##* }"
  echo "${workflow}: green (${line##* })"
}

check_images_gate() {
  local file
  file="$(gh api -H "Accept: application/vnd.github.raw" \
    "repos/${repo}/contents/.github/workflows/images.yml?ref=${sha}")" \
    || fail "could not read images.yml at ${sha}"
  # Not `grep -q` on a pipe: its early exit would fail the writer under pipefail.
  grep -F -- "$tag_gate" <<<"$file" >/dev/null \
    || fail "images.yml at ${sha} does not publish on a dispatch of a tag ref; pick a commit that has release.yml's change"
}

tag() {
  local message tag_sha
  message="$(printf '%s\n\nCreated by %s\nRequested by %s' "$version" "${RUN_URL:-the release workflow}" "${ACTOR:-unknown}")"
  tag_sha="$(gh api -X POST "repos/${repo}/git/tags" \
    -f tag="$version" -f message="$message" -f object="$sha" -f type=commit \
    -f "tagger[name]=github-actions[bot]" \
    -f "tagger[email]=41898282+github-actions[bot]@users.noreply.github.com" \
    --jq .sha)" || fail "could not create the tag object for ${version}"
  # 422 here means another run created the ref first: nothing is overwritten.
  gh api -X POST "repos/${repo}/git/refs" \
    -f ref="refs/tags/${version}" -f sha="$tag_sha" >/dev/null \
    || fail "could not create refs/tags/${version}"
  echo "tagged ${version} at ${sha} (tag object ${tag_sha})"
}

# The tag stays when this fails: the request may have been accepted although
# the answer was lost, so "nothing was published" is not known. The error says
# how to continue.
dispatch() {
  local attempt
  for attempt in 1 2 3; do
    if gh workflow run images.yml --ref "$version"; then
      echo "Images dispatched on ${version}; its publish job waits for the release approval"
      return 0
    fi
    [ "$attempt" = 3 ] || sleep "${DISPATCH_WAIT:-5}"
  done
  fail "tag ${version} exists but Images was not dispatched. Check the Images runs of ${version}; if there is none, run Images on the ref ${version} from the Actions page. The tag is not deleted"
}

case "${1:-}" in
  check)
    check_inputs
    check_on_main
    check_tag_absent
    check_green ci.yml
    check_green images.yml
    check_images_gate
    ;;
  tag) tag ;;
  dispatch) dispatch ;;
  *)
    echo "usage: release-tag.sh check|tag|dispatch" >&2
    exit 2
    ;;
esac

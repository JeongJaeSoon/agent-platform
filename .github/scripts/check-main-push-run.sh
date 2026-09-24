#!/usr/bin/env bash
# Reports whether recent commits on main received their CI push run.
#
# A push event GitHub never delivered leaves no run behind, so nothing inside
# ci.yml can notice it; this runs from a separate scheduled workflow. It looks
# for a run of ci.yml with event=push on the exact commit rather than comparing
# the latest push run's head_sha with the tip, which would also fire while a
# fresh push is still queueing its run.
#
# Without an argument every commit on main from the last LOOKBACK_HOURS is
# judged, not just the tip: a dropped run on commit A followed by a normal
# push of commit B would otherwise never be seen. The lookback overlaps the
# schedule by a wide margin, and the issue titles carry the SHA, so a commit
# seen twice is reported once.
#
# A commit merged within a second of the next one can reach main inside that
# one's push (1583f5d, 6e7badf): the ref moves from an older commit straight
# past it, so it is never the tip, and GitHub has no push event and no run to
# give it. The push that carried it ran on a tree containing it. Such a commit
# is `coalesced`, told apart from a lost event by main's ref activity: the
# lost 70139eb was the tip, since the next update left from it.
#
# Prints one line per commit, `<verdict> <short-sha>`, where the verdict is
# `present`, `missing`, `coalesced` or `too-recent`; a `present` line ends with
# the push run's id, a `coalesced` line with the tip its push moved main to.
# Exits 1 when any commit is missing and 2 when GitHub could not be asked, so a
# caller can tell "found a gap" from "could not look" — the lines already
# printed are then a partial answer.
#
# usage: check-main-push-run.sh [sha]
#   sha  a single commit to judge instead of the window (fixture runs)
# env:   GH_REPO (owner/name), GH_TOKEN with actions:read
#        MIN_AGE_MINUTES  a commit younger than this is not judged (default 15):
#                         a run can take a minute or two to appear after a push
#        LOOKBACK_HOURS   window of main commits to judge (default 36)

set -euo pipefail

: "${GH_REPO:?GH_REPO must name the repository as owner/name}"
min_age=${MIN_AGE_MINUTES:-15}
lookback=${LOOKBACK_HOURS:-36}
for value in "$min_age" "$lookback"; do
  case "$value" in
  '' | *[!0-9]*)
    echo "MIN_AGE_MINUTES and LOOKBACK_HOURS must be whole numbers" >&2
    exit 2
    ;;
  esac
done

# `date -d` is GNU-only; python is on every ubuntu runner and on macOS.
minutes_since() {
  python3 - "$1" <<'PY'
import sys
from datetime import datetime, timezone

committed = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
print(int((datetime.now(timezone.utc) - committed).total_seconds() // 60))
PY
}

api_failed() {
  echo "GitHub API call failed: $1" >&2
  exit 2
}

commit_line='"\(.sha) \(.commit.committer.date) \(.parents[0].sha // "")"'

# `<type> <before> <after>` per update of main, read once and only when some
# commit has no run. A month covers the window with room; a single older sha
# finds no trace here and stays `missing`.
ref_updates=
ref_updates_read=0
read_ref_updates() {
  [ "$ref_updates_read" = 0 ] || return 0
  ref_updates=$(gh api "repos/${GH_REPO}/activity?ref=refs/heads/main&time_period=month&per_page=100" --paginate \
    --jq '.[] | "\(.activity_type) \(.before) \(.after)"') || api_failed "activity of main"
  ref_updates_read=1
}

parent_of() {
  local parent
  if ! parent=$(awk -v sha="$1" '$1 == sha { print $3; found = 1; exit } END { exit !found }' <<<"$commits"); then
    parent=$(gh api "repos/${GH_REPO}/commits/$1" --jq '.parents[0].sha // ""') || return 2
  fi
  echo "$parent"
}

# Prints the tip of the push that carried the commit past the tip. Walks
# parents while they were never the tip either (three merges in one push), up
# to the one the push left from. Returns 1 when the commit was itself the tip
# or no such push is recorded, 2 when a parent could not be looked up.
carrying_push() {
  local sha=$1 hops
  for hops in 0 1 2 3 4 5 6 7 8 9; do
    if awk -v sha="$sha" '$2 == sha || $3 == sha { found = 1 } END { exit !found }' <<<"$ref_updates"; then
      [ "$hops" -gt 0 ] || return 1
      # Only a fast-forward leaves from its before toward the commit; a force
      # push's before need not be an ancestor of anything on main now.
      awk -v sha="$sha" '$2 == sha && ($1 == "push" || $1 == "pr_merge" || $1 == "merge_queue_merge") { print $3; found = 1; exit } END { exit !found }' <<<"$ref_updates"
      return
    fi
    sha=$(parent_of "$sha") || return 2
    [ -n "$sha" ] || return 1
  done
  return 1
}

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  commits=$(gh api "repos/${GH_REPO}/commits/$1" --jq "$commit_line") \
    || api_failed "commits/$1"
else
  since=$(python3 -c "
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(hours=${lookback})).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  # --paginate: a busy window can hold more than one page of commits.
  commits=$(gh api "repos/${GH_REPO}/commits?sha=main&since=${since}&per_page=100" --paginate \
    --jq ".[] | $commit_line") \
    || api_failed "commits since ${since}"
fi

status=0
while read -r sha committed_at _; do
  [ -n "$sha" ] || continue
  short=${sha:0:7}

  if [ "$(minutes_since "$committed_at")" -lt "$min_age" ]; then
    echo "too-recent ${short}"
    continue
  fi

  # The newest push run; its id lets a caller read that run's jobs.
  found=$(gh api "repos/${GH_REPO}/actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=1" \
    --jq '"\(.total_count) \(.workflow_runs[0].id // "")"') || api_failed "runs for ${short}"
  read -r runs run_id <<<"$found"
  if [ "$runs" -gt 0 ]; then
    echo "present ${short} ${run_id}"
    continue
  fi

  read_ref_updates
  rc=0
  tip=$(carrying_push "$sha") || rc=$?
  case "$rc" in
  0) echo "coalesced ${short} ${tip:0:7}" ;;
  1)
    echo "missing ${short}"
    status=1
    ;;
  *) api_failed "parents of ${short}" ;;
  esac
done <<<"$commits"

exit "$status"

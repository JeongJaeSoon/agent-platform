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
# Prints one line per commit, `<verdict> <short-sha>`, where the verdict is
# `present`, `missing` or `too-recent`. Exits 1 when any commit is missing and
# 2 when GitHub could not be asked, so a caller can tell "found a gap" from
# "could not look" — the lines already printed are then a partial answer.
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

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  commits=$(gh api "repos/${GH_REPO}/commits/$1" --jq '"\(.sha) \(.commit.committer.date)"') \
    || api_failed "commits/$1"
else
  since=$(python3 -c "
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(hours=${lookback})).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  # --paginate: a busy window can hold more than one page of commits.
  commits=$(gh api "repos/${GH_REPO}/commits?sha=main&since=${since}&per_page=100" --paginate \
    --jq '.[] | "\(.sha) \(.commit.committer.date)"') \
    || api_failed "commits since ${since}"
fi

status=0
while read -r sha committed_at; do
  [ -n "$sha" ] || continue
  short=${sha:0:7}

  if [ "$(minutes_since "$committed_at")" -lt "$min_age" ]; then
    echo "too-recent ${short}"
    continue
  fi

  runs=$(gh api "repos/${GH_REPO}/actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=1" \
    --jq '.total_count') || api_failed "runs for ${short}"
  if [ "$runs" -gt 0 ]; then
    echo "present ${short}"
  else
    echo "missing ${short}"
    status=1
  fi
done <<<"$commits"

exit "$status"

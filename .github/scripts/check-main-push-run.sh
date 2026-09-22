#!/usr/bin/env bash
# Reports whether the tip of main received its CI push run.
#
# A push event GitHub never delivered leaves no run behind, so nothing inside
# ci.yml can notice it; this runs from a separate scheduled workflow. It looks
# for a run of ci.yml with event=push on the exact commit rather than comparing
# the latest push run's head_sha with the tip, which would also fire while a
# fresh push is still queueing its run.
#
# Prints exactly one of `present`, `missing`, `too-recent` and exits 0, 1, 0.
#
# usage: check-main-push-run.sh [sha]
#   sha  commit to check instead of the current main tip (fixture runs)
# env:   GH_REPO (owner/name), GH_TOKEN with actions:read
#        MIN_AGE_MINUTES  a commit younger than this is not judged (default 15):
#                         a run can take a minute or two to appear after a push

set -euo pipefail

: "${GH_REPO:?GH_REPO must name the repository as owner/name}"
min_age=${MIN_AGE_MINUTES:-15}
case "$min_age" in
'' | *[!0-9]*)
  echo "MIN_AGE_MINUTES must be a whole number of minutes" >&2
  exit 2
  ;;
esac

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  commit=$(gh api "repos/${GH_REPO}/commits/$1" --jq '"\(.sha) \(.commit.committer.date)"')
else
  commit=$(gh api "repos/${GH_REPO}/commits/main" --jq '"\(.sha) \(.commit.committer.date)"')
fi
sha=${commit%% *}
committed_at=${commit#* }

# `date -d` is GNU-only; python is on every ubuntu runner and on macOS.
age_minutes=$(python3 - "$committed_at" <<'PY'
import sys
from datetime import datetime, timezone

committed = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
print(int((datetime.now(timezone.utc) - committed).total_seconds() // 60))
PY
)

if [ "$age_minutes" -lt "$min_age" ]; then
  echo "too-recent"
  exit 0
fi

runs=$(gh api "repos/${GH_REPO}/actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=1" \
  --jq '.total_count')

if [ "$runs" -gt 0 ]; then
  echo "present"
  exit 0
fi

echo "missing"
exit 1

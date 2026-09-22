#!/usr/bin/env bash
# Files a GitHub issue for a CI signal that the run conclusion hides, or
# appends to the one already open, so repeats of the same signal never pile up.
#
# The open issue is found by label through the REST list endpoint, not by a
# title search: search results are indexed with a delay, and two runs minutes
# apart would each open their own issue. A label lookup reads the live state.
#
# usage: upsert-ci-issue.sh <label> <title> <body-file>
# env:   GH_REPO (owner/name), GH_TOKEN with issues:write

set -euo pipefail

[ "$#" -eq 3 ] || {
  echo "usage: $0 <label> <title> <body-file>" >&2
  exit 2
}

label=$1
title=$2
body=$3

: "${GH_REPO:?GH_REPO must name the repository as owner/name}"
[ -r "$body" ] || {
  echo "body file not readable: $body" >&2
  exit 2
}

# `gh issue list --label` fails on a label the repository does not have yet,
# so make sure it exists. --force turns a second create into a no-op update.
gh label create "$label" --force --color D93F0B \
  --description "Opened by CI; closed by a person once the signal is understood" >/dev/null

number=$(gh issue list --repo "$GH_REPO" --label "$label" --state open \
  --limit 1 --json number --jq '.[0].number // empty')

if [ -n "$number" ]; then
  gh issue comment "$number" --repo "$GH_REPO" --body-file "$body" >/dev/null
  echo "updated #${number}"
else
  url=$(gh issue create --repo "$GH_REPO" --label "$label" --title "$title" --body-file "$body")
  echo "created ${url}"
fi

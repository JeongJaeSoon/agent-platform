#!/usr/bin/env bash
# Files a GitHub issue for a CI signal that the run conclusion hides, or
# appends to the one already open, so repeats of the same signal never pile up.
#
# The open issue is found by label through the REST list endpoint, not by a
# title search: search results are indexed with a delay, and two runs minutes
# apart would each open their own issue. A label lookup reads the live state.
#
# Two runs failing at the same moment can still both see no open issue and
# both create one. There is no lock across runs, so the loser is detected
# after the fact: whichever created issue is not the oldest open one under the
# label is closed as a duplicate and its body lands on the oldest instead.
#
# usage: upsert-ci-issue.sh [--by-title] <label> <title> <body-file>
#   --by-title  the signal's identity is the label AND the exact title, not the
#               label alone: only an open issue with this title is appended
#               to, and a closed one with this title counts as acknowledged
#               (print `acknowledged`, do nothing). For signals whose title
#               names the thing (a commit), so that closing one means "seen,
#               not coming back" and two things get two issues.
# env:   GH_REPO (owner/name), GH_TOKEN with issues:write

set -euo pipefail

usage() {
  echo "usage: $0 [--by-title] <label> <title> <body-file>" >&2
  exit 2
}

by_title=0
if [ "${1:-}" = "--by-title" ]; then
  by_title=1
  shift
fi
[ "$#" -eq 3 ] || usage

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

# `gh --jq` takes a bare expression and no `--arg`; the exact-title match goes
# through jq itself so the title never has to be escaped into a filter.
matching() {
  local state=$1 pick=$2
  if [ "$by_title" -eq 1 ]; then
    gh issue list --repo "$GH_REPO" --label "$label" --state "$state" \
      --limit 100 --json number,title \
      | jq -r --arg title "$title" "[.[] | select(.title == \$title) | .number] | ${pick} // empty"
  else
    gh issue list --repo "$GH_REPO" --label "$label" --state "$state" \
      --limit 100 --json number,title \
      | jq -r "[.[].number] | ${pick} // empty"
  fi
}

oldest_open() { matching open min; }

number=$(oldest_open)
if [ -n "$number" ]; then
  gh issue comment "$number" --repo "$GH_REPO" --body-file "$body" >/dev/null
  echo "updated #${number}"
  exit 0
fi

if [ "$by_title" -eq 1 ]; then
  closed=$(matching closed max)
  if [ -n "$closed" ]; then
    echo "acknowledged #${closed}"
    exit 0
  fi
fi

url=$(gh issue create --repo "$GH_REPO" --label "$label" --title "$title" --body-file "$body")
created=${url##*/}

oldest=$(oldest_open)
if [ -n "$oldest" ] && [ "$oldest" != "$created" ]; then
  gh issue close "$created" --repo "$GH_REPO" \
    --comment "Duplicate of #${oldest}: two runs reported at the same time." >/dev/null
  gh issue comment "$oldest" --repo "$GH_REPO" --body-file "$body" >/dev/null
  echo "updated #${oldest} (closed duplicate #${created})"
  exit 0
fi

echo "created ${url}"

#!/usr/bin/env bash
# Whether snapshot.debian.org holds every source a publish ships:
# `image-sources.sh <list dir> <result dir> <main|release>`.
#
# <list dir> holds <app>-<arch>.md, each image's /app/DEBIAN_SOURCES.md. The six
# lists share nearly all their sources, so they are asked about once, here,
# rather than per image: the service is a volunteer one that answers about half
# of what it is asked. It imports the archive every few hours, so a build right
# after a Debian security release can list a version it does not hold yet.
#
# A source the service denies stops the publish. One it did not answer for
# stops a release; a main build goes out with it, listed for the images that
# ship it in <result dir>/<app>.json: the file exists after every check, so `[]`
# means checked and its absence never reads as "none". The budget keeps an
# outage inside the job's timeout.
set -euo pipefail

lists="$1"
results="$2"
mode="$3"
case "$mode" in
  main) budget=600 ;;
  release) budget=1800 ;;
  *)
    echo "::error::image-sources.sh: unknown mode ${mode}"
    exit 2
    ;;
esac

apps=(control-host worker egress-proxy)
files=()
for app in "${apps[@]}"; do
  for arch in amd64 arm64; do
    file="${lists}/${app}-${arch}.md"
    if [ ! -s "$file" ]; then
      echo "::error::no source list for ${app} on ${arch}"
      exit 1
    fi
    files+=("$file")
  done
done

answers="$(mktemp)"
unreachable="$(mktemp)"
trap 'rm -f "$answers" "$unreachable"' EXIT

snapshot_check_copying_stderr_to() {
  { bun scripts/third-party-notices.ts --snapshot-check "$budget" "${files[@]}" 2>&1 >&3 | tee "$1" >&2; } 3>&1
}

if snapshot_check_copying_stderr_to "$answers"; then
  status=0
else
  status=$?
fi

case "${mode}:${status}" in
  *:0) ;;
  main:3)
    sed -n 's/^unreachable: //p' "$answers" >"$unreachable"
    if [ ! -s "$unreachable" ]; then
      echo "::error::the check found unreachable sources but listed none"
      exit 1
    fi
    ;;
  *)
    echo "::error::snapshot.debian.org does not hold every source the images list (exit ${status})"
    exit 1
    ;;
esac

mkdir -p "$results"
for app in "${apps[@]}"; do
  # `|| true`: an image that ships none of the unanswered sources.
  { grep -ohFf "$unreachable" "${lists}/${app}-amd64.md" "${lists}/${app}-arm64.md" || true; } |
    sort -u | jq -Rn '[inputs]' >"${results}/${app}.json"
  count="$(jq length "${results}/${app}.json")"
  if [ "$count" -gt 0 ]; then
    echo "::warning::${app}: snapshot.debian.org did not answer for ${count} sources; this main build goes out with them unverified"
    {
      echo "### ${app}: ${count} sources unverified on snapshot.debian.org"
      jq -r '.[] | "- \(.)"' "${results}/${app}.json"
    } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  fi
done

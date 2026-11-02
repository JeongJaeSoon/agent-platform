#!/usr/bin/env bash
# Storybook's place on the Pages site (/<repo>/storybook/).
#
#   check <dir>             fails unless index.json is there and every file the
#         pages and scripts import is present and relative, as a site served
#         below the domain root needs.
#   keep  <dir> <live-url>  copies into <dir>/assets the hashed files the live
#         site still serves from builds retired within the last hour, and
#         writes <dir>/assets-kept.txt for the next deploy. Every build renames
#         almost every chunk, and Pages replaces the whole site and serves HTML
#         with max-age=600: without this, a tab opened before a deploy, or an
#         iframe.html still cached, asks for chunks that are gone and the story
#         fails to load. Never fails on the live site: what it cannot fetch in
#         time is left out, and only older tabs lose it.
#
# assets-kept.txt has one "<epoch> <file>" per line: 0 for the deployed build's
# own files, otherwise when the build that had it was replaced.
# STORYBOOK_KEEP_SECONDS overrides the one-hour window and
# STORYBOOK_KEEP_BUDGET the 120 seconds keep may spend fetching.
set -euo pipefail

usage() {
  echo "usage: $0 check <dir> | keep <dir> <live-url>" >&2
  exit 2
}

# The relative module specifiers a page or script imports, one per line.
imports() {
  grep -ohE "(from|import)[[:space:]]*\(?[[:space:]]*[\"'][./][^\"']*[\"']" "$1" |
    sed -E "s/^(from|import)[[:space:]]*\(?[[:space:]]*[\"']//; s/[\"']$//" |
    sort -u || true
}

check() {
  local dir=$1 failed=0 ref path file
  missing() {
    echo "::error::$1"
    failed=1
  }

  [ -s "$dir/index.json" ] && grep -q '"entries"' "$dir/index.json" ||
    missing "$dir/index.json is missing or has no entries"

  for file in index.html iframe.html; do
    [ -f "$dir/$file" ] || {
      missing "$dir/$file is missing"
      continue
    }
    while read -r ref; do
      case $ref in
      http://* | https://* | data:* | '#'*) ;;
      /*) missing "$file references $ref from the domain root" ;;
      *)
        path=${ref#./}
        path=${path%%[?#]*}
        [ -e "$dir/$path" ] || missing "$file references $ref, which is not in $dir"
        ;;
      esac
    done < <(
      grep -oE '(src|href)="[^"]+"' "$dir/$file" | sed -E 's/^[a-z]+="(.*)"$/\1/'
      imports "$dir/$file"
    )
  done

  # Vite's output only: sb-manager and sb-addons ship prebuilt from the
  # storybook package, unused files and import-shaped strings included.
  for file in "$dir"/*.js "$dir"/assets/*.js; do
    [ -e "$file" ] || continue
    while read -r ref; do
      case $ref in
      /*) missing "${file#"$dir"/} imports $ref from the domain root" ;;
      *) [ -e "${file%/*}/$ref" ] || missing "${file#"$dir"/} imports $ref, which is not in $dir" ;;
      esac
    done < <(imports "$file")
  done
  # Vite also lists a dynamic import's chunks and CSS as "./<file>" strings
  # for preloading; a missing one stops the story loading.
  while read -r ref; do
    [ -e "$dir/assets/${ref#./}" ] || missing "a chunk preloads $ref, which is not in $dir/assets"
  done < <(grep -ohE '"\./[^"/]+\.(js|css)"' "$dir"/assets/*.js | tr -d '"' | sort -u)

  [ "$failed" = 0 ] || exit 1
  echo "$dir: index.json, the pages and every import are in place"
}

keep() {
  local dir=$1 live=${2%/}
  local window=${STORYBOOK_KEEP_SECONDS:-3600} budget=${STORYBOOK_KEEP_BUDGET:-120}
  local now deadline prev next epoch file kept=0 missed=0
  now=$(date +%s)
  deadline=$((SECONDS + budget))
  # One request, retries included, within what is left of the budget (the
  # attempt under way when it runs out may overshoot by up to 20 s).
  fetch() {
    local left=$((deadline - SECONDS))
    ((left > 0)) || return 1
    curl -fsS --connect-timeout 5 --max-time $((left < 20 ? left : 20)) \
      --retry 2 --retry-max-time "$left" "$1" -o "$2"
  }
  prev=$(mktemp)
  next=$(mktemp)
  find "$dir/assets" -maxdepth 1 -type f -exec basename {} \; | sort | sed 's/^/0 /' >"$next"

  if ! fetch "$live/assets-kept.txt" "$prev"; then
    echo "::warning::no $live/assets-kept.txt; nothing kept from the live site"
    : >"$prev"
  fi
  while read -r epoch file || [ -n "$file" ]; do
    [[ $epoch =~ ^[0-9]{1,10}$ && $file =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || continue
    # The live build's own files retire with this deploy.
    [ "$epoch" = 0 ] && epoch=$now
    ((epoch <= now && now - epoch < window)) || continue
    [ -e "$dir/assets/$file" ] && continue
    if fetch "$live/assets/$file" "$dir/assets/$file"; then
      echo "$epoch $file" >>"$next"
      kept=$((kept + 1))
    else
      rm -f "$dir/assets/$file"
      missed=$((missed + 1))
    fi
  done <"$prev"
  mv "$next" "$dir/assets-kept.txt"
  rm -f "$prev"
  ((missed == 0)) || echo "::warning::$missed earlier files not fetched from $live; tabs that need them reload"
  echo "kept $kept files from builds retired within ${window}s"
}

case ${1:-} in
check) [ $# = 2 ] || usage; check "$2" ;;
keep) [ $# = 3 ] || usage; keep "$2" "$3" ;;
*) usage ;;
esac

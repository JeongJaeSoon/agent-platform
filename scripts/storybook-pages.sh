#!/usr/bin/env bash
# Storybook's place on the Pages site (/<repo>/storybook/).
#
#   keep  <dir> <live-url>  copies into <dir>/assets the hashed files the live
#         site still serves from deploys of the last hour, and writes
#         <dir>/assets-kept.txt ("<epoch> <file>" per line) for the next deploy.
#         Every build renames almost every chunk, and Pages replaces the whole
#         site and serves HTML with max-age=600: without this, a tab opened
#         before a deploy, or an iframe.html still cached, asks for chunks that
#         are gone and the story fails to load.
#   check <dir>             fails unless index.json is there and every file
#         index.html, iframe.html and the chunks reference is present and
#         relative, as a site served below the domain root needs.
#
# STORYBOOK_KEEP_SECONDS overrides the one-hour window.
set -euo pipefail

usage() {
  echo "usage: $0 keep <dir> <live-url> | check <dir>" >&2
  exit 2
}

keep() {
  local dir=$1 live=${2%/}
  local window=${STORYBOOK_KEEP_SECONDS:-3600}
  local now prev next epoch file kept=0 missed=0
  now=$(date +%s)
  prev=$(mktemp)
  next=$(mktemp)
  find "$dir/assets" -maxdepth 1 -type f -exec basename {} \; | sort |
    sed "s/^/$now /" >"$next"

  if ! curl -fsS --retry 3 "$live/assets-kept.txt" -o "$prev"; then
    echo "::warning::no $live/assets-kept.txt; nothing kept from the live site"
    : >"$prev"
  fi
  while read -r epoch file; do
    [[ $epoch =~ ^[0-9]+$ && $file =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || continue
    ((now - epoch < window)) || continue
    [ -e "$dir/assets/$file" ] && continue
    if curl -fsS --retry 3 "$live/assets/$file" -o "$dir/assets/$file"; then
      echo "$epoch $file" >>"$next"
      kept=$((kept + 1))
    else
      rm -f "$dir/assets/$file"
      missed=$((missed + 1))
    fi
  done <"$prev"
  mv "$next" "$dir/assets-kept.txt"
  rm -f "$prev"
  echo "kept $kept files from earlier deploys ($missed no longer on $live)"
}

check() {
  local dir=$1 failed=0 ref path js
  missing() {
    echo "::error::$1"
    failed=1
  }

  [ -s "$dir/index.json" ] && grep -q '"entries"' "$dir/index.json" ||
    missing "$dir/index.json is missing or has no entries"

  for page in index.html iframe.html; do
    [ -f "$dir/$page" ] || {
      missing "$dir/$page is missing"
      continue
    }
    while read -r ref; do
      case $ref in
      http://* | https://* | data:* | '#'*) continue ;;
      /*) missing "$page references $ref from the domain root" ;;
      *)
        path=${ref#./}
        path=${path%%[?#]*}
        [ -e "$dir/$path" ] || missing "$page references $ref, which is not in $dir"
        ;;
      esac
    done < <(grep -oE '(src|href)="[^"]+"' "$dir/$page" | sed -E 's/^[a-z]+="(.*)"$/\1/')
  done

  # A chunk names its siblings as "./<file>"; a root script names "./assets/<file>".
  for js in "$dir"/*.js; do
    [ -e "$js" ] || continue
    while read -r ref; do
      [ -e "$dir/${ref#./}" ] || missing "$(basename "$js") imports $ref, which is not in $dir"
    done < <(grep -ohE '"\./assets/[^"/]+\.(js|css)"' "$js" | tr -d '"' | sort -u)
  done
  while read -r ref; do
    [ -e "$dir/assets/${ref#./}" ] || missing "a chunk imports $ref, which is not in $dir/assets"
  done < <(grep -ohE '"\./[^"/]+\.(js|css)"' "$dir"/assets/*.js | tr -d '"' | sort -u)

  if [ -f "$dir/assets-kept.txt" ]; then
    while read -r _ path; do
      [ -e "$dir/assets/$path" ] || missing "assets-kept.txt lists $path, which is not in $dir/assets"
    done <"$dir/assets-kept.txt"
  fi

  [ "$failed" = 0 ] || exit 1
  echo "$dir: index.json, the pages and every referenced chunk are in place"
}

case ${1:-} in
keep) [ $# = 3 ] || usage; keep "$2" "$3" ;;
check) [ $# = 2 ] || usage; check "$2" ;;
*) usage ;;
esac

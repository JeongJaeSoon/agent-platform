#!/usr/bin/env bash
# Gives a tag a GitHub Release that carries its manifest:
# `release-publish.sh <tag> <release-manifest.json>`, with GH_REPO and GH_TOKEN
# set (contents: write).
#
# The Release is a draft until its manifest has been read back, so nobody sees a
# release without one. A rerun of the same tag converges: a manifest already
# there with the same content passes, one with other content fails and nothing
# is overwritten, and a half-done earlier run (draft, missing or unfinished
# asset) is completed. A lookup that fails is never taken for "absent".
set -euo pipefail

tag="$1"
manifest="$2"
asset="release-manifest.json"
repo="${GH_REPO:?}"
test "$(basename "$manifest")" = "$asset"

work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT

# Prints "<id> <draft>", or nothing when the repository confirms there is no
# release for the tag. Drafts are listed too: `gh release view` cannot see them.
find_release() {
  local found
  # errexit does not reach into a command substitution: say it explicitly, or a
  # failed lookup reads as "no release".
  found="$(gh api --paginate "repos/${repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"${tag}\") | \"\(.id) \(.draft)\"")" || return 1
  if [ "$(printf '%s' "$found" | grep -c .)" -gt 1 ]; then
    echo "::error::more than one release names ${tag}" >&2
    return 1
  fi
  printf '%s' "$found"
}

# Prints "<id> <state>" of the manifest asset, nothing when absent.
find_asset() {
  gh api --paginate "repos/${repo}/releases/${1}/assets?per_page=100" \
    --jq ".[] | select(.name == \"${asset}\") | \"\(.id) \(.state)\""
}

# Reads the asset back and compares it with ours. 0 same, 1 different or unreadable.
matches() {
  local release_id="$1" line asset_id state
  line="$(find_asset "$release_id")" || return 1
  [ -n "$line" ] || return 1
  read -r asset_id state <<<"$line"
  [ "$state" = uploaded ] || return 1
  gh api -H "Accept: application/octet-stream" \
    "repos/${repo}/releases/assets/${asset_id}" >"${work}/remote.json" || return 1
  # Each jq on its own: its failure must not hide behind the comparison.
  local theirs ours
  theirs="$(jq -S . "${work}/remote.json")" || return 1
  ours="$(jq -S . "$manifest")" || return 1
  [ "$theirs" = "$ours" ]
}

entry="$(find_release)"
if [ -z "$entry" ]; then
  flags=()
  case "$tag" in *-*) flags+=(--prerelease) ;; esac
  # gh puts --notes in front of the generated notes, so the manifest line comes
  # first. Categories come from .github/release.yml.
  gh release create "$tag" --draft --verify-tag --title "$tag" --generate-notes \
    --notes "The manifest ($asset) holds the image digests, the worker runtime and the chart version." \
    ${flags[@]+"${flags[@]}"}
  # The listing can lag behind the create by a moment.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    entry="$(find_release)"
    [ -z "$entry" ] || break
    sleep 3
  done
fi
if [ -z "$entry" ]; then
  echo "::error::the release for ${tag} does not appear in the list" >&2
  exit 1
fi
read -r id draft <<<"$entry"

line="$(find_asset "$id")"
if [ -n "$line" ]; then
  read -r asset_id state <<<"$line"
  if [ "$state" = uploaded ]; then
    if ! matches "$id"; then
      echo "::error::${tag} already carries a different ${asset}; it is not replaced" >&2
      exit 1
    fi
    echo "${tag} already carries this ${asset}: a rerun"
  else
    # An upload that did not finish leaves a stub; it holds no manifest.
    gh api -X DELETE "repos/${repo}/releases/assets/${asset_id}"
    line=""
  fi
fi
if [ -z "$line" ]; then
  # A failed upload may still have lost a race to an identical one, so the
  # readback decides.
  gh release upload "$tag" "$manifest" || echo "upload failed, reading back" >&2
  if ! matches "$id"; then
    echo "::error::${tag} does not carry this ${asset} after the upload" >&2
    exit 1
  fi
fi

if [ "$draft" = true ]; then
  gh api -X PATCH "repos/${repo}/releases/${id}" -F draft=false >/dev/null
fi
test "$(gh api "repos/${repo}/releases/${id}" --jq .draft)" = false
echo "${tag} is published with ${asset}"

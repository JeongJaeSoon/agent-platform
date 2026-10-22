#!/usr/bin/env bash
# What the images are built from: HEAD plus a digest of uncommitted changes
# (tracked diffs and untracked files), skill files excluded.
#   tree-id.sh <repo>
set -euo pipefail
cd "$1"
{
  git diff HEAD --binary -- . ':!.claude'
  git ls-files --others --exclude-standard -z -- . ':!.claude' | xargs -0 -r shasum
} | shasum | { read -r digest _; echo "$(git rev-parse HEAD)+$digest"; }

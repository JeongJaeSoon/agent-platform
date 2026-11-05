#!/usr/bin/env bash
set -euo pipefail

tests=true
product=true
site=true
quickstart=true
docs_only=false
count=0

if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
  base="${BASE_SHA:?BASE_SHA is required for a pull request}"
  if [[ ! "$base" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::invalid pull request base SHA" >&2
    exit 1
  fi
  git fetch --no-tags --depth=1 origin "$base"
  paths="${RUNNER_TEMP:?}/ci-paths"
  git diff --name-only --no-renames -z "$base" HEAD >"$paths"
  docs_only=true
  site=false
  quickstart=false
  while IFS= read -r -d '' path; do
    count=$((count + 1))
    case "$path" in
      README.md | CHANGELOG.md | docs/*.md | apps/docs/content/*.mdx) ;;
      *) docs_only=false ;;
    esac
    case "$path" in
      apps/docs/content/*) site=true ;;
    esac
    case "$path" in
      docs/quickstart.md | apps/docs/content/docs/reference/api-guide.mdx) quickstart=true ;;
    esac
  done <"$paths"
  if [ "$docs_only" = true ] && [ "$count" -gt 0 ]; then
    tests=false
    product=false
  else
    docs_only=false
    site=true
    quickstart=true
  fi
fi

printf '%s\n' \
  "tests=$tests" \
  "product=$product" \
  "site=$site" \
  "quickstart=$quickstart" \
  "docs_only=$docs_only" >>"${GITHUB_OUTPUT:?}"
echo "CI plan: files=$count docs_only=$docs_only tests=$tests product=$product site=$site quickstart=$quickstart"


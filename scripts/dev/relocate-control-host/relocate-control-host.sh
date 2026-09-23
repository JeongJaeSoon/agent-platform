#!/usr/bin/env bash
# 94S-117 L1: apps/api, apps/scheduler and apps/reconciler become one app,
# apps/control-host, with one executable that names its role
# (`src/main.ts api|scheduler|reconciler`) and one image.
#
# Run from the repository root on a clean checkout of the latest main; run it
# again there right before the feature branch lands, so PRs that touched the
# old apps in between are carried along. Every text edit asserts the text it
# expects: drift on main stops the run with the file and the snippet instead
# of producing a half move.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

test -z "$(git status --porcelain)" || { echo "tree not clean" >&2; exit 1; }
for app in api scheduler reconciler; do
  test -d "apps/$app" || { echo "apps/$app is missing" >&2; exit 1; }
done
test ! -e apps/control-host || { echo "apps/control-host already exists" >&2; exit 1; }

expect_files() {
  local dir="$1"; shift
  local found
  found="$(git ls-files -- "$dir" | grep -v "^$dir/src/" | sort | tr '\n' ' ')"
  [ "$found" = "$* " ] || { echo "$dir holds files this script does not know: $found" >&2; exit 1; }
}
expect_files apps/api apps/api/Dockerfile apps/api/package.json apps/api/tsconfig.json
expect_files apps/scheduler apps/scheduler/Dockerfile apps/scheduler/package.json apps/scheduler/tsconfig.json
expect_files apps/reconciler apps/reconciler/package.json apps/reconciler/tsconfig.json

# The manifests the merged package.json is built from, before they go.
manifests="$(mktemp -d)"
trap 'rm -rf "$manifests"' EXIT
for app in api scheduler reconciler; do
  cp "apps/$app/package.json" "$manifests/$app.json"
done

git mv apps/api apps/control-host
git mv apps/control-host/src apps/control-host/api-src
mkdir -p apps/control-host/src
git mv apps/control-host/api-src apps/control-host/src/api
git mv apps/scheduler/src apps/control-host/src/scheduler
git mv apps/reconciler/src apps/control-host/src/reconciler
git rm -q apps/scheduler/Dockerfile apps/scheduler/package.json apps/scheduler/tsconfig.json \
  apps/reconciler/package.json apps/reconciler/tsconfig.json
# git mv leaves ignored node_modules behind. Anything else left there is an
# ignored file someone keeps (a local env file), so stop rather than delete it.
for old in apps/api apps/scheduler apps/reconciler; do
  test -z "$(git ls-files -- "$old")" || { echo "$old still has tracked files" >&2; exit 1; }
  test -e "$old" || continue
  kept="$(find "$old" -name node_modules -prune -o -type f ! -name .DS_Store -print)"
  test -z "$kept" || { printf '%s holds ignored files; move them first:\n%s\n' "$old" "$kept" >&2; exit 1; }
  /bin/rm -rf "$old"
done

MANIFESTS="$manifests" python3 "$here/relocate_control_host.py"

bun install >/dev/null
bunx biome check --write . >/dev/null || true
git add -A
echo "moved; now: bun run check, then the role E2E in the PR body"

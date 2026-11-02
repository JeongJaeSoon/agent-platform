#!/usr/bin/env bash
# Seed the rich demo data into a verify-agent-platform run started with
# VERIFY_DEMO_ACCOUNTS=1 and infra/compose.mock-slack.yml:
#   scripts/dev/demo-rich-seed.sh <run dir> [--keep-running]
# Account passwords stay in <run dir>/demo-rich-accounts.json (0600); the
# script never prints them.
set -euo pipefail
run=${1:?run dir}
shift
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$repo"
# shellcheck disable=SC1091
. .claude/skills/verify-agent-platform/scripts/lib.sh "$run" >/dev/null
accounts="$run/demo-rich-accounts.json"
inside=/app/apps/control-host/src/api/demo-rich-seed.ts
ap_compose cp scripts/dev/demo-rich-seed.ts "api:$inside" >/dev/null
# Written through stdin so the file belongs to the container's user;
# `compose cp` would keep the host owner and its 0600 would lock it out.
if [ -f "$accounts" ]; then
  ap_compose exec -T api sh -c 'umask 077; cat > /tmp/demo-rich-creds.json' <"$accounts"
fi
code=0
ap_compose exec -T -w /app/apps/control-host api bun run "$inside" "$@" || code=$?
if [ "$*" != "--keep-running" ]; then
  umask 077
  # A run that died before writing must not blank the passwords kept so far.
  if ap_compose exec -T api cat /tmp/demo-rich-creds.json >"$accounts.new" && [ -s "$accounts.new" ]; then
    mv "$accounts.new" "$accounts"
    chmod 600 "$accounts"
  else
    rm -f "$accounts.new"
  fi
fi
exit "$code"

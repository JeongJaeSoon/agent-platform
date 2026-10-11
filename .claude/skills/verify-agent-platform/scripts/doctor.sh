#!/usr/bin/env bash
# Read-only: is the latest (or given) run's stack worth driving?
#   doctor.sh [run dir]
set -uo pipefail
here=$(dirname "$0")
# shellcheck disable=SC1091
. "$here/lib.sh" "${1:-}"
echo "run:      $VERIFY_RUN"
echo "project:  $COMPOSE_PROJECT_NAME"
echo "checkout: $(git -C "$VERIFY_REPO" rev-parse --short HEAD)"
echo "api:      $API"
ap_compose ps --format '{{.Service}} {{.State}}' | sort
ready=$(curl -sS --max-time 3 "$API/readyz" || true)
echo "readyz:   ${ready:-no answer}"
case "$ready" in *'"status":"ready"'*) ;; *) exit 1 ;; esac

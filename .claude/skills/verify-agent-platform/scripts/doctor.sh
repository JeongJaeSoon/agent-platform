#!/usr/bin/env bash
# Read-only: is the latest (or given) run's stack worth driving?
#   doctor.sh [run dir]
set -uo pipefail
here=$(dirname "$0")
# shellcheck disable=SC1091
. "$here/lib.sh" "${1:-}"
echo "run:      $VERIFY_RUN"
echo "project:  $COMPOSE_PROJECT_NAME"
head=$(git -C "$VERIFY_REPO" rev-parse HEAD)
echo "built:    ${VERIFY_BUILT_FROM:-unknown}"
echo "checkout: $head"
# The images were built from VERIFY_BUILT_FROM; a moved HEAD is not what runs.
[ "$head" = "${VERIFY_BUILT_FROM:-}" ] || { echo "doctor: checkout moved since up.sh; down.sh and up.sh again" >&2; exit 1; }
echo "api:      $API"
ap_compose ps --format '{{.Service}} {{.State}}' | sort
ready=$(curl -sS --max-time 3 "$API/readyz" || true)
echo "readyz:   ${ready:-no answer}"
case "$ready" in *'"status":"ready"'*) ;; *) exit 1 ;; esac

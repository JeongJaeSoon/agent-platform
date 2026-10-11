#!/usr/bin/env bash
# Read-only: is the latest (or given) run's stack worth driving?
#   doctor.sh [run dir]
set -uo pipefail
here=$(dirname "$0")
# shellcheck disable=SC1091
. "$here/lib.sh" "${1:-}"
echo "run:      $VERIFY_RUN"
echo "project:  $COMPOSE_PROJECT_NAME"
head=$("$here/tree-id.sh" "$VERIFY_REPO") || exit 1
echo "built:    ${VERIFY_BUILT_FROM:-unknown}"
echo "checkout: $head"
# The images were built from VERIFY_BUILT_FROM; a moved HEAD or a new edit is not what runs.
[ "$head" = "${VERIFY_BUILT_FROM:-}" ] || { echo "doctor: checkout (HEAD or uncommitted changes) moved since up.sh; down.sh and up.sh again" >&2; exit 1; }
echo "api:      $API"
services=$(ap_compose ps --format '{{.Service}} {{.State}} {{.Health}}') || { echo "doctor: docker compose ps failed" >&2; exit 1; }
echo "$services" | sort
# /readyz covers the database, schema and config only; sessions also need
# these running (and healthy where they have a healthcheck).
for service in api scheduler reconciler postgres localstack gitea egress-proxy fake-messages secrets; do
  line=$(echo "$services" | awk -v s="$service" '$1 == s')
  case "$line" in
    *" running unhealthy" | *" running starting") echo "doctor: $service is not healthy yet: $line" >&2; exit 1 ;;
    *" running"*) ;;
    *) echo "doctor: $service is not running${line:+: $line}" >&2; exit 1 ;;
  esac
done
ready=$(curl -sS --max-time 3 "$API/readyz" || true)
echo "readyz:   ${ready:-no answer}"
case "$ready" in *'"status":"ready"'*) ;; *) exit 1 ;; esac

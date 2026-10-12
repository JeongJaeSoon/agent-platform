#!/usr/bin/env bash
# Runs one operator CLI of the api (keys, grants, catalog-authority) inside
# an api Pod of a Kubernetes install, the way `bun run keys` does inside the
# compose api container: the Pod already has DATABASE_URL from the chart's
# Secret, so nothing secret passes through this shell.
#
#   scripts/k8s-api.sh <keys|grants|catalog-authority> <args...>
#
# kubectl's current context, or KUBECONFIG, picks the cluster. NAMESPACE and
# RELEASE name the chart install (both default to agent-platform).
set -euo pipefail

NAMESPACE="${NAMESPACE:-agent-platform}"
RELEASE="${RELEASE:-agent-platform}"

cli="${1:-}"
case "$cli" in
  keys | grants | catalog-authority) shift ;;
  *)
    echo "usage: scripts/k8s-api.sh <keys|grants|catalog-authority> <args...>" >&2
    exit 2
    ;;
esac

# The chart's fullname rule (ap.fullname in _helpers.tpl).
fullname="$RELEASE"
case "$RELEASE" in *agent-platform*) ;; *) fullname="${RELEASE}-agent-platform" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"

exec kubectl -n "$NAMESPACE" exec "deploy/${fullname}-api" -c api -- \
  bun run "apps/control-host/src/api/${cli}.ts" "$@"

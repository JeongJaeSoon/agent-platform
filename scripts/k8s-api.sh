#!/usr/bin/env bash
# Runs one operator CLI of the api (keys, grants, settings) inside an api Pod
# of a Kubernetes install, the way `bun run keys` does inside the compose api
# container: the Pod already has DATABASE_URL from the chart's Secret, so
# nothing secret passes through this shell. Stdin reaches the CLI:
# `settings import --document -` reads the document from it.
#
#   scripts/k8s-api.sh <keys|grants|settings> <args...>
#
# kubectl's current context, or KUBECONFIG, picks the cluster. NAMESPACE and
# RELEASE name the chart install (both default to werft).
set -euo pipefail

NAMESPACE="${NAMESPACE:-werft}"
RELEASE="${RELEASE:-werft}"

cli="${1:-}"
case "$cli" in
  keys | grants | settings) shift ;;
  *)
    echo "usage: scripts/k8s-api.sh <keys|grants|settings> <args...>" >&2
    exit 2
    ;;
esac

# The chart's fullname rule (ap.fullname in _helpers.tpl).
fullname="$RELEASE"
case "$RELEASE" in *werft*) ;; *) fullname="${RELEASE}-werft" ;; esac
fullname="${fullname:0:50}"
fullname="${fullname%-}"

exec kubectl -n "$NAMESPACE" exec "deploy/${fullname}-api" -i -c api -- \
  bun run "apps/control-host/src/api/${cli}.ts" "$@"

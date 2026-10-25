#!/usr/bin/env bash
# Brings a pull request up as a preview on OrbStack's built-in Kubernetes:
# its own namespace pr-<N>, reached by Host pr-<N>.$PREVIEW_DOMAIN through
# one Traefik shared by every preview.
#
#   deploy/preview/preview.sh up <N>    check the PR head out, build its images
#                                       (tag pr-<N>), install or upgrade, and
#                                       read /readyz through Traefik
#   deploy/preview/preview.sh down <N>  delete the namespace, the image tags
#                                       and the checkout
#   deploy/preview/preview.sh list      the previews: URL, head, memory, /readyz
#
# The PR's own tree is installed (Dockerfiles, chart, stand-ins) by this
# checkout's deploy/kind/up.sh, copied into it, so a head that predates
# up.sh's orbstack mode still installs. The fake model only.
#
# Each preview namespace carries the label agent-platform.dev/preview=true
# and the annotations agent-platform.dev/preview-head (the installed head)
# and agent-platform.dev/preview-up-at (when `up` last started).
#
#   PREVIEW_HOME       checkouts and up.sh state, outside any git worktree
#                      (default ~/.cache/agent-platform/preview)
#   PREVIEW_DOMAIN     the hosts' parent domain (default preview.94soon.dev)
#   PREVIEW_MEMORY_MI  what one preview needs from the node's unrequested
#                      memory before `up` installs it (default 2560: the
#                      requests of deploy/preview/values.yaml's Deployments
#                      and one session worker)
#   MAX_MEMORY_MI      the node memory the check counts from, in place of
#                      its allocatable memory
set -euo pipefail

PREVIEW_HOME="${PREVIEW_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-platform/preview}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.94soon.dev}"
PREVIEW_MEMORY_MI="${PREVIEW_MEMORY_MI:-2560}"
INGRESS_NAMESPACE=preview-ingress
TRAEFIK_CHART=oci://ghcr.io/traefik/helm/traefik
TRAEFIK_VERSION=42.1.3
HTTP_PORT=18180
HTTPS_PORT=18543
APPS=(control-host egress-proxy worker)

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

usage() {
  echo "usage: $0 up <PR number> | down <PR number> | list" >&2
  exit 2
}

# It goes into the Ingress manifest below.
if ! [[ "$PREVIEW_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "PREVIEW_DOMAIN must be a DNS name, not '${PREVIEW_DOMAIN}'" >&2
  exit 1
fi
for name in PREVIEW_MEMORY_MI MAX_MEMORY_MI; do
  if [ -n "${!name:-}" ] && ! [[ "${!name}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be a whole number of MiB, not '${!name}'" >&2
    exit 1
  fi
done

pr_number() {
  if ! [[ "${1:-}" =~ ^[1-9][0-9]{0,6}$ ]]; then
    echo "a PR number, not '${1:-}'" >&2
    usage
  fi
  printf '%s' "$1"
}

mkdir -p "$PREVIEW_HOME"
chmod 700 "$PREVIEW_HOME"
# Only OrbStack's cluster, whatever the shell's current context is.
export KUBECONFIG="${PREVIEW_HOME}/kubeconfig"
if ! env -u KUBECONFIG kubectl config view --raw --minify --context orbstack >"$KUBECONFIG" 2>/dev/null; then
  echo "no orbstack context in the default kubeconfig: is OrbStack's Kubernetes on?" >&2
  exit 1
fi
chmod 600 "$KUBECONFIG"

# The LoadBalancer ports stay on the Mac's 127.0.0.1 only while OrbStack does
# not expose services to the local network.
require_local_only() {
  local expose
  expose="$(orb config get k8s.expose_services)"
  if [ "$expose" != false ]; then
    echo "OrbStack k8s.expose_services is '${expose}': Traefik's ports would be open to the network" >&2
    exit 1
  fi
}

ensure_traefik() {
  helm status traefik --namespace "$INGRESS_NAMESPACE" >/dev/null 2>&1 && return
  echo "installing Traefik ${TRAEFIK_VERSION} into ${INGRESS_NAMESPACE}"
  # Without the CRD provider the chart needs none of its CRDs, and skipping
  # them leaves nothing cluster-wide behind an uninstall but the IngressClass.
  helm upgrade --install traefik "$TRAEFIK_CHART" --version "$TRAEFIK_VERSION" \
    --namespace "$INGRESS_NAMESPACE" --create-namespace --skip-crds \
    -f "$here/traefik-values.yaml" \
    --set "ports.web.exposedPort=${HTTP_PORT}" \
    --set "ports.websecure.exposedPort=${HTTPS_PORT}" \
    --wait --timeout 5m
}

# Quantities as Kubernetes writes them (128Mi, 1Gi, 512M, bytes) in MiB.
JQ_MI='def mi: capture("^(?<n>[0-9.]+)(?<u>[A-Za-z]*)$")
  | (.n | tonumber) * {"": 1, "k": 1e3, "Ki": 1024, "M": 1e6, "Mi": 1048576,
      "G": 1e9, "Gi": 1073741824, "T": 1e12, "Ti": 1099511627776}[.u] / 1048576;'

require_memory() {
  local namespace="$1" allocatable requested free
  allocatable="${MAX_MEMORY_MI:-$(kubectl get nodes -o json \
    | jq "${JQ_MI} [.items[].status.allocatable.memory | mi] | add | floor")}"
  requested="$(kubectl get pods --all-namespaces -o json | jq "${JQ_MI}
    [.items[] | select(.status.phase != \"Succeeded\" and .status.phase != \"Failed\")
      | .spec.containers[].resources.requests.memory // \"0\" | mi] | add // 0 | ceil")"
  free=$((allocatable - requested))
  if [ "$free" -lt "$PREVIEW_MEMORY_MI" ]; then
    echo "not installing ${namespace}: the node has ${allocatable}Mi, pods request ${requested}Mi," \
      "leaving ${free}Mi, under the ${PREVIEW_MEMORY_MI}Mi one preview needs" >&2
    exit 1
  fi
  echo "memory: ${allocatable}Mi - ${requested}Mi requested = ${free}Mi free, ${PREVIEW_MEMORY_MI}Mi needed"
}

readyz() {
  local host="$1"
  curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "${host}:${HTTPS_PORT}:127.0.0.1" "https://${host}:${HTTPS_PORT}/readyz" || true
}

# The printed URLs are the entry point's (443, 94S-961); this is the same
# host on Traefik's own port, which needs no DNS.
local_hint() {
  echo "on this Mac: curl -k --resolve ${1}:${HTTPS_PORT}:127.0.0.1 https://${1}:${HTTPS_PORT}/"
}

free_port() {
  bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    console.log(s.port); s.stop(true);'
}

up() {
  local n namespace host dir head code
  n="$(pr_number "${1:-}")"
  namespace="pr-${n}"
  host="${namespace}.${PREVIEW_DOMAIN}"
  dir="${PREVIEW_HOME}/${namespace}"
  SECONDS=0

  require_local_only
  if kubectl get namespace "$namespace" >/dev/null 2>&1; then
    require_preview "$namespace"
  else
    require_memory "$namespace"
  fi
  ensure_traefik

  git -C "$root" fetch -q origin "+refs/pull/${n}/head:refs/preview/${namespace}"
  head="$(git -C "$root" rev-parse "refs/preview/${namespace}")"
  if [ -d "${dir}/src" ]; then
    git -C "${dir}/src" checkout -q --force --detach "$head"
  else
    git -C "$root" worktree add -q --detach "${dir}/src" "$head"
  fi
  cp "$root/deploy/kind/up.sh" "${dir}/src/deploy/kind/preview-up.sh"
  echo "${namespace}: head ${head}"

  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl label namespace "$namespace" --overwrite agent-platform.dev/preview=true >/dev/null
  kubectl annotate namespace "$namespace" --overwrite \
    "agent-platform.dev/preview-up-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null

  CLUSTER_PROVIDER=orbstack KIND_MODEL=fake NAMESPACE="$namespace" IMAGE_TAG="$namespace" \
    EXTRA_VALUES="$here/values.yaml" STATE_DIR="${dir}/state" FORWARD_PORT="$(free_port)" \
    "${dir}/src/deploy/kind/preview-up.sh"

  # Traefik's legacy router names come from the Ingress name alone, so the
  # same name in two namespaces collides and the second host answers 404.
  kubectl -n "$namespace" apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: preview-${namespace}
spec:
  ingressClassName: preview
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: agent-platform-api
                port:
                  number: 3000
EOF
  kubectl annotate namespace "$namespace" --overwrite "agent-platform.dev/preview-head=${head}" >/dev/null

  for _ in $(seq 1 30); do
    code="$(readyz "$host")"
    [ "$code" = 200 ] && break
    sleep 2
  done
  echo "GET https://${host}/readyz (Traefik 127.0.0.1:${HTTPS_PORT}) -> ${code}"
  echo "${namespace} up in ${SECONDS}s: https://${host}/"
  local_hint "$host"
  [ "$code" = 200 ]
}

# Refuses a namespace this script did not make.
require_preview() {
  local label
  label="$(kubectl get namespace "$1" -o jsonpath='{.metadata.labels.agent-platform\.dev/preview}')"
  if [ "$label" != true ]; then
    echo "namespace $1 exists without the label agent-platform.dev/preview=true: not a preview" >&2
    exit 1
  fi
}

down() {
  local n namespace dir left app
  n="$(pr_number "${1:-}")"
  namespace="pr-${n}"
  dir="${PREVIEW_HOME}/${namespace}"

  if kubectl get namespace "$namespace" >/dev/null 2>&1; then
    require_preview "$namespace"
    kubectl delete namespace "$namespace" --wait --timeout 5m
  fi
  # The kubelet removes the pods' exited containers within about a minute;
  # until then they hold the images.
  for _ in $(seq 1 24); do
    left="$(docker ps -aq --filter "label=io.kubernetes.pod.namespace=${namespace}" | wc -l | tr -d ' ')"
    [ "$left" = 0 ] && break
    sleep 5
  done
  echo "${namespace}: ${left} containers left"
  for app in "${APPS[@]}"; do
    docker image rm "agent-platform-${app}:${namespace}" >/dev/null 2>&1 \
      && echo "removed agent-platform-${app}:${namespace}"
  done
  if [ -d "${dir}/src" ]; then
    git -C "$root" worktree remove --force "${dir}/src"
  fi
  git -C "$root" update-ref -d "refs/preview/${namespace}" 2>/dev/null || true
  rm -rf -- "${PREVIEW_HOME:?}/${namespace:?}"
}

list() {
  local metrics namespace head up_at memory
  metrics="$(kubectl top pods --all-namespaces --no-headers 2>/dev/null || true)"
  printf '%-10s %-44s %-12s %-20s %-14s %s\n' NAMESPACE URL HEAD UP_AT MEMORY READYZ
  kubectl get namespaces -l agent-platform.dev/preview=true -o json | jq -r '.items[]
    | [.metadata.name,
       (.metadata.annotations["agent-platform.dev/preview-head"] // "-"),
       (.metadata.annotations["agent-platform.dev/preview-up-at"] // "-")] | @tsv' \
    | while IFS=$'\t' read -r namespace head up_at; do
      if [ -n "$metrics" ]; then
        memory="$(awk -v ns="$namespace" '$1 == ns { sub(/Mi$/, "", $4); total += $4 }
          END { printf "%dMi used", total }' <<<"$metrics")"
      else
        memory="$(kubectl -n "$namespace" get pods -o json | jq -r "${JQ_MI}
          [.items[].spec.containers[].resources.requests.memory // \"0\" | mi] | add // 0
          | \"\\(ceil)Mi req\"")"
      fi
      printf '%-10s %-44s %-12s %-20s %-14s %s\n' "$namespace" \
        "https://${namespace}.${PREVIEW_DOMAIN}/" "${head:0:12}" "$up_at" "$memory" \
        "$(readyz "${namespace}.${PREVIEW_DOMAIN}")"
    done
  local_hint "pr-<N>.${PREVIEW_DOMAIN}"
}

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down "${2:-}" ;;
  list) list ;;
  *) usage ;;
esac

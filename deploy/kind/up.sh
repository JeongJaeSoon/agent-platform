#!/usr/bin/env bash
# Installs the chart on a local kind cluster with its default values, over
# the development stand-ins in deps.yaml, and checks what a fresh install
# must reach: the migrate Job complete, the api answering /readyz and /docs,
# the egress proxy and the reconciler Ready.
#
#   deploy/kind/up.sh        create (or reuse) the cluster and registry, build,
#                            push, install, check
#   deploy/kind/up.sh down   delete the cluster and the registry container
#
# Images go through a registry container connected to the kind network (the
# kind + registry:2 pattern), so they have the digests the chart requires.
# The kubeconfig is written to $STATE_DIR, never to ~/.kube/config.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-agent-platform-dev}"
REGISTRY_NAME="${REGISTRY_NAME:-${CLUSTER_NAME}-registry}"
REGISTRY_PORT="${REGISTRY_PORT:-5001}"
NAMESPACE="${NAMESPACE:-agent-platform}"
RELEASE="${RELEASE:-agent-platform}"
STATE_DIR="${STATE_DIR:-${TMPDIR:-/tmp}/${CLUSTER_NAME}}"
REGISTRY_IMAGE="registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"

root="$(cd "$(dirname "$0")/../.." && pwd)"
export KUBECONFIG="${STATE_DIR}/kubeconfig"
mkdir -p "$STATE_DIR"

if [ "${1:-}" = down ]; then
  kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG"
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  exit 0
fi

if [ -z "$(docker ps -q --filter "name=^${REGISTRY_NAME}$")" ]; then
  docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --network bridge --name "$REGISTRY_NAME" "$REGISTRY_IMAGE" >/dev/null
fi

if ! kind get clusters | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --config - <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
EOF
fi
# Pods pull localhost:<port>/... from the registry container by its name.
for node in $(kind get nodes --name "$CLUSTER_NAME"); do
  dir="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  docker exec "$node" mkdir -p "$dir"
  printf '[host."http://%s:5000"]\n' "$REGISTRY_NAME" | docker exec -i "$node" cp /dev/stdin "$dir/hosts.toml"
done
docker network connect kind "$REGISTRY_NAME" 2>/dev/null || true

# Builds and pushes one app image; prints its registry digest.
publish() {
  local ref="localhost:${REGISTRY_PORT}/agent-platform-$1:dev"
  docker build -q -f "$root/apps/$1/Dockerfile" -t "$ref" "$root" >/dev/null
  docker push -q "$ref" >/dev/null
  docker inspect --format '{{index .RepoDigests 0}}' "$ref" | sed 's/.*@//'
}
control_host_digest="$(publish control-host)"
egress_proxy_digest="$(publish egress-proxy)"
worker_digest="$(publish worker)"

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create configmap localstack-init \
  --from-file=10-create-resources.sh="$root/infra/localstack/init/10-create-resources.sh" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" apply -f "$root/deploy/kind/deps.yaml"

# The Secret the chart reads. The authorizer token is random per cluster and
# never printed; the rest are the stand-ins' local defaults. The default
# catalog names ANTHROPIC_API_KEY, which only has to resolve here: no session
# runs in this check.
if ! kubectl -n "$NAMESPACE" get secret agent-platform >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" create secret generic agent-platform \
    --from-literal=DATABASE_URL=postgresql://postgres:dev@postgres:5432/sessions \
    --from-literal=EGRESS_AUTHORIZER_TOKEN="$(openssl rand -hex 32)" \
    --from-literal=AWS_ACCESS_KEY_ID=test \
    --from-literal=AWS_SECRET_ACCESS_KEY=test \
    --from-literal=ANTHROPIC_API_KEY=kind-check-no-key >/dev/null
fi

kubectl -n "$NAMESPACE" rollout status deploy/postgres --timeout=180s
kubectl -n "$NAMESPACE" rollout status deploy/localstack --timeout=300s

# No --wait: the scheduler's kubernetes backend (94S-523/524) is checked on
# its own (94S-525). Helm still waits for the migrate hook.
helm upgrade --install "$RELEASE" "$root/deploy/helm/agent-platform" \
  --namespace "$NAMESPACE" \
  -f "$root/deploy/kind/values.yaml" \
  --set "images.controlHost.repository=localhost:${REGISTRY_PORT}/agent-platform-control-host" \
  --set "images.controlHost.digest=${control_host_digest}" \
  --set "images.egressProxy.repository=localhost:${REGISTRY_PORT}/agent-platform-egress-proxy" \
  --set "images.egressProxy.digest=${egress_proxy_digest}" \
  --set "images.worker.repository=localhost:${REGISTRY_PORT}/agent-platform-worker" \
  --set "images.worker.digest=${worker_digest}" \
  --timeout 10m

fullname="$RELEASE"
case "$RELEASE" in *agent-platform*) ;; *) fullname="${RELEASE}-agent-platform" ;; esac

kubectl -n "$NAMESPACE" wait --for=condition=complete "job/${fullname}-migrate" --timeout=60s
for deploy in api egress-proxy reconciler; do
  kubectl -n "$NAMESPACE" rollout status "deploy/${fullname}-${deploy}" --timeout=600s
done

kubectl -n "$NAMESPACE" port-forward "svc/${fullname}-api" 13000:3000 >"$STATE_DIR/port-forward.log" 2>&1 &
forward=$!
trap 'kill "$forward" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:13000/healthz" && break
  sleep 1
done
status=0
for path in /readyz /docs; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:13000${path}")"
  echo "GET ${path} -> ${code}"
  [ "$code" = 200 ] || status=1
done

kubectl -n "$NAMESPACE" get jobs,deploy,pods -o wide
exit "$status"

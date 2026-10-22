#!/usr/bin/env bash
# Installs the chart on a local kind cluster with its default values, over
# the development stand-ins in deps.yaml, and checks what a fresh install
# must reach: the migrate Job complete, the api answering /readyz and /docs,
# the egress proxy, the reconciler and the scheduler Ready.
#
#   deploy/kind/up.sh        create (or reuse) the cluster and registry, build,
#                            push, install, check
#   deploy/kind/up.sh down   delete the cluster and the registry container
#
# Images go through a registry container connected to the kind network (the
# kind + registry:2 pattern), so they have the digests the chart requires.
# The kubeconfig is written to $STATE_DIR, never to ~/.kube/config.
#
# KIND_MODEL (default none) also installs what a session needs; smoke.sh
# sets it and runs one:
#   none  the default catalog, with a placeholder key: no session runs
#   fake  config/fake-model's catalog, its fake Messages API and Secrets
#         Manager (deps-fake-model.yaml), and the sample repository
#   real  the chart's claude-coding-real profile and the sample repository,
#         with ANTHROPIC_API_KEY read by scripts/lib/real-model-key.sh
#         (the shell's, else the AGENT_PLATFORM_DOTENV file's line). The
#         key goes into the Secret from a file descriptor: never printed,
#         never in an argument. A fresh cluster only.
#
# CI pulls nothing from Docker Hub (docs/contributing/ci.md § 서드파티 이미지 미러):
#   KIND_NODE_IMAGE, REGISTRY_IMAGE  the node and registry images
#   KIND_IMAGE_MIRROR                prefix the stand-ins' images are pulled
#                                    from instead, by the same digest
#   BUN_IMAGE, BUILDKIT_SYNTAX       build args of the app images
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-agent-platform-dev}"
REGISTRY_NAME="${REGISTRY_NAME:-${CLUSTER_NAME}-registry}"
REGISTRY_PORT="${REGISTRY_PORT:-5001}"
# Local end of the api port-forward the check below reads through.
FORWARD_PORT="${FORWARD_PORT:-13000}"
NAMESPACE="${NAMESPACE:-agent-platform}"
RELEASE="${RELEASE:-agent-platform}"
KIND_MODEL="${KIND_MODEL:-none}"
# Per user, not a shared /tmp path another user could create first.
STATE_DIR="${STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-platform/kind/${CLUSTER_NAME}}"
REGISTRY_IMAGE="${REGISTRY_IMAGE:-registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373}"

root="$(cd "$(dirname "$0")/../.." && pwd)"
export KUBECONFIG="${STATE_DIR}/kubeconfig"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [ "${1:-}" = down ]; then
  kind delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG"
  docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
  exit 0
fi

case "$KIND_MODEL" in
  none | fake | real) ;;
  *) echo "KIND_MODEL must be none, fake or real, not '${KIND_MODEL}'" >&2; exit 1 ;;
esac
# It goes into a sed replacement below.
if ! [[ "${KIND_IMAGE_MIRROR:-}" =~ ^[a-z0-9./:-]*$ ]]; then
  echo "KIND_IMAGE_MIRROR must be a registry path, not '${KIND_IMAGE_MIRROR}'" >&2
  exit 1
fi

# The manifest with each image moved to the mirror: `<path>/<name>:<tag>@<digest>`
# becomes `$KIND_IMAGE_MIRROR/<name>@<digest>`, the mirror's naming.
manifest() {
  if [ -n "${KIND_IMAGE_MIRROR:-}" ]; then
    sed -E "s#^( *image: )([^ ]*/)?([a-z0-9-]+):[^@ ]+@#\\1${KIND_IMAGE_MIRROR}/\\3@#" "$1"
  else
    cat "$1"
  fi
}

if [ -z "$(docker ps -q --filter "name=^${REGISTRY_NAME}$")" ]; then
  docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --network bridge --name "$REGISTRY_NAME" "$REGISTRY_IMAGE" >/dev/null
fi

if ! kind get clusters | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" \
    ${KIND_NODE_IMAGE:+--image "$KIND_NODE_IMAGE"} --config - <<'EOF'
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
  docker build -q -f "$root/apps/$1/Dockerfile" -t "$ref" \
    ${BUN_IMAGE:+--build-arg "BUN_IMAGE=$BUN_IMAGE"} \
    ${BUILDKIT_SYNTAX:+--build-arg "BUILDKIT_SYNTAX=$BUILDKIT_SYNTAX"} \
    "$root" >/dev/null
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
manifest "$root/deploy/kind/deps.yaml" | kubectl -n "$NAMESPACE" apply -f -
deps=(postgres localstack)
values=(-f "$root/deploy/kind/values.yaml")

if [ "$KIND_MODEL" != none ]; then
  kubectl -n "$NAMESPACE" create configmap gitea-init \
    --from-file=init-sample-repo.sh="$root/infra/gitea/init-sample-repo.sh" \
    --dry-run=client -o yaml | kubectl apply -f -
  manifest "$root/deploy/kind/deps-session.yaml" | kubectl -n "$NAMESPACE" apply -f -
  deps+=(gitea)
  values+=(-f "$root/deploy/kind/values-${KIND_MODEL}-model.yaml")
fi
if [ "$KIND_MODEL" = fake ]; then
  testkit="$root/packages/testkit/src"
  kubectl -n "$NAMESPACE" create configmap fake-messages-source \
    --from-file="$testkit/fake-messages-main.ts" \
    --from-file="$testkit/fake-anthropic.ts" \
    --from-file="$testkit/scripted-messages.ts" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$NAMESPACE" create configmap secrets-init \
    --from-file=10-seed-secrets.sh="$root/infra/localstack/secrets-init/10-seed-secrets.sh" \
    --dry-run=client -o yaml | kubectl apply -f -
  manifest "$root/deploy/kind/deps-fake-model.yaml" | kubectl -n "$NAMESPACE" apply -f -
  deps+=(fake-messages secrets)
  # config/fake-model as the chart's catalog, in place of its default one.
  bun -e '
    const read = async (name) =>
      Bun.YAML.parse(await Bun.file(`${process.argv[1]}/${name}.yaml`).text());
    const { profiles } = await read("profiles");
    const { repositories } = await read("repositories");
    console.log(JSON.stringify({
      catalog: { profiles: { "claude-coding-real": null, ...profiles }, repositories },
    }));
  ' "$root/config/fake-model" >"$STATE_DIR/catalog-fake-model.json"
  values+=(-f "$STATE_DIR/catalog-fake-model.json")
fi

# The Secret the chart reads. The authorizer token is random per cluster,
# never printed and never on a command line; the rest are the stand-ins'
# local defaults. The default catalog names ANTHROPIC_API_KEY, which only
# has to resolve unless KIND_MODEL is real.
if [ "$KIND_MODEL" = real ]; then
  if kubectl -n "$NAMESPACE" get secret agent-platform >/dev/null 2>&1; then
    echo "KIND_MODEL=real needs a fresh cluster: the Secret already holds another key (up.sh down first)" >&2
    exit 1
  fi
  set +x
  # shellcheck source=../../scripts/lib/real-model-key.sh
  . "$root/scripts/lib/real-model-key.sh"
  if ! real_model_key_from_dotenv; then
    echo "KIND_MODEL=real: no ANTHROPIC_API_KEY in the shell or in ${AGENT_PLATFORM_DOTENV:-.env}" >&2
    exit 1
  fi
  provider_key() { printf '%s' "$ANTHROPIC_API_KEY"; }
else
  provider_key() { printf kind-check-no-key; }
fi
if ! kubectl -n "$NAMESPACE" get secret agent-platform >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" create secret generic agent-platform \
    --from-literal=DATABASE_URL=postgresql://postgres:dev@postgres:5432/sessions \
    --from-file=EGRESS_AUTHORIZER_TOKEN=<(openssl rand -hex 32 | tr -d '\n') \
    --from-literal=AWS_ACCESS_KEY_ID=test \
    --from-literal=AWS_SECRET_ACCESS_KEY=test \
    --from-file=ANTHROPIC_API_KEY=<(provider_key) >/dev/null
fi
unset ANTHROPIC_API_KEY

for dep in "${deps[@]}"; do
  kubectl -n "$NAMESPACE" rollout status "deploy/$dep" --timeout=300s
done

# Helm waits for the migrate hook, and the rollouts below for the rest.
helm upgrade --install "$RELEASE" "$root/deploy/helm/agent-platform" \
  --namespace "$NAMESPACE" \
  "${values[@]}" \
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
for deploy in api egress-proxy reconciler scheduler; do
  kubectl -n "$NAMESPACE" rollout status "deploy/${fullname}-${deploy}" --timeout=600s
done

kubectl -n "$NAMESPACE" port-forward "svc/${fullname}-api" "${FORWARD_PORT}:3000" >"$STATE_DIR/port-forward.log" 2>&1 &
forward=$!
trap 'kill "$forward" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:${FORWARD_PORT}/healthz" && break
  sleep 1
done
status=0
for path in /readyz /docs; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${FORWARD_PORT}${path}")"
  echo "GET ${path} -> ${code}"
  [ "$code" = 200 ] || status=1
done

kubectl -n "$NAMESPACE" get jobs,deploy,pods -o wide
exit "$status"

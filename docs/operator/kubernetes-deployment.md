# Kubernetes 설치 (Helm chart)

main을 Kubernetes에 올리는 절차다. chart는 `deploy/helm/agent-platform`에 있고, 기본값은 일반 Kubernetes(kind 포함)에서 돈다. AWS 전용 값(ALB Ingress, IRSA, ECR, External Secrets)은 `values-aws.example.yaml`에만 있다. 각 구성요소의 동작과 환경 변수는 [Kubernetes 실행 backend](kubernetes-backend.md), 백업은 [backup-restore.md § Kubernetes 설치](backup-restore.md#kubernetes-설치)에 있다.

Docker 단일 서버 설치(`local-docker` 실행 기반, compose)는 그대로 운영한다. 그 절차는 [server-deployment.md](server-deployment.md)와 [test-ops.md](test-ops.md)이고, 이 문서는 그 옆의 두 번째 설치 경로다.

worker Pod 하나의 메모리(`worker.memoryMb`)는 transcript 상한에 맞춰 잡은 값이고, requests = limits라서 노드당 동시 세션 수를 정한다. 노드 크기를 정하거나 이 값을 바꾸기 전에 [capacity.md](capacity.md)를 본다.

명령마다 어디서 확인했는지 적었다. **kind**는 `deploy/kind/up.sh`로 띄운 클러스터에서 그대로 돌려 본 명령이고, **AWS 전용**은 AWS 리소스가 있어야 해서 로컬에서는 돌릴 수 없는 명령이다.

## chart가 만드는 것

| 리소스 | 수 | 비고 |
|---|---|---|
| api Deployment + Service(3000) + authorizer Service(3100) | 2 | 3100은 egress-proxy만 닿는다(NetworkPolicy). Ingress는 3000의 `/v1`·`/docs`·`/healthz`·`/readyz`만 route한다. worker용 `/internal`은 열지 않는다 |
| scheduler Deployment + Role/RoleBinding | 1, `Recreate` | worker Pod·nonce Secret·workspace PVC를 같은 namespace에서만 만들고 지운다 |
| reconciler Deployment | 1 | |
| slack Deployment | 1 | Slack inbox를 비운다. `slack.enabled: false`면 없다. 바깥으로는 DNS(53), 443, DB 포트(`networkPolicy.slack.databasePort`, 기본 5432)로만 나간다 |
| egress-proxy Deployment + Service(3128, 3129) | 2 | worker의 유일한 바깥 경로 |
| migrate Job | install·upgrade마다 1 | `pre-install,pre-upgrade` hook |
| upgrade-check Job | upgrade마다 1 | `pre-upgrade` hook, migrate 앞. `scheduler.enabled: false`면 없다([업그레이드 전 검사](#업그레이드-전-검사)) |
| checkpoint GC CronJob | 주 1회 | `checkpointGc.schedule` |
| 카탈로그 ConfigMap | 1 | `catalog.connections`(필수)·`catalog.profiles`(빈 DB 시드)·`catalog.repositories` |
| NetworkPolicy | 5 | worker는 egress-proxy로만 나간다. 제어 영역 Pod 중 바깥 연결을 막는 것은 slack 하나다 |
| Ingress, ExternalSecret | 선택 | `ingress.enabled`, `secrets.externalSecret.enabled` |
| metrics Deployment + Service(9464) + NetworkPolicy | 선택, 1, `Recreate` | `metrics.enabled`. 플랫폼 지표를 낸다([metrics.md](metrics.md)) |

chart가 만들지 않는 것: PostgreSQL 16, S3 호환 object store, Secret 값, worker Pod(scheduler가 세션마다 만든다). kind에서는 `deploy/kind/deps.yaml`의 PostgreSQL·LocalStack이 대신한다.

## 준비

- NetworkPolicy를 강제하는 CNI. 강제하지 않는 CNI에서는 worker 격리가 없다. kind v0.33의 기본 CNI(kindnet)는 강제한다. EKS는 VPC CNI의 network policy agent를 켠다.
- PostgreSQL 16과 S3 bucket. 기본 보호 모드 `locked`는 versioning과 Object Lock이 켜진 bucket을 요구하고, 아니면 api가 기동을 거부한다.
- 이미지 셋(control-host, egress-proxy, worker)을 registry에 올리고 digest를 적어 둔다. chart는 tag를 받지 않고 `<registry>/<repository>@<digest>`로만 그린다. digest가 없으면 render가 실패한다. scheduler가 받는 `WORKER_IMAGE`도 `repository@sha256:<digest>` 형식이어야 한다.
- `secrets.name`(기본 `agent-platform`) Secret. 키는 아래와 같다. 값은 명령 인자나 셸 history에 남기지 않는다.

| 키 | 읽는 곳 |
|---|---|
| `DATABASE_URL` | api, scheduler, reconciler, slack, migrate, checkpoint GC |
| `EGRESS_AUTHORIZER_TOKEN` | api, egress-proxy(같은 값) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | api, checkpoint GC. `secrets.objectStoreKeys: true`일 때만. `false`면 AWS 기본 credential chain(IRSA)으로 서명한다 |
| `secrets.catalogEnv`의 이름(기본 `ANTHROPIC_API_KEY`) | api만. 카탈로그가 `value_env`로 가리키는 provider·저장소 자격 증명. slack도 카탈로그 파일은 읽지만 자격 증명은 받지 않는다 |
| `PLATFORM_SECRET_KEY` | api, slack. 선택. 없으면 Slack secret 저장소가 꺼진다 |

## 설치 순서

설치 순서는 Secret → 이미지 digest → migrate → 제어 영역이다. chart에서는 Secret과 schema만 앞서야 하고, 나머지는 Helm이 hook으로 맞춘다.

1. ExternalSecret(사용할 때, hook weight -10)이 Secret을 쓴다.
   upgrade에서는 그다음 upgrade-check Job(hook weight -5)이 재개할 수 없게 될 세션을 검사한다. 실패하면 Helm이 멈추고 migrate도 돌지 않는다([업그레이드 전 검사](#업그레이드-전-검사)).
2. migrate Job(hook weight 0)이 schema를 올린다. 실패하면 Helm이 멈추고 Deployment는 바뀌지 않는다.
3. api, egress-proxy, reconciler, scheduler, slack Deployment가 한꺼번에 적용된다. 서로 기다리지 않고, 각자 probe를 통과하면 ready가 된다. scheduler·reconciler·slack은 첫 pass가 끝나야 ready다.

### kind (로컬)

`deploy/kind/up.sh`가 위 순서를 한 번에 한다. 클러스터·registry 생성, 이미지 빌드·push(digest 확보), namespace·PostgreSQL·LocalStack·Secret 생성, `helm upgrade --install`, rollout과 `/readyz`·`/docs` 확인까지다. kubeconfig는 `~/.kube/config`가 아니라 `~/.cache/agent-platform/kind/<cluster>/kubeconfig`에 쓴다. **kind**

```bash
CLUSTER_NAME=<cluster> REGISTRY_PORT=<port> deploy/kind/up.sh
export KUBECONFIG=~/.cache/agent-platform/kind/<cluster>/kubeconfig
```

`CLUSTER_NAME`(기본 `agent-platform-dev`)과 `REGISTRY_PORT`(기본 5001)는 생략할 수 있다. 다른 클러스터나 registry와 겹치면 바꾼다. 지우는 명령은 `CLUSTER_NAME=… deploy/kind/up.sh down`이다(클러스터와 registry 컨테이너만 지운다).

`EXTRA_VALUES=<파일>`을 주면 values 파일 하나를 다른 values 파일(모델·카탈로그 포함) 위에 마지막으로 얹는다. 노트북에서 api·egress-proxy를 1개씩만 띄울 때 쓴다(`api.replicas: 1`, `egressProxy.replicas: 1`).

### OrbStack (로컬)

`CLUSTER_PROVIDER=orbstack`이면 kind 클러스터와 registry 컨테이너를 만들지 않고 OrbStack 내장 Kubernetes(`orb start k8s`)에 설치한다. OrbStack 클러스터는 Docker 엔진의 이미지 저장소를 그대로 쓰므로 이미지는 로컬에서 빌드만 하고, containerd 이미지 저장소가 준 manifest digest로 chart에 고정한다. Docker 엔진이 containerd 이미지 저장소를 쓰지 않으면 digest가 없어서 up.sh가 멈춘다. 이미지 태그는 `IMAGE_TAG`(기본 `kind-dev`)다. kubeconfig는 `~/.kube/config`의 `orbstack` context를 namespace마다 따로 `~/.cache/agent-platform/orbstack/<namespace>/kubeconfig`로 복사해 쓴다.

```bash
export CLUSTER_PROVIDER=orbstack NAMESPACE=<namespace>
deploy/kind/up.sh          # 설치
deploy/kind/smoke.sh       # 또는 smoke 전체. 이 실행이 만든 namespace는 끝에 지운다
deploy/kind/up.sh down     # NAMESPACE만 지운다. 클러스터는 남는다
```

zsh에서는 환경 변수 묶음을 문자열 하나로 넘기면 단어로 나뉘지 않으므로 위처럼 `export A=… B=…`로 준다. namespace 범위 밖에 남는 것은 빌드한 이미지 태그뿐이다. smoke의 contract 단계는 무작위 이름의 `ap-ct-*`·`ap-it-*` namespace를 따로 만들고 끝나면 지운다(`K8S_BACKEND_TEST_KEEP=1`이면 남긴다). smoke는 다른 것이 없는 전용 namespace에서 돌린다. 이미 있던 namespace는 지우지 않지만, 그 안의 probe Pod(`k8s-smoke-worker`, `k8s-smoke-control`)는 지우고 다시 만든다.

### 직접 설치

namespace와 Secret을 먼저 만든다. Secret은 키마다 파일 하나인 디렉터리(`0700`, 파일 이름이 키)에서 만든다. 값이 명령줄에 나오지 않는다. **kind**

```bash
kubectl create namespace agent-platform
kubectl -n agent-platform create secret generic agent-platform --from-file=<secret-dir>
```

설치별 값은 values 파일 하나에 둔다. 최소한 세 이미지의 digest, 카탈로그(`catalog.connections`와 `catalog.repositories`는 하나 이상), checkpoint bucket이 들어간다. `catalog.connections`가 없으면 api와 slack이 `connections.yaml is missing`으로 뜨지 않는다. 기본값과 설명은 `values.yaml`에 있다. 같은 명령이 처음 설치와 업그레이드를 모두 한다. **kind**(`-f deploy/kind/values.yaml -f <digest만 담은 파일>`)

```bash
helm upgrade --install agent-platform deploy/helm/agent-platform \
  --namespace agent-platform -f values-<installation>.yaml --timeout 10m
kubectl -n agent-platform get job agent-platform-migrate
for d in api egress-proxy reconciler scheduler; do
  kubectl -n agent-platform rollout status deploy/agent-platform-$d --timeout=600s
done
```

release 이름에 `agent-platform`이 들어가지 않으면 리소스 이름은 `<release>-agent-platform-…`가 된다.

## AWS 값 넣기

`values-aws.example.yaml`을 설치별 파일로 복사해 placeholder(account id, ARN, host, digest)를 채우고, `values.yaml` 위에 얹는다. 아래 render는 로컬에서 돌지만, 그 결과를 적용하는 일은 **AWS 전용**이다.

**ALB는 사내망 전용이다.** 이 설치는 사내망에서만 닿는 입구를 전제로 하므로, 예제의 Ingress annotation `scheme`은 이미 `internal`이다. 설치별 파일에서도 `internet-facing`으로 바꾸지 않는다. `render-check`가 예제 render에서 `internet-facing`을 거부한다. 적용 뒤에는 ALB가 사내망 subnet에 생겼는지 확인한다(**AWS 전용**).

```bash
helm lint deploy/helm/agent-platform -f deploy/helm/agent-platform/values-aws.example.yaml   # kind 머신에서 확인
helm template agent-platform deploy/helm/agent-platform \
  -f deploy/helm/agent-platform/values-aws.example.yaml >/dev/null                          # kind 머신에서 확인
helm upgrade --install agent-platform deploy/helm/agent-platform \
  --namespace agent-platform -f values-aws-<installation>.yaml --timeout 10m               # AWS 전용
```

| 값 | 무엇을 바꾸나 |
|---|---|
| `images.registry`, `images.*.digest` | ECR host와 그 이미지의 digest |
| `secrets.objectStoreKeys: false`, `serviceAccounts.api.annotations` | 정적 AWS key 대신 IRSA. api와 checkpoint GC가 이 role로 S3·Secrets Manager에 서명한다. scheduler와 worker는 S3 권한이 없다 |
| `secrets.externalSecret` | External Secrets Operator가 Secrets Manager의 `remoteKey`(JSON, 위 Secret 키 전부. IRSA면 AWS key 둘은 뺀다)로 Secret을 쓴다. 운영자 CRD가 필요하다 |
| `ingress` | ALB Ingress. `scheme`은 `internal`이다(위). `healthcheck-path: /readyz`, SSE를 위해 idle timeout 300초. 공개 경로(`/v1`·`/docs`·`/healthz`·`/readyz`)만 route하고 `/internal`과 authorizer(3100)는 열지 않는다 |
| `config.egress.credentialAllowlist` | provider host에 checkpoint bucket의 virtual-hosted endpoint를 더한다. worker의 checkpoint upload·restore가 credential route로 나간다 |
| `worker.storageClass`, `worker.nodeSelector`, `worker.tolerations` | worker 전용 node group과 workspace PVC의 StorageClass(gp3) |
| `networkPolicy.enabled` | VPC CNI의 network policy agent가 켜져 있어야 효력이 있다 |

정적 S3 key를 써야 하면 `secrets.objectStoreKeys: true`로 두고 Secret에 AWS key 둘을 넣는다(#443 이전의 방식). 둘 다 있으면 정적 key가 IRSA보다 우선한다.

## health 확인

probe는 chart가 정한다. 사람이 확인할 때도 같은 것을 부른다.

| 구성요소 | readiness | liveness | startup |
|---|---|---|---|
| api | `GET /readyz`(DB, schema, 설정) | `GET /healthz`(HTTP만) | `GET /healthz`, 최대 120초 |
| scheduler | `main.ts scheduler --health` | 같음 | 같음. `intervalSec + passTimeoutSec + 39`초까지 기다린다 |
| reconciler | `main.ts reconciler --health` | 같음 | 같음 |
| egress-proxy | `/app/src/healthcheck.ts` | 같음 | 없음 |

`/livez`는 없다. liveness는 `/healthz`다. **kind**

```bash
kubectl -n agent-platform port-forward svc/agent-platform-api 13000:3000 &
curl -fsS -w '\n' http://127.0.0.1:13000/readyz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/docs
kubectl -n agent-platform exec deploy/agent-platform-scheduler -- bun run apps/control-host/src/main.ts scheduler --health
kubectl -n agent-platform exec deploy/agent-platform-reconciler -- bun run apps/control-host/src/main.ts reconciler --health
kubectl -n agent-platform exec deploy/agent-platform-egress-proxy -- bun run /app/src/healthcheck.ts
```

port-forward는 끝나면 그 job만 끈다(`kill %1`). AWS에서는 port-forward 대신 Ingress host로 `/readyz`를 부른다(**AWS 전용**).

## API key, 실행 권한, 카탈로그 권한

compose 설치의 `bun run keys`·`grants`·`catalog-authority`는 api 컨테이너 안에서 돈다. Kubernetes 설치에서는 `:k8s`가 붙은 같은 이름의 script가 `scripts/k8s-api.sh`로 api Pod 안에서 같은 CLI를 돌린다. Pod가 이미 `DATABASE_URL`을 가지고 있어서 비밀값이 운영자 셸을 지나지 않는다. kubectl의 현재 context나 `KUBECONFIG`가 클러스터를, `NAMESPACE`·`RELEASE`(기본 둘 다 `agent-platform`)가 설치를 고른다. **kind**

```bash
bun run keys:k8s create <owner_id> --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover
# stdout: 평문 key(한 번만 나온다), stderr: key_id
bun run keys:k8s revoke <key_id>
bun run grants:k8s revoke <session_id> --reason <text>
bun run grants:k8s restore <session_id> --reason <text>
bun run catalog-authority:k8s show
bun run catalog-authority:k8s activate <revision> --expected <revision|none>
```

script 없이 부르면 다음과 같다. `deploy/…-api`는 api Pod 하나를 고른다. 세 CLI는 DB만 쓰므로 어느 Pod든 같다.

```bash
kubectl -n agent-platform exec deploy/agent-platform-api -c api -- \
  bun run apps/control-host/src/api/keys.ts create <owner_id> --scopes sessions:read
```

`catalog-authority activate`의 `<revision>`은 api Pod가 기동할 때 남긴 로그(`Session catalog loaded`, `revision`)에 있다. **kind**(`show`만. activate는 카탈로그를 바꾸는 운영 결정이라 돌리지 않았다)

```bash
kubectl -n agent-platform logs deploy/agent-platform-api | grep 'Session catalog loaded'
```

## 업그레이드와 롤백

업그레이드는 values 파일의 digest를 새 이미지로 바꾸고 설치와 같은 `helm upgrade --install`을 돌린다. migrate hook이 먼저 돌고, 실패하면 Deployment는 그대로다. scheduler는 `Recreate`라서 옛 Pod가 내려간 뒤 새 Pod가 뜬다. 그 사이에는 scheduler pass가 돌지 않는다(새 worker launch와 회수가 멈춘다). **kind**

```bash
helm -n agent-platform history agent-platform
helm -n agent-platform rollback agent-platform <revision> --wait --timeout 10m
```

롤백은 migrate hook을 돌리지 않는다(`pre-rollback`이 아니다). DB는 새 schema에 남고, 옛 빌드는 자기보다 앞선 schema에서도 ready가 된다(`/readyz`의 schema 검사는 자기 migration 목록이 적용된 목록의 앞부분과 같은지만 본다). 그래서 롤백할 수 없는 migration은 배포하지 않는다. worker 이미지를 되돌릴 때 checkpoint 호환은 [images-and-supply-chain.md § worker·control-host 롤백과 incremental checkpoint](images-and-supply-chain.md#workercontrol-host-롤백과-incremental-checkpoint)를 먼저 본다.

### 배포 순서

worker Pod의 이미지는 scheduler가 launch할 때 정해진다. 이미지는 격리 stamp에 들어가지 않으므로, upgrade가 `images.worker`를 바꿔도 이미 떠 있는 worker Pod는 교체되지 않고 끝날 때까지 옛 이미지로 돈다. 입력이 없는 worker도 `WORKER_IDLE_TIMEOUT_SEC`(기본 1800초) 동안 남는다. 새 이미지는 그 뒤의 launch부터 쓰인다.

- worker가 보내는 protocol 필드를 더하거나 checkpoint manifest에 필드를 더하는 릴리스는 `images.controlHost`만 바꾼 upgrade를 먼저 하고, `images.worker`는 다음 upgrade에서 바꾼다. 한 번의 upgrade로는 새 worker가 옛 api보다 먼저 뜨지 않는다는 보장이 없다. 필드별 순서는 [images-and-supply-chain.md § worker protocol 필드를 걷어내는 순서](images-and-supply-chain.md#worker-protocol-필드를-걷어내는-순서)에 있다.
- DB 변경은 [images-and-supply-chain.md § DB 스키마를 바꾸는 순서](images-and-supply-chain.md#db-스키마를-바꾸는-순서)의 확장→전환→정리를 따른다. migrate hook이 rollout보다 먼저 돌기 때문에 옛 api와 옛 worker가 새 schema 위에서 돈다.
- 새 control-host와 직전 릴리스 worker 이미지의 조합은 CI가 아직 검사하지 않는다. 릴리스 전에 kind나 시험 설치에서 직접 확인한다. `images.controlHost`만 새 digest로, `images.worker`는 직전 릴리스 digest로 둔 values로 upgrade하고, 세션 하나가 turn 1을 끝내는지 본다. 그 세션의 worker Pod를 `kubectl delete pod`로 지운 뒤 입력을 하나 더 보내 새 Pod가 checkpoint에서 이어 turn 2를 끝내는지 본다. api 로그에 worker 요청의 400 `BAD_REQUEST`가 없어야 한다. `deploy/kind/up.sh`는 `images.worker`를 `--set`으로 덮으므로 `EXTRA_VALUES`로는 worker 이미지를 바꾸지 못한다. 직접 `helm upgrade`한다.

### 바뀌는 것별로 세션이 이어지는 방법

| 바뀌는 것 | 실행 중인 worker Pod | 세션이 이어지는 방법 |
|---|---|---|
| worker 이미지(`images.worker`) | 끝날 때까지 옛 이미지로 돈다 | 다음 launch가 checkpoint 포인터의 engine·SDK·CLI·profile digest 방식과 같은 이미지를 새 이미지(`images.worker`), 직전 이미지(`images.workerPrevious`) 순으로 골라 복원한다. 둘 다 맞지 않으면 launch 전에 `recovery_required`로 멈춘다. 그런 세션은 아래 사전 검사가 upgrade 전에 보여 준다 |
| 격리 설정(stamp에 든 값: egress proxy 주소, 저장 용량, worker ServiceAccount, 한도 등) | stale이 된다. claim된 Pod는 turn 경계까지 drain한 뒤 내려간다 | 마지막으로 끝난 turn까지 checkpoint가 덮으면 새 Pod가 PostgreSQL 포인터와 S3 checkpoint에서 이어 간다. checkpoint 없이 끝난 turn이 있으면 세션은 `recovery_required`로 멈춘다(`CONTEXT_GAP`). drain 기한(`MAX_TURN_SECONDS` + 5분)을 넘긴 turn은 `outcome_unknown`이 되고, 그 세션은 `recovery_required`로 멈춰 운영자의 결정을 기다린다([execution.md § 계약이 오를 때 claim된 worker의 drain](execution.md#계약이-오를-때-claim된-worker의-drain)) |
| 노드 교체, Kubernetes 업그레이드 | Pod가 사라진다. SIGTERM을 받으면 drain으로 release하고, 받지 못하면 heartbeat가 끊긴다 | release됐으면 바로, 아니면 scheduler가 Pod가 사라진 것을 확인하거나 lease가 끝난 뒤 회수된다. 돌던 turn이 없고 마지막으로 끝난 turn까지 checkpoint가 덮으면 다음 launch가 그 checkpoint에서 이어 간다. checkpoint가 뒤처졌으면 세션은 `recovery_required`로 멈춘다(세션 상세 attention `CONTEXT_GAP`). 확정되지 않은 turn이 있었으면 그 turn은 `outcome_unknown`이 되고 세션은 `recovery_required`로 멈춘다([execution.md](execution.md)) |
| checkpoint bucket(`config.checkpoints.bucket`) | bucket이 stamp에 있어 stale로 교체된다 | 자동으로 이어지지 않는다. 옛 bucket의 객체는 새 bucket에 없다. 미수거 checkpoint 행이 있는데 새 bucket에 object version이 하나도 없으면 api가 기동하지 않는다([api-server.md](api-server.md)). Kubernetes 설치에는 checkpoint를 다른 bucket으로 옮기는 절차가 없다. 복원도 같은 bucket의 version을 가리킨다([backup-restore.md § Kubernetes 설치](backup-restore.md#kubernetes-설치)). 미수거 checkpoint가 있는 동안에는 bucket을 바꾸지 않는다 |

### 업그레이드 전 검사

`helm upgrade`는 migrate보다 먼저(hook weight -5) `upgrade-check` Job을 대상 릴리스의 api 이미지로 돌린다. Job은 수거되지 않은 checkpoint가 있는 세션마다 포인터의 조합을 읽고, 대상 릴리스의 `images.worker`와 `images.workerPrevious` 어느 쪽으로도 재개할 수 없는 세션을 고른다. 조합을 기록하기 전에 커밋된 포인터도 고른다. 결과는 Job 로그의 JSON 한 줄이다.

```bash
kubectl -n agent-platform logs job/agent-platform-upgrade-check
```

| `verdict` | exit | upgrade | 뜻 |
|---|---|---|---|
| `proceed` | 0 | 진행 | `upgrade.approvedSessions`가 `affected`의 `sessionId`와 정확히 같다. 고른 세션이 없거나 worker 이미지가 그대로이면 승인 목록이 비어 있어야 한다 |
| `refused` | 2 | 멈춤 | 승인 목록이 하나라도 다르다(지난 upgrade의 승인이 values에 남은 경우 포함). 또는 대상의 `images.workerPrevious`가 지금 배포된 worker 이미지가 아니다. 이 경우는 승인으로 넘길 수 없다 |
| `check_failed` | 1 | 멈춤 | DB를 읽지 못했거나, 이미지 조합(`images.worker.runtime` 등)이 없거나 읽히지 않거나, 배포된 worker 이미지를 알 수 없다. 넘기는 설정은 없다 |

고른 세션이 재개하지 못해도 되면 그 목록을 그대로 values에 넣고 같은 upgrade를 다시 돌린다. 승인은 세션 상태를 바꾸지 않는다. `no_image`로 고른 세션은 재개할 때 `recovery_required`로 멈춘다. `unrecorded`로 고른 세션은 새 이미지로 뜨고, 복원이 판정해 이어지거나 `recovery_required`로 멈춘다.

```bash
helm upgrade --install ... --set-json 'upgrade.approvedSessions=["<sessionId>", ...]'
```

승인 목록은 release values에 남는다. 다음 upgrade마다 `--set-json 'upgrade.approvedSessions=[]'`로 비우고, 그 upgrade의 목록을 다시 읽고 승인한다. 남은 목록은 그 upgrade의 `affected`와 다르면 `refused`로 멈추지만, 같으면 그대로 통과한다.

Job은 승인 목록을 `UPGRADE_APPROVED_SESSIONS`(JSON 배열)로, 배포된 worker 이미지를 `UPGRADE_DEPLOYED_WORKER_IMAGE`로 받는다. 배포된 worker 이미지는 chart가 지금 scheduler Deployment의 `WORKER_IMAGE`를 `lookup`으로 읽어 넘긴다. `helm template`과 `--dry-run`에서는 `lookup`이 아무것도 읽지 않으므로 그 렌더로 돌린 Job은 `check_failed`가 된다. 첫 설치(`pre-install`)와 `scheduler.enabled: false`에서는 Job을 만들지 않는다. Job과 scheduler가 같은 이미지를 보도록 `WORKER_IMAGE`·`WORKER_IMAGE_PREVIOUS`·`WORKER_IMAGE_RUNTIME`·`WORKER_IMAGE_PREVIOUS_RUNTIME`은 `*.extraEnv`, `config.limits`, `secrets.catalogEnv`로 줄 수 없다. 주면 render가 실패한다. `images.worker`와 `images.workerPrevious`로 준다.

**`helm rollback` 전.** rollback은 hook을 돌리지 않으므로 같은 명령을 api Pod에서 직접 돌린다. 값은 되돌릴 revision의 것(`helm get values --revision <revision>`)을 넣는다.

```bash
kubectl -n agent-platform exec deploy/agent-platform-api -- env \
  UPGRADE_DEPLOYED_WORKER_IMAGE='<지금 scheduler의 WORKER_IMAGE>' \
  WORKER_IMAGE='<되돌릴 revision의 worker 이미지>' WORKER_IMAGE_RUNTIME='<그 runtime JSON>' \
  WORKER_IMAGE_PREVIOUS='<그 revision의 workerPrevious>' WORKER_IMAGE_PREVIOUS_RUNTIME='<그 runtime JSON>' \
  bun run apps/control-host/src/api/upgrade-check.ts
```

worker 이미지를 되돌리는 보통의 rollback은 `refused`다. 되돌릴 revision의 `images.workerPrevious`가 지금 배포된 이미지가 아니기 때문이다(검사는 조합이 아니라 이미지 참조를 비교한다). 설정이나 DB를 읽지 못하면 `check_failed`다. 지금 이미지로 도는 worker는 rollback 뒤에도 끝날 때까지 그 이미지의 조합으로 checkpoint를 남기는데, 검사는 그 checkpoint를 보지 못한다. 출력의 `affected`는 검사 시점에 이미 고른 세션이다. 롤포워드가 우선이다. 그래도 되돌리면 재개할 때 scheduler가 조합으로 이미지를 고른다. 되돌린 두 이미지 어느 쪽과도 조합이 맞지 않는 세션(지금 이미지가 새 SDK·CLI를 실었다면 rollback 동안 지금 이미지로 checkpoint를 남긴 세션)은 `recovery_required`로 멈춘다. `images.worker`를 그대로 두는 rollback은 승인 목록 없이 돌리면 `proceed`다.

**검사가 보지 않는 것.** compose의 `scripts/test-ops.sh upgrade`와 달리 이 검사는 대상 이미지를 실행하지 않는다. 포인터에 기록된 조합(engine·SDK·CLI·profile digest 방식)만 비교하고, 실제 profile digest는 복원 때 판정된다. 검사 뒤 writer를 멈추고 다시 검사하지도 않는다. 대상의 `images.workerPrevious`가 지금 배포된 이미지와 같아야 통과하므로, 검사 뒤에 지금 이미지의 worker가 남기는 checkpoint는 대상 지원 창 안에 있다. 그보다 옛 이미지로 도는 worker의 세션은 포인터가 이미 그 조합이라 목록에 오른다. 대상 이미지를 registry에서 받을 수 있는지도 보지 않는다. 받지 못하면 launch 실패로 나타난다.

## 단일 서버 배포 10단계와의 대응

[server-deployment.md](server-deployment.md)의 단계가 Kubernetes에서 어디로 가는지다.

| 단일 서버 단계 | Kubernetes 설치 |
|---|---|
| 1. 호스트 준비 | 클러스터와 NetworkPolicy를 강제하는 CNI, worker node group. XFS quota 대신 workspace PVC 크기(위 "준비") |
| 2. 네트워크 경로 | SSH tunnel 대신 사내망 ALB Ingress(**AWS 전용**). authorizer 3100과 DB는 클러스터 밖에 열지 않는다 |
| 3. 전용 S3 | 같다. 정적 key 대신 IRSA(위 "AWS 값 넣기") |
| 4. release·설정 봉인 | 이미지 digest와 카탈로그를 설치별 values 파일 하나에 둔다 |
| 5. 설치와 첫 사용 | "설치 순서", "health 확인", "API key" 절 |
| 6. 백업·복원 | RDS·S3 기능([backup-restore.md § Kubernetes 설치](backup-restore.md#kubernetes-설치)) |
| 7. 업그레이드·롤백 | "업그레이드와 롤백" 절 |
| 8. 물리 재부팅 | node가 바뀌어도 Deployment가 다시 띄운다. EBS PVC는 AZ에 묶이므로 worker가 같은 AZ의 node에 다시 붙는지는 EKS에서 확인한다(**AWS 전용**) |
| 9. Day 1 운영 | 같은 점검. 명령은 `kubectl exec`·`bun run *:k8s`로 바꾼다 |
| 10. 증거 | 같다. `helm history`, `kubectl get job,deploy,pods`, `/readyz` 출력을 남긴다 |

## 제거

```bash
helm -n agent-platform uninstall agent-platform
```

**kind**. `helm uninstall`이 남기는 것은 다음과 같다.

- scheduler가 만든 worker Pod, nonce Secret, workspace PVC. 지우기 전에 세션이 끝났는지(또는 checkpoint됐는지) 본다. PVC를 지우면 checkpoint되지 않은 작업이 사라진다. 목록: `kubectl -n agent-platform get pods,secrets,pvc -l app.kubernetes.io/part-of=agent-platform,agent-platform.installation=<installationId>`
- hook으로 만든 migrate Job, ExternalSecret과 그것이 쓴 Secret(`creationPolicy: Orphan`). 직접 만든 Secret도 남는다.

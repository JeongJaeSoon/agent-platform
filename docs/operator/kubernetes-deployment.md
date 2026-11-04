# Kubernetes 설치 (Helm chart)

main을 Kubernetes에 올리는 절차다. chart는 `deploy/helm/agent-platform`에 있고, 기본값은 일반 Kubernetes(kind 포함)에서 돈다. AWS 전용 값(ALB Ingress, IRSA, ECR, External Secrets)은 `values-aws.example.yaml`에만 있다. 각 구성요소의 동작과 환경 변수는 [Kubernetes 실행 backend](kubernetes-backend.md), 백업은 [backup-restore.md § Kubernetes 설치](backup-restore.md#kubernetes-설치)에 있다.

**현재 상태:** chart 패키지와 게시된 앱 이미지가 아직 없다. chart는 저장소 checkout의 경로로 설치하고, 이미지는 직접 빌드한다(아래 "준비"). `values.yaml` 기본값은 digest가 비어 있어 그대로는 render가 실패한다. digest만 채우고 기본값의 `ghcr.io` 이름을 두면 받을 이미지가 없어 migrate Job이 `ImagePullBackOff`로 멈춘다.

Docker 단일 서버 설치(`local-docker` 실행 기반, compose)는 그대로 운영한다. 그 절차는 [server-deployment.md](server-deployment.md)와 [test-ops.md](test-ops.md)이고, 이 문서는 그 옆의 두 번째 설치 경로다.

worker Pod 하나의 메모리(`worker.memoryMb`)는 transcript 상한에 맞춰 잡은 값이고, requests = limits라서 노드당 동시 세션 수를 정한다. 노드 크기를 정하거나 이 값을 바꾸기 전에 [capacity.md](capacity.md)를 본다.

명령마다 어디서 확인했는지 적었다. **kind**는 `deploy/kind/up.sh`로 띄운 클러스터에서 그대로 돌려 본 명령이고, **AWS 전용**은 AWS 리소스가 있어야 해서 로컬에서는 돌릴 수 없는 명령이다.

## chart가 만드는 것

| 리소스 | 수 | 비고 |
|---|---|---|
| api Deployment + Service(3000) + authorizer Service(3100) | 2 | 3100은 egress-proxy만 닿는다(NetworkPolicy). Ingress는 3000의 `/v1`·`/docs`·`/healthz`·`/readyz`만 route한다. worker용 `/internal`은 열지 않는다. 웹 콘솔 `/`는 `ingress.console.enabled`로 더한다([아래](#웹-콘솔과-internal)) |
| scheduler Deployment + Role/RoleBinding | 1, `Recreate` | worker Pod·nonce Secret·workspace PVC를 같은 namespace에서만 만들고 지운다 |
| reconciler Deployment | 1 | |
| slack Deployment | 1 | Slack inbox를 비운다. `slack.enabled: false`면 없다. 바깥으로는 DNS(53), 443, DB 포트(`networkPolicy.slack.databasePort`, 기본 5432)로만 나간다 |
| egress-proxy Deployment + Service(3128, 3129) | 2 | worker의 유일한 바깥 경로 |
| migrate Job | install·upgrade마다 1 | `pre-install,pre-upgrade` hook |
| upgrade-check Job | upgrade마다 1 | `pre-upgrade` hook, migrate 앞. `scheduler.enabled: false`면 없다([업그레이드 전 검사](#업그레이드-전-검사)) |
| checkpoint GC CronJob | 주 1회 | `checkpointGc.schedule` |
| session archive CronJob | 주 1회 | `sessionArchive.schedule`(기본 `0 5 * * 0`)·`afterDays`(기본 180, 0=끔, 30~3650)·`dryRun`(기본 `true`). 오래 쉰 세션의 이벤트를 bucket으로 옮긴다([data-retention.md](data-retention.md#세션-이벤트-보관)) |
| NetworkPolicy | 5 | worker는 egress-proxy로만 나간다. 제어 영역 Pod 중 바깥 연결을 막는 것은 slack 하나다 |
| Ingress, ExternalSecret | 선택 | `ingress.enabled`, `secrets.externalSecret.enabled` |
| metrics Deployment + Service(9464) + NetworkPolicy | 선택, 1, `Recreate` | `metrics.enabled`. 플랫폼 지표를 낸다([metrics.md](metrics.md)) |

chart가 만들지 않는 것: PostgreSQL 16, S3 호환 object store, Secret 값, worker Pod(scheduler가 세션마다 만든다). kind에서는 `deploy/kind/deps.yaml`의 PostgreSQL·LocalStack이 대신한다.

chart는 Git 서버도 만들지 않는다. 설정 문서의 저장소에는 Pod가 egress proxy로 닿을 수 있는 주소를 적는다. kind 확인 환경에서는 `deploy/kind/up.sh`가 `KIND_MODEL`이 `fake` 또는 `real`일 때(`smoke.sh`와 PR 미리보기가 이 경우다) `deploy/kind/deps-session.yaml`로 읽기 전용 fake-git을 띄운다. fake-git은 control-host 이미지로 돌고, Service `fake-git:3000`의 `/agent/sample-app.git`·`/agent/gate-app.git`을 내주며, 기동할 때마다 같은 커밋으로 다시 만들어지고 push는 403이다.

## 준비

- NetworkPolicy를 강제하는 CNI. 강제하지 않는 CNI에서는 worker 격리가 없다. kind v0.33의 기본 CNI(kindnet)는 강제한다. EKS는 VPC CNI의 network policy agent를 켠다.
- PostgreSQL 16과 S3 bucket. 기본 보호 모드 `locked`는 versioning과 Object Lock이 켜진 bucket을 요구하고, 아니면 api가 기동을 거부한다.
- 이미지 셋(control-host, egress-proxy, worker)을 registry에 올리고 digest를 적어 둔다. 게시된 이미지가 없으므로 checkout에서 빌드한다. kind에서는 `deploy/kind/up.sh`가 대신하고, 그 밖에서는 [이미지를 직접 빌드](test-ops.md#이미지를-직접-빌드한다)한 뒤 values의 `images.registry`와 `images.*.repository`를 그 registry로 바꾼다(`values-aws.example.yaml`의 형식). chart는 tag를 받지 않고 `<registry>/<repository>@<digest>`로만 그린다. digest가 없으면 render가 실패한다. scheduler가 받는 `WORKER_IMAGE`도 `repository@sha256:<digest>` 형식이어야 한다.
- `secrets.name`(기본 `werft`) Secret. 키는 아래와 같다. 값은 명령 인자나 셸 history에 남기지 않는다.

| 키 | 읽는 곳 |
|---|---|
| `DATABASE_URL` | api, scheduler, reconciler, slack, migrate, checkpoint GC |
| `EGRESS_AUTHORIZER_TOKEN` | api, egress-proxy(같은 값) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | api, checkpoint GC. `secrets.objectStoreKeys: true`일 때만. `false`면 AWS 기본 credential chain(IRSA)으로 서명한다 |
| `secrets.catalogEnv`의 이름(기본 `ANTHROPIC_API_KEY`) | api만. 설정 문서가 `value_env`로 가리키는 provider·저장소 자격 증명. slack은 받지 않는다 |
| `PLATFORM_SECRET_KEY` | api, slack. 필수. 64자 hex master key. 콘솔에서 저장한 자격 증명을 봉인한다. Secret에 없으면 Pod가 뜨지 않는다 |

## 설치 순서

설치 순서는 Secret → 이미지 digest → migrate → 제어 영역이다. chart에서는 Secret과 schema만 앞서야 하고, 나머지는 Helm이 hook으로 맞춘다.

1. ExternalSecret(사용할 때, hook weight -10)이 Secret을 쓴다.
   upgrade에서는 그다음 upgrade-check Job(hook weight -5)이 재개할 수 없게 될 세션을 검사한다. 실패하면 Helm이 멈추고 migrate도 돌지 않는다([업그레이드 전 검사](#업그레이드-전-검사)).
2. migrate Job(hook weight 0)이 schema를 올리고, 파일 카탈로그가 있던 chart에서 올라오는 경우 옛 ConfigMap을 설정으로 가져온다(아래 "파일 카탈로그에서 올리기"). 실패하면 Helm이 멈추고 Deployment는 바뀌지 않는다.
3. api, egress-proxy, reconciler, scheduler, slack Deployment가 한꺼번에 적용된다. 서로 기다리지 않고, 각자 probe를 통과하면 ready가 된다. scheduler·reconciler·slack은 첫 pass가 끝나야 ready다.

### kind (로컬)

`deploy/kind/up.sh`가 위 순서를 한 번에 한다. 클러스터·registry 생성, 이미지 빌드·push(digest 확보), namespace·PostgreSQL·LocalStack·Secret 생성, `helm upgrade --install`, rollout과 `/readyz`·`/docs` 확인까지다. kubeconfig는 `~/.kube/config`가 아니라 `~/.cache/agent-platform/kind/<cluster>/kubeconfig`에 쓴다. **kind**

```bash
CLUSTER_NAME=<cluster> REGISTRY_PORT=<port> deploy/kind/up.sh
export KUBECONFIG=~/.cache/agent-platform/kind/<cluster>/kubeconfig
```

`CLUSTER_NAME`(기본 `agent-platform-dev`)과 `REGISTRY_PORT`(기본 5001)는 생략할 수 있다. 다른 클러스터나 registry와 겹치면 바꾼다. 지우는 명령은 `CLUSTER_NAME=… deploy/kind/up.sh down`이다(클러스터와 registry 컨테이너만 지운다).

`EXTRA_VALUES=<파일>`을 주면 values 파일 하나를 다른 values 파일(모델 포함) 위에 마지막으로 얹는다. 노트북에서 api·egress-proxy를 1개씩만 띄울 때 쓴다(`api.replicas: 1`, `egressProxy.replicas: 1`).

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
kubectl create namespace werft
kubectl -n werft create secret generic werft --from-file=<secret-dir>
```

설치별 값은 values 파일 하나에 둔다. 최소한 세 이미지의 digest와 checkpoint bucket이 들어간다. 연결·저장소·MCP 서버·상한은 values에 없다. 설치 뒤 콘솔에서 더하거나 `bun run settings:k8s import --document - < settings.json`으로 가져온다([api-server.md](api-server.md#설정-문서-가져오기내보내기)). 기본값과 설명은 `values.yaml`에 있다. 같은 명령이 처음 설치와 업그레이드를 모두 한다. **kind**(`-f deploy/kind/values.yaml -f <digest만 담은 파일>`)

```bash
helm upgrade --install werft deploy/helm/agent-platform \
  --namespace werft -f values-<installation>.yaml --timeout 10m
kubectl -n werft get job werft-migrate
for d in api egress-proxy reconciler scheduler; do
  kubectl -n werft rollout status deploy/werft-$d --timeout=600s
done
```

release 이름에 `werft`가 들어가지 않으면 리소스 이름은 `<release>-werft-…`가 된다.

chart 이름이 `agent-platform`이던 때 설치한 release는 제자리에서 올릴 수 없다. 리소스 이름이 바뀌어 upgrade-check Job이 기존 scheduler를 찾지 못하고 멈춘다. 세션이 끝났는지 확인하고 옛 이름으로 지운 뒤(`helm -n agent-platform uninstall agent-platform`, [제거](#제거)에서 남는 것을 본다) 새로 설치한다. 파일 카탈로그를 쓰던 release는 지우기 전에 ["파일 카탈로그에서 올리기"](#파일-카탈로그에서-올리기)의 ConfigMap부터 저장한다.

첫 설치가 실패하면(이미지 경로나 pull 권한 오류가 흔하다) 값을 고치고 같은 명령을 다시 돌린다. Helm은 release가 `failed`로 남아 있으므로 이를 upgrade로 처리하고, 그래서 upgrade-check Job이 처음으로 돈다. scheduler Deployment가 없고 DB가 비어 있거나 세션이 없으면 Job이 `proceed`로 끝나고 설치가 이어진다([업그레이드 전 검사](#업그레이드-전-검사)). Deployment까지 만들어진 뒤 실패했다면 재시도는 보통의 upgrade 규칙을 따른다. worker 이미지를 고친 재시도는 여기서 멈추므로(`check_failed`, runtime을 넣었다면 `refused`), 세션을 시작하지 않았다면 [제거](#제거)한 뒤 다시 설치한다.

## AWS 값 넣기

`values-aws.example.yaml`을 설치별 파일로 복사해 placeholder(account id, ARN, host, digest)를 채우고, `values.yaml` 위에 얹는다. 아래 render는 로컬에서 돌지만, 그 결과를 적용하는 일은 **AWS 전용**이다.

**ALB는 사내망 전용이다.** 이 설치는 사내망에서만 닿는 입구를 전제로 하므로, 예제의 Ingress annotation `scheme`은 이미 `internal`이다. 설치별 파일에서도 `internet-facing`으로 바꾸지 않는다. `render-check`가 예제 render에서 `internet-facing`을 거부한다. 적용 뒤에는 ALB가 사내망 subnet에 생겼는지 확인한다(**AWS 전용**).

### 웹 콘솔과 `/internal`

웹 콘솔은 api가 3000번에서 서빙한다. `ingress.console.enabled: true`(기본 `false`)면 Ingress가 `/`(Prefix)를 api Service로 보낸다. 같은 포트에 worker용 `/internal`도 있고, `/` Prefix는 `/internal`까지 맞는다. 그래서 chart는 `/` 앞에 `/internal`(Prefix) 규칙을 두고, 그 규칙은 api가 아니라 annotation `alb.ingress.kubernetes.io/actions.block-internal`의 fixed-response(404, `text/plain`)로 보낸다. AWS Load Balancer Controller는 긴 Prefix를 짧은 Prefix보다 먼저 평가하므로 `/internal`과 그 아래 경로는 ALB가 404로 답한다. `render-check`가 이 규칙이 `/`보다 앞에 있는지, 404 action을 가리키는지, 나머지 경로가 api Service의 `http`(3000) 포트로 가는지 검사한다.

이 규칙은 ALB에서만 효과가 있다. 다른 controller는 `block-internal`이라는 Service가 없는 경로를 건너뛰고 `/`로 `/internal`을 열 수 있으므로, `ingress.className`이 `alb`가 아니면 chart가 render를 거부한다. `/internal` 요청을 404 규칙 밖으로 보낼 수 있는 annotation(`alb.ingress.kubernetes.io/`의 `actions.*`·`conditions.*`·`transforms.*`·`group.*`, `kubernetes.io/ingress.class`)이 `ingress.annotations`에 있어도 render를 거부한다. IngressClass의 `IngressClassParams`가 이 Ingress를 다른 Ingress와 같은 group에 넣으면 앞선 Ingress의 규칙이 먼저 평가되므로, 콘솔을 켤 때는 `alb` IngressClass가 group을 강제하지 않는지 확인한다(**AWS 전용**).

**켜는 조건.** api는 percent-encoding을 디코드한 경로로 route한다. ALB path pattern에는 `%`를 쓸 수 없으므로 `/%69nternal/…`처럼 인코딩한 경로는 `/internal` 규칙에 걸리지 않고 `/` 규칙을 타고 api에 닿는다. api는 디코드하지 않은 경로가 `/internal`로 시작할 때만 worker 라우트로 보내고, 인코딩한 변형에는 404 `NOT_FOUND`로 답한다. 이 동작이 들어간 api 이미지를 쓸 때만 `ingress.console.enabled`를 켠다.

dot segment(`/x/../internal/…`, `/%2e/internal/…`)와 역슬래시(`/internal\…`, `/x/..\internal/…`)는 Bun이 요청을 api에 넘기기 전에 `/internal/…`로 정리하므로, api는 이 경로를 그냥 `/internal/…`과 구분하지 못한다. 이 경로를 막는 것은 ALB다. ALB는 URI를 정규화한 뒤 규칙을 평가하지만, 문서에는 무엇을 정규화하는지 나와 있지 않다. 그래서 콘솔을 켠 뒤에는 사내망에서 아래 요청을 보내 확인한다(**AWS 전용**). `/%69nternal/x`는 api의 404(`application/json`)가 기대값이다(ALB가 이것까지 정규화해 `text/plain` 404로 답해도 안전하다). 나머지 경로는 모두 ALB의 404(`text/plain`)가 기대값이다. api의 `/internal` 라우트는 상태와 상관없이 `application/json`으로 답한다. 그래서 dot segment나 역슬래시 경로에 `application/json` 응답이 오면 ALB가 그 경로를 api로 보낸 것이므로 콘솔을 다시 끈다(ALB가 400 같은 자기 오류로 거절하는 것은 안전하다).

```bash
for p in /internal/x /%69nternal/x /x/../internal/x /%2e/internal/x '/internal\x' '/x/..\internal/x'; do
  curl -s --path-as-is -o /dev/null -w "$p %{http_code} %{content_type}\n" "https://<host>$p"
done
```

켤 때는 설치별 파일에 다음을 둔다. 끄면 `/`와 `/internal` 규칙이 함께 빠지고 `/v1`·`/docs`·`/healthz`·`/readyz`는 그대로다.

```yaml
ingress:
  className: alb
  console:
    enabled: true
```

적용 뒤 사내망에서 확인한다(**AWS 전용**). `curl -s -o /dev/null -w '%{http_code}\n' https://<host>/`는 200이다. `curl -si -X POST https://<host>/internal/worker/x`는 404이고, 응답 헤더가 `content-type: text/plain`이며 api가 붙이는 `x-request-id`가 없어야 한다. api의 404는 `application/json`에 `x-request-id`가 붙으므로, 상태 코드만으로는 ALB가 막았는지 알 수 없다.

```bash
helm lint deploy/helm/agent-platform -f deploy/helm/agent-platform/values-aws.example.yaml   # kind 머신에서 확인
helm template werft deploy/helm/agent-platform \
  -f deploy/helm/agent-platform/values-aws.example.yaml >/dev/null                          # kind 머신에서 확인
helm upgrade --install werft deploy/helm/agent-platform \
  --namespace werft -f values-aws-<installation>.yaml --timeout 10m               # AWS 전용
```

| 값 | 무엇을 바꾸나 |
|---|---|
| `images.registry`, `images.*.digest` | ECR host와 그 이미지의 digest |
| `secrets.objectStoreKeys: false`, `serviceAccounts.api.annotations` | 정적 AWS key 대신 IRSA. api와 checkpoint GC가 이 role로 S3·Secrets Manager에 서명한다. scheduler와 worker는 S3 권한이 없다 |
| `secrets.externalSecret` | External Secrets Operator가 Secrets Manager의 `remoteKey`(JSON, 위 Secret 키 전부. IRSA면 AWS key 둘은 뺀다)로 Secret을 쓴다. 운영자 CRD가 필요하다 |
| `ingress` | ALB Ingress. `scheme`은 `internal`이다(위). `healthcheck-path: /readyz`, SSE를 위해 idle timeout 300초. 공개 경로(`/v1`·`/docs`·`/healthz`·`/readyz`)만 route하고 `/internal`과 authorizer(3100)는 열지 않는다 |
| `ingress.console.enabled` | 기본 `false`. 켜면 웹 콘솔 `/`와 `/internal` 404 규칙을 더한다. 켜는 조건은 [아래](#웹-콘솔과-internal) |
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
kubectl -n werft port-forward svc/werft-api 13000:3000 &
curl -fsS -w '\n' http://127.0.0.1:13000/readyz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/docs
kubectl -n werft exec deploy/werft-scheduler -- bun run apps/control-host/src/main.ts scheduler --health
kubectl -n werft exec deploy/werft-reconciler -- bun run apps/control-host/src/main.ts reconciler --health
kubectl -n werft exec deploy/werft-egress-proxy -- bun run /app/src/healthcheck.ts
```

port-forward는 끝나면 그 job만 끈다(`kill %1`). AWS에서는 port-forward 대신 Ingress host로 `/readyz`를 부른다(**AWS 전용**).

## API key, 실행 권한, 설정 문서

compose 설치의 `bun run keys`·`grants`·`settings`는 api 컨테이너 안에서 돈다. Kubernetes 설치에서는 `:k8s`가 붙은 같은 이름의 script가 `scripts/k8s-api.sh`로 api Pod 안에서 같은 CLI를 돌린다. Pod가 이미 `DATABASE_URL`을 가지고 있어서 비밀값이 운영자 셸을 지나지 않는다. kubectl의 현재 context나 `KUBECONFIG`가 클러스터를, `NAMESPACE`·`RELEASE`(기본 둘 다 `werft`)가 설치를 고른다. **kind**

```bash
bun run keys:k8s create <owner_id> --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover
# stdout: 평문 key(한 번만 나온다), stderr: key_id
bun run keys:k8s revoke <key_id>
bun run grants:k8s revoke <session_id> --reason <text>
bun run grants:k8s restore <session_id> --reason <text>
bun run settings:k8s export > settings.json
bun run settings:k8s import --document - --dry-run < settings.json
```

script 없이 부르면 다음과 같다. `deploy/…-api`는 api Pod 하나를 고른다. 세 CLI는 DB만 쓰므로 어느 Pod든 같다.

```bash
kubectl -n werft exec deploy/werft-api -c api -- \
  bun run apps/control-host/src/api/keys.ts create <owner_id> --scopes sessions:read
```

`Session catalog loaded` 로그는 api Pod가 DB에서 읽은 상한·저장소 수를 남긴다.

```bash
kubectl -n werft logs deploy/werft-api | grep 'Session catalog loaded'
```

## 업그레이드와 롤백

업그레이드는 values 파일의 digest를 새 이미지로 바꾸고 설치와 같은 `helm upgrade --install`을 돌린다. migrate hook이 먼저 돌고, 실패하면 Deployment는 그대로다. scheduler는 `Recreate`라서 옛 Pod가 내려간 뒤 새 Pod가 뜬다. 그 사이에는 scheduler pass가 돌지 않는다(새 worker launch와 회수가 멈춘다). **kind**

```bash
helm -n werft history werft
helm -n werft rollback werft <revision> --wait --timeout 10m
```

롤백은 migrate hook을 돌리지 않는다(`pre-rollback`이 아니다). DB는 새 schema에 남고, 옛 빌드는 자기보다 앞선 schema에서도 ready가 된다(`/readyz`의 schema 검사는 자기 migration 목록이 적용된 목록의 앞부분과 같은지만 본다). 그래서 롤백할 수 없는 migration은 배포하지 않는다. worker 이미지를 되돌릴 때 checkpoint 호환은 [images-and-supply-chain.md § worker·control-host 롤백과 incremental checkpoint](images-and-supply-chain.md#workercontrol-host-롤백과-incremental-checkpoint)를 먼저 본다.

### 배포 순서

worker Pod의 이미지는 scheduler가 launch할 때 정해진다. 이미지는 격리 stamp에 들어가지 않으므로, upgrade가 `images.worker`를 바꿔도 이미 떠 있는 worker Pod는 교체되지 않고 끝날 때까지 옛 이미지로 돈다. 입력이 없는 worker도 `WORKER_IDLE_TIMEOUT_SEC`(기본 1800초) 동안 남는다. 새 이미지는 그 뒤의 launch부터 쓰인다.

- worker가 보내는 protocol 필드를 더하거나 checkpoint manifest에 필드를 더하는 릴리스는 `images.controlHost`만 바꾼 upgrade를 먼저 하고, `images.worker`는 다음 upgrade에서 바꾼다. 한 번의 upgrade로는 새 worker가 옛 api보다 먼저 뜨지 않는다는 보장이 없다. 필드별 순서는 [images-and-supply-chain.md § worker protocol 필드를 걷어내는 순서](images-and-supply-chain.md#worker-protocol-필드를-걷어내는-순서)에 있다.
- DB 변경은 [images-and-supply-chain.md § DB 스키마를 바꾸는 순서](images-and-supply-chain.md#db-스키마를-바꾸는-순서)의 확장→전환→정리를 따른다. migrate hook이 rollout보다 먼저 돌기 때문에 옛 api와 옛 worker가 새 schema 위에서 돈다.
- 새 control-host와 직전 릴리스 worker 이미지의 조합은 CI가 아직 검사하지 않는다. 릴리스 전에 kind나 시험 설치에서 직접 확인한다. `images.controlHost`만 새 digest로, `images.worker`는 직전 릴리스 digest로 둔 values로 upgrade하고, 세션 하나가 turn 1을 끝내는지 본다. 그 세션의 worker Pod를 `kubectl delete pod`로 지운 뒤 입력을 하나 더 보내 새 Pod가 checkpoint에서 이어 turn 2를 끝내는지 본다. api 로그에 worker 요청의 400 `BAD_REQUEST`가 없어야 한다. `deploy/kind/up.sh`는 `images.worker`를 `--set`으로 덮으므로 `EXTRA_VALUES`로는 worker 이미지를 바꾸지 못한다. 직접 `helm upgrade`한다.

### 파일 카탈로그에서 올리기

옛 chart의 `catalog` ConfigMap은 이번 chart에 없다. Helm은 hook이 끝난 뒤에 옛 리소스를 지우므로, pre-upgrade migrate Job이 같은 ConfigMap을 `/legacy-config`에 선택 마운트해 `settings import --from-dir /legacy-config --if-present`로 가져온다. 다음 upgrade부터는 ConfigMap이 없어 아무 일도 하지 않는다. 일부 파일만 있거나 값이 깨졌으면 Job이 실패하고 Deployment는 바뀌지 않는다.

1. `PLATFORM_SECRET_KEY`를 Secret에 먼저 넣는다. 이미 있으면 같은 값을 그대로 둔다.
2. values에서 `catalog` 절을 지우고 `helm upgrade`한다. `api.extraEnv`에 `PLATFORM_CONFIG_DIR`을 두었다면 지운다.
3. 끝나면 `bun run settings:k8s export`로 더해진 항목을 본다. `installation_profiles`에 행이 이미 있으면 파일의 상한은 다시 넣지 않는다. 절차와 되돌리기 하한은 [api-server.md](api-server.md#설정-문서-가져오기내보내기)에 있다.

chart 이름이 `agent-platform`이던 release는 지우고 새로 설치하므로 ConfigMap도 함께 사라지고, 새 chart는 다른 이름을 찾는다. 옛 release를 지우기 전에 ConfigMap을 새 이름으로 저장하고, `helm install` 전에 만들어 둔다. migrate Job은 설치 때도 돌아 그 ConfigMap을 가져온다. ConfigMap에는 참조만 있고 비밀값은 없다.

```bash
kubectl -n agent-platform get configmap agent-platform-catalog -o json \
  | jq '{apiVersion, kind, data, metadata: {name: "werft-catalog", namespace: "werft"}}' > catalog-configmap.json
# 옛 release를 지우고 namespace를 만든 뒤
kubectl apply -f catalog-configmap.json
```

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
kubectl -n werft logs job/werft-upgrade-check
```

| `verdict` | exit | upgrade | 뜻 |
|---|---|---|---|
| `proceed` | 0 | 진행 | `upgrade.approvedSessions`가 `affected`의 `sessionId`와 정확히 같다. 고른 세션이 없거나, worker 이미지가 그대로이거나, 배포된 적이 없으면 승인 목록이 비어 있어야 한다 |
| `refused` | 2 | 멈춤 | 승인 목록이 하나라도 다르다(지난 upgrade의 승인이 values에 남은 경우 포함). 또는 대상의 `images.workerPrevious`가 지금 배포된 worker 이미지가 아니다. 이 경우는 승인으로 넘길 수 없다 |
| `check_failed` | 1 | 멈춤 | DB를 읽지 못했거나, 이미지 조합이 읽히지 않거나 아래 표대로 필요한데 없거나, 배포된 worker 이미지를 알 수 없다. scheduler Deployment가 없는데 DB에 세션이나 일부 schema가 있어도 여기다. 넘기는 설정은 없다 |

`images.worker.runtime`은 첫 설치에는 없어도 된다. upgrade에서 필요한지는 배포된 상태와 대상 값에 달렸다.

| 배포된 상태 | 대상 | runtime 없을 때 |
|---|---|---|
| scheduler Deployment 없음, DB가 비어 있거나 세션 없음(첫 설치 재시도) | 어떤 worker 이미지든, `images.workerPrevious` 없음 | `proceed` |
| worker 이미지 하나, runtime·직전 이미지 없음 | 같은 worker 이미지, `images.workerPrevious` 없음 | `proceed` |
| worker 이미지 하나, runtime·직전 이미지 없음 | 다른 worker 이미지 | `check_failed`. 대상에 `images.worker.runtime`과, 지금 이미지를 담은 `images.workerPrevious`를 둔다 |
| runtime이나 직전 이미지가 있음 | `images.worker.runtime`을 뺀 값 | `check_failed`. 조합 없이는 세션을 검사할 수 없다 |

runtime 값을 얻는 방법은 [configuration.md의 API 설정](configuration.md)에 있다. 최소 values 설치는 runtime 없이 시작하고, worker 이미지를 처음 바꾸는 upgrade에서 두 이미지의 runtime을 함께 넣는다.

`images.worker`를 그대로 두고 `images.workerPrevious`만 빼는 upgrade는 막지 않는다. 같은 이미지 upgrade는 세션을 비교하지 않으므로 `proceed`다. 빠진 이미지의 조합으로 남은 세션은 재개할 때 `recovery_required`로 멈출 수 있으니, 그런 세션이 없을 때만 뺀다.

고른 세션이 재개하지 못해도 되면 그 목록을 그대로 values에 넣고 같은 upgrade를 다시 돌린다. 승인은 세션 상태를 바꾸지 않는다. `no_image`로 고른 세션은 재개할 때 `recovery_required`로 멈춘다. `unrecorded`로 고른 세션은 새 이미지로 뜨고, 복원이 판정해 이어지거나 `recovery_required`로 멈춘다.

```bash
helm upgrade --install ... --set-json 'upgrade.approvedSessions=["<sessionId>", ...]'
```

승인 목록은 release values에 남는다. 다음 upgrade마다 `--set-json 'upgrade.approvedSessions=[]'`로 비우고, 그 upgrade의 목록을 다시 읽고 승인한다. 남은 목록은 그 upgrade의 `affected`와 다르면 `refused`로 멈추지만, 같고 지원 창 조건도 맞으면 그대로 통과한다.

Job은 승인 목록을 `UPGRADE_APPROVED_SESSIONS`(JSON 배열)로, 배포된 worker 이미지를 `UPGRADE_DEPLOYED_WORKER_IMAGE`로 받는다. 배포된 worker 이미지는 chart가 지금 scheduler Deployment의 `WORKER_IMAGE`를 `lookup`으로 읽어 넘긴다. 위 표의 예외를 열 수 있는 것은 chart가 함께 넘기는 `UPGRADE_DEPLOYED_STATE`뿐이다. `absent`는 scheduler Deployment가 없고 namespace의 `default` ServiceAccount는 읽혔다는 뜻이다(그래서 이 경로에는 그 ServiceAccount의 `get` 권한이 필요하다). `unpinned`는 Deployment가 runtime·직전 이미지 없이 도는 상태다. `helm template`과 클라이언트 `--dry-run`에서는 `lookup`이 아무것도 읽지 않아 두 값이 비므로 그 렌더로 돌린 Job은 `check_failed`가 된다. `--dry-run=server`는 클러스터를 읽지만 hook을 실행하지 않으므로 판정을 대신하지 않는다. 검사는 `DATABASE_URL`이 이 설치의 DB라고 믿는다. 다른 빈 DB를 가리키면 `absent` 경로가 통과한다. 첫 설치(`pre-install`)와 `scheduler.enabled: false`에서는 Job을 만들지 않는다. Job과 scheduler가 같은 이미지를 보도록 `WORKER_IMAGE`·`WORKER_IMAGE_PREVIOUS`·`WORKER_IMAGE_RUNTIME`·`WORKER_IMAGE_PREVIOUS_RUNTIME`은 `*.extraEnv`, `config.limits`, `secrets.catalogEnv`로 줄 수 없다. 주면 render가 실패한다. `images.worker`와 `images.workerPrevious`로 준다.

**`helm rollback` 전.** rollback은 hook을 돌리지 않으므로 같은 명령을 api Pod에서 직접 돌린다. 값은 되돌릴 revision의 것(`helm get values --revision <revision>`)을 넣는다.

```bash
kubectl -n werft exec deploy/werft-api -- env \
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
| 4. release·설정 봉인 | 이미지 digest를 설치별 values 파일 하나에 두고, 설정은 설정 문서로 가져온다 |
| 5. 설치와 첫 사용 | "설치 순서", "health 확인", "API key" 절 |
| 6. 백업·복원 | RDS·S3 기능([backup-restore.md § Kubernetes 설치](backup-restore.md#kubernetes-설치)) |
| 7. 업그레이드·롤백 | "업그레이드와 롤백" 절 |
| 8. 물리 재부팅 | node가 바뀌어도 Deployment가 다시 띄운다. EBS PVC는 AZ에 묶이므로 worker가 같은 AZ의 node에 다시 붙는지는 EKS에서 확인한다(**AWS 전용**) |
| 9. Day 1 운영 | 같은 점검. 명령은 `kubectl exec`·`bun run *:k8s`로 바꾼다 |
| 10. 증거 | 같다. `helm history`, `kubectl get job,deploy,pods`, `/readyz` 출력을 남긴다 |

## 제거

```bash
helm -n werft uninstall werft
```

**kind**. `helm uninstall`이 남기는 것은 다음과 같다.

- scheduler가 만든 worker Pod, nonce Secret, workspace PVC. 지우기 전에 세션이 끝났는지(또는 checkpoint됐는지) 본다. PVC를 지우면 checkpoint되지 않은 작업이 사라진다. 목록: `kubectl -n werft get pods,secrets,pvc -l app.kubernetes.io/part-of=agent-platform,agent-platform.installation=<installationId>`
- hook으로 만든 migrate Job과 upgrade-check Job, ExternalSecret과 그것이 쓴 Secret(`creationPolicy: Orphan`). 직접 만든 Secret도 남는다. 남은 Job은 다음 설치를 막지 않는다. 같은 이름의 hook이 돌 때 Helm이 먼저 지운다. 지금 지우려면 `kubectl -n werft delete job werft-migrate werft-upgrade-check --ignore-not-found`를 돌린다.

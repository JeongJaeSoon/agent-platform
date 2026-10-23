# Kubernetes 실행 backend

scheduler가 worker를 Docker 컨테이너 대신 Kubernetes Pod로 띄울 때의 동작과 설정이다. Helm chart로 설치하는 절차는 [kubernetes-deployment.md](kubernetes-deployment.md)에, Docker backend의 동작은 [실행 기반과 worker 격리](execution.md)에 있다.

`packages/adapters/execution/kubernetes`는 launch 하나에 worker Pod 하나를 만든다. Pod마다 그 Pod가 소유하는 nonce Secret이 하나 붙고, 세션의 workspace PVC가 마운트된다.

scheduler는 `EXECUTION_BACKEND`로 backend를 고른다. 값은 `local_docker`(기본값, 비워 둬도 같다)와 `kubernetes` 둘이고, 그 밖의 값이면 그 값을 적은 오류로 기동을 거부한다. `kubernetes`이면 Docker 설정(`DOCKER_HOST`, `EXECUTION_DOCKER_*`, `EXECUTION_WORKSPACE_QUOTA`)을 읽지 않고 Docker socket도 쓰지 않는다. Docker 전용 preflight인 egress proxy 격리 확인과 workspace quota probe도 돌지 않는다. kubernetes에서 worker 격리는 chart의 NetworkPolicy가 맡고, workspace 상한은 PVC 크기다. 정지·요청 timeout은 고정값(120s + 30s)이어서 `SCHEDULER_PASS_TIMEOUT_SEC`는 150보다 커야 한다. `migrate-workspace`는 Docker volume을 옮기는 도구라서 `local_docker`에서만 돈다.

readOnlyRootFilesystem인 Pod에서는 status file을 쓰기 가능한 경로에 둔다. 기본 경로 `/tmp/scheduler-status.json`·`/tmp/reconciler-status.json`은 `/tmp`에 emptyDir를 마운트하면 그대로 쓸 수 있다. 다른 경로라면 `SCHEDULER_STATUS_FILE`·`RECONCILER_STATUS_FILE`로 바꾼다. 루프는 status file과 같은 디렉터리에 임시 파일(`<status file>.<pid>.tmp`)을 쓴 뒤 rename한다. scheduler는 그 옆에 `.quota-verified` 기록도 둔다. 그래서 파일 하나가 아니라 디렉터리 전체가 쓰기 가능해야 한다.

공유 env(`WORKER_IMAGE`, `WORKER_GATEWAY_URL`, `EXECUTION_EGRESS_PROXY_URL`, `EXECUTION_EGRESS_CREDENTIAL_PORT`, `EXECUTION_INSTALLATION_ID`, `EXECUTION_WORKSPACE_QUOTA_MB`, `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC`, `S3_BUCKET`, `AWS_REGION`)는 Docker backend와 같다. kubernetes 모드에서는 다음 두 값에 제약이 더 붙는다.

- `WORKER_IMAGE`는 `repository@sha256:<digest>` 형식이어야 한다.
- `EXECUTION_INSTALLATION_ID`는 32자 이하의 소문자 DNS label이어야 한다.

kubernetes 모드에서만 읽는 설정은 다음과 같다.

| 변수 | 뜻 |
| --- | --- |
| `EXECUTION_K8S_NAMESPACE` | worker Pod·Secret·PVC를 두는 namespace. 기본값은 scheduler 자신의 namespace다. 클러스터 밖에서 돌리면 반드시 줘야 한다. |
| `EXECUTION_K8S_WORKER_SERVICE_ACCOUNT` | worker Pod의 ServiceAccount. token은 늘 마운트하지 않는다. |
| `EXECUTION_K8S_STORAGE_CLASS` | workspace PVC의 StorageClass. 비우면 클러스터 기본값을 쓴다. |
| `EXECUTION_K8S_IMAGE_PULL_SECRETS` | 선택. 쉼표로 구분한 Secret 이름. |
| `EXECUTION_K8S_WORKER_NODE_SELECTOR` | 선택. JSON object. |
| `EXECUTION_K8S_WORKER_TOLERATIONS` | 선택. JSON array. |

## chart가 넣는 값

Helm chart(`deploy/helm/agent-platform`, 설치 절차는 [kubernetes-deployment.md](kubernetes-deployment.md))로 설치하면 위 env를 직접 적지 않는다. chart가 values에서 만든다.

| env | values | 비고 |
| --- | --- | --- |
| `EXECUTION_BACKEND` | 없음 | 늘 `kubernetes` |
| `EXECUTION_K8S_WORKER_SERVICE_ACCOUNT` | 없음 | chart가 만든 `<fullname>-worker`. token은 마운트하지 않는다 |
| `EXECUTION_K8S_NAMESPACE` | 없음 | 넣지 않는다. scheduler 자신의 namespace(release namespace)가 된다 |
| `EXECUTION_K8S_STORAGE_CLASS` | `worker.storageClass` | 비면 넣지 않는다 |
| `EXECUTION_K8S_IMAGE_PULL_SECRETS` | `images.pullSecrets` | 제어 영역 Pod에도 같은 Secret을 쓴다 |
| `EXECUTION_K8S_WORKER_NODE_SELECTOR`, `EXECUTION_K8S_WORKER_TOLERATIONS` | `worker.nodeSelector`, `worker.tolerations` | JSON으로 바꿔 넣는다 |
| `WORKER_IMAGE` | `images.registry`, `images.worker.*` | `<registry>/<repository>@<digest>`. digest가 없으면 render가 실패한다 |
| `WORKER_GATEWAY_URL`, `EXECUTION_EGRESS_PROXY_URL`, `EXECUTION_EGRESS_CREDENTIAL_PORT` | 없음 | api Service의 3000, egress-proxy Service의 3128, 3129 |
| `EXECUTION_INSTALLATION_ID` | `installationId` | worker NetworkPolicy의 label 값이기도 하다 |
| `EXECUTION_WORKSPACE_QUOTA_MB`, `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC` | `worker.workspace.*` | quota는 workspace PVC의 크기 |
| `WORKER_CPUS`, `WORKER_MEMORY_MB` | `worker.cpus`, `worker.memoryMb` | |
| 설치 상한(`EXECUTION_SLOT_LIMIT` 등) | `config.limits` | api와 scheduler에 같은 값 |
| `SCHEDULER_*` | `scheduler.intervalSec` 등 | `SCHEDULER_PASS_TIMEOUT_SEC`(`scheduler.passTimeoutSec`, 기본 180)는 150보다 커야 한다 |

어느 Deployment에나 `extraEnv`로 env를 더할 수 있다. Secret에서 오는 값(`DATABASE_URL`, `EGRESS_AUTHORIZER_TOKEN`, AWS key, 카탈로그 credential)은 [kubernetes-deployment.md § 준비](kubernetes-deployment.md#준비)의 표에 있다.

## probe

| 구성요소 | readiness | liveness | startup |
| --- | --- | --- | --- |
| api | `GET /readyz` | `GET /healthz` | `GET /healthz`(5초 × 24) |
| scheduler | `bun run apps/control-host/src/main.ts scheduler --health` | 같음 | 같음. 실패 허용 횟수는 `(intervalSec + passTimeoutSec + 39) / 10` |
| reconciler | `bun run apps/control-host/src/main.ts reconciler --health` | 같음 | scheduler와 같은 식 |
| egress-proxy | `bun run /app/src/healthcheck.ts` | 같음 | 없음 |

`/healthz`는 HTTP를 받는지만 보고 DB를 보지 않는다. 그래서 liveness에 쓰고, DB·schema·설정을 보는 `/readyz`는 readiness에만 쓴다. DB가 잠시 끊겨도 api Pod는 재시작되지 않고 트래픽에서만 빠진다. `/livez`는 없다. scheduler와 reconciler의 `--health`는 loop가 쓰는 status file을 읽고, 직전 pass가 실패했거나 기한을 넘겼거나, `SCHEDULER_HEALTH_STALE_SEC`·`RECONCILER_HEALTH_STALE_SEC` 안에 끝난 pass가 없으면 실패한다. startup probe는 첫 pass가 끝날 때까지 기다린다.

## scheduler는 replica 1, `Recreate`

scheduler pass는 PostgreSQL advisory lock(`pg_try_advisory_lock`) 하나로 직렬화된다. 두 번째 scheduler는 lock을 얻지 못해 pass를 건너뛰고, 성공한 pass가 없으니 `--health`가 stale이 되어 liveness가 그 Pod를 계속 재시작한다. 늘려도 처리량은 늘지 않는다. 그래서 chart는 `replicas: 1`을 고정하고(values에 키가 없다), rollout도 `RollingUpdate`가 아니라 `Recreate`로 옛 Pod를 먼저 내린다. 업그레이드 동안 잠깐 pass가 멈춘다. reconciler는 pass를 행 lock 아래에서 다시 판단하므로 leader election 없이 `reconciler.replicas`를 늘릴 수 있고, 기본은 1이다.

## worker NetworkPolicy

chart의 NetworkPolicy가 Docker backend의 execution별 internal 네트워크를 대신한다. worker Pod(`app.kubernetes.io/part-of=agent-platform`, `app.kubernetes.io/component=worker`, `agent-platform.installation=<installationId>`)는 아무 연결도 받지 않고, 바깥으로는 egress-proxy의 3128·3129로만 연결한다. DB, api, 다른 worker, node·cloud metadata 주소에 직접 닿지 않는다. api로 가는 gateway 요청도 proxy를 거친다. egress-proxy는 worker에게서만 연결을 받고, api의 authorizer(3100)는 egress-proxy에게서만 받는다. 클러스터 CNI가 NetworkPolicy를 강제하지 않으면 이 격리가 없다(kind의 kindnet은 강제한다. EKS는 VPC CNI의 network policy agent를 켠다).

## API server 인증

API server 인증은 `KUBECONFIG`가 있으면 그것을 쓰고, 없으면 Pod의 ServiceAccount를 쓴다. ServiceAccount 경로는 `KUBERNETES_SERVICE_HOST`·`KUBERNETES_SERVICE_PORT`와 token·CA 파일을 읽는다. scheduler의 Role 동사와 pidsLimit 처리는 패키지 README에 있다.

kind에 대한 테스트는 opt-in이다. `K8S_BACKEND_TEST=1`과 `KUBECONFIG`를 주면 실행된다. `K8S_BACKEND_TEST_IMAGE`로 digest 형식의 이미지를 바꿀 수 있고, `K8S_BACKEND_TEST_KEEP=1`을 주면 테스트 namespace를 지우지 않고 남긴다.

```sh
K8S_BACKEND_TEST=1 KUBECONFIG=<kind kubeconfig> \
  bun test packages/adapters/execution/kubernetes/src/backend.contract.integration.test.ts \
  packages/adapters/execution/kubernetes/src/backend.integration.test.ts
```

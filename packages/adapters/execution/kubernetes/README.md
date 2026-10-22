# @werft-ai/execution-kubernetes

`ExecutionBackend`을 Kubernetes로 구현한 패키지다. launch 하나가 다음 셋을 만든다.

- worker Pod 하나. 이름은 `ap-worker-<installation>-<execution>-g<generation>`이다.
- 그 Pod가 소유하는 nonce Secret.
- 세션의 workspace PVC(`ap-ws-<installation>-<session>`)를 Pod에 마운트한다.
  마운트 지점은 `workspaceDir`(`/workspace`)이고, worker는 그 아래 `repo/`에 checkout한다(`WORKER_WORKSPACE_DIR`). 새 볼륨의 루트는 root 소유라(fsGroup은 그룹만 바꾼다) git이 그 자리의 저장소를 "dubious ownership"으로 거부하기 때문이다. `repo/`는 worker가 자기 uid로 만든다.

`providerRef`는 Pod UID다. Pod와 PVC를 지울 때는 `DeleteOptions.preconditions.uid`를 붙여서, 같은 이름에 새로 생긴 다른 Pod·PVC를 건드리지 않는다.

## scheduler RBAC

worker namespace 하나에만 거는 `Role`이다. 어댑터가 실제로 부르는 동사만 담았고, chart가 이 목록 그대로 Role을 만든다.

| resource | verbs | 쓰는 곳 |
| --- | --- | --- |
| `pods` | get, list, create, delete | 생성·adopt·inspect·`listManaged`·terminate. `removeWorkspace`의 사용 중 확인에도 쓴다 |
| `secrets` | get, list, create, delete | nonce Secret 생성. adopt 전에 Secret이 있는지 확인한다. terminate 때 지운다 |
| `persistentvolumeclaims` | get, list, create, delete | workspace 생성·확인, `listWorkspaces`·`removeWorkspace` |

이 Role에 없는 동사는 다음과 같다.

- `watch`: 삭제를 기다릴 때 GET 폴링을 쓰므로 필요 없다.
- `patch`·`update`: Secret을 Pod보다 나중에 만들면서 처음부터 ownerReferences를 달아 두므로 고칠 일이 없다.
- `pods/log`, `events`: 쓰지 않는다.

Secret의 ownerReference에는 `blockOwnerDeletion`을 넣지 않는다. 넣으면 `pods/finalizers` update 권한이 필요하기 때문이다.

## nonce

nonce가 저장되는 곳은 Pod별 Secret(`stringData.nonce`, immutable) 하나뿐이다. worker는 `env.valueFrom.secretKeyRef`로 이 값을 받는다.

- Pod spec과 annotation에는 nonce의 지문(`agent-platform.bootstrap-fingerprint`)만 들어간다.
- 오류 메시지에서는 nonce를 가린다.

생성 순서는 Pod가 먼저, Secret이 나중이다. Secret을 Pod에 소유시키려면 Pod의 UID가 필요하기 때문이다.

- 두 생성 사이에는 kubelet이 컨테이너를 `CreateContainerConfigError` 상태로 두고 재시도한다.
- Secret 생성이 거부되면 Pod를 UID 조건으로 지운다.
- Secret이 끝내 생기지 않아 Pending으로 남은 Pod는 다음 pass가 교체한다.

## pidsLimit

Pod 단위로 PID 수를 제한하는 필드가 없다. 실제 상한은 노드 kubelet의 `podPidsLimit`이고, worker 노드 풀에서 이 값을 설정해야 한다.

`intent.resources.pidsLimit`은 Pod spec에는 들어가지 않지만 launch spec 지문에는 그대로 들어간다. 그래서 제한값이 바뀌면 실행 중인 Pod를 다른 spec으로 보고 교체 대상으로 판단한다.

## 인증

| 상황 | 인증 방식 |
| --- | --- |
| `KUBECONFIG`가 설정됨 (로컬 실행·테스트) | current-context의 server, CA, client cert·key 또는 token |
| 클러스터 안 (기본) | Pod의 ServiceAccount token, CA, namespace 파일. token은 회전되므로 요청마다 다시 읽는다 |

kubeconfig에 `exec` 플러그인이나 `insecure-skip-tls-verify`가 있으면 실행하지 않고 오류를 낸다.

## 설정

공유 env는 local-docker와 같다. kubernetes 모드에서만 쓰는 env는 다음과 같다.

| env | 뜻 |
| --- | --- |
| `EXECUTION_K8S_NAMESPACE` | worker namespace. 기본값은 scheduler 자신의 namespace |
| `EXECUTION_K8S_WORKER_SERVICE_ACCOUNT` | worker Pod의 ServiceAccount. token은 늘 마운트하지 않는다 |
| `EXECUTION_K8S_STORAGE_CLASS` | workspace PVC의 StorageClass. 비우면 클러스터 기본값 |
| `EXECUTION_K8S_IMAGE_PULL_SECRETS` | 쉼표로 구분한 Secret 이름 |
| `EXECUTION_K8S_WORKER_NODE_SELECTOR` | JSON object |
| `EXECUTION_K8S_WORKER_TOLERATIONS` | JSON array |

설정할 때 지켜야 할 제약이 둘 있다.

- `EXECUTION_INSTALLATION_ID`는 소문자 DNS label이어야 하고 32자를 넘을 수 없다. 모든 리소스 이름과 라벨 값에 들어가기 때문이다.
- `WORKER_IMAGE`는 `repository@sha256:<digest>` 형식이어야 한다. `resolveImage`는 tag를 거부하고 registry를 조회하지 않는다.

## 테스트

```sh
bun test packages/adapters/execution/kubernetes          # unit
K8S_BACKEND_TEST=1 KUBECONFIG=<kind kubeconfig> \
  bun test packages/adapters/execution/kubernetes/src/*.integration.test.ts
```

integration 테스트는 실행할 때마다 namespace를 새로 만들고, 끝나면 지운다. `K8S_BACKEND_TEST_KEEP=1`을 주면 namespace를 남긴다. 테스트 이미지는 `K8S_BACKEND_TEST_IMAGE`로 바꿀 수 있고, digest 형식이어야 한다.

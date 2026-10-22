# 용량 관리: transcript 상한, worker 메모리, 노드당 세션 수

세션 하나가 쓸 수 있는 transcript 크기와 worker 메모리는 서로 묶여 있다. Kubernetes에서는 worker Pod의 requests가 limits와 같아서, 이 두 값이 노드 하나에 올릴 수 있는 동시 세션 수까지 정한다. 이 문서는 세 값의 관계, 근거가 된 실측, 바꾸는 방법과 그 대가를 한곳에 모은다.

## 한눈에

| 값 | 기본값 | 정의된 곳 |
|---|---|---|
| transcript 합계 상한 `MAX_TRANSCRIPT_BYTES` | 512MiB | `packages/runtime-core/src/checkpoint-manifest.ts` |
| transcript part 상한 `MAX_TRANSCRIPT_PART_BYTES` | 16MiB | 같은 파일 |
| 경고 문턱 `transcriptWarnBytes` | 상한의 80%, 409.6MiB | 같은 파일. 아래 "80% 경고" |
| worker 메모리 `WORKER_MEMORY_MB` / helm `worker.memoryMb` | 4608MiB | `apps/control-host/src/scheduler/config.ts`, `deploy/helm/agent-platform/values.yaml`, `infra/compose.core.yml` |
| workspace 상한 `EXECUTION_WORKSPACE_QUOTA_MB` / helm `worker.workspace.quotaMb` | 4096MiB (최솟값 1024) | `packages/adapters/execution/kubernetes/src/config.ts`, `packages/adapters/execution/local-docker/src/config.ts`, `deploy/helm/agent-platform/values.yaml` |

`.env.example`은 로컬 개발용으로 `WORKER_MEMORY_MB=2048`을 둔다. 이 값을 그대로 쓰면 아래 절반 기준이 지켜지지 않는다. 큰 transcript를 resume하는 로컬 시험에서는 이 줄을 지우거나 4608로 바꾼다.

## transcript 상한

checkpoint 하나에 담기는 transcript(root와 모든 subagent의 합)가 512MiB를 넘으면 안 된다. part 하나는 16MiB를 넘으면 안 된다. 세 곳이 같은 값으로 검사한다.

1. worker가 checkpoint를 올리기 전(`captureTranscripts`, manifest를 올리고 커밋하기 전).
2. API의 finalize가 part를 읽기 전. 이 판정이 기준이다.
3. restore가 part를 받기 전(`#checkManifest`).

크기는 compaction 뒤에도 남는 JSONL 전체다. 엔진(Claude Code CLI)은 resume할 때 마지막 compaction 이전을 다시 읽지 않지만, 플랫폼은 파일 전체를 저장하고 복원한다. 그래서 상한은 파일 전체 크기에 건다.

### 80% 경고

- 커밋된 checkpoint의 transcript가 처음으로 상한의 80%(409.6MiB) 이상이 되면 SSE `system` 이벤트(`transcript_near_limit`)를 한 번 보내고, 세션 상세 `attention`을 `TRANSCRIPT_LIMIT`로 둔다. 막지는 않는다.

### 상한을 넘으면

- worker의 사전검사(workspace를 올리기 전)나 finalize(part를 읽기 전)가 `transcript_too_large`(part 하나가 넘으면 `transcript_part_too_large`)를 세션의 `durability.checkpoint_pending_reason`에 기록한다. 처음 기록될 때 SSE `system` 이벤트(`transcript_limit_reached`)를 한 번 보낸다.
- 상한을 넘긴 turn은 실행된 대로 `completed`로 끝나지만 그 turn의 checkpoint는 커밋되지 않는다.
- 그 뒤 새 메시지는 409 `CHECKPOINT_UNAVAILABLE`로 거절되고, queue에 있던 turn도 실행되지 않는다. 이어 가려면 새 세션을 만들거나 recovery 경로의 `start_fresh`를 쓴다. close도 409 `CHECKPOINT_UNAVAILABLE`이다. terminate한 뒤 recovery close로 닫는다.
- interrupt된 turn은 다르다. 그 turn의 checkpoint가 거절되면 turn은 `outcome_unknown`(`interrupt_checkpoint_unavailable`)으로 끝나고 세션은 `recovery_required`로 간다.
- 마지막으로 커밋된 checkpoint가 복원 지점으로 남는다. 상한을 넘긴 turn 하나는 checkpoint가 없어서, worker가 바뀐 뒤에는 그 turn의 context를 이어받지 못한다(세션 상세 attention `CONTEXT_GAP`).

## worker 메모리와 transcript 크기 (실측)

기준(2026-10-21 결정): **compaction이 없는 transcript를 resume할 때의 최악 peak이 worker 메모리 한도의 절반 이하**여야 한다. 나머지 절반은 첫 turn의 작업, 측정하지 않은 transcript 모양, 엔진 버전 차이에 쓰는 여유다.

### 측정 방법

카드 전용 compose 스택(fake model, OrbStack, cgroup v2)에서 쟀다. source worker가 합성 transcript를 mirror에 넣고 checkpoint한 뒤 pause한다. 이어서 새 worker가 그 checkpoint를 복원하고 첫 resume turn을 돈다. 그동안 0.5초마다 worker 컨테이너의 cgroup(`memory.peak`, anon, file, shmem, swap, oom_kill)과 프로세스별 VmHWM을 기록했다. `memory.peak`에는 회수 가능한 page cache(file)도 들어간다. 그래도 기준에는 포함했다. worker 이미지는 claude-agent-sdk 0.3.270, Claude Code CLI 2.1.270이다.

### 4608MiB 한도 (현재 기본값)

| transcript | compaction | 첫 resume turn | memory.peak MiB (한도 대비) | anon | file | swap | OOM | worker(bun) VmHWM | CLI VmHWM |
|---|---|---|---|---|---|---|---|---|---|
| 511MiB | 없음 | 성공 | **1970 (43%)** | 1054 | 710 | 0 | 0 | 546 | 1129 |
| 511MiB | 있음 | 성공 | 1338 (29%) | 533 | 716 | 0 | 0 | 588 | 237 |
| 64MiB | 없음 | 성공 | 726 (16%) | 558 | 75 | 0 | 0 | 504 | 329 |

### 6144MiB 한도 (상한 800MiB를 검토할 때)

| transcript | compaction | 첫 resume turn | memory.peak MiB (한도 대비) | anon | file | swap | worker(bun) VmHWM | CLI VmHWM |
|---|---|---|---|---|---|---|---|---|
| 600.0MiB | 없음 | 성공 | 2178 (35%) | 1301 | 745 | 0 | 626 | 1308 |
| 600.1MiB | 있음 | 성공 | 1029 (17%) | 453 | 609 | 0 | 497 | 236 |
| 799.4MiB | 없음 | 성공 | 2785 (45%) | 1669 | 852 | 0 | 597 | 1727 |
| 799.1MiB | 있음 | 성공 | 1392 (23%) | 671 | 996 | 0 | 716 | 234 |
| 64.9MiB | 없음 | 성공 | 839 (14%) | 508 | 279 | 0 | 437 | 326 |
| 150.2MiB | 없음 | 성공 | 828 (13%) | 501 | 151 | 0 | 487 | 492 |

### 읽는 법

- worker(bun)는 transcript 크기와 상관없이 440~720MiB를 쓴다. restore가 part 단위로 스트리밍하기 때문이다.
- 크기에 비례하는 몫은 엔진(CLI)이다. compaction이 없으면 엔진은 대략 **210 + 1.85 × T MiB**를 쓴다(T는 transcript MiB). 511MiB에서 공식은 1155MiB이고, 실측은 1129MiB였다. compaction이 있으면 엔진 몫은 크기와 상관없이 약 235MiB다.
- 전체 peak는 page cache를 더해 150~800MiB 구간에서 transcript 1MiB당 약 3MiB씩 는다(150.2MiB에서 828MiB, 600MiB에서 2178MiB, 800MiB에서 2785MiB). 아래 표의 256·400MiB 값은 이 직선으로 보간한 **추정**이다.
- 이 구조 변경 전(2048MiB 한도, transcript를 tmpfs와 메모리에 통째로 올리던 경로)에는 300MiB부터 restore가 실패했다.

## 512MiB / 4608MiB를 고른 이유

후보 상한마다 필요한 메모리와 노드당 세션 수를 비교했다. 메모리는 2 × peak를 512MiB 단위로 올린 값이다. 세션 수는 allocatable 30GiB(30720MiB) 노드 기준이다. 분포는 사용자가 2026-10-21에 자기 PC 두 대에서 잰 실제 transcript 12개다. 한 PC의 상위 10개는 400.1, 217.2, 113.4, 102.0, 96.3, 86.0, 85.2, 78.8, 70.4, 68.5MiB이고, 다른 PC의 상위 2개는 591.8, 150MiB다. 상위 값만 모은 표본이라 전체 분포를 대표하지는 않는다.

| 상한 | compaction 없는 peak | 절반 기준 메모리 | 노드당 세션 | 분포 중 상한 안 | 80% 경고 |
|---|---|---|---|---|---|
| 256MiB | 1146MiB (추정) | 2560MiB | 12 | 10/12 | 204.8MiB |
| 400MiB | 1578MiB (추정) | 3584MiB | 8 | 10/12 | 320MiB |
| **512MiB** | **1970MiB (실측)** | 4096MiB → **4608MiB** | **6** | **11/12** | **409.6MiB** |
| 600MiB | 2178MiB (실측) | 4608MiB | 6 | 12/12 | 480MiB |
| 800MiB | 2785MiB (실측) | 5632MiB | 5 | 12/12 | 640MiB |

- 512MiB는 관측한 12개 중 11개를 담는다. 둘째로 큰 400.1MiB 세션도 경고에 걸리지 않는다. 넘는 것은 591.8MiB 하나다. 이런 세션은 409.6MiB에서 경고를 받고 새 세션으로 옮긴다.
- 400MiB면 400.1MiB 세션의 checkpoint가 바로 거절된다. 256MiB면 217MiB 세션도 경고 구간에 들어간다.
- 공개된 다른 시스템도 활성 기록은 작게 묶는다. Temporal은 event history가 50MB에 닿으면 실행을 끝낸다([defaults](https://docs.temporal.io/self-hosted-guide/defaults)). Inngest는 run state를 32MiB로 묶는다([usage limits](https://www.inngest.com/docs/usage-limits/inngest)). Claude Code의 선택형 `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`는 compaction 뒤 파일이 5MB를 넘으면 그 이전을 지운다([env vars](https://code.claude.com/docs/en/env-vars)). 수백 MiB를 통째로 복원하는 사례는 찾지 못했다(2026-10-21 조사).
- 메모리는 4096MiB가 아니라 4608MiB다. 512MiB의 실측 peak 1970MiB는 4096MiB의 절반(2048)에 78MiB밖에 남지 않는다. 4608MiB면 여유가 334MiB다.

## 노드당 동시 세션 수

worker Pod는 requests와 limits가 같다(Guaranteed QoS). 그래서 노드 하나에 올라가는 worker 수는 다음과 같다.

```
노드당 세션 = floor((노드 allocatable 메모리 − 그 노드의 다른 Pod requests 합) ÷ worker.memoryMb)
```

worker 전용 노드 그룹(`worker.nodeSelector`, `worker.tolerations`)을 쓰면 다른 Pod 몫은 DaemonSet 정도다. 30GiB allocatable 노드에서 DaemonSet 몫을 0으로 보면 다음과 같다.

| `worker.memoryMb` | 노드당 세션 |
|---|---|
| 2048 | 15 |
| **4608 (현재)** | **6** |
| 6144 | 5 |

CPU도 같은 식으로 센다(`worker.cpus`, 기본 1). 보통은 메모리가 먼저 찬다. 세션마다 workspace PVC(`worker.workspace.quotaMb`, 기본 4096MiB)도 하나씩 붙는다. 복원된 transcript(최대 512MiB)는 작업 트리, git objects, restore spool과 함께 이 안에 든다.

local Docker 실행 기반에서는 한 머신의 메모리를 `EXECUTION_SLOT_LIMIT`(기본 10)개 worker가 나눠 쓴다. 한도는 cgroup 상한이지 예약이 아니라서 동시에 다 차지 않으면 넘쳐도 돈다. 그래도 slot 수 × 4608MiB가 머신 메모리를 크게 넘으면 OOM이 난다.

## 조정 방법과 대가

| 방법 | 하는 일 | 얻는 것 | 대가 |
|---|---|---|---|
| ① `worker.memoryMb` 낮추기 | values 값 하나만 바꾼다(`WORKER_MEMORY_MB`, 다음 launch부터 적용) | 노드당 세션이 는다. 예를 들어 3584MiB면 30GiB 노드에 8개다 | compaction 없는 큰 transcript를 resume할 여유가 같이 준다. 절반 기준을 지키려면 상한도 같이 내려야 한다(3584MiB면 상한 약 400MiB, 추정). 상한은 코드 상수라 빌드가 필요하다 |
| ② requests < limits 오버커밋 | chart의 worker Pod requests를 limits보다 작게 둔다 | 작은 세션이 많을 때 노드당 세션이 크게 는다. 실측에서 64~150MiB transcript의 resume peak는 726~839MiB였다 | 지금 chart와 scheduler는 requests = limits로만 Pod를 만든다. 바꾸려면 코드 변경이 필요하다. QoS가 Burstable로 내려가, 큰 세션 몇 개가 동시에 resume하면 노드 메모리 압박으로 OOM kill이나 eviction이 난다 |
| ③ 노드 그룹 키우기 | worker 노드 수나 노드 크기를 늘린다 | 세션당 보장은 그대로 두고 총 세션 수를 늘린다 | 비용이 는다. 코드 변경은 없다 |
| ④ 세션 크기별 Pod 크기 | 복원할 transcript 크기를 보고 scheduler가 Pod 메모리를 고른다 | 작은 세션은 작게, 큰 세션만 크게 띄운다 | **미구현.** scheduler가 launch 전에 checkpoint 크기를 알아야 하고, 실행 중에 같은 Pod 안에서 transcript가 커지는 경우를 따로 다뤄야 한다 |

상한(`MAX_TRANSCRIPT_BYTES`)만 올리고 메모리를 그대로 두는 것은 권하지 않는다. compaction 없는 큰 transcript의 resume이 한도에 닿으면 worker가 재기동을 반복하다 세션이 `recovery_required`가 된다. 상한을 바꿀 때는 이 문서의 방법으로 다시 재고, 위 표를 갱신한다.

## 결과물(`out/`) 색인 상한

worker는 checkpoint마다 작업 디렉터리의 `out/` 아래 일반 파일을 git 상태와 상관없이 색인해 manifest `outputs`에 넣고, 파일마다 객체를 하나 올린다. 상한은 `apps/worker/src/workspace-outputs.ts`의 `DEFAULT_OUTPUT_LIMITS`다.

| 값 | 기본값 | 넘으면 |
|---|---|---|
| 파일 하나 `maxFileBytes` | 64MiB | 그 파일은 `{path, bytes, omitted: "too_large"}`로만 남고 올리지 않는다 |
| checkpoint 하나의 업로드 합계 `maxTotalBytes` | 256MiB | 합계를 넘기게 하는 파일부터 `too_large`가 된다 |
| 파일 수 `maxFiles` | 1,000 | 경로 순으로 1,000개 뒤의 파일은 목록에서 빠진다. publish 로그의 `outputs_dropped`에 개수가 남는다 |

- 색인 상한을 넘어도 checkpoint는 실패하지 않는다. git bundle 상한(256MiB)과 workspace quota는 그대로라서, git이 추적하거나 저장소 없는 세션이 bundle에 싣는 큰 `out/` 파일은 그쪽 상한에 따로 걸린다. git이 무시하지 않는 untracked `out/` 파일도 복원용 untracked 객체로는 그대로 올라간다. 색인에서 `too_large`여도 마찬가지다.
- manifest 상한(객체 20,000개, 8MiB)도 checkpoint를 실패시키지 않는다. 결과물은 복원에 쓰는 객체가 남긴 개수까지만 목록에 들고, 넘는 파일은 `outputs_dropped`로 센다. 목록 때문에 manifest가 8MiB를 넘으면 그 checkpoint는 `outputs` 없이 올라가고, publish 로그 `outputs_refused`에 이유가 남는다.
- 파일은 한 번에 하나씩 메모리에 읽는다. worker 메모리에 더해지는 것은 파일 하나 상한(64MiB)까지다.
- symlink, 일반 파일 아닌 것, `.git`이나 UTF-8이 아닌 이름처럼 manifest가 받지 않는 이름은 목록에 없다. `out` 자체가 symlink면 목록이 빈다.
- 같은 digest는 한 번만 올린다. 직전 checkpoint가 올린 같은 digest는 그 객체를 그대로 가리키고 다시 올리지 않는다.
- 객체는 `sessions/<id>/checkpoints/<revision>/<attempt>/<publish>/outputs/<sha256>`에 있다. control plane이 finalize에서 크기와 digest를 확인하고 version을 hold한다. checkpoint GC는 보존하는 checkpoint가 가리키는 결과물 객체를 지우지 않는다.

## 배포 순서

이 값들을 바꾸는 변경은 control-host와 worker 이미지를 **같은 릴리스로** 올린다. 상한은 worker(capture, restore)와 API(finalize)가 따로 검사한다. 그래서 한쪽만 새 값이면 다음과 같이 된다.

- API만 옛 값(작은 상한): finalize가 큰 checkpoint를 거절하고 `transcript_too_large`를 기록한다. 세션은 위와 같이 새 turn을 받지 않는다. worker 기준으로는 상한 안인 세션도 이렇게 멈출 수 있다.
- worker만 옛 값(작은 상한): 큰 checkpoint의 restore를 거절하고, 작은 상한으로 capture도 거절한다.

상한 초과 reason(`transcript_too_large`, `transcript_part_too_large`)과 `checkpoints.transcript_bytes` 컬럼을 더하는 migration이 든 릴리스는 migration → control-host(api) **모든** 인스턴스 → worker 이미지 순서로 배포한다. 옛 api는 worker가 보낸 새 reason을 400으로 거절하고, 새 worker는 그 보고가 실패하면 capture를 실패시킨다. 롤백은 이 reason을 아는 빌드까지만 한다. 그보다 옛 빌드는 이 reason이 남은 세션을 worker 경로에서 읽다가 예외를 낸다.

manifest `outputs`가 든 릴리스는 control-host(api) **모든** 인스턴스 → worker 이미지 순서로 배포한다. 옛 api의 manifest codec은 모르는 필드를 거절하므로, 새 worker가 `out/`이 있는 세션에서 쓴 checkpoint를 커밋하지 못한다. 롤백은 api와 worker 모두 이 필드를 아는 빌드까지만 한다. 그보다 옛 빌드는 `outputs`가 든 checkpoint를 복원 지점으로 읽지 못한다.

`WORKER_MEMORY_MB`(`worker.memoryMb`)는 다음 launch부터 적용된다. 실행 중인 worker는 교체되지 않는다.

## 관련 문서

- [operations.md § scheduler·worker 컨테이너·egress 설정](../operations.md#schedulerworker-컨테이너egress-설정): `WORKER_MEMORY_MB` 등 환경 변수
- [operations.md § worker workspace의 상한과 회수](../operations.md#worker-workspace의-상한과-회수): workspace quota
- [kubernetes-deployment.md](kubernetes-deployment.md): chart 설치와 업그레이드

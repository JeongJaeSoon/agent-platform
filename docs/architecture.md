# 구성요소와 경계

이 저장소만 받은 사람이 무엇이 어디 있고 서로 무엇을 넘지 않는지 알 수 있게 적는다. 작동 방식과 설정값은 [operations.md](operations.md)에, 개발 명령은 [development.md](development.md)에 있다.

## 한눈에

- **control host**(`apps/control-host`)가 제어 영역이다. 실행물 하나가 api·scheduler·reconciler 세 role을 인자로 받는다. api는 공개 `/v1` API와 worker용 `/internal` Worker Gateway를, scheduler는 세션마다 worker 컨테이너를, reconciler는 lease가 만료된 세션의 회수를 맡는다.
- **worker**(`apps/worker`)는 세션 하나당 컨테이너 하나다. Gateway에서 세션을 claim하고 그 안에서 Claude Agent SDK와 번들된 Claude Code를 돌린다. DB driver와 Docker socket이 없고, object store는 `packages/storage`를 거쳐서만 부른다.
- **egress proxy**(`apps/egress-proxy`)가 worker 네트워크에서 바깥으로 나가는 유일한 길이다. provider key와 저장소·object store 자격 증명은 worker에 가지 않는다([operations.md § provider 키와 저장소 자격 증명](operations.md#provider-키와-저장소-자격-증명은-worker에-가지-않는다-94s-252)).
- 상태는 PostgreSQL(세션·turn·lease·checkpoint pointer)과 S3 호환 object store(transcript·workspace bundle·checkpoint manifest)에 있다. 저장소 원본은 Gitea(로컬)나 카탈로그에 등록한 git 서버다.

## 저장소 구성

| 경로 | 구현된 기반 |
|---|---|
| `packages/contracts` | Zod 계약을 `api`(공개 REST·SSE)·`worker-protocol`(Gateway DTO)·`shared`(ID·error)로 분리. `docs/openapi.json`은 `bun run --cwd packages/contracts openapi:generate`로 생성하며 테스트가 drift를 검출. 이 파일이 유일한 정본이고 API는 이를 서빙하지 않는다(`/openapi.json`은 404) |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/storage` | S3 transcript와 git 저장·복원 primitive |
| `packages/observability` | 구조화 로깅·메트릭·트레이싱 기반 |
| `packages/platform` | 저장소·실행 backend를 port로만 아는 도메인 층. `SessionService`(접수·조회·권한), `WorkerGateway`(epoch/lease fencing), `runScheduler`(슬롯·launch intent·orphan 회수), `CheckpointService`(manifest·pointer CAS·복원 계획), catalog·policy |
| `apps/control-host` | 제어 영역 배포 단위(94S-117). 실행물 하나(`src/main.ts <api\|scheduler\|reconciler>`)가 role을 인자로 받고 기본값은 없다. `src/api`는 Hono `/v1`·`/internal`(Worker Gateway)·API 키·키 발급 CLI, `src/scheduler`는 launch intent를 커밋하고 LocalDockerBackend로 worker 컨테이너를 보장하는 pass, `src/reconciler`는 만료된 lease를 회수하는 pass다. Docker backend는 scheduler role만 로드한다 |
| `packages/runtime-core` | 엔진 중립 실행 계약(`AgentRuntime.start(config, hooks)`, `AgentRun`, `RuntimeCapabilities`, checkpoint 준비 결과). `mode: "new" | "resume"`를 config가 들고 다니며 별도 open 진입점이 없다 |
| `packages/adapters/runtimes/claude` | Claude Agent SDK 0.3.270 adapter(`ClaudeSdkRuntime`·`ClaudeSdkRun`), 승인 profile·최소 환경, native envelope·SSE projection, 제어 가능한 fake |
| `packages/adapters/runtimes/claude-codec` | Claude checkpoint manifest codec(`claudeCheckpointCodec`)·transcript digest·pin된 SDK/CLI 버전 상수. SDK 의존이 없어 api 이미지가 읽을 수 있다(94S-201). `runtime-claude`는 이를 재수출한다 |
| `apps/worker` | worker 컨테이너의 진입점(`src/main.ts`). scheduler가 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프(Gateway claim → Claude adapter 실행 → 이벤트 발행 → pending 등록 → checkpoint publish·restore)를 돈다(94S-122·246). SDK·DB driver·cloud SDK를 직접 의존하지 않는다(`tests/architecture.test.ts`가 검사) |
| `packages/adapters/execution/local-docker` | `ExecutionBackend` port의 Docker Engine API 구현. 컨테이너 이름·label로 launch intent와 1:1, non-root·read-only rootfs·세션 전용 volume·자원 상한·전용 internal 네트워크 |
| `apps/egress-proxy` | worker 네트워크에서 유일하게 바깥으로 나가는 forward proxy. CONNECT·absolute-form HTTP만 받고 목적지 allowlist를 DNS 해석 결과의 IP 대역까지 검사한다. workspace 의존이 없어 `apps/egress-proxy/Dockerfile`이 install 없이 자기 `src`만 복사한 이미지로 기동한다(94S-323) |
| `packages/testkit` | 테스트 fixture(`fake-anthropic`·`postgres`·`localstack`·`workspace`). 각 패키지가 devDependency로만 참조한다 |
| `packages/ui` | 웹 콘솔 화면이 공유하는 표현 계층. 서버가 준 상태를 그리기만 한다([packages/ui/README.md](../packages/ui/README.md)) |
| `infra/compose.core.yml` | 모든 설치가 같이 쓰는 제품 서비스: Postgres·Gitea, one-shot migration, egress proxy(worker 네트워크는 scheduler가 execution마다 만든다). `apps` profile은 control-host 이미지 하나로 api·scheduler(루프)·reconciler(루프) role을 띄우고(Docker socket은 scheduler에만) worker 이미지를 smoke한다. 보안 설정은 이 파일에만 있다(94S-430) |
| `infra/docker-compose.yml` (+ 루트 `compose.yaml`) | 로컬 스택: core 위에 `infra/compose.local.yml`(LocalStack S3·Secrets Manager, fake Messages API, 샘플 저장소 생성, 앱 이미지 빌드)을 합친다. 루트 `compose.yaml`이 이 파일을 include하므로 루트에서 `docker compose`를 그대로 쓴다. test-ops는 core 위에 `infra/compose.test-ops.yml`과 object store layer(기본 LocalStack, 또는 AWS S3)를 얹고 `scripts/test-ops.sh`로 운영한다([test-ops.md](test-ops.md)) |
| `apps/*/Dockerfile` | control-host(api·scheduler·reconciler role)·worker·egress-proxy 이미지. base는 `oven/bun:1.3.10` digest pin, `bun install --frozen-lockfile --production` multi-stage(egress-proxy는 install 없는 한 단계). `.github/workflows/images.yml`이 빌드·smoke·digest artifact, tag push만 ghcr push |

## 경계

`tests/architecture.test.ts`가 아래 규칙을 import와 package 의존성으로 검사한다. 규칙을 바꾸려면 그 테스트를 먼저 고친다.

- `@anthropic-ai/claude-agent-sdk`는 Claude adapter의 `runtime`·`run` 모듈만 import한다. 그 dependency를 선언하는 패키지도 adapter 하나다.
- `packages/runtime-core`는 `packages/contracts`에만 의존한다. `packages/platform`은 contracts·runtime-core·zod에만 의존하고, driver·ORM·SDK를 import하지 않는다.
- Claude adapter는 platform·db·storage에 닿지 않는다. Docker backend는 platform·contracts에만 의존하고 db·pg·Docker SDK에 닿지 않는다.
- 앱끼리는 import하지 않는다. control host는 실행물 하나에 role 셋이고, Docker backend에 닿는 것은 scheduler role뿐이다. worker 컨테이너에는 Docker socket도 host bind mount도 없다.
- worker는 runtime-core·Claude adapter·contracts·storage·observability만 import하고, storage는 worker의 object store 모듈 하나만 import한다.
- `packages/testkit`은 devDependency로만 쓰고 runtime 코드가 import하지 않는다. 패키지 밖으로 나가는 상대 경로 import는 없다.

## checkpoint 경로

immutable checkpoint manifest와 authoritative pointer는 `packages/platform`의 `CheckpointService`가 담당하고, `apps/control-host`의 api role이 이를 S3 object store·Postgres `CheckpointStore`·git bundle verifier로 조립해 Worker Gateway에 붙인다(94S-201). Gateway의 finalize는 manifest ref가 `requestCheckpoint`가 발급한 `sessions/<sid>/checkpoints/<rev>/<attempt>/<publishId>/manifest.json`이고 본문 digest·bundle이 검증된 checkpoint만 받으며, pointer는 `finalizeAtomic`(turn 있는 경로)과 `CheckpointStore.commitAtomic`(turn 없는 경로, 94S-137)이 같은 SQL helper로 "정확히 current+1"만 전진시킨다. 워커용 `/internal/worker/checkpoint-request`·`/restore-plan`은 lease fence 안에서 읽은 pointer로 답한다. 워커 heartbeat의 `transcript` 보고는 세션의 `last_transcript_persisted_at`과 `checkpoint_pending_reason`이 되고, `mirror_error`가 기록된 세션은 새 입력과 checkpoint 없는 completed 종료를 409 `CHECKPOINT_UNAVAILABLE`로 거절한다 — 같은 attempt의 checkpoint는 이를 지우지 못하고 **다른** attempt가 커밋한 checkpoint만 지운다(복구 결정은 94S-140). completed turn에 checkpoint를 강제하지는 않는다: 세션 상세의 `durability`가 `last_completed_turn_id`와 `last_checkpointed_turn_id`의 차이로 드러낸다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

checkpoint 객체의 version 고정과 복원 뒤 재고정은 [backup-restore.md](backup-restore.md)에, GC와 복원이 계속 실패하는 세션의 처리는 [operations.md](operations.md)에 있다.

## SDK와 LiteLLM 방향

`@anthropic-ai/claude-agent-sdk`는 `packages/adapters/runtimes/claude/src/{runtime,run}.ts` 안에서만 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. profile의 endpoint·model 설정은 [operations.md § 운영자 카탈로그](operations.md#운영자-카탈로그-agent-profile--repository)에 있다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 94S-91 transport gate는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 제품 경로(빌드한 이미지의 worker·scheduler·API)는 `tests/e2e`가 확인한다. 각 명령은 [development.md](development.md)에 있다.

## 설계 이력과 추가 참고

저장소는 `claude-session-platform`에서 `agent-platform`으로 이름을 바꿨다. 내부 package scope는 `@agent-platform/*`이다. 이 문서는 저장소의 현재 구현을 따라간다. 아래는 저장소 밖의 추가 참고이고, 이 문서를 읽는 데 필요하지 않다.

- 통합 설계 정본: Obsidian `Private/Project/agent-platform`의 `final-design.md`·`module-design.md`·`api.md`·`deployment.md`·`delivery-plan.md`(비공개). rename 이전 설계서(`DESIGN.md`)는 지금의 계약·티켓 번호와 맞지 않아 저장소에서 지웠다(94S-433).
- 작업 순서·상태·인수 조건: [Linear P-94S-5](https://linear.app/94soon/project/agent-platform-9c503b0fad62)의 D0~D4 티켓(94S-108~147)과 native blocked-by 관계. [옛 프로젝트](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)(94S-7~94)는 rename 이전 이력이다.
- 완료된 SDK gate: [94S-91](https://linear.app/94soon/issue/94S-91), 저장 backend 선택: [94S-92](https://linear.app/94soon/issue/94S-92). process-level 조사 harness와 검증 범위는 [`spikes/94s-91`](../spikes/94s-91/README.md), [`spikes/94s-92`](../spikes/94s-92/README.md)에 둔다.
- 인터페이스·협업 트랙(웹 콘솔·Dispatch·Slack·기억·루틴): 설계 정본은 Obsidian `Private/Project/agent-platform/interface/00~06`, 티켓은 [Linear P-94S-6](https://linear.app/94soon/project/agent-platform-interface-and-collaboration-933c7892a8a4)(94S-148~195), 조사 초안과 Codex 리뷰 원문은 [`docs/references`](references/README.md)에 둔다. alpha D0~D4 실행 계층은 바꾸지 않고 그 위에 올린다.

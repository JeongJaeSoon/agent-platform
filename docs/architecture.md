# 구성요소와 경계

이 저장소만 받은 사람이 무엇이 어디 있고 서로 무엇을 넘지 않는지 알 수 있게 적는다. 작동 방식과 설정값은 [operations.md](operations.md)에, 개발 명령은 [development.md](development.md)에 있다.

## 한눈에

이 저장소에서 동작하는 코드의 중심은 Werft의 Kiel 모듈(세션 런타임)이다. 모듈 구성과 개발 순서는 [README](../README.md)의 이름 범위 문단이 정본이다. 아래 control host·worker·egress proxy와 공개 `/v1` API의 세션 경로가 Kiel에 속한다. 다른 모듈의 코드도 일부 먼저 들어와 있다. Musterrolle 쪽은 이미 동작한다. 웹 콘솔 로그인과 첫 owner bootstrap(`/v1/auth/*`), API 키, 권한 판정이 control host 안에서 Kiel과 함께 돈다. 계약과 policy는 이미 `musterrolle` 디렉터리에 있고, control host에 있는 route와 저장소 구현은 Musterrolle 모듈로 옮겨 갈 대상이다. Kollegium 쪽은 쓰는 앱이 없는 선행 코드다(`packages/contracts`의 `kollegium`: 에이전트 정의·채널 연결·chat envelope 계약). 웹 콘솔 화면 부품 `packages/ui`도 쓰는 앱이 아직 없다. `packages/contracts`의 `domain`은 소속 모듈이 정해지지 않았다. 그 가운데 기억 계약은 쓰는 곳이 없는 선행 코드이고, digest의 비용 형식은 `/v1` 사용량 응답이 쓴다.

- **control host**(`apps/control-host`)가 세션 런타임의 제어 영역이다. 실행물 하나가 api·scheduler·reconciler 세 role을 인자로 받는다. api는 공개 `/v1` API(Musterrolle의 `/v1/auth/*` 포함)와 worker용 `/internal` Worker Gateway를, scheduler는 세션마다 worker 컨테이너를, reconciler는 lease가 만료된 세션의 회수를 맡는다.
- **worker**(`apps/worker`)는 세션 하나당 컨테이너 하나다. Gateway에서 세션을 claim하고 그 안에서 Claude Agent SDK와 번들된 Claude Code를 돌린다. DB driver와 Docker socket이 없고, object store는 `packages/storage`를 거쳐서만 부른다.
- **egress proxy**(`apps/egress-proxy`)가 worker 네트워크에서 바깥으로 나가는 유일한 길이다. provider key와 저장소·object store 자격 증명은 worker에 가지 않는다([operations.md § provider 키와 저장소 자격 증명](operations.md#provider-키와-저장소-자격-증명은-worker에-가지-않는다-94s-252)).
- 상태는 PostgreSQL(세션·turn·lease·checkpoint pointer)과 S3 호환 object store(transcript·workspace bundle·checkpoint manifest)에 있다. 저장소 원본은 Gitea(로컬)나 카탈로그에 등록한 git 서버다.

## 저장소 구성

최상위 디렉터리는 다음과 같다. 테스트와 스크립트를 어디에 두는지는 [development.md § 테스트·스크립트 배치](development.md#테스트스크립트-배치)에 있다.

| 경로 | 무엇이 있는가 |
|---|---|
| `apps` | 배포 단위 셋(control-host·worker·egress-proxy). 앱마다 `Dockerfile`이 있고 이미지 하나가 된다. 앱끼리는 import하지 않는다 |
| `packages` | 앱이 조립하는 workspace 라이브러리. 아래 표에 패키지마다 한 줄씩 있다 |
| `spikes` | workspace 밖의 독립 설치 단위. [`spikes/94s-91`](../spikes/94s-91/README.md)은 SDK·LiteLLM 버전을 올릴 때 돌리는 호환 harness다. 실제 LiteLLM proxy를 거친 SDK 왕복은 여기서만 확인한다. `spikes/94s-92`는 저장 backend 선택(94S-92)의 harness다. CI `spikes` job은 main push와 수동 실행에서만 돌고 run을 막지 않는다([ci.md](ci.md)) |
| `tests` | 패키지 하나로 닫히지 않는 테스트: 여러 앱·패키지를 엮는 흐름, 저장소·CI·`scripts`를 검사하는 테스트, 스택 전체 harness(`tests/e2e`, `tests/d2-gate`), `scripts/soak` 판정 함수의 단위 테스트(`tests/soak`) |
| `scripts` | 운영자와 개발자가 직접 실행하는 도구: 백업·복원(`backup.sh`·`restore.sh`·`verify-restore.sh`), 로컬 스택(`local.sh`), test-ops(`test-ops.sh`), gate와 과거 soak 실행기(`scripts/d2-gate`·`scripts/soak`), 공용 구현(`scripts/lib`), 개발용 fixture(`scripts/dev`), `THIRD_PARTY_NOTICES.md` 생성기(`third-party-notices.ts`), 수동 재현기(`scripts/bun-http-stall`) |
| `.github` | CI 전용. workflow(`workflows`), composite action(`actions/bun-setup`), workflow만 부르는 helper(`.github/scripts`). 운영자가 부르는 도구는 여기가 아니라 `scripts`에 둔다 |
| `infra` | compose layer(`compose.core.yml`·`compose.local.yml`·`compose.test-ops*.yml`·`compose.real-model.yml`·`compose.fake-model.yml`·`compose.datadog.yml`)와 진입 파일 `docker-compose.yml`, 복원용 layer `docker-compose.restore.yml`, 컨테이너 초기화 스크립트(`infra/gitea`·`infra/localstack`), Datadog 설정(`infra/datadog`) |
| `config` | API가 읽는 로컬 기본 카탈로그(`profiles.yaml`·`repositories.yaml`). 실제 Messages API를 실행자의 `ANTHROPIC_API_KEY`로 부른다. compose가 `/app/config`로 mount한다. `config/fake-model`은 compose `fake-messages`를 부르는 카탈로그로, `--fake-model` overlay(`infra/compose.fake-model.yml`)를 얹은 실행(quickstart, 무료 e2e·복원 확인)이 쓴다 |
| `docs` | 사용자·운영·개발 문서, 생성된 `openapi.json`, API가 `/docs`로 서빙하는 참조 페이지(`docs/api`) |

### 패키지와 앱

| 경로 | 구현된 기반 |
|---|---|
| `packages/contracts` | 재사용 가능한 Zod payload 계약을 `api`(공개 REST·SSE)·`worker-protocol`(Gateway DTO)·`musterrolle`(auth·authorization·workspace)·`kollegium`(agent 정의, 채널 연결 surface, chat 표면 envelope 선행 계약)·`domain`(소속 미정인 기억·digest 계약)·`shared`(ID·error·canonical JSON·숫자 설정 parser)로 분리한다. HTTP method·path·인증·scope 같은 transport 메타데이터는 실행 어댑터인 `apps/control-host`가 소유한다 |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/storage` | content-addressed checkpoint object store, 요청·body 읽기에 상한을 건 S3 client, worker가 egress proxy의 object route로 쓰는 client, scope 밖 key를 막는 object store, 자원 상한을 건 git 실행기, git workspace bundle 검증 |
| `packages/observability` | 구조화 로거(`createLogger`, `LOG_LEVEL`)와 로그 redaction 규칙. 메트릭과 트레이싱은 없다 |
| `packages/system` | 업무 의미가 없는 Bun·OS 도구: 캐시 없이 매번 묻는 DNS 조회(`lookupEveryTime`), 자원 상한을 건 git 실행(`gitCommand`)·process group 종료. db·storage·worker가 쓰고, 이 패키지는 아무것에도 의존하지 않는다(94S-403) |
| `packages/platform` | 저장소·실행 backend를 port로만 아는 도메인 층. `SessionService`(접수·조회·권한), `WorkerGateway`(epoch/lease fencing), `runScheduler`(슬롯·launch intent·orphan 회수), `CheckpointService`(manifest·pointer CAS·복원 계획), catalog. 권한 policy는 `src/musterrolle`에 있다 |
| `apps/control-host` | 세션 런타임의 제어 영역 배포 단위(94S-117). 실행물 하나(`src/main.ts <api\|scheduler\|reconciler>`)가 role을 인자로 받고 기본값은 없다. `src/api`는 `@hono/zod-openapi` route 선언에서 `/v1` handler와 OpenAPI를 함께 등록하고, `/internal` Worker Gateway·API 키·키 발급 CLI도 제공한다. `bun run --cwd apps/control-host openapi:generate`가 `docs/openapi.json`과 로컬 Scalar HTML을 함께 만들며 API는 인증 전 `GET /v1/openapi.json`과 읽기 전용 `GET /docs`를 제공한다. `/docs/scalar.js`는 외부 CDN 없이 같은 origin에서 서빙하고 두 문서 UI 경로는 OpenAPI operation에 넣지 않는다. `src/scheduler`는 launch intent를 커밋하고 LocalDockerBackend로 worker 컨테이너를 보장하는 pass, `src/reconciler`는 만료된 lease를 회수하는 pass다. Docker backend는 scheduler role만 로드한다 |
| `packages/runtime-core` | 엔진 중립 실행 계약(`AgentRuntime.start(config, hooks)`, `AgentRun`, `RuntimeCapabilities`, checkpoint 준비 결과). `mode: "new" | "resume"`를 config가 들고 다니며 별도 open 진입점이 없다. worker와 control plane이 함께 지키는 checkpoint 상한(manifest 크기·object 수, bundle 크기·사슬 길이)도 여기 한 곳에서 export한다. worker가 쓰는 port(`WorkerGatewayClient`, workspace 준비 계획)도 여기 있다(94S-340) |
| `packages/adapters/runtimes/claude` | Claude Agent SDK 0.3.270 adapter(`ClaudeSdkRuntime`·`ClaudeSdkRun`), 승인 profile·최소 환경, native envelope·SSE projection, 제어 가능한 fake |
| `packages/adapters/runtimes/claude-codec` | Claude checkpoint manifest codec(`claudeCheckpointCodec`)·transcript digest·pin된 SDK/CLI 버전 상수. SDK 의존이 없어 api 이미지와 운영 스크립트(`scripts/lib`)가 읽는다(94S-201). `runtime-claude`는 worker와 테스트가 쓰는 codec·버전 상수만 이름으로 재수출한다 |
| `apps/worker` | worker 컨테이너의 진입점(`src/main.ts`). scheduler가 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프(Gateway claim → Claude adapter 실행 → 이벤트 발행 → pending 등록 → checkpoint publish·restore)를 돈다(94S-122·246). SDK·DB driver·cloud SDK를 직접 의존하지 않는다(`tests/architecture.test.ts`가 검사) |
| `packages/adapters/execution/local-docker` | `ExecutionBackend` port의 Docker Engine API 구현. 컨테이너 이름·label로 launch intent와 1:1, non-root·read-only rootfs·세션 전용 volume·자원 상한·전용 internal 네트워크 |
| `apps/egress-proxy` | worker 네트워크에서 유일하게 바깥으로 나가는 forward proxy. CONNECT·absolute-form HTTP만 받고 목적지 allowlist를 DNS 해석 결과의 IP 대역까지 검사한다. workspace 의존이 없어 `apps/egress-proxy/Dockerfile`이 install 없이 자기 `src`만 복사한 이미지로 기동한다(94S-323) |
| `packages/testkit` | 테스트 fixture: fake Messages API(`fake-anthropic`·`scripted-messages`), PostgreSQL·LocalStack opt-in 헬퍼(`postgres`·`localstack`), 격리 workspace(`workspace`), 메모리 checkpoint object store(`checkpoint-objects`), git bundle·HTTP 저장소 헬퍼(`git-bundle`·`git-http`). 각 패키지가 devDependency로만 참조한다. `fake-messages-main.ts`는 로컬 compose의 `fake-messages` 서비스가 실행하는 진입점이다 |
| `packages/ui` | 웹 콘솔 화면이 공유하는 표현 계층. 서버가 준 상태를 그리기만 한다([packages/ui/README.md](../packages/ui/README.md)) |
| `infra/compose.core.yml` | 모든 설치가 같이 쓰는 제품 서비스: Postgres·Gitea, one-shot migration, egress proxy(worker 네트워크는 scheduler가 execution마다 만든다). `apps` profile은 control-host 이미지 하나로 api·scheduler(루프)·reconciler(루프) role을 띄우고(Docker socket은 scheduler에만) worker 이미지를 smoke한다. 보안 설정은 이 파일에만 있다(94S-430) |
| `infra/docker-compose.yml` (+ 루트 `compose.yaml`) | 로컬 스택: core 위에 `infra/compose.local.yml`(LocalStack S3, 샘플 저장소 생성, 앱 이미지 빌드, `fake-model` profile 뒤의 fake Messages API와 API 전용 Secrets Manager `secrets`)을 합친다. 기본은 실제 Messages API이고, `infra/compose.fake-model.yml`을 얹으면 fake Messages API·`secrets`와 `config/fake-model`로 돈다. 루트 `compose.yaml`이 이 파일을 include하므로 루트에서 `docker compose`를 그대로 쓴다. test-ops는 core 위에 `infra/compose.test-ops.yml`과 object store layer(기본 LocalStack, 또는 AWS S3)를 얹고 `scripts/test-ops.sh`로 운영한다([test-ops.md](test-ops.md)) |
| `apps/*/Dockerfile` | control-host(api·scheduler·reconciler role)·worker·egress-proxy 이미지. base는 `oven/bun:1.3.14` digest pin, `bun install --frozen-lockfile --production` multi-stage(egress-proxy는 install 없는 한 단계). `.github/workflows/images.yml`이 빌드·smoke·digest artifact, tag push만 ghcr push |

## 경계

`tests/architecture.test.ts`가 아래 규칙을 import와 package 의존성으로 검사한다. 규칙을 바꾸려면 그 테스트를 먼저 고친다.

- `@anthropic-ai/claude-agent-sdk`는 Claude adapter의 `runtime`·`run` 모듈만 import한다. 그 dependency를 선언하는 패키지도 adapter 하나다.
- `packages/runtime-core`는 `packages/contracts`에만 의존한다. `packages/platform`은 contracts·runtime-core·zod에만 의존하고, driver·ORM·SDK를 import하지 않는다.
- Claude adapter는 platform·db·storage에 닿지 않는다. Docker backend는 platform·contracts에만 의존하고 db·pg·Docker SDK에 닿지 않는다.
- 앱끼리는 import하지 않는다. control host는 실행물 하나에 role 셋이고, Docker backend에 닿는 것은 scheduler role뿐이다. worker 컨테이너에는 Docker socket도 host bind mount도 없다.
- worker는 runtime-core·Claude adapter·contracts·storage·system·observability만 import하고, storage는 worker의 object store 모듈 하나만 import한다.
- DNS 조회와 git 실행 도구는 `packages/system`에 있고 runtime-core에는 없다. checkpoint 상한은 worker와 platform이 따로 선언하지 않고 runtime-core에서 가져온다.
- Claude adapter의 진입점은 export할 심볼을 이름으로 적는다(`export *` 없음). `scripts/lib`는 codec을 `runtime-claude-codec`에서 가져온다.
- `/v1` route는 DB-backed 오류와 row를 platform port(`InvalidCursorError`, `IdentityStore`)로만 알고, db 구현을 직접 import하지 않는다.
- `packages/testkit`은 devDependency로만 쓰고 runtime 코드가 import하지 않는다. 패키지 밖으로 나가는 상대 경로 import는 없다.

## checkpoint 경로

immutable checkpoint manifest와 authoritative pointer는 `packages/platform`의 `CheckpointService`가 담당하고, `apps/control-host`의 api role이 이를 S3 object store·Postgres `CheckpointStore`·git bundle verifier로 조립해 Worker Gateway에 붙인다(94S-201). Gateway의 finalize는 manifest ref가 `requestCheckpoint`가 발급한 `sessions/<sid>/checkpoints/<rev>/<attempt>/<publishId>/manifest.json`이고 본문 digest·bundle이 검증된 checkpoint만 받으며, pointer는 `finalizeAtomic`(turn 있는 경로)과 `CheckpointStore.commitAtomic`(turn 없는 경로, 94S-137)이 같은 SQL helper로 "정확히 current+1"만 전진시킨다. 워커용 `/internal/worker/checkpoint-request`·`/restore-plan`은 lease fence 안에서 읽은 pointer로 답한다. 워커는 turn 경계에 engine process tree의 descendant나 reparent 뒤에도 workspace 안을 cwd로 둔 process가 남아 있으면 `background_writer`로 checkpoint를 거절한다. 또한 경로·형태·크기·mtime·ctime으로 만든 workspace 지문을 capture 전후에 비교하고, 바뀌었으면 전체 capture를 한 번 다시 시도한 뒤 다시 바뀌면 publish를 거절한다(94S-481). 워커 heartbeat의 `transcript` 보고는 세션의 `last_transcript_persisted_at`과 `checkpoint_pending_reason`이 되고, `mirror_error`가 기록된 세션은 새 입력과 checkpoint 없는 completed 종료를 409 `CHECKPOINT_UNAVAILABLE`로 거절한다 — 같은 attempt의 checkpoint는 이를 지우지 못하고 **다른** attempt가 커밋한 checkpoint만 지운다(복구 결정은 94S-140). 롤백한 빌드가 모르는 reason(새 빌드가 남긴 값)은 세션 상세에 `unknown`으로 보이고 경고 로그를 남기며, 새 입력은 `mirror_error`처럼 거절한다(94S-396). completed turn에 checkpoint를 강제하지는 않는다: 세션 상세의 `durability`가 `last_completed_turn_id`와 `last_checkpointed_turn_id`의 차이로 드러낸다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

checkpoint 객체의 version 고정과 복원 뒤 재고정은 [backup-restore.md](backup-restore.md)에, GC와 복원이 계속 실패하는 세션의 처리는 [operations.md](operations.md)에 있다.

## SDK와 LiteLLM 방향

`@anthropic-ai/claude-agent-sdk`는 `packages/adapters/runtimes/claude/src/{runtime,run}.ts` 안에서만 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. profile의 endpoint·model 설정은 [operations.md § 운영자 카탈로그](operations.md#운영자-카탈로그-agent-profile--repository)에 있다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 94S-91 transport gate는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 제품 경로(빌드한 이미지의 worker·scheduler·API)는 `tests/e2e`가 확인한다. 각 명령은 [development.md](development.md)에 있다.

## 설계 이력과 추가 참고

저장소는 `claude-session-platform`에서 `agent-platform`으로 이름을 바꿨다. 내부 package scope는 `@agent-platform/*`이다. 이 문서는 저장소의 현재 구현을 따라간다. 아래는 저장소 밖의 추가 참고이고, 이 문서를 읽는 데 필요하지 않다.

- 통합 설계 정본: Obsidian `Private/Project/agent-platform`의 `final-design.md`·`module-design.md`·`api.md`·`deployment.md`·`delivery-plan.md`(비공개). rename 이전 설계서(`DESIGN.md`)는 지금의 계약·티켓 번호와 맞지 않아 저장소에서 지웠다(94S-433).
- 작업 순서·상태·인수 조건: [Linear P-94S-5](https://linear.app/94soon/project/agent-platform-9c503b0fad62)의 D0~D4 티켓(94S-108~147)과 native blocked-by 관계. [옛 프로젝트](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)(94S-7~94)는 rename 이전 이력이다.
- 완료된 SDK gate: [94S-91](https://linear.app/94soon/issue/94S-91), 저장 backend 선택: [94S-92](https://linear.app/94soon/issue/94S-92). process-level 조사 harness와 검증 범위는 [`spikes/94s-91`](../spikes/94s-91/README.md), [`spikes/94s-92`](../spikes/94s-92/README.md)에 둔다.
- 인터페이스·협업 트랙(웹 콘솔·Dispatch·Slack·기억·루틴): 설계 정본은 Obsidian `Private/Project/agent-platform/interface/00~06`, 티켓은 [Linear P-94S-6](https://linear.app/94soon/project/agent-platform-interface-and-collaboration-933c7892a8a4)(94S-148~195)다. 작성 시점 코드에 묶인 조사 초안과 리뷰 원문은 저장소에서 제거했다. alpha D0~D4의 Kiel 실행 경로는 바꾸지 않고 그 위에 올린다.

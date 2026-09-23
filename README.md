# Agent Platform (코드명 Kollegium) — 세션 컨트롤 플레인

공식 TypeScript Claude Agent SDK로 에이전트 세션을 실행하고, 그 세션을 HTTP API·이벤트 스트림·권한 요청·제어(interrupt·pause·resume·terminate·복구)·checkpoint 복원으로 다루게 하는 플랫폼이다. 세션마다 격리된 worker 컨테이너에서 Claude Code가 돈다.

> 저장소는 `claude-session-platform`에서 `agent-platform`으로 이름을 바꿨다. package scope는 `@agent-platform/*`이다. 설계 정본은 Obsidian `Private/Project/agent-platform`이고, 작업 순서와 인수 조건은 [Linear P-94S-5](https://linear.app/94soon/project/agent-platform-9c503b0fad62)(D0~D4, 94S-108~)에 있다. [docs/DESIGN.md](docs/DESIGN.md)는 rename 이전 설계의 보관본이다.

## 빠른 시작

Docker Engine 28 이상, Docker Compose v2, Bun이 있으면 저장소 루트에서 명령 두 개로 API가 뜬다. 모델 계정은 필요 없다 — 예시 카탈로그는 compose의 fake Messages API를 쓴다.

```bash
docker compose --profile apps up -d --build
bun run keys create quickstart \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover
```

그다음 curl로 세션 한 바퀴(생성 → 이벤트 → 권한 요청 응답 → 후속 메시지 → interrupt → pause → resume → terminate → 복구 결정 → resume)를 도는 절차는 **[docs/quickstart.md](docs/quickstart.md)**에 있다. CI가 그 문서의 명령을 새 clone에서 그대로 실행하고(`quickstart` job), 같은 시나리오를 `tests/e2e`로 돈다(`e2e` job).

**private alpha는 신뢰된 내부 인원 한정이다.** worker 안에서 실행되는 코드는 공유 provider key·저장소 credential([94S-252](https://linear.app/94soon/issue/94S-252))과 bucket 전체 credential([94S-251](https://linear.app/94soon/issue/94S-251))에 닿을 수 있다. 외부 공개 전에 252·251·253을 닫는다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | 로컬 스택 기동, key 발급, curl 9단계, 워커 로그, 문제 해결 |
| [docs/operations.md](docs/operations.md) | reconciler·scheduler, worker 격리·egress·네트워크, workspace 상한·회수, 카탈로그, 인증, 설치 상한, 이미지·compose |
| [docs/backup-restore.md](docs/backup-restore.md) | 설치 백업·새 project로 복원·검증 |
| [docs/ci.md](docs/ci.md) | CI job별 실행 내용, required check, 수동 실행 |
| [docs/openapi.json](docs/openapi.json) | 공개 `/v1` API 계약(`packages/contracts`에서 생성) |
| [`spikes/94s-91`](spikes/94s-91/README.md), [`spikes/94s-92`](spikes/94s-92/README.md) | SDK gate·저장 backend 조사 harness |
| [docs/references](docs/references/README.md) | 인터페이스·협업 트랙(웹 콘솔·Dispatch·Slack 등, [P-94S-6](https://linear.app/94soon/project/agent-platform-interface-and-collaboration-933c7892a8a4)) 조사 초안 |

## 저장소 구성

| 경로 | 구현된 기반 |
|---|---|
| `packages/contracts` | Zod 계약을 `api`(공개 REST·SSE)·`worker-protocol`(Gateway DTO)·`shared`(ID·error)로 분리. `docs/openapi.json`은 `bun run --cwd packages/contracts openapi:generate`로 생성하며 테스트가 drift를 검출 |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/queue` | PostgreSQL durable queue·이벤트·lease, Redis placeholder |
| `packages/storage` | S3 transcript와 git 저장·복원 primitive |
| `packages/observability` | 구조화 로깅·메트릭·트레이싱 기반 |
| `packages/platform` | 저장소·실행 backend를 port로만 아는 도메인 층. `SessionService`(접수·조회·권한), `WorkerGateway`(epoch/lease fencing), `runScheduler`(슬롯·launch intent·orphan 회수), `CheckpointService`(manifest·pointer CAS·복원 계획), catalog·policy |
| `apps/api` | Hono `/v1` 골격, API 키 인증, strict zod 검증·에러 응답, 키 발급 CLI. `/internal`에 Worker Gateway 라우트를 얹는다 |
| `packages/runtime-core` | 엔진 중립 실행 계약(`AgentRuntime.start(config, hooks)`, `AgentRun`, `RuntimeCapabilities`, checkpoint 준비 결과). `mode: "new" | "resume"`를 config가 들고 다니며 별도 open 진입점이 없다 |
| `packages/adapters/runtimes/claude` | Claude Agent SDK 0.3.270 adapter(`ClaudeSdkRuntime`·`ClaudeSdkRun`), 승인 profile·최소 환경, native envelope·SSE projection, 제어 가능한 fake |
| `packages/adapters/runtimes/claude-codec` | Claude checkpoint manifest codec(`claudeCheckpointCodec`)·transcript digest·pin된 SDK/CLI 버전 상수. SDK 의존이 없어 api 이미지가 읽을 수 있다(94S-201). `runtime-claude`는 이를 재수출한다 |
| `apps/worker` | worker 컨테이너의 진입점(`src/main.ts`). scheduler가 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프(Gateway claim → Claude adapter 실행 → 이벤트 발행 → pending 등록 → checkpoint publish·restore)를 돈다(94S-122·246). SDK·DB driver·cloud SDK를 직접 의존하지 않는다(`tests/architecture.test.ts`가 검사) |
| `apps/reconciler` | 만료된 worker lease를 한 번 스캔해 원래 queue row를 release하고 세션을 재신호하는 one-shot 프로세스 |
| `apps/scheduler` | eligible unassigned session 수요를 보고 `executions` launch intent를 커밋한 뒤 LocalDockerBackend로 worker 컨테이너를 보장하는 one-shot 프로세스 (94S-117 전까지의 control host 자리) |
| `packages/adapters/execution/local-docker` | `ExecutionBackend` port의 Docker Engine API 구현. 컨테이너 이름·label로 launch intent와 1:1, non-root·read-only rootfs·세션 전용 volume·자원 상한·전용 internal 네트워크 |
| `apps/egress-proxy` | worker 네트워크에서 유일하게 바깥으로 나가는 forward proxy. CONNECT·absolute-form HTTP만 받고 목적지 allowlist를 DNS 해석 결과의 IP 대역까지 검사한다. workspace 의존이 없어 `apps/egress-proxy/Dockerfile`이 install 없이 자기 `src`만 복사한 이미지로 기동한다(94S-323) |
| `infra/docker-compose.yml` (+ 루트 `compose.yaml`) | Postgres·LocalStack·Gitea와 one-shot migration·샘플 저장소 생성, fake Messages API, egress proxy(worker 네트워크는 scheduler가 execution마다 만든다). `apps` profile은 `apps/*/Dockerfile`로 빌드한 api·scheduler(루프)를 띄우고 scheduler가 띄울 worker 이미지도 빌드한다. 루트 `compose.yaml`이 이 파일을 include하므로 루트에서 `docker compose`를 그대로 쓴다 |
| `apps/*/Dockerfile` | api(+reconciler)·worker·scheduler·egress-proxy 이미지. base는 `oven/bun:1.3.10` digest pin, `bun install --frozen-lockfile --production` multi-stage(egress-proxy는 install 없는 한 단계). `.github/workflows/images.yml`이 빌드·smoke·digest artifact, tag push만 ghcr push |

immutable checkpoint manifest와 authoritative pointer는 `packages/platform`의 `CheckpointService`가 담당하고, `apps/api`가 이를 S3 object store·Postgres `CheckpointStore`·git bundle verifier로 조립해 Worker Gateway에 붙인다(94S-201). Gateway의 finalize는 manifest ref가 `sessions/<sid>/checkpoints/<rev>/<attempt>/manifest.json`이고 본문 digest·bundle이 검증된 checkpoint만 받으며, pointer는 `finalizeAtomic`(turn 있는 경로)과 `CheckpointStore.commitAtomic`(turn 없는 경로, 94S-137)이 같은 SQL helper로 "정확히 current+1"만 전진시킨다. 워커용 `/internal/worker/checkpoint-request`·`/restore-plan`은 lease fence 안에서 읽은 pointer로 답한다. 워커 heartbeat의 `transcript` 보고는 세션의 `last_transcript_persisted_at`과 `checkpoint_pending_reason`이 되고, `mirror_error`가 기록된 세션은 새 입력과 checkpoint 없는 completed 종료를 409 `CHECKPOINT_UNAVAILABLE`로 거절한다 — 같은 attempt의 checkpoint는 이를 지우지 못하고 **다른** attempt가 커밋한 checkpoint만 지운다(복구 결정은 94S-140). completed turn에 checkpoint를 강제하지는 않는다: 세션 상세의 `durability`가 `last_completed_turn_id`와 `last_checkpointed_turn_id`의 차이로 드러낸다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

## 개발 검증

저장소 루트에서 Bun 1.3.10과 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다.

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 workspace typecheck → Biome → 패키지·앱 Bun 테스트다(CI는 이 셋을 역할별 job으로 나눠 동시에 돈다). `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. 이 두 opt-in 변수와 fake Messages API·격리 workspace fixture는 `packages/testkit`(`fake-anthropic`·`postgres`·`localstack`·`workspace`)이 제공하며, 각 패키지는 devDependency로만 참조한다(`tests/architecture.test.ts`가 검사). API의 실제 PostgreSQL·키 CLI·HTTP 프로세스 검증은 CI와 로컬에서 별도 명령으로 실행한다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다. CI가 어느 job에서 어떤 변수를 켜는지는 [docs/ci.md](docs/ci.md)에 있다.

워커 adapter의 단위 테스트와 실제 SDK·로컬 fake Messages API 테스트는 분리해서 실행할 수 있다. 후자는 실제 번들 Claude Code subprocess를 띄워 같은 process의 후속 턴과 새 process의 resume을 확인하지만 유료 모델 API는 호출하지 않는다.

```bash
bun run --cwd packages/adapters/runtimes/claude test:unit
bun run --cwd packages/adapters/runtimes/claude test:direct-local
bun test spikes/94s-91/src/litellm-transport.test.ts
```

```bash
QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test ./apps/api/src/server.integration.ts
```

전체 alpha 경로를 이 checkout의 이미지로 확인하려면(Docker Engine 28 이상, 기동 중인 다른 스택과 포트가 겹치지 않는 별도 project로 뜬다):

```bash
tests/e2e/run.sh
```

## SDK와 LiteLLM 방향

`@anthropic-ai/claude-agent-sdk`는 `packages/adapters/runtimes/claude/src/{runtime,run}.ts` 안에서만 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. 설정·인증·버전·모델 alias와 검증 조건은 [설계서 §9](docs/DESIGN.md#9-dockerfile)에 둔다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 94S-91 transport gate는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 제품 경로(빌드한 이미지의 worker·scheduler·API)는 `tests/e2e`가 확인한다.

## 라이선스

이 저장소는 **source-available이지 오픈소스가 아니다.** 읽고 감사할 수 있도록 공개할 뿐,
공개 자체가 사용권을 주지 않는다. 실행·복제·수정·배포와 이 소프트웨어를 이용한 서비스
제공은 저작권자의 사전 서면 허가가 있어야 한다. 전문은 [LICENSE](LICENSE)에 있다.

기여는 지금 받지 않는다. 외부 기여가 섞이면 저작권자가 이 소프트웨어를 상용으로
라이선스할 수 있는 여지가 좁아지기 때문이다.

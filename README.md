# Agent Platform (코드명 Kollegium) — 세션 컨트롤 플레인

> 저장소는 `claude-session-platform`에서 `agent-platform`으로 이름을 바꿨다. 내부 package scope는 `@agent-platform/*`이다. 통합 설계 정본은 Obsidian `Private/Project/agent-platform`이며, 이 README 이하와 [docs/DESIGN.md](docs/DESIGN.md)는 rename 이전 구현 범위의 기록이다.

공식 TypeScript Claude Agent SDK로 세션을 제어하고, HTTP API·큐·이벤트·격리·영속화를 제공하는 플랫폼이다.

현재는 **G1 설계 확정, M0 기반 레이어, G2 SDK·저장소 gate, API 골격과 SDK adapter까지**다. API 키 인증과 `/v1` base path, 고정 SDK의 streaming·interrupt·abort·resume 경계는 구현됐지만 세션 endpoint와 워커 턴 처리 루프는 아직 구현하지 않았다. 전체 앱이나 Kubernetes가 동작한다고 해석하지 않는다.

## 정본과 다음 단계

- 작업 순서·상태·인수 조건: [Linear 프로젝트](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)의 native blocked-by 관계
- 구조·runtime 계약·검증 계획: [설계서](docs/DESIGN.md)
- 완료된 SDK gate: [94S-91](https://linear.app/94soon/issue/94S-91), 저장 backend 선택: [94S-92](https://linear.app/94soon/issue/94S-92)
- process-level 조사 harness와 검증 범위는 [`spikes/94s-91`](spikes/94s-91/README.md), [`spikes/94s-92`](spikes/94s-92/README.md)에 둔다.

## 현재 구현 범위

| 경로 | 구현된 기반 |
|---|---|
| `packages/contracts` | Zod 계약을 `api`(공개 REST·SSE)·`worker-protocol`(Gateway DTO)·`shared`(ID·error)로 분리. `docs/openapi.json`은 `bun run --cwd packages/contracts openapi:generate`로 생성하며 테스트가 drift를 검출 |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/queue` | PostgreSQL durable queue·이벤트·lease, Redis placeholder |
| `packages/storage` | S3 transcript와 git 저장·복원 primitive |
| `packages/observability` | 구조화 로깅·메트릭·트레이싱 기반 |
| `apps/api` | Hono `/v1` 골격, API 키 인증, strict zod 검증·에러 응답, 키 발급 CLI |
| `packages/runtime-core` | 엔진 중립 실행 계약(`AgentRuntime.start(config, hooks)`, `AgentRun`, `RuntimeCapabilities`, checkpoint 준비 결과). `mode: "new" | "resume"`를 config가 들고 다니며 별도 open 진입점이 없다 |
| `packages/adapters/runtimes/claude` | Claude Agent SDK 0.3.270 adapter(`ClaudeSdkRuntime`·`ClaudeSdkRun`), 승인 profile·최소 환경, native envelope·SSE projection, 제어 가능한 fake |
| `apps/worker` | runtime-core·Claude adapter·contracts만 조립하는 워커 진입점. SDK·DB driver·cloud SDK를 직접 의존하지 않는다(`tests/architecture.test.ts`가 검사) |
| `apps/reconciler` | 만료된 worker lease를 한 번 스캔해 원래 queue row를 release하고 세션을 재신호하는 one-shot 프로세스 |
| `apps/scheduler` | eligible unassigned session 수요를 보고 `executions` launch intent를 커밋한 뒤 LocalDockerBackend로 worker 컨테이너를 보장하는 one-shot 프로세스 (94S-117 전까지의 control host 자리) |
| `packages/adapters/execution/local-docker` | `ExecutionBackend` port의 Docker Engine API 구현. 컨테이너 이름·label로 launch intent와 1:1, non-root·read-only rootfs·세션 전용 volume·자원 상한·전용 internal 네트워크 |
| `apps/egress-proxy` | worker 네트워크에서 유일하게 바깥으로 나가는 forward proxy. CONNECT·absolute-form HTTP만 받고 목적지 allowlist를 DNS 해석 결과의 IP 대역까지 검사한다. workspace 의존이 없어 bare Bun 이미지에 자기 디렉터리만 마운트해 기동한다 |
| `infra/docker-compose.yml` | Postgres·LocalStack·Gitea와 one-shot migration, worker용 internal 네트워크와 egress proxy |

immutable checkpoint manifest와 authoritative pointer, typed pending requests, SDK 기반 resume은 후속 확장이다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

## 현재 실행 가능한 검증

저장소 루트에서 Bun 1.3.10과 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다.

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 workspace typecheck → Biome → 패키지·앱 Bun 테스트다. `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. 이 두 opt-in 변수와 fake Messages API·격리 workspace fixture는 `packages/testkit`(`fake-anthropic`·`postgres`·`localstack`·`workspace`)이 제공하며, 각 패키지는 devDependency로만 참조한다(`tests/architecture.test.ts`가 검사). API의 실제 PostgreSQL·키 CLI·HTTP 프로세스 검증은 CI와 로컬에서 별도 명령으로 실행한다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다. CI가 어느 job에서 어떤 변수를 켜는지는 [§ CI에서 실행되는 것](#ci에서-실행되는-것)에 있다.

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

reconciler는 스케줄러를 내장하지 않고 한 batch만 처리한 뒤 종료한다. 워커와 같은 `HEARTBEAT_TTL_SEC`를 사용해야 하며, 실제 변경 전에 대상만 확인하려면 dry-run을 명시한다. 미처리 row 또는 `queued` turn만 자동 재전달하며, 실행 중이거나 상태를 증명할 수 없는 row는 session을 `failed`로 전환하고 명시적 복구 대상으로 남긴다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
HEARTBEAT_TTL_SEC=30 RECONCILER_DRY_RUN=true \
  bun run --cwd apps/reconciler start

DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
HEARTBEAT_TTL_SEC=30 RECONCILER_DRY_RUN=false \
  bun run --cwd apps/reconciler start
```

scheduler도 one-shot이다. 한 pass는 ① 살아 있는 `executions` row를 Docker와 대조(컨테이너가 없으면 같은 intent로 재생성, exit했으면 `terminated` 기록 후 제거) ② launch intent 없는 관리 컨테이너를 로그 후 정지 ③ `EXECUTION_SLOT_LIMIT`(기본 10) 안에서 unassigned session마다 intent 커밋 → 컨테이너 생성 순서로 진행한다. worker 컨테이너는 Docker socket·host HOME을 받지 않고 env는 bootstrap claim에 필요한 `WORKER_EXECUTION_ID`·`WORKER_EXECUTION_GENERATION`·`WORKER_BOOTSTRAP_NONCE`·`WORKER_GATEWAY_URL`, tmpfs를 가리키는 `HOME`, 그리고 egress proxy를 가리키는 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`(대소문자 두 표기)만 받는다. `/tmp`·HOME tmpfs는 worker uid/gid 소유로 마운트된다. `/workspace` named volume은 Docker가 이미지의 같은 경로에서 초기화하므로 worker 이미지가 `/workspace`를 worker uid 소유로 미리 만들어 두어야 한다(이미지 계약). worker 이미지는 형제 티켓이므로 이름만 `WORKER_IMAGE`로 받는다. pass 전체는 Postgres session advisory lock(`scheduler:pass`)으로 직렬화되어 겹친 실행은 로그만 남기고 건너뛴다. 같은 Docker daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. scheduler는 이 값이 없으면 기동하지 않는다(adapter만 테스트용 기본값 `local`을 가짐). 같은 값을 쓰는 두 설치가 daemon을 공유하면 서로의 컨테이너를 orphan으로 회수한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
WORKER_IMAGE=agent-platform-worker:dev \
WORKER_GATEWAY_URL=http://host.docker.internal:3000 \
EXECUTION_SLOT_LIMIT=10 \
EXECUTION_INSTALLATION_ID=local \
EXECUTION_DOCKER_NETWORK=agent-platform-worker \
EXECUTION_DOCKER_NETWORK_ALLOWLIST=agent-platform-worker \
EXECUTION_EGRESS_PROXY_URL=http://egress-proxy:3128 \
  bun run --cwd apps/scheduler start
```

worker 컨테이너는 compose가 만드는 `agent-platform-worker`(`internal: true`) 네트워크에만 붙는다. Docker가 이 네트워크에 바깥으로 나가는 경로를 만들지 않으므로 worker는 host·LAN·instance metadata(`169.254.169.254`)·다른 compose 서비스에 직접 닿지 못한다. 두 네트워크에 걸친 유일한 구성원이 `egress-proxy` 서비스이고, worker는 `HTTP_PROXY`/`HTTPS_PROXY`로 그것을 가리킨다. `host.docker.internal:host-gateway` 매핑은 worker에서 제거했다 — gateway도 proxy를 거친다.

차단 정책은 proxy의 두 목록으로 버전 관리한다. `EGRESS_ALLOWLIST`는 공인 목적지(`host:port`)이고 해석된 주소가 전부 public unicast여야 통과한다. `EGRESS_PRIVATE_ALLOWLIST`는 사설 대역에 있다고 알고 허용하는 목적지(gateway, gitea)다. 두 목록 모두 link-local(`169.254.0.0/16`·`fe80::/10`)·multicast·reserved로 해석되면 거부하므로 allowlist에 오른 이름이 metadata 주소로 해석되는 rebinding도 막힌다. 목록에 없는 host·port는 CONNECT·absolute-form 모두 `403`이고, absolute-form이 아닌 요청은 `/healthz` 외에는 `400`이다.

**이것은 아직 세션 간 격리 경계가 아니다.** 지금 서는 보장은 worker가 *바깥으로* 나갈 때 allowlist를 지난다는 것까지이고, 두 가지가 남아 있다.

1. 같은 worker 네트워크에 붙은 worker끼리는 서로의 열린 포트에 닿는다. 침해된 세션이 옆 세션을 스캔·접속할 수 있다.
2. CONNECT 터널의 실제 TLS SNI는 검사하지 않는다. proxy는 요청자가 제시한 hostname만 대조하고 터널을 연 뒤에는 바이트를 그대로 흘리므로, allowlist에 있는 CDN hostname으로 CONNECT한 뒤 같은 edge IP의 다른 SNI를 쓰는 경로가 남는다.

둘 다 후속 티켓이다. 서로 신뢰하지 않는 코드를 한 daemon에서 돌려야 하는 배치라면 이 둘이 닫히기 전까지는 다른 수단(설치·세션별 daemon 등)이 필요하다.

scheduler는 pass 전에 daemon에 `EXECUTION_DOCKER_NETWORK`를 조회해 실제로 `Internal`인지 확인하고, 없거나 라우팅 가능한 네트워크면 아무것도 띄우지 않고 종료한다. `bridge`·`default`·`host`·`none`은 allowlist에 넣어도 거부한다.

컨테이너에는 만들어질 때의 격리 계약이 `agent-platform.isolation` label로 `<버전>:<지문>` 형태로 찍힌다. 지문은 네트워크·proxy URL·user·workspace/HOME 경로·tmpfs 크기의 해시라서, 코드를 바꾸지 않고 `EXECUTION_DOCKER_NETWORK`나 `EXECUTION_EGRESS_PROXY_URL`만 바꿔도 값이 달라진다. 실행 중인 컨테이너의 격리는 제어 호스트를 올려도 바뀌지 않으므로, scheduler는 label이 현재 값과 다른 컨테이너를 `stale`로 보고 정지·제거한 뒤 저장된 intent로 다시 만든다(`ensureExecution`도 그런 컨테이너는 adopt하지 않는다). 버전이 **더 높은** 컨테이너는 롤백 중인 새 제어 호스트가 만든 것이다. 그 경계가 지금 요구하는 것과 같은지 알 수 없으므로 adopt도 교체도 하지 않고 `IsolationContractError`로 거절한다 — row는 살아 있고 pass는 non-zero로 끝나므로 운영자가 롤포워드하거나 직접 제거해야 한다. 격리의 모양 자체가 바뀌면 `ISOLATION_CONTRACT`를 올린다.

같은 daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`뿐 아니라 `EXECUTION_DOCKER_NETWORK`와 egress proxy도 설치마다 따로 두어야 한다. 하나의 internal 네트워크를 공유하면 설치 A의 worker가 설치 B의 worker와 proxy에 직접 닿고, B의 allowlist를 그대로 쓸 수 있다.

```bash
docker compose -f infra/docker-compose.yml up -d egress-proxy
docker network inspect agent-platform-worker \
  --format '{{.Name}} internal={{.Internal}}'
```

실제 Docker daemon 대상 테스트는 `DOCKER_BACKEND_TEST=1`로 opt-in한다(`busybox:1.36`을 sleep으로 띄움). egress suite는 internal 네트워크·바깥 네트워크·upstream 두 개·`oven/bun:1.3.10`으로 띄운 proxy를 직접 만들어 컨테이너 안에서 `wget`·`nc`로 확인하며 인터넷을 쓰지 않는다. scheduler의 15 세션 → 컨테이너 ≤ 10 검증은 `QUEUE_DATABASE_URL`까지 있어야 실행된다.

```bash
DOCKER_BACKEND_TEST=1 bun run --cwd packages/adapters/execution/local-docker test:docker
DOCKER_BACKEND_TEST=1 QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test apps/scheduler/src/main.integration.test.ts
```

로컬 의존 서비스만 기동하려면 다음을 사용한다. 기본 포트 5432·4566·3001·2222가 이미 사용 중인지 먼저 확인한다.

```bash
docker compose -f infra/docker-compose.yml up -d postgres localstack gitea egress-proxy
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml run --rm migrate
```

기존 환경 파일이나 volume을 덮어쓰거나 삭제하지 않는다. host에서 실행하는 테스트는 컨테이너 DNS 이름이 아니라 host에 공개된 endpoint를 사용한다. PostgreSQL integration fixture는 임시 DB 생성 권한이 필요하므로 전용 로컬 테스트 DB만 지정한다. LocalStack fixture는 `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`의 로컬 테스트 설정을 요구한다. 운영 DB·운영 credential로 실행하지 않는다.

API를 로컬 인증 비활성 모드로 띄울 때만 `X-Owner-Id`를 사용할 수 있다. 이 모드는 기동 시 경고를 출력하며 기본값이 아니다.

```bash
AUTH_MODE=none PORT=3000 bun run --cwd apps/api start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest만 저장한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/api keys create local-owner
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/api start
curl -H 'Authorization: Bearer <issued-key>' http://127.0.0.1:3000/v1
```

Compose의 `apps`·`worker` profile은 아직 없는 Dockerfile을 참조하는 placeholder다. 현재 활성화하지 않는다. `FAKE_SDK`, `scripts/dev`, `/ui`, 세션 HTTP endpoint, 이미지 빌드 workflow는 후속 티켓 범위다.

## CI에서 실행되는 것

`.github/workflows/ci.yml`은 `main` push와 모든 pull request에서 세 job을 **병렬로** 돌린다. 같은 커밋이 push와 pull_request로 두 번 돌지 않게 push는 `main`으로만 제한했다.

그 대가로 **pull request가 없는 브랜치에 push하면 CI가 돌지 않는다.** PR을 열기 전에 확인하고 싶으면 `workflow_dispatch`로 수동 실행한다(`gh workflow run CI --ref <branch>`). tag push도 빌드하지 않는다 — 태그가 가리키는 트리는 이미 main push에서 돌았다. merge queue를 켜려면 `merge_group` 이벤트를 따로 추가해야 한다.

`concurrency`는 PR이면 PR 번호로 묶어 새 push가 이전 run을 취소하고, 그 외(`main` push·수동 실행)는 run 단위로 묶어 서로 취소하거나 대기하지 않는다.

bun 버전 고정과 `~/.bun/install/cache` 캐시는 `.github/actions/bun-setup`에 모여 있다. 캐시 키는 **그 job이 실제로 설치하는 lockfile만** 해시한다 — `check`가 쓰는 `bun-root-*`는 root lockfile만, `spikes`가 쓰는 `bun-spikes-*`는 root와 두 spike lockfile을 함께 해시한다. 키가 세 lockfile을 약속하면서 root만 설치한 job이 저장하면, spike 전용 의존성은 exact hit인데도 매번 다시 받게 된다. scope마다 쓰기 job은 하나뿐이라 같은 키에 동시 저장하는 레이스도 없다.

| job | 서비스 컨테이너 | 켜지는 opt-in 변수 | 실행 명령 | 머지 차단 |
|---|---|---|---|---|
| `check` | 없음 | 없음 | `bun run check` (typecheck → Biome → `bun test tests packages apps`) | ✅ |
| `integration` | `postgres:16`, `localstack/localstack:3` | `QUEUE_DATABASE_URL`, `STORAGE_LOCALSTACK_TEST=1`, `DOCKER_BACKEND_TEST=1` | `bun run test` + `bun test ./apps/api/src/server.integration.ts` | ✅ |
| `spikes` | `localstack/localstack:3` | `SESSION_STORE_LOCALSTACK_TEST=1` | `spikes/94s-91 probe:version`·`check`, `spikes/94s-92 check` (uv로 `litellm[proxy]==1.100.1` 설치) | ❌ |

`check`는 opt-in 변수를 하나도 켜지 않으므로 PostgreSQL·LocalStack·Docker를 요구하는 테스트가 **의도적으로 skip된다**. 반대로 외부 의존이 없는 테스트는 파일 이름에 `integration`이 들어 있어도 여기서 그대로 돈다 — 로컬 fake Messages API를 쓰는 SDK adapter suite가 그렇다. 같은 스위트를 `integration`이 변수를 전부 켠 채 다시 돌려 skip 0으로 만든다. 파일 이름으로 integration만 골라 돌리지 않는 이유는 `packages/storage/src/localstack.test.ts`처럼 `*.integration.test.ts` 규칙을 따르지 않으면서 opt-in에 걸린 테스트가 있어서다 — 이름 필터는 테스트를 조용히 빠뜨린다. 로그에서 pass 숫자만 보지 말고 `check`의 skip 수와 `integration`의 skip 0을 같이 확인한다.

`DOCKER_BACKEND_TEST=1`은 runner에 딸린 Docker daemon으로 `LocalDockerBackend` 테스트를 돌리게 한다(94S-123). `SESSION_STORE_LOCALSTACK_TEST`는 `spikes/94s-92`만 읽으므로 `spikes` job에만 있다.

`spikes/94s-91`·`spikes/94s-92`는 조사용 harness이고 지금까지 CI 실패가 전부 flaky였다(제품 회귀 0건, 94S-198 조사 코멘트 참조). 그래서 `spikes` job은 `continue-on-error: true`로 workflow run을 실패시키지 않는다. 두 suite는 `.github/scripts/retry-flaky.sh`가 1회 재시도하고, 한쪽이 실패해도 다른 쪽은 그대로 실행한다.

**이 설정이 무엇을 숨기는지 분명히 해둔다.** `spikes` check-run 자체는 실패로 남아 PR checks 목록에 빨갛게 보이지만(실측: 커밋 `2640693`에서 `spikes=failure`, run `conclusion=success`), run 결론만 읽는 소비자 — 알림, 대시보드, release automation — 에게는 spike 회귀가 보이지 않는다. 그래서 job 마지막에 두 suite의 outcome을 run summary에 적는다(취소되지 않은 run이면 언제나 — 취소·timeout으로 job이 끊기면 이 표도 남지 않는다). 그래도 **spike 회귀를 자동으로 알려주는 장치는 없다**. 사람이 Checks를 열어야 한다.

재시도 역시 숨기지 않는다 — `::warning` annotation과 run summary에 남으므로 "첫 시도 통과"와 "재시도 후 통과"를 구분할 수 있다. 다만 재시도는 같은 workspace에서 도는 것이라 **독립 재현이 아니다**: 첫 시도가 남긴 LocalStack 객체나 subprocess 때문에 cleanup·idempotency 버그가 두 번째에 우연히 통과할 수 있다. 중단된 경우는 재시도하지 않는다 — 취소된 workflow를 다시 시작하지 않기 위해서다. 판단 근거는 wrapper 자신이 받은 SIGHUP·SIGINT·SIGTERM이며, runner는 step의 진입 프로세스에만 신호를 보내므로 wrapper는 suite를 background로 띄우고 `wait`에서 블록한다(foreground 명령이면 bash가 trap을 그 명령이 끝날 때까지 미룬다). child만 신호를 받은 경우를 위해 exit 129·130·137·143도 함께 본다. `128 이상`을 전부 취소로 보면 스스로 200으로 끝나는 명령이 재시도를 못 받는다. flaky 원인 수정은 별도 티켓이다.

`main` branch protection은 아직 설정되어 있지 않다(`gh api repos/JeongJaeSoon/agent-platform/branches/main/protection` → 404). 켤 때 **`check`와 `integration`을 모두 required로 지정한다.** 재구성 전 `check` 하나가 PostgreSQL·LocalStack 검증까지 포함했으므로, 이름이 같다는 이유로 `check`만 required로 두면 `integration`이 실패한 PR도 머지된다. `spikes`는 required에서 제외한다.

## SDK와 LiteLLM 방향

`@anthropic-ai/claude-agent-sdk`는 `packages/adapters/runtimes/claude/src/{runtime,run}.ts` 안에서만 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. 설정·인증·버전·모델 alias와 검증 조건은 [설계서 §9](docs/DESIGN.md#9-dockerfile)에 둔다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 94S-91 transport gate는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 아직 워커 턴 루프나 배포 검증을 대신하지 않는다.

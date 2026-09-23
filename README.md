# Agent Platform (코드명 Kollegium) — 세션 컨트롤 플레인

> 저장소는 `claude-session-platform`에서 `agent-platform`으로 이름을 바꿨다. 내부 package scope는 `@agent-platform/*`이다. 통합 설계 정본은 Obsidian `Private/Project/agent-platform`이고, 이 README는 저장소의 현재 구현 범위를 따라간다. [docs/DESIGN.md](docs/DESIGN.md)는 rename 이전 설계의 보관본이며 지금의 계약·티켓 번호와 일치하지 않는다.

공식 TypeScript Claude Agent SDK로 세션을 제어하고, HTTP API·큐·이벤트·격리·영속화를 제공하는 플랫폼이다.

현재는 **D0 계약 정렬, D1 접수·조회 API, D2 실행 기반(Worker Gateway·스케줄러·로컬 Docker backend·CheckpointService·egress 격리)까지**다. 세션 생성·목록·상세·메시지·turn·receipt endpoint와 Gateway 내부 protocol은 구현됐지만 **둘을 잇는 워커 턴 처리 루프([94S-122](https://linear.app/94soon/issue/94S-122)), checkpoint 결선([94S-201](https://linear.app/94soon/issue/94S-201)), 앱 이미지([94S-125](https://linear.app/94soon/issue/94S-125))가 없어 HTTP→세션→turn→checkpoint→재개의 세로 경로는 아직 닫히지 않았다.** 전체 앱이나 Kubernetes가 동작한다고 해석하지 않는다.

## 정본과 다음 단계

- 작업 순서·상태·인수 조건: [Linear P-94S-5](https://linear.app/94soon/project/agent-platform-9c503b0fad62)의 D0~D4 티켓(94S-108~147)과 native blocked-by 관계. [옛 프로젝트](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)(94S-7~94)는 rename 이전 이력이다
- 구조·runtime 계약·검증 계획: Obsidian `Private/Project/agent-platform`의 `architecture.md`·`module-design.md`·`delivery-plan.md`. [docs/DESIGN.md](docs/DESIGN.md)는 보관본이다
- 완료된 SDK gate: [94S-91](https://linear.app/94soon/issue/94S-91), 저장 backend 선택: [94S-92](https://linear.app/94soon/issue/94S-92)
- process-level 조사 harness와 검증 범위는 [`spikes/94s-91`](spikes/94s-91/README.md), [`spikes/94s-92`](spikes/94s-92/README.md)에 둔다.
- 인터페이스·협업 트랙(웹 콘솔·Dispatch·Slack·기억·루틴): 설계 정본은 Obsidian `Private/Project/agent-platform/interface/00~06`, 티켓은 [Linear P-94S-6](https://linear.app/94soon/project/agent-platform-interface-and-collaboration-933c7892a8a4)(94S-148~195), 조사 초안과 Codex 리뷰 원문은 [`docs/references`](docs/references/README.md)에 둔다. alpha D0~D4 실행 계층은 바꾸지 않고 그 위에 올린다.

## 현재 구현 범위

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
| `apps/worker` | 아직 진입점이 아니라 runtime-core·Claude adapter의 재수출뿐이다. 턴 처리 루프는 94S-122에서 온다. SDK·DB driver·cloud SDK를 직접 의존하지 않는다(`tests/architecture.test.ts`가 검사) |
| `apps/reconciler` | 만료된 worker lease를 한 번 스캔해 원래 queue row를 release하고 세션을 재신호하는 one-shot 프로세스 |
| `apps/scheduler` | eligible unassigned session 수요를 보고 `executions` launch intent를 커밋한 뒤 LocalDockerBackend로 worker 컨테이너를 보장하는 one-shot 프로세스 (94S-117 전까지의 control host 자리) |
| `packages/adapters/execution/local-docker` | `ExecutionBackend` port의 Docker Engine API 구현. 컨테이너 이름·label로 launch intent와 1:1, non-root·read-only rootfs·세션 전용 volume·자원 상한·전용 internal 네트워크 |
| `apps/egress-proxy` | worker 네트워크에서 유일하게 바깥으로 나가는 forward proxy. CONNECT·absolute-form HTTP만 받고 목적지 allowlist를 DNS 해석 결과의 IP 대역까지 검사한다. workspace 의존이 없어 bare Bun 이미지에 자기 디렉터리만 마운트해 기동한다 |
| `infra/docker-compose.yml` | Postgres·LocalStack·Gitea와 one-shot migration, worker용 internal 네트워크와 egress proxy. `apps` profile은 `apps/*/Dockerfile`로 빌드한 api·scheduler(루프)를 띄우고, `worker` profile은 scheduler가 띄울 worker 이미지를 빌드한다 |
| `apps/*/Dockerfile` | api(+reconciler)·worker·scheduler 이미지. base는 `oven/bun:1.3.10` digest pin, `bun install --frozen-lockfile --production` multi-stage. `.github/workflows/images.yml`이 빌드·smoke·digest artifact, tag push만 ghcr push |

immutable checkpoint manifest와 authoritative pointer는 `packages/platform`의 `CheckpointService`가 담당하고, `apps/api`가 이를 S3 object store·Postgres `CheckpointStore`·git bundle verifier로 조립해 Worker Gateway에 붙인다(94S-201). Gateway의 finalize는 manifest ref가 `sessions/<sid>/checkpoints/<rev>/<attempt>/manifest.json`이고 본문 digest·bundle이 검증된 checkpoint만 받으며, pointer는 `finalizeAtomic`(turn 있는 경로)과 `CheckpointStore.commitAtomic`(turn 없는 경로, 94S-137)이 같은 SQL helper로 "정확히 current+1"만 전진시킨다. 워커용 `/internal/worker/checkpoint-request`·`/restore-plan`은 lease fence 안에서 읽은 pointer로 답한다. 워커 heartbeat의 `transcript` 보고는 세션의 `last_transcript_persisted_at`과 `checkpoint_pending_reason`이 되고, `mirror_error`가 기록된 세션은 새 입력과 checkpoint 없는 completed 종료를 409 `CHECKPOINT_UNAVAILABLE`로 거절한다 — 같은 attempt의 checkpoint는 이를 지우지 못하고 **다른** attempt가 커밋한 checkpoint만 지운다(복구 결정은 94S-140). completed turn에 checkpoint를 강제하지는 않는다: 세션 상세의 `durability`가 `last_completed_turn_id`와 `last_checkpointed_turn_id`의 차이로 드러낸다. typed pending requests와 SDK 기반 resume은 D3다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

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

scheduler도 one-shot이다. 한 pass는 ① 살아 있는 `executions` row를 Docker와 대조(컨테이너가 없으면 같은 intent로 재생성, exit했으면 `terminated` 기록 후 제거) ② launch intent 없는 관리 컨테이너를 로그 후 정지하고, 컨테이너가 사라진 worker 네트워크를 지우거나 proxy가 떨어진 네트워크에 다시 붙임(94S-216) ③ `EXECUTION_SLOT_LIMIT`(기본 10) 안에서 unassigned session마다 intent 커밋 → 컨테이너 생성 ④ 끝난 session의 workspace volume 회수 순서로 진행한다. worker 컨테이너는 Docker socket·host HOME을 받지 않고 env는 bootstrap claim에 필요한 `WORKER_EXECUTION_ID`·`WORKER_EXECUTION_GENERATION`·`WORKER_BOOTSTRAP_NONCE`·`WORKER_GATEWAY_URL`, tmpfs를 가리키는 `HOME`, egress proxy를 가리키는 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`(대소문자 두 표기), 그리고 object store 접근(94S-244) — 제어 호스트와 같은 이름의 `S3_BUCKET`·`AWS_REGION`·`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`·`AWS_ENDPOINT_URL`(없으면 AWS 자체. http·https 모두 되며 https는 아래 egress 절의 전용 transport를 탄다)과 세션 prefix `WORKER_OBJECT_PREFIX`(`sessions/<sessionId>/`) — 를 받는다. scheduler는 이 값들이 없으면 기동하지 않는다. 자격 증명은 bucket 전체에 미치고 워커는 `scopedCheckpointObjectStore`(`packages/storage`)로 스스로 prefix 밖 key를 거절한다. 이것은 클라이언트 쪽 가드이지 자격 증명 경계가 아니다 — 세션·generation 범위 STS 자격 증명은 identity provider가 있는 배치(EKS/MVM)로 미룬다. 워커 안에서 `@agent-platform/storage`를 import하는 파일은 `apps/worker/src/object-store.ts` 하나뿐이며 `tests/architecture.test.ts`가 이를 강제한다. Docker daemon 응답이 create 요청 본문을 되돌려 주는 경우에 대비해 backend는 오류 메시지에서 nonce와 secret key를 지운다. `/tmp`·HOME tmpfs는 worker uid/gid 소유로 마운트된다. `/workspace` named volume은 Docker가 이미지의 같은 경로에서 초기화하므로 worker 이미지가 `/workspace`를 worker uid 소유로 미리 만들어 두어야 한다(이미지 계약). worker 이미지는 형제 티켓이므로 이름만 `WORKER_IMAGE`로 받는다. pass 전체는 Postgres session advisory lock(`scheduler:pass`)으로 직렬화되어 겹친 실행은 로그만 남기고 건너뛴다. 같은 Docker daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. scheduler는 이 값이 없으면 기동하지 않는다(adapter만 테스트용 기본값 `local`을 가짐). 같은 값을 쓰는 두 설치가 daemon을 공유하면 서로의 컨테이너를 orphan으로 회수한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
WORKER_IMAGE=agent-platform-worker:dev \
WORKER_GATEWAY_URL=http://host.docker.internal:3000 \
EXECUTION_SLOT_LIMIT=10 \
EXECUTION_INSTALLATION_ID=local \
EXECUTION_EGRESS_PROXY_URL=http://egress-proxy:3128 \
EXECUTION_WORKSPACE_QUOTA=off \
  bun run --cwd apps/scheduler start
```

worker 컨테이너는 scheduler가 execution마다 만드는 **전용 네트워크** `ap-net-<installationId>-<executionId>-g<generation>` 하나에만 붙는다(94S-216). 이 네트워크는 bridge driver, `internal: true`, `EnableIPv6: false`로 만들어진다. Docker가 이 네트워크에서 바깥으로 나가는 경로를 만들지 않으므로 worker는 host·LAN·instance metadata(`169.254.169.254`)·다른 compose 서비스·다른 worker에 직접 닿지 못한다. 이 네트워크의 구성원은 worker 자신과 egress proxy 둘뿐이다. scheduler는 `agent-platform.egress-proxy=<installationId>` label이 붙은 **실행 중인 컨테이너 정확히 하나**를 그 설치의 proxy로 보고, 네트워크마다 `EXECUTION_EGRESS_PROXY_URL`의 host 이름을 alias로 붙여 connect한다. worker는 `HTTP_PROXY`/`HTTPS_PROXY`로 그 이름을 가리킨다. proxy 주소가 네트워크마다 다르므로 `EXECUTION_EGRESS_PROXY_URL`의 host는 이름이어야 하고, IP literal과 `localhost`는 거부한다. compose의 `egress-proxy` 서비스는 이 label을 달고 있다. `host.docker.internal:host-gateway` 매핑은 worker에서 제거했다 — gateway도 proxy를 거친다.

차단 정책은 proxy의 두 목록으로 버전 관리한다. `EGRESS_ALLOWLIST`는 공인 목적지(`host:port`)이고 해석된 주소가 전부 public unicast여야 통과한다. `EGRESS_PRIVATE_ALLOWLIST`는 사설 대역에 있다고 알고 허용하는 목적지(gateway, gitea, 그리고 워커의 object store인 localstack)다. compose의 localstack은 이 때문에 S3만 켠다 — 허용된 port 위의 서비스는 전부 워커가 부를 수 있는 서비스다. 두 목록 모두 link-local(`169.254.0.0/16`·`fe80::/10`)·multicast·reserved로 해석되면 거부하므로 allowlist에 오른 이름이 metadata 주소로 해석되는 rebinding도 막힌다. 목록에 없는 host·port는 CONNECT·absolute-form 모두 `403`이고, absolute-form이 아닌 요청은 `/healthz` 외에는 `400`이다.

CONNECT 터널은 TLS만 나른다(94S-219). proxy는 `200 Connection Established`를 쓴 뒤 클라이언트의 첫 바이트를 upstream에 흘리기 전에 TLS ClientHello로 읽어, DNS 이름 authority면 `server_name`이 그 authority와(대소문자만 무시하고) 같아야 하고, allowlist에 명시된 IP literal authority면 `server_name`이 없어야 한다. `encrypted_client_hello`(0xfe0d)는 GREASE 여부와 관계없이 거부한다 — proxy는 둘을 구별할 수 없고, 진짜 ECH는 검사 대상인 이름을 숨긴다. handshake가 아닌 첫 레코드, host_name이 둘인 hello, 최초 16KiB(record header 포함) 또는 15초(`handshakeTimeoutMs`) 안에 완성되지 않는 hello는 전부 연결을 끊는다. 거부는 200 뒤에 일어나므로 클라이언트에는 handshake 도중 연결 종료로 보인다.

이 관문의 한계:

* 검사 대상은 평문으로 보이는 **바깥** ClientHello의 SNI다. TLS를 종단하지 않으므로 그 안의 HTTP `Host`·경로·본문, 허용된 서비스가 다시 중계하는 곳은 보지 못한다. domain fronting을 CDN 쪽에서 막는 것은 별개의 통제다.
* IP literal allowlist는 `IP:port` 접근 권한이지 hostname 보장이 아니다. 공유 CDN edge 주소를 IP로 allowlist에 올리지 않는다.
* **Bun 1.3의 `fetch`·`node:https`는 GREASE ECH를 보내므로 이 proxy로 CONNECT하면 거부된다**(Bun `node:tls`·`Bun.connect({tls})`, Node, curl, 그리고 worker의 SDK가 spawn하는 Claude Code 바이너리는 보내지 않는다 — 2026-09-23 실측). 그래서 worker의 object store는 https 요청(https endpoint, 그리고 endpoint가 없는 AWS)에 Bun의 HTTP 클라이언트를 쓰지 않는다. `packages/storage`의 `TlsTunnelHttpHandler`가 `HTTPS_PROXY`로 CONNECT 터널을 열고 `node:tls`로 TLS를 직접 맺은 뒤 HTTP/1.1을 말한다(94S-254). http endpoint(compose의 localstack)는 예전처럼 Bun `node:http`가 `HTTP_PROXY`로 absolute-form을 보낸다. 이 transport는 요청마다 연결 하나(`connection: close`, pooling 없음)이고 바이트 본문만 보낸다. IP 주소로 된 https endpoint는 워커·scheduler가 시작 단계에서 거부한다 — Bun `node:tls`는 IP host에 SNI `localhost`를 보내고 그 이름으로 인증서를 검증하기 때문이다. endpoint를 비우면(AWS) SDK가 virtual-hosted 이름으로 부르므로 proxy의 `EGRESS_ALLOWLIST`에 `<bucket>.s3.<region>.amazonaws.com:443`이 있어야 하고, 사설 CA를 쓰는 https S3-compatible 저장소라면 worker 이미지에 `NODE_EXTRA_CA_CERTS`로 CA를 넣는다. object store 밖에서 worker의 Bun HTTP 클라이언트로 https upstream을 부르는 코드는 여전히 지원하지 않는다. 런타임·클라이언트 버전을 올리면 다시 측정한다.

**worker끼리는 서로 닿지 않는다(94S-216).** 다른 worker와 같은 네트워크에 있지 않으므로 그 주소로 가는 경로가 없고, 컨테이너 이름도 풀리지 않는다. proxy를 거쳐 가려 해도 사설 주소는 `EGRESS_PRIVATE_ALLOWLIST`에 없으면 거부된다. 다른 설치의 worker와 proxy에도 닿지 않는다 — 네트워크와 proxy 선택이 모두 설치별이다. 통합 테스트(`egress.integration.test.ts`의 "workers do not reach one another")가 이를 확인한다. 같은 네트워크의 형제 컨테이너라면 열린 포트에 닿는다는 양성 대조와 함께 확인한다. 남은 한계:

* proxy는 모든 worker 네트워크에 붙는 신뢰 구성요소다. proxy가 침해되면 그 설치의 모든 worker에 닿는다. `EGRESS_PRIVATE_ALLOWLIST`에는 worker로 해석될 수 있는 이름을 넣지 않는다.
* internal bridge도 host 쪽 bridge 인터페이스에 주소를 가진다. 그래서 daemon host가 그 주소나 wildcard로 listen하는 **host 프로세스**에는 worker가 proxy를 거치지 않고 닿을 수 있다. Docker가 publish한 포트가 아니라 host에서 직접 띄운 프로세스가 대상이다. 94S-199 때부터 있던 구멍이고 94S-274에서 다룬다.

scheduler는 pass 전에 그 설치의 proxy가 정확히 하나 떠 있는지 확인한다(`verifyNetworkIsolation`). 없거나 둘 이상이면 아무것도 띄우지 않고 종료한다. worker 네트워크는 launch 때마다 검사한다. 이미 같은 이름의 네트워크가 있으면 새로 만들지 않고 다음을 확인한다. 하나라도 어긋나면 `NetworkIsolationError`로 launch를 거부한다(fail closed).

* bridge·internal·IPv6 꺼짐·소유 label(설치·execution·generation)이 맞는가
* worker와 proxy 외의 구성원이 없는가

proxy attach 결과는 응답 코드가 아니라 proxy 컨테이너가 보고하는 attach·alias로 판정한다. 이미 붙어 있으면 403이 오고, alias 없이 붙어 있으면 DNS가 풀리지 않기 때문이다. 이미 있는 컨테이너를 adopt할 때는 그 컨테이너가 자기 네트워크(같은 id) **하나에만** 붙어 있어야 한다. 컨테이너는 네트워크 이름이 아니라 id로 만든다. 그래서 같은 이름으로 다시 만들어진 네트워크가 검사받은 네트워크를 대신할 수 없다.

예전 설정 `EXECUTION_DOCKER_NETWORK`·`EXECUTION_DOCKER_NETWORK_ALLOWLIST`는 더 이상 읽지 않는다. 값이 남아 있으면 조용히 무시하지 않고 기동을 거부한다. 환경 파일에서 지우고 proxy 컨테이너에 label을 단다.

컨테이너에는 만들어질 때의 격리 계약이 `agent-platform.isolation` label로 `<버전>:<지문>` 형태로 찍힌다. 지문은 proxy URL·user·workspace/HOME 경로·tmpfs 크기, 그리고 object store의 bucket·endpoint·region·access key id의 해시라서, 코드를 바꾸지 않고 `EXECUTION_EGRESS_PROXY_URL`이나 `S3_BUCKET`만 바꿔도 값이 달라진다. secret access key는 지문에 넣지 않는다 — 같은 key id로 secret만 바꾼 경우 실행 중인 컨테이너는 그대로이고, 교체는 운영자가 직접 한다. 실행 중인 컨테이너의 격리는 제어 호스트를 올려도 바뀌지 않으므로, scheduler는 label이 현재 값과 다른 컨테이너를 `stale`로 보고 정지·제거한 뒤 저장된 intent로 다시 만든다(`ensureExecution`도 그런 컨테이너는 adopt하지 않는다). 버전이 **더 높은** 컨테이너는 롤백 중인 새 제어 호스트가 만든 것이다. 그 경계가 지금 요구하는 것과 같은지 알 수 없으므로 adopt도 교체도 하지 않고 `IsolationContractError`로 거절한다 — row는 살아 있고 pass는 non-zero로 끝나므로 운영자가 롤포워드하거나 직접 제거해야 한다. 격리의 모양 자체가 바뀌면 `ISOLATION_CONTRACT`를 올린다. 94S-216이 계약을 5로 올렸다(execution별 네트워크). 그래서 업그레이드하면 공유 네트워크 위의 기존 컨테이너가 전부 stale로 교체된다. **이미 claim된 worker는 교체되지 않고 teardown된다.** 진행 중이던 turn은 `outcome_unknown`으로 닫힌다. 업그레이드는 진행 중인 turn이 없을 때 한다. 계약이 바뀔 때 claim된 worker를 drain하는 경로는 94S-250이다.

### worker workspace의 상한과 회수

세션마다 `ap-ws-<installationId>-<sessionId>-<접미사>` volume 하나가 `/workspace`에 붙는다. 이 volume은 세대(generation)를 넘어 살아남는다 — 컨테이너를 교체해도 세션의 작업 트리는 그대로여야 하기 때문이다. 그래서 **컨테이너를 지우는 `terminate`는 volume을 건드리지 않고**, 회수는 pass의 ④단계가 따로 한다.

volume은 이제 backend가 `POST /volumes/create`로 **명시적으로** 만든다. mount spec에 이름만 적으면 Docker가 label도 상한도 없는 volume을 알아서 만들어 버리기 때문이다. 만들 때 `agent-platform.managed`·`.installation`·`.session-id`·`.workspace-quota` label을 찍고, GC는 이름을 파싱하지 않고 이 label만 본다.

**volume 이름은 1회용이다.** `local` 드라이버는 이미 quota를 걸었던 이름을 다시 만들면 `Options.size`는 그대로 돌려주면서 실제 project quota는 걸지 않는다. xfs+prjquota(Docker 27.5.1)에서 측정한 결과 — 처음 만든 이름은 컨테이너 안 `df` 총량이 설정값(64MiB)이지만, 같은 이름을 지웠다 다시 만들면 `Options.size`가 같은데도 `df`는 파일시스템 전체(8GiB)를 보고한다. Engine API로는 둘을 구분할 수 없으므로, 세션의 workspace는 이름으로 유도하지 않고 무작위 접미사를 붙여 만든 뒤 **label로 조회한다.** GC나 운영자가 volume을 지워도 다음 것은 새 이름을 받으므로 상한이 다시 선다. 한 세션에 workspace가 둘 보이면 어느 쪽이 작업 트리인지 판단하지 않고 보고만 한다. preflight probe도 같은 이유로 매번 새 이름을 쓰고, 이전 실행이 남긴 probe는 label로 회수한다.

CPU·메모리·PID·tmpfs와 달리 `/workspace`에는 상한이 없었다. `EXECUTION_WORKSPACE_QUOTA_MB`(기본 4096)가 `local` 드라이버의 `size` driver option으로 그 상한이 된다. 단 이 옵션은 **daemon의 저장소가 project quota를 감당할 때만**(xfs + `prjquota`) 동작하고, 그렇지 않으면 daemon이 create를 `400 quota size requested but no quota support`로 거절한다. scheduler는 pass 전에 probe volume을 하나 만들어 보는 것으로 이 능력을 확인하고(`verifyWorkspaceQuota`), 감당하지 못하는 daemon에서는 **아무것도 띄우지 않고 종료한다.** 조용히 무제한으로 떨어지는 경로는 없고, 무제한을 감수하려면 `EXECUTION_WORKSPACE_QUOTA=off`를 명시해야 한다 — 그 경우 기동 로그에 경고 1건이 남는다. `on`·`off` 외의 값(`false`, `0`, `no`)은 오타로 보고 거절한다.

Docker Desktop은 커널 자체가 XFS quota 없이 빌드돼 있어(`XFS (loopN): quota support not available in this kernel`) 로컬에서는 `off`가 사실상 유일한 선택지다. GitHub Actions 러너의 daemon도 data root가 ext4라 마찬가지다. 그래서 실제 상한이 무는지는 CI의 `workspace-quota` job이 xfs + prjquota loop 파일을 data root로 쓰는 daemon을 따로 띄워 확인한다.

상한은 volume 하나에만 거는 것으로는 부족하다. Docker는 이미지가 선언한 `VOLUME` 경로마다 **쓰기 가능한 익명 volume**을 자동으로 붙이는데, 거기에는 상한도 label도 없다. 그래서 launch 전에 이미지를 조회해 `/workspace` 외의 `VOLUME` 선언이 있으면 거절하고(`ImageVolumeError`), 컨테이너를 지울 때는 `v=true`로 익명 volume을 함께 지운다(named volume인 workspace는 영향을 받지 않는다). 아직 pull되지 않은 이미지는 조회가 404이므로 그대로 두고 create가 같은 404를 내게 한다.

확인한 것과 실제로 띄우는 것 사이도 벌어질 수 있다. 태그는 가변이므로 컨테이너는 **조회한 이미지의 id**(`sha256:…`)로 만들고, volume은 create 직후 start 전에 한 번 더 확인한다 — 그 사이에 `docker volume prune`이 지나가면 Docker가 mount용으로 label도 상한도 없는 volume을 새로 만들어 주기 때문이다. 어긋나면 아직 아무것도 실행되지 않은 컨테이너를 지우고 실패시킨다.

quota preflight가 실패하면 **아무것도 띄우지 않되 회수는 한 번 돌린다.** probe도 디스크를 조금 쓰므로 이미 가득 찬 daemon은 preflight부터 실패하는데, 그 순간이 바로 끝난 세션의 workspace를 회수해야 할 때다. 그대로 종료하면 회수할 방법이 영영 없어진다. 이때 도는 것은 pass가 아니라 `reclaimWorkspaces` — 같은 advisory lock 아래에서 ④단계만 수행한다. slot limit 0짜리 pass로는 부족하다. 새 예약만 막힐 뿐 사라진 컨테이너를 재생성하고 stale 컨테이너를 교체하는 일은 그대로 하기 때문이다. 회수가 끝나면 원래 오류를 다시 던져 non-zero로 끝낸다.

상한은 **byte에만** 걸린다. Docker `local` 드라이버가 노출하는 것이 `size`뿐이고 daemon의 quota 구조체에 inode 필드가 없어서, Engine API로는 inode 상한을 표현할 방법이 없다. 작은 파일 수백만 개로 inode를 소진하는 경로는 아직 열려 있다(94S-224).

volume의 quota label이 지금 설정과 다르면 — 예전에 암묵 생성된 label 없는 volume이거나, 다른 상한으로 만들어진 volume이면 — 기동을 거절한다(`WorkspaceQuotaError`). 이름을 유도하던 시절의 `ap-ws-<installationId>-<sessionId>` volume도 계속 찾아본다. label이 없어 조회에는 걸리지 않지만, 못 본 척하고 새 workspace를 만들면 그 세션이 빈 트리로 시작하고 예전 트리는 묻히기 때문이다(마이그레이션은 94S-225). volume의 quota는 나중에 바꿀 수 없고, 바꾸겠다고 지우면 그 세션의 작업 트리가 날아가기 때문이다. 운영자가 해당 volume을 직접 정리하거나 이전 설정으로 되돌려야 한다. 같은 이유로 quota 설정은 `agent-platform.isolation` 지문에도 들어간다 — 그러지 않으면 이미 떠 있는 컨테이너가 예전 상한을 그대로 들고 계속 산다.

이 거절은 **이미 돌고 있는 worker를 죽이기 전에** 일어나야 한다. 지문이 바뀌면 stale 판정 → `terminate` → 재생성 순서인데, 재생성이 volume에서 거절당하면 그 세션은 worker도 없고 되돌아갈 길도 없는 상태로 남는다. 그래서 `inspect`는 stale을 보고하기 전에 그 세션의 volume을 읽기 전용으로 확인하고, 쓸 수 없는 volume이면 stale 대신 예외를 던진다 — 컨테이너는 예전 상한 그대로 계속 돌고, pass는 `reconcileFailed`로 non-zero를 내며, 운영자가 volume을 정리할 때까지 그 상태가 유지된다. 작업 트리를 살린 채 옮기는 마이그레이션 경로는 94S-225에서 따로 다룬다.

④단계의 GC는 fail-safe 방향이다. **volume을 먼저 나열하고 그 다음 DB에 묻는다** — 순서를 뒤집으면 두 호출 사이에 생긴 세션의 volume을 지운다. 남기는 조건은 session row가 있고 admission state가 `closed`가 아니거나 살아 있는 execution row가 있는 것이다. **`stopped`도 남긴다** — resume은 expected revision만 받고 같은 session id로 돌아오므로 같은 volume을 다시 쓴다. `closed`만이 돌아오지 않는 상태다. 그래서 stop만 해 둔 세션의 디스크는 close할 때까지 남고, 그것을 만료시키려면 resume과 직렬화된 claim이 필요하다(94S-225). session id label이 없거나 session id 모양이 아닌 volume, 아직 컨테이너가 물고 있는 volume(409), 다른 설치의 volume은 전부 **남기고 로그만 남긴다.** `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC`(기본 3600)보다 어린 volume은 아예 후보가 아니다 — volume은 컨테이너보다 먼저 만들어지므로 그 사이에 회수해 버리면 진행 중인 launch를 깨뜨린다. **판단으로 남긴 것과 실패로 남은 것은 exit code가 다르다.** 아직 마운트돼 있거나(409) 다른 설치 것이라 남긴 volume은 정상 상태이므로 exit code를 바꾸지 않는다(`workspacesUnresolved`). 반면 목록을 못 읽었거나 DB가 답하지 않았거나(`workspaceScanFailed`) 삭제 호출이 던진 경우(`workspacesFailed`)는 아무도 보지 않은 채 디스크가 쌓이는 상태이므로 pass가 non-zero로 끝난다.

### worker 네트워크: 주소 풀, slot limit, 회수

**주소 풀.** worker 네트워크 하나가 daemon의 `default-address-pools`에서 subnet 하나를 가져간다. Docker 기본 풀은 합쳐서 31개다.

* `172.17.0.0/16`~`172.31.0.0/16`의 /16 15개
* `192.168.0.0/16`을 /20으로 나눈 16개

이 중 `docker0`와 daemon 위의 다른 네트워크가 먼저 가져간다. 이 저장소의 compose는 `default` 하나를 쓴다. 그래서 기본값에서 worker에게 남는 것은 대략 **30개 − (그 daemon의 다른 네트워크 수)**다.

**slot limit과의 관계.** execution 하나는 네트워크를 하나만 쥔다. 교체(replace)는 이전 generation을 지운 뒤 새 것을 만든다. 그래서 동시에 쓰이는 worker 네트워크 수는 대략 `EXECUTION_SLOT_LIMIT`(기본 10)이다. 다만 풀은 **daemon 전역**이라 같은 daemon의 다른 설치·다른 compose 프로젝트와 나눠 쓴다. 회수에 실패해 남은 네트워크도 slot limit이 세지 않는다. 따라서 기본 풀로는 slot limit 10인 설치 두 개가 한 daemon에 겨우 들어간다.

**풀 넓히기.** 그보다 크게 쓰려면 daemon.json에서 풀을 넓힌다. 예: `{"default-address-pools":[{"base":"10.210.0.0/16","size":24}]}`는 /24 256개다.

* LAN·VPN과 겹치지 않는 대역을 고른다.
* size를 줄이면(`/28`이면 4096개) 그 daemon에서 자동 할당되는 **다른** 네트워크도 모두 작아진다. /28이면 컨테이너 13개까지다.
* daemon을 재시작해야 적용되고, 이미 있는 네트워크에는 적용되지 않는다.

**소진 시 동작.** 소진은 조용한 장애가 아니다. 네트워크 create가 `could not find an available, non-overlapping IPv4 address pool`로 실패한다. 그러면 그 launch는 `failedLaunches`로 기록되고 pass는 exit 1로 끝난다. intent는 남아 다음 pass가 다시 시도한다.

**회수는 두 겹이다.**

1. `terminate`: 컨테이너를 지운 뒤 proxy를 떼고 네트워크를 id로 지운다(best effort).
2. pass의 ②단계 끝, slot을 채우기 전(`reconcileNetworks`): 이 설치 label이 붙은 worker 네트워크를 전부 훑는다.
   * 이름에 대응하는 컨테이너가 **없으면**(어떤 상태로든) proxy만 떼고 네트워크를 지운다. 컨테이너를 `docker rm -f`로 지운 경우가 여기에 해당한다. launch가 아직 살아 있는 execution이면 ①단계가 컨테이너를 먼저 다시 만들었으므로 그 네트워크는 그대로 재사용된다.
   * 컨테이너가 **있으면** proxy attach를 확인하고, 떨어져 있으면 다시 붙인다. `compose up`이 proxy를 다시 만들면 새 proxy는 어느 worker 네트워크에도 붙어 있지 않다. 그래서 떠 있는 worker의 egress는 다음 pass(`SCHEDULER_INTERVAL_SEC`, 기본 5초)까지 끊긴다.

**회수 실패 시 동작.**

* 살아 있는 네트워크도 매 pass 같은 기준으로 다시 검사한다. 대상은 네트워크 모양, 이름에 대응하는 컨테이너가 이 설치의 그 worker인지, worker·proxy 외 구성원, worker가 다른 네트워크에도 붙었는지다. 교체를 앞두고 미리 만들어 둔 네트워크(아직 옛 컨테이너가 붙지 않은 것)는 문제로 보지 않는다.
* 모르는 구성원이 붙은 네트워크에서는 그 구성원을 떼어 내지 않는다. 강제로 떼면 흔적이 사라지기 때문이다. 대신 **이 설치의 proxy를 뗀다.** 모르는 컨테이너가 이 설치의 allowlist를 쓰지 못하게 하기 위해서다. 그 네트워크의 worker도 egress를 잃는다. 이런 네트워크는 그대로 두고 `networksFailed`로 보고하며 pass는 exit 1로 끝난다.
* 목록 조회 자체가 실패하면(`networkScanFailed`) 역시 exit 1이다.
* 남은 네트워크는 주소 풀을 계속 차지한다. 운영자가 `docker network inspect <name>`으로 구성원을 확인하고 정리한다.
* proxy가 없으면 preflight에서 종료하므로 이 회수도 돌지 않는다. 대신 새 네트워크도 생기지 않아 누수가 늘지 않고, proxy가 돌아온 뒤 첫 pass가 회수한다.

같은 daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 주고, egress proxy도 설치마다 따로 두어 각자의 id로 label을 단다. worker 네트워크 이름·label에 설치 id가 들어가므로 설치 A의 worker 네트워크에는 A의 proxy만 붙는다. 하나의 proxy를 두 설치가 쓰면 두 설치의 worker가 같은 allowlist를 쓰게 된다.

```bash
docker compose -f infra/docker-compose.yml up -d egress-proxy
docker network ls --filter label=agent-platform.worker-network=true \
  --format '{{.Name}} {{.Labels}}'
```

실제 Docker daemon 대상 테스트는 `DOCKER_BACKEND_TEST=1`로 opt-in한다(`busybox:1.36`을 sleep으로 띄움). egress suite는 backend가 띄운 worker 셋(설치 둘)으로 worker 사이 차단과 proxy 재부착·orphan 네트워크 회수를 보고, internal 네트워크·바깥 네트워크·upstream 두 개·host `openssl`로 만든 인증서를 쓰는 TLS upstream·그 인증서로 LocalStack 앞에 세운 TLS front(https S3 endpoint)·`oven/bun:1.3.10`으로 띄운 proxy를 직접 만들어 컨테이너 안에서 `wget`·`nc`·`curlimages/curl`로 확인하며 인터넷을 쓰지 않는다(이미지 pull 제외). scheduler의 15 세션 → 컨테이너 ≤ 10 검증은 `QUEUE_DATABASE_URL`까지 있어야 실행된다.

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
AUTH_MODE=none PORT=3000 CHECKPOINT_OBJECT_STORE=disabled bun run --cwd apps/api start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

API는 checkpoint object store 설정을 기동 시 요구한다 — `S3_BUCKET`·`AWS_REGION`·`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`(+ 선택 `AWS_ENDPOINT_URL`, scheduler·worker와 같은 이름)가 없으면 기동하지 않는다. object store 없이 띄우려면 `CHECKPOINT_OBJECT_STORE=disabled`를 명시한다: 모든 checkpoint가 거절되고 워커 checkpoint 프로토콜은 409 `CHECKPOINT_UNAVAILABLE`로 답하며 기동 로그에 경고가 남는다. 빠진 bucket이 checkpoint 없는 finalize 뒤에 숨지 않도록 침묵 기본값을 두지 않았다. compose `apps` profile은 localstack 값을 기본으로 넣는다.

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest만 저장한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/api keys create local-owner
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
  bun run --cwd apps/api start
curl -H 'Authorization: Bearer <issued-key>' http://127.0.0.1:3000/v1
```

웹 콘솔은 같은 `/v1`을 cookie 세션으로 호출한다(94S-151). 처음 한 번 `POST /v1/auth/bootstrap`이 첫 owner와 기본 workspace를 만드는데, `BOOTSTRAP_TOKEN`이 일치하고 `users`가 0행일 때만 통과하며 이후 호출은 `409 BOOTSTRAP_DONE`이다. `BOOTSTRAP_TOKEN`을 주지 않으면 API가 기동 시 하나를 생성해 stderr에 `BOOTSTRAP_TOKEN=…` 한 줄로 출력한다(users가 0행일 때만, 구조화 로그는 토큰 필드를 가리므로 거기엔 없다). 로그인은 `POST /v1/auth/login`(email·password, argon2id)이며 `__Host-ap_session` cookie(`HttpOnly; Secure; SameSite=Lax; Path=/`, Domain 없음, 14일 sliding)를 세운다. `__Host-` 접두사라 형제 서브도메인이 같은 이름의 cookie를 심어 가리지 못한다. 미들웨어는 `Authorization` 헤더가 있으면 그것만 평가하고(잘못되거나 비었거나 Bearer가 아닌 헤더를 cookie로 대체하지 않음) 헤더가 없을 때만 cookie를 본다. cookie principal의 상태 변경 요청은 `X-Requested-With: agent-platform-web` 헤더가 없으면 `403`이다(bearer 경로에는 적용되지 않음). login은 cookie를 세우므로 호출자와 무관하게 같은 헤더가 필요하다(없거나 cross-site면 `403`, login CSRF로 피해자를 공격자 계정에 로그인시키는 것을 막는다). 사용자당 live 세션은 10개까지이고, login이 그 사용자의 만료·폐기된 row를 지우고 가장 오래된 세션부터 밀어낸다. 로그인 실패는 email당 5회/15분 뒤 `429`. 주소를 바꿔 가며 시도해도 비밀번호 검증(argon2id)은 프로세스당 동시 4개·대기 64개까지만 받고 넘치면 조회 전에 `429`(`Retry-After: 1`)로 끊는다. IP 단위·replica 공통 제한은 ingress가 맡는다. `GET /v1/auth/me`가 선택된 principal·user·workspace를 돌려준다. `AUTH_MODE=none`에서는 cookie 경로가 꺼지고 `X-Owner-Id`만 본다. 기동 로그(stderr)를 설치자가 아닌 사람도 읽는 배포에서는 `BOOTSTRAP_TOKEN`을 직접 넣어 자동 생성 경로를 쓰지 않는다 — 자동 생성 토큰은 첫 owner가 생길 때까지 그 로그를 읽는 누구에게나 bootstrap 권한을 준다. 설정한 값은 32~256자여야 하며 벗어나면 API가 기동하지 않는다. 빈 값(`BOOTSTRAP_TOKEN=`)도 설정 실패로 보고 기동하지 않는다.

```bash
curl -s -X POST http://127.0.0.1:3000/v1/auth/bootstrap -H 'Content-Type: application/json' \
  -d '{"bootstrap_token":"<token>","email":"owner@example.com","password":"<12+ chars>","display_name":"Owner","workspace_name":"Acme","workspace_slug":"acme"}'
curl -s -c jar -X POST http://127.0.0.1:3000/v1/auth/login -H 'Content-Type: application/json' \
  -H 'X-Requested-With: agent-platform-web' \
  -d '{"email":"owner@example.com","password":"<12+ chars>"}'
curl -s -b jar http://127.0.0.1:3000/v1/auth/me
curl -s -b jar -X POST http://127.0.0.1:3000/v1/auth/logout -H 'X-Requested-With: agent-platform-web' -i
```

### 이미지와 Compose `apps` profile

세 앱 이미지는 `apps/{api,worker,scheduler}/Dockerfile`이 정의한다. 셋 다 저장소 루트를 context로 `oven/bun:1.3.10`의 multi-arch index digest 하나를 base로 pin하고(`tests/images.test.ts`가 세 파일의 digest 일치를 검사), `bun install --frozen-lockfile --production`으로 workspace closure만 설치한 뒤 runtime stage로 복사한다.

| 이미지 | 내용 | 실행 주체 |
|---|---|---|
| `agent-platform-api` | `apps/api` 서버 + `apps/reconciler` one-shot. `--filter`로 두 앱의 closure만 설치하며 Agent SDK·Claude Code executable을 담지 않는다(빌드가 `node_modules/@anthropic-ai` 부재를 확인). uid 1000 | `bun run apps/api/src/server.ts` (reconciler는 `bun run apps/reconciler/src/main.ts`) |
| `agent-platform-worker` | SDK 0.3.270과 번들 Claude Code 2.1.270, git, non-root(uid 1000), `/workspace`를 1000 소유로 미리 생성(LocalDockerBackend의 volume 계약). 빌드 시 `resolvePinnedClaudeExecutable()`로 executable 경로를 확정해 `/usr/local/bin/claude`로 걸고 `claude --version`을 실행한다 | `bun run apps/worker/src/main.ts` — scheduler가 env로 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프를 돈다 |
| `agent-platform-scheduler` | `apps/scheduler` one-shot. Docker socket을 mount하는 유일한 서비스이며 root로 실행한다(socket 소유자는 어차피 daemon host의 root와 같고, socket gid는 daemon마다 달라 고정 uid가 이식성을 깎기만 한다) | compose에서는 `sh` 루프가 `SCHEDULER_INTERVAL_SEC`(기본 5초)마다 한 pass를 실행. 앱 자체는 one-shot 계약을 유지한다. 실패 pass가 `SCHEDULER_MAX_CONSECUTIVE_FAILURES`(3)번 이어지면 루프가 exit 1 해 `restart: unless-stopped`가 재시작하고(`compose ps`에 드러남), `SCHEDULER_HEALTH_STALE_SEC`(60초) 동안 성공 pass가 없으면 healthcheck가 unhealthy가 된다. DB가 멈추면 pass가 스스로 exit 1로 끝난다: scheduler·reconciler pool은 API와 같은 timeout(connect 5초·statement 10초·read 20초, `packages/db/src/pool.ts`의 `JOB_POOL_TIMEOUTS`)을 쓰고, 연결을 한 번 잃은 뒤의 store 호출은 기다리지 않고 바로 실패하므로 DB 대기는 실패한 statement(5+20초)와 pass lock 해제(20초)를 합친 약 45초가 상한이다(실측: pass 전 정지 5초, pass 중 정지 약 40초). `SCHEDULER_PASS_TIMEOUT_SEC`(120초)는 이 45초보다 크게 두는 바깥 watchdog이며, 상한이 없는 Docker 호출 등 그 밖의 hang을 kill해 실패로 센다(unhealthy만으로는 Docker가 재시작하지 않는다). pool timeout을 늘리면 이 값도 `connect + 2 × read`보다 크게 올린다 |

```bash
docker compose -f infra/docker-compose.yml --profile worker build          # WORKER_IMAGE(agent-platform-worker:dev)
docker compose -f infra/docker-compose.yml --profile worker run --rm worker claude --version
docker compose -f infra/docker-compose.yml --profile apps up -d --build      # migrate → api(/readyz healthcheck) → scheduler 루프
curl -s http://127.0.0.1:3000/readyz
```

`apps` profile의 값은 전부 기본값이 있어 환경 파일 없이 뜬다. `DATABASE_URL`만은 예외로 항상 compose의 postgres를 가리킨다 — `up`이 migrate를 실행하므로 셸이나 환경 파일에 있는 다른 DSN이 로컬 스택 기동만으로 migrate되면 안 된다. `AUTH_MODE` 기본값은 `api-key`다 — 워커가 proxy 경유로 `api:3000`에 닿으므로 `none`이면 워커 안의 코드가 `X-Owner-Id`로 아무 owner 행세를 할 수 있다(`/internal` 워커 라우트는 자체 인증). 키는 `docker compose -f infra/docker-compose.yml exec api bun run apps/api/src/keys.ts create <owner>`로 발급한다. API 포트는 `127.0.0.1:3000`에만 바인드한다. `EXECUTION_WORKSPACE_QUOTA`는 compose에서 기본 `off`다 — Docker Desktop은 project quota를 감당하지 못하므로(94S-215) 로컬 스택은 무제한 workspace를 감수하고 기동 로그에 경고 1건이 남는다; xfs+prjquota daemon이면 `on`으로 되돌린다. 나머지 값은 `.env` 없이 뜬다. `.env`가 있으면 읽되(`required: false`) 만들거나 덮어쓰지 않는다. `SESSION_CATALOG_JSON`만 기본값이 없다 — 빈 문자열은 JSON parse 실패로 API가 기동하지 않으므로 세션을 만들려면 `.env`에 넣는다. worker 컨테이너는 compose 서비스가 아니라 scheduler가 세션마다 띄운다. `worker` profile 항목은 그 이미지를 빌드·검사하기 위한 것이며 `network_mode: none`으로 서비스로 돌지 않는다. 워커는 proxy 경유로 `api:3000`(`EGRESS_PRIVATE_ALLOWLIST` 기본값에 포함)·`gitea:3000`·`localstack:4566`에 닿고, 직접 연결과 metadata 주소는 internal 네트워크가 막는다.

같은 daemon에 두 설치를 올리면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. compose의 `egress-proxy` label은 이 값을 따르므로 설치마다 자기 proxy가 붙는다. 다른 worktree의 compose project가 기본 포트를 잡고 있으면 `-p <name>`과 `ports: !override` override 파일로 분리한다.

`.github/workflows/images.yml`은 PR·main push마다 세 이미지를 빌드하고 worker에서 `claude --version`이 2.1.270인지, api·scheduler에 `@anthropic-ai`가 없는지 확인한 뒤 digest JSON을 `image-digest-<app>` artifact로 남긴다. `v*` tag의 **push 이벤트**에서만(`workflow_dispatch`는 어떤 ref든 지정할 수 있어 이벤트도 본다) `publish`·`promote` job이 `ghcr.io/<owner>/agent-platform-<app>`으로 게시한다. 두 job만 package write 권한을 가지며 `release` environment에서 돌고, tag가 가리키는 commit이 `main`의 조상이 아니면 실패한다(tag는 리뷰가 아니다). `publish`는 이미지마다 run 전용 staging tag로 push한 뒤 그 digest를 pull해 같은 smoke(`.github/scripts/image-smoke.sh`)를 통과시키고, `promote`가 세 digest가 모두 통과한 뒤에야 `vX`·`sha-…` tag로 retag한다(registry-side, 재빌드 없음). 이 run의 staged digest가 release candidate다. 기존 tag가 다른 digest를 가리키면 아무 tag도 쓰기 전에 실패하고(한 버전이 두 build attempt의 이미지로 섞이지 않는다), 조회 자체가 실패하면(인증·rate limit·5xx) "없음"으로 보지 않고 중단한다(fail-closed). tag를 쓴 뒤 여섯 reference를 다시 읽어 candidate와 같을 때만 `image-digests-published` artifact를 만든다. retag는 저장소별로 순서대로 일어나므로 중간에 실패하면 세트가 반만 tag된 채 남는다 — 그때는 **같은 run의 "Re-run failed jobs"**로 채운다(publish job은 다시 돌지 않아 staged artifact와 digest가 그대로다). tag를 다시 push하면 새 build(worker의 apt layer는 pin되지 않는다)라 거부된다. 세 digest를 한 번에 커밋하는 소비자용 release manifest는 D5이며, 그 전까지는 초록 run의 `image-digests-published` artifact가 세트의 기록이다. `release` environment의 required reviewer·deployment branch 규칙은 저장소 설정에서 건다. registry CD는 D5다.

`FAKE_SDK`, `scripts/dev`, `/ui`, 워커 턴 루프(94S-122)는 후속 티켓 범위다. 세션 HTTP endpoint는 D1에서 구현됐다.

## CI에서 실행되는 것

`.github/workflows/images.yml`은 ci.yml과 별도 workflow로 세 앱 이미지를 빌드·smoke하고 digest artifact를 남긴다([§ 이미지와 Compose `apps` profile](#이미지와-compose-apps-profile)). 아래는 ci.yml이다.

`.github/workflows/ci.yml`은 `main` push와 모든 pull request에서 먼저 `check`를 실행하고, 성공하면 `integration`을 돌린다. 기본 검사 실패·취소 시에는 무거운 서비스 컨테이너를 시작하지 않는다. 성공한 변경의 테스트 범위는 그대로지만, 실패한 변경에서는 통합 진단 결과를 얻으려면 먼저 `check`를 고쳐야 한다. 성공 경로의 대기 시간은 `check` 실행 시간만큼 늘어날 수 있다. 같은 커밋이 push와 pull_request로 두 번 돌지 않게 push는 `main`으로만 제한했다.

`spikes`는 **pull request에서는 돌지 않는다.** 결과가 어차피 run을 막지 않으므로(아래 참고) PR 커밋마다 돌려도 `main` push가 주는 신호 이상을 얻지 못한다. `main` push와 수동 실행에서만 돈다. spike 코드를 건드린 PR은 `-f only=spikes`로 직접 확인한다.

네 job의 OS는 `ubuntu-24.04`로 고정한다. `ubuntu-latest`의 자동 major-version 변경을 피하기 위한 것이며, runner 이미지의 패치 업데이트까지 고정하는 것은 아니다. `timeout-minutes`는 관측된 최장 실행(`check` 6분, `integration` 4분, `workspace-quota` 4분, `spikes` 6분)에 맞춰 10/12/15/15분으로 좁혔다. 한 번 멈춘 job이 태우는 분의 상한이지 정상 실행에 거는 제약이 아니다.

그 대가로 **pull request가 없는 브랜치에 push하면 CI가 돌지 않는다.** PR을 열기 전에 확인하고 싶으면 `workflow_dispatch`로 수동 실행한다(`gh workflow run CI --ref <branch>`). tag push도 빌드하지 않는다 — 태그가 가리키는 트리는 이미 main push에서 돌았다. merge queue를 켜려면 `merge_group` 이벤트를 따로 추가해야 한다.

`concurrency`는 PR이면 PR 번호로 묶어 새 push가 이전 run을 취소한다. `main` push는 기존처럼 run 단위로 분리해 연속 merge를 모두 검증한다. 수동 실행은 기본적으로 workflow·이벤트·ref·SHA가 같은 진행 중 run을 대체해 실수로 여러 번 실행한 작업의 중첩을 줄인다. 다른 브랜치·다른 SHA·PR·main push를 취소하지 않고, 이미 끝난 run의 재실행까지 막는 것은 아니다. 식이 `inputs.*`가 아니라 `github.event.inputs.*`를 읽는 이유는 API 경유 dispatch가 입력을 문자열로 보내기 때문이다 — 문자열 `"false"`는 truthy라 `!inputs.allow_parallel`이면 기본값이 조용히 "병렬 허용"으로 뒤집힌다.

### 수동 실행 옵션

```bash
gh workflow run CI --ref <branch>                          # 세 job (spikes 포함)
gh workflow run CI --ref <branch> -f only=spikes           # spikes만
gh workflow run CI --ref <branch> -f allow_parallel=true   # 진행 중 수동 run을 취소하지 않음
```

`only`는 그 job 하나만 남기고 나머지를 건너뛴다. flaky 추적처럼 한 job의 결과만 필요한 수동 실행에서 나머지 job 값을 내지 않기 위한 것이다.

`allow_parallel=true`는 수동 실행을 run별로 분리하므로 같은 SHA를 반복 실행해도 서로 취소되지 않는다. flaky 표본은 이것으로 모은다 — `only=spikes`와 함께 N번 dispatch한다. 기존 브랜치는 변경된 workflow를 가져와야 이 기본값들이 적용된다.

예산 `$0`과 사용 중지를 유지한다. 포함 분이 소진되어 GitHub가 job을 시작하지 않으면 재시도해도 복구되지 않는다. 한도 초기화 또는 별도로 승인된 runner 대안이 필요하며, CI 최적화는 이미 사용한 분을 되돌리지 않는다.

외부 action은 태그가 아니라 **커밋 SHA로 고정하고 버전은 뒤 주석에 적는다.** 태그는 움직인다 — 메인테이너(혹은 탈취된 계정)가 `v7`을 임의 커밋으로 다시 가리키면 다음 run이 그 코드를 받는다. 릴리스 태그를 악성 커밋으로 옮기는 것이 tj-actions/changed-files 공급망 공격이 수천 개 저장소에 닿은 경로였다. 고정만 하고 방치하면 그 자체가 문제이므로 `.github/dependabot.yml`이 주 1회 올린다(composite action은 `directory`를 따로 잡아야 스캔된다). 올라온 PR에서는 새 버전이 요구하는 러너 버전도 같이 본다.

bun 버전 고정과 `~/.bun/install/cache` 캐시는 `.github/actions/bun-setup`에 모여 있다. 캐시 키는 **그 job이 실제로 설치하는 lockfile만** 해시한다 — `check`가 쓰는 `bun-root-*`는 root lockfile만, `spikes`가 쓰는 `bun-spikes-*`는 root와 두 spike lockfile을 함께 해시한다. 키가 세 lockfile을 약속하면서 root만 설치한 job이 저장하면, spike 전용 의존성은 exact hit인데도 매번 다시 받게 된다. scope마다 쓰기 job은 하나뿐이라 같은 키에 동시 저장하는 레이스도 없다.

| job | 서비스 컨테이너 | 켜지는 opt-in 변수 | 실행 명령 | 머지 차단 |
|---|---|---|---|---|
| `check` | 없음 | 없음 | `bun run check` (typecheck → Biome → `bun test tests packages apps`) | ✅ |
| `integration` | `postgres:16`, `localstack/localstack:3` | `QUEUE_DATABASE_URL`, `STORAGE_LOCALSTACK_TEST=1`, `DOCKER_BACKEND_TEST=1` | `bun run test` + `bun test ./apps/api/src/server.integration.ts` | ✅ |
| `workspace-quota` | 없음 — xfs+prjquota loop 파일을 data root로 쓰는 dind daemon을 job이 직접 띄운다 | `DOCKER_BACKEND_TEST=1`, `DOCKER_HOST` | `bun test packages/adapters/execution/local-docker/src/workspace.integration.test.ts` | ✅ |
| `spikes` | `localstack/localstack:3` | `SESSION_STORE_LOCALSTACK_TEST=1` | `spikes/94s-91 probe:version`·`check`, `spikes/94s-92 check` (uv로 `litellm[proxy]==1.100.1` 설치) | ❌ |

`check`는 opt-in 변수를 하나도 켜지 않으므로 PostgreSQL·LocalStack·Docker를 요구하는 테스트가 **의도적으로 skip된다**. 반대로 외부 의존이 없는 테스트는 파일 이름에 `integration`이 들어 있어도 여기서 그대로 돈다 — 로컬 fake Messages API를 쓰는 SDK adapter suite가 그렇다. 같은 스위트를 `integration`이 변수를 전부 켠 채 다시 돌려 skip 0으로 만든다. 파일 이름으로 integration만 골라 돌리지 않는 이유는 `packages/storage/src/localstack.test.ts`처럼 `*.integration.test.ts` 규칙을 따르지 않으면서 opt-in에 걸린 테스트가 있어서다 — 이름 필터는 테스트를 조용히 빠뜨린다. 로그에서 pass 숫자만 보지 말고 `check`의 skip 수와 `integration`의 skip 0을 같이 확인한다.

`DOCKER_BACKEND_TEST=1`은 runner에 딸린 Docker daemon으로 `LocalDockerBackend` 테스트를 돌리게 한다(94S-123). `SESSION_STORE_LOCALSTACK_TEST`는 `spikes/94s-92`만 읽으므로 `spikes` job에만 있다.

`workspace-quota` job은 runner의 daemon으로는 확인할 수 없는 절 하나만을 위해 있다. workspace volume의 byte 상한은 daemon 저장소가 project quota를 감당할 때만 서는데(xfs + `prjquota`) runner의 data root는 ext4다. 그래서 이 job은 loop 파일에 xfs를 만들어 `prjquota`로 mount하고 그것을 data root로 쓰는 dind daemon을 띄운 뒤 workspace suite를 그쪽에 붙인다 — 상한을 넘는 `dd`가 실제로 `No space left on device`로 끝나는지, 그리고 volume을 지운 뒤 만든 다음 workspace에도 상한이 서는지 확인하는 곳은 여기뿐이다. 같은 suite가 `integration` job에서는 반대쪽 절을 확인한다: 상한을 걸 수 없는 daemon에서 scheduler가 기동을 거절하는지.

`spikes/94s-91`·`spikes/94s-92`는 조사용 harness이고 지금까지 CI 실패가 전부 flaky였다(제품 회귀 0건, 94S-198 조사 코멘트 참조). 그래서 `spikes` job은 `continue-on-error: true`로 workflow run을 실패시키지 않는다. 한쪽이 실패해도 다른 쪽은 그대로 실행한다.

**이 설정이 무엇을 숨기는지 분명히 해둔다.** `spikes` check-run 자체는 실패로 남아 PR checks 목록에 빨갛게 보이지만(실측: 커밋 `2640693`에서 `spikes=failure`, run `conclusion=success`), run 결론만 읽는 소비자 — 알림, 대시보드, release automation — 에게는 spike 회귀가 보이지 않는다. 그래서 job 마지막에 두 suite의 outcome을 run summary에 적는다(취소되지 않은 run이면 언제나 — 취소·timeout으로 job이 끊기면 이 표도 남지 않는다). 여기에 더해 **어느 한 suite의 outcome이 `success`가 아니면 GitHub 이슈를 연다**(setup이 깨져 suite가 돌지 못한 경우 포함; job timeout·cancel과 이슈 호출 자체의 실패는 아직 못 잡는다 — 후속 티켓)(이 job은 PR에서 돌지 않으므로 `main` push와 수동 실행이 대상이고, 이슈 본문에 ref·SHA·run이 적힌다)(94S-238, label `ci-spikes-failure`). 같은 label로 열린 이슈가 있으면 새로 만들지 않고 그 이슈에 코멘트를 붙이므로 반복 실패가 이슈로 쌓이지 않는다. 사람이 닫으면 다음 실패는 새 이슈가 된다. `.github/scripts/upsert-ci-issue.sh`가 이 upsert를 맡고, 이슈 조회는 search API가 아니라 list API로 한다 — search는 인덱싱이 늦어 몇 분 간격의 두 run이 각자 이슈를 만든다. 같은 순간에 두 run이 실패하면 둘 다 빈 목록을 보고 각자 만들 수 있으므로, 만든 뒤 다시 조회해 자기 것이 가장 오래된 열린 이슈가 아니면 중복으로 닫고 본문을 그쪽에 붙인다.

**`spikes`를 required로 올리지 않는 이유**도 여기 적어 둔다(`ci.yml`의 job 주석과 같다). (1) PR에서 돌지 않는 context를 required로 걸면 모든 PR이 `Expected — Waiting for status`로 멈춘다. (2) PR에서 다시 돌리면 94S-232가 걷어낸 비용이 되살아난다 — 세 job 중 가장 비싼 job이다. (3) 모든 `main` push에서 이미 돌아 회귀가 한 커밋 안에 잡히므로 PR 게이팅이 더해 주는 것이 없다. 남는 위험은 "회귀가 들어간다"가 아니라 "들어간 걸 아무도 모른다"였고, 그것을 위 이슈가 메운다.

**push run 자체가 누락되는 경우**는 `ci.yml`이 감지할 수 없다 — run이 없으니 아무것도 돌지 않는다(실측: `70139eb`에 `event=push` run 0건). `.github/workflows/main-push-run.yml`이 하루 두 번 최근 36시간의 `main` 커밋 각각에 `ci.yml`의 `event=push` run이 있는지 `.github/scripts/check-main-push-run.sh`로 확인하고(tip만 보면 누락 커밋 뒤에 정상 push가 오는 순간 영영 못 본다), 없으면 label `ci-missing-push-run`으로 **커밋마다** 이슈를 연다(같은 upsert의 `--by-title` 모드: label + 정확한 제목이 식별자이고 제목에 커밋 SHA가 있다). 커밋은 나중에 push run이 생기지 않으므로 사람이 닫은 이슈는 그 커밋의 확인으로 간주해 다시 열지 않고, 다른 커밋의 누락을 거기에 덧붙이지도 않는다. 조회 실패(API 오류)는 `missing`과 exit code가 달라(2 vs 1) 워크플로가 실패로 남는다 — 일부만 판정한 목록을 답으로 치지 않는다. 갓 push된 커밋은 run이 생기기까지 시간이 걸리므로 15분 미만은 판정하지 않는다. `gh workflow run 'main push run' -f sha=<commit>`으로 특정 커밋을 검사할 수 있다.

**재시도 wrapper는 94S-217에서 걷어냈다.** 이 job은 `continue-on-error`라 실패가 머지를 막지 않으므로 재시도가 사는 것은 안전이 아니라 flaky가 보일 확률의 감소뿐이었다 — 재현율 14%가 2%가 된다. 94s-92의 LocalStack timeout이 233 run 동안 숨어 있던 방식이 정확히 그것이다. 두 suite는 이제 자기가 어디서 멈췄는지 stderr로 말하므로(`STEP_STUCK`, 테스트 단위 deadline watchdog) 첫 발생에서 바로 이름이 찍혀야 의미가 있다. `.github/scripts/retry-flaky.sh`와 `tests/retry-flaky.test.ts`는 계약 그대로 남겨 두었다 — 호출하는 job만 없앴다.

`main` branch protection은 **`check`와 `integration`을 둘 다 required로** 켜 두었다. 재구성 전에는 `check` 하나가 PostgreSQL·LocalStack 검증까지 포함했으므로, 이름이 같다는 이유로 `check`만 required로 두면 `integration`이 실패한 PR도 머지된다. `spikes`는 required에서 제외한다. **`workspace-quota`는 아직 required가 아니다** — 켤 때 함께 넣는다. 이 job이 확인하는 것(상한이 실제로 무는지)은 다른 어떤 job도 확인하지 못하므로, required가 아닌 동안에는 빨간 `workspace-quota`를 사람이 직접 봐야 머지를 막을 수 있다.

**건너뛴 job은 GitHub의 required-check 판정에서 성공으로 센다** — 성공 상태는 `success`·`skipped`·`neutral` 셋이다([Status checks](https://docs.github.com/en/pull-requests/reference/status-checks)). 비용 절감을 위해 job을 건너뛰게 만든 이번 변경은 그래서 두 가지 주의를 남긴다.

1. `needs`로 건너뛴 `integration`도 통과로 보이므로 `integration`만 required로 두면 안 된다. `check`도 함께 required여야 `check` 실패가 머지를 막는다.
2. `only=`를 쓴 수동 실행은 건너뛴 job을 **그 커밋에 성공으로 기록한다.** branch protection을 켠 뒤에는 PR head SHA에 대고 `only=`를 쓰지 않는다. 필요하면 PR을 열기 전 브랜치에서 쓰거나, 검증은 PR 자동 실행에 맡긴다.

반대로 **workflow 전체가 건너뛰어지면**(path·branch 필터, commit message) 체크는 `pending`으로 남아 머지를 막는다. 그래서 비용을 줄이려고 `on:`에 `paths` 필터를 거는 방식은 여기서 쓰지 않았고, 건너뛰기는 전부 job 단위 `if:`로만 한다.

## SDK와 LiteLLM 방향

`@anthropic-ai/claude-agent-sdk`는 `packages/adapters/runtimes/claude/src/{runtime,run}.ts` 안에서만 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. 설정·인증·버전·모델 alias와 검증 조건은 [설계서 §9](docs/DESIGN.md#9-dockerfile)에 둔다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 94S-91 transport gate는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 아직 워커 턴 루프나 배포 검증을 대신하지 않는다.

## 라이선스

이 저장소는 **source-available이지 오픈소스가 아니다.** 읽고 감사할 수 있도록 공개할 뿐,
공개 자체가 사용권을 주지 않는다. 실행·복제·수정·배포와 이 소프트웨어를 이용한 서비스
제공은 저작권자의 사전 서면 허가가 있어야 한다. 전문은 [LICENSE](LICENSE)에 있다.

기여는 지금 받지 않는다. 외부 기여가 섞이면 저작권자가 이 소프트웨어를 상용으로
라이선스할 수 있는 여지가 좁아지기 때문이다.

# 실행 기반과 worker 격리

reconciler·scheduler가 worker를 띄우고 회수하는 방식, worker 격리, 멈춘 세션의 복구, worker workspace와 worker 네트워크의 상한과 회수를 적는다. 설정값 표는 [설정 레퍼런스](configuration.md)에, 카탈로그·자격 증명·인증은 [API 서버](api-server.md)에 있다.

## reconciler·scheduler와 worker 격리

reconciler pass(`main.ts reconciler --once`, package script `reconciler`)는 한 batch만 처리한 뒤 종료한다. lease 기한은 스스로 해석하지 않는다 — API가 heartbeat를 받을 때 `workers.lease_expires_at`에 마감 시각을 적고 reconciler는 그 시각과 DB 시계를 비교한다. `HEARTBEAT_TTL_SEC`는 API만 읽으며(기본 30, 20 이하이거나 86400을 넘으면 기동 거부 — [API 설정](configuration.md#api-설정) 참고), reconciler는 이 값이 설정돼 있으면 기동하지 않는다. 실제 변경 전에 대상만 확인하려면 dry-run을 명시한다. 미처리 row 또는 `queued` turn만 자동 재전달하며, 실행 중이거나 상태를 증명할 수 없는 row는 session을 `failed`로 전환하고 명시적 복구 대상으로 남긴다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
RECONCILER_DRY_RUN=true \
  bun run --cwd apps/control-host reconciler

DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
RECONCILER_DRY_RUN=false \
  bun run --cwd apps/control-host reconciler
```

compose의 `apps` profile에서는 `reconciler` 서비스가 이 pass를 기본으로 반복 실행한다. role 이름만 준 `main.ts reconciler`가 감독 루프(`apps/control-host/src/pass-loop`)이고, pass는 루프가 띄운 자식 프로세스(`main.ts reconciler --serve`)에서 돈다. 자식은 루프가 IPC로 요청할 때마다 pass를 하나 돌리고 다음 요청을 기다린다. pass마다 bun을 새로 띄우고 모듈을 다시 읽으면 pass 자체보다 몇 배의 CPU가 들어, 놀고 있는 스택에서도 role 하나가 코어의 수십 %를 썼기 때문이다. pool은 지금도 pass마다 새로 열고 닫는다. 실패한 pass, 제한 시간을 넘겨 kill된 pass, 종료 신호를 받은 pass는 자식과 함께 끝나므로 다음 pass는 새 프로세스에서 돈다. pass 사이에 자식이 죽으면 실패 pass로 센다. pass는 겹치지 않고 직렬로 돈다. healthcheck는 `main.ts reconciler --health`다. 루프가 SIGTERM을 받으면 새 pass를 시작하지 않고 진행 중 pass에 SIGTERM을 보낸 뒤 10초 뒤 SIGKILL한다. 쓰기마다 트랜잭션이라 어디서 끊겨도 잃는 것이 없다. compose `stop_grace_period`는 20s다.

| 설정 | 기본 | 의미 |
|---|---|---|
| `RECONCILER_INTERVAL_SEC` | 10 | pass가 끝난 뒤 다음 pass까지 쉬는 시간 |
| `RECONCILER_PASS_TIMEOUT_SEC` | 60 | 이 시간을 넘긴 pass는 SIGTERM, 10초 뒤 SIGKILL로 끝내고 실패로 센다. DB가 멈춘 pass가 pool timeout으로 스스로 끝나는 약 45초보다 크게 둔다 |
| `RECONCILER_MAX_CONSECUTIVE_FAILURES` | 3 | 실패 pass가 이만큼 이어지면 루프가 exit 1 하고 `restart: unless-stopped`가 재시작한다. 그보다 적으면 다음 pass가 곧 재시도다 |
| `RECONCILER_HEALTH_STALE_SEC` | 90 | healthcheck는 마지막으로 끝난 pass가 실패했거나, 진행 중인 pass가 제한 시간을 넘겼거나, 이 시간 동안 성공한 pass가 없으면 unhealthy다. 성공 직후 멈춘 pass도 제한 시간에서 바로 unhealthy가 된다. `RECONCILER_INTERVAL_SEC + RECONCILER_PASS_TIMEOUT_SEC`보다 커야 기동한다 |
| `RECONCILER_STATUS_FILE` | `/tmp/reconciler-status.json` | 루프가 pass마다 갱신하는 상태(`lastSuccessAt`·`lastDegradedAt`·`lastFailureAt`·`lastFailureReason`·`consecutiveFailures`·`lastPassDurationMs`, 진행 중인 pass의 `passDeadlineAt`). healthcheck가 읽는다 |
| `RECONCILER_BATCH_SIZE` | 100 | pass의 각 단계(orphan·lease·interrupt 회수, 기한을 넘긴 interrupt·terminate receipt의 `unknown` 마감, 입력 대기 알림)가 한 번에 처리하는 row 수 상한. 남은 row는 다음 pass가 처리한다. scheduler의 terminate 기한 sweep은 이 값을 읽지 않고 pass마다 고정 상한 100개씩 처리한다 |

최근 성공·실패는 `docker compose -f infra/compose.yml exec reconciler cat /tmp/reconciler-status.json`과 로그의 `Reconciler pass completed`/`Reconciler pass failed`로 본다. reconciler 서비스는 환경 파일을 읽지 않는다 — 환경 파일에 흔히 있는 `HEARTBEAT_TTL_SEC`를 받으면 기동을 거부하기 때문이다. 위 값은 `docker compose`를 실행하는 셸에서 준다. 단 compose는 `RECONCILER_STATUS_FILE`과 `RECONCILER_DRY_RUN`을 넘기지 않는다. 그래서 compose의 reconciler는 셸 값과 상관없이 기본 경로에 상태를 쓰고, 언제나 실제로 고친다. dry-run은 위 예시처럼 pass를 직접 한 번 돌려서 확인한다. reconciler 컨테이너에는 Docker socket이 없다. reconciler는 epoch fence와 `desired_state = terminated`만 DB에 적고, 컨테이너 제거와 부재 확인은 scheduler가 한다. 두 reconciler가 겹쳐 돌거나 pass 도중 재시작돼도 각 쓰기가 row lock 아래에서 다시 판정되므로 같은 lease·interrupt·orphan을 두 번 처리하지 않는다(`apps/control-host/src/reconciler/overlap.integration.test.ts`).

pass의 마지막 단계는 도구 호출 투영이다. 지난 pass 뒤에 쌓인 `tool_use`·`tool_result` 이벤트를 짝지어 `tool_calls`와 일별 합계 `tool_call_days`에 적는다. 사용량 API(`GET /v1/usage/tools`)는 이벤트를 다시 파싱하지 않고 이 두 표만 읽는다. 한 트랜잭션에 이벤트 5,000개씩, pass마다 10초 동안 처리하고 남은 것은 다음 pass가 잇는다. 배치가 문장 timeout(10초)에 걸리면 배치를 10분의 1로 줄여 다시 처리하고, 줄인 크기를 `tool_call_progress.batch_size`에 바로 커밋한다. pass timeout(60초)이 pass를 끊어도 다음 pass는 그 크기에서 시작하므로 결국 한 배치는 지나간다. timeout 없이 끝난 pass는 크기를 10배씩 되돌린다(설정값에 닿으면 NULL). timeout마다 `Tool call batch timed out` 로그(`batch_size`, `retry_size`)를 바로 남기고, pass 끝의 `Tool calls projected`에는 `timed_out_batches`로 횟수를 남긴다. 진행 위치는 `tool_call_progress.applied_through`(이벤트 id)다. 이 커서는 60초보다 오래된 이벤트까지만 넘어가므로, 늦게 커밋된 낮은 id의 이벤트도 빠뜨리지 않는다. 그보다 새 이벤트는 다음 pass가 다시 읽으며, 다시 적용해도 결과는 같다. 그래서 새 호출이 API에 보이기까지는 보통 pass 하나만큼(10초 남짓) 걸린다. migration 뒤 첫 pass들은 커서 0에서 기존 이벤트를 모두 채운다(backfill). 로컬 PG16에서 이벤트 2,000만 개를 쉬지 않고 투영하는 데 약 26분이 걸렸다. pass 사이에 `RECONCILER_INTERVAL_SEC`만큼 쉬므로 실제로는 그 두 배쯤(1시간 안팎) 걸리고, 그동안 API의 도구 집계는 덜 찬 값이다. dry-run은 투영하지 않는다.

scheduler pass도 one-shot이다(`main.ts scheduler --once`, package script `scheduler`). compose `scheduler` 서비스는 같은 감독 루프로 이 pass를 반복 실행한다(`main.ts scheduler`, healthcheck `main.ts scheduler --health`). 설정은 `SCHEDULER_INTERVAL_SEC`(5)·`SCHEDULER_PASS_TIMEOUT_SEC`(180, `EXECUTION_DOCKER_STOP_TIMEOUT_SEC` + `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC`보다 커야 기동. kubernetes backend는 [Kubernetes 실행 backend](kubernetes-backend.md))·`SCHEDULER_MAX_CONSECUTIVE_FAILURES`(3)·`SCHEDULER_HEALTH_STALE_SEC`(200, interval + timeout보다 커야 기동)·`SCHEDULER_STATUS_FILE`(`/tmp/scheduler-status.json`, compose는 넘기지 않는다)이고 의미는 위 reconciler 표와 같다. 다른 pass가 lock을 쥐고 있어 건너뛴 pass는 exit 75로 끝나며 성공도 실패도 아니다. 건너뛰기만 이어지면 성공이 없으므로 stale 시간 뒤 unhealthy가 된다. 할 일은 다 했지만 이번 pass에서 도울 수 없는 세션을 남긴 pass — launch가 backoff 중이거나(`launch_backoff_count`), 방금 quarantine됐거나(`launch_quarantined_count`), 교체 한도를 다 쓴(`replacement_exhausted_count`) 세션 — 는 exit 76(degraded)으로 끝난다. 그 상태는 DB에 있어 재시작으로 풀리지 않으므로 degraded는 연속 실패로 세지 않고 실패 streak를 끊는다. health는 최근 degraded pass를 healthy로 보되 reason에 `completed degraded`를 적고, status에는 `lastDegradedAt`으로 남는다(`lastSuccessAt`은 깨끗한 pass만). 같은 pass에 다른 실패가 하나라도 있으면 지금처럼 exit 1이다. 루프가 SIGTERM을 받으면 진행 중 pass는 다음 안전 지점(pass lock 상실 때 멈추는 자리와 같다)에서 멈춰 더 예약하지 않고, 30초 안에 끝나지 않으면 kill된다. pass가 기다리던 worker 정지는 kill돼도 daemon에서 계속된다(Engine 25부터 요청이 끊겨도 stop을 취소하지 않는다). compose `stop_grace_period`는 45s다. kill 의도(terminate, lease 만료, quarantine)를 수행할 때 pass는 worker가 turn을 drain하기를 기다리지 않는다. stop을 요청하고 5초 안에 끝나지 않으면 그 컨테이너를 `kills_stopping_count`로 세고 넘어가며, 실패로 세지 않는다. daemon은 SIGTERM 뒤 `EXECUTION_DOCKER_STOP_TIMEOUT_SEC`가 지나면 SIGKILL하고, 다음 pass가 컨테이너가 사라진 것을 확인해 slot을 돌려준다. drain 기한을 넘긴 claimed worker의 교체와 launch intent 없는 orphan 컨테이너의 정지도 같다(orphan은 `orphan_stopping_count`로 세고 사라질 때까지 slot을 차지한다). unclaimed worker의 교체는 기다린다. turn이 없어 곧 끝나고, 교체를 시도할 때마다 교체 한도를 쓰기 때문이다. 그래도 unclaimed 컨테이너를 지우고 다시 만드는 경로에서는 pass가 정지 하나를 끝까지 기다릴 수 있다. 그래서 pass timeout이 stop timeout + request timeout보다 작으면 scheduler가 기동을 거부한다. 컨테이너 create·start 요청이 `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC` 안에 답을 받지 못하면 컨테이너가 생겼는지 알 수 없으므로 launch 실패로 세지 않는다. nonce를 폐기하지 않고 backoff도 걸지 않는다. 그 pass는 실패(exit 1)로 끝난다. 다음 pass가 inspect해서 컨테이너가 있으면 채택한다(생성만 됐으면 시작한다). 없으면 그제야 launch 실패로 센다. 이때 nonce를 폐기하고 backoff를 걸어, 끝내 생기지 않는 create가 slot을 계속 붙잡지 않고 실패 한도에서 quarantine된다. 폐기 뒤에 늦게 생긴 컨테이너는 실패한 시도로 보고 지운다. daemon이 거절로 답한 경우(4xx·5xx)는 지금처럼 launch 실패로 센다. scheduler를 멈춰도 worker는 끝나지 않는다. slot은 pass가 worker 부재를 확인한 뒤에만 반환된다. 한 pass는 ① 살아 있는 `executions` row를 Docker와 대조(컨테이너가 없으면 같은 intent로 재생성, exit했으면 `terminated` 기록 후 제거) ② launch intent 없는 관리 컨테이너를 로그 후 정지하고, 컨테이너가 사라진 worker 네트워크를 지우거나 proxy가 떨어진 네트워크에 다시 붙임 ③ `EXECUTION_SLOT_LIMIT` 안에서 unassigned session마다 intent 커밋 → 컨테이너 생성 ④ 끝난 session의 workspace volume 회수 순서로 진행한다. worker 컨테이너는 Docker socket·host HOME을 받지 않고 env는 bootstrap claim에 필요한 `WORKER_EXECUTION_ID`·`WORKER_EXECUTION_GENERATION`·`WORKER_BOOTSTRAP_NONCE`·`WORKER_GATEWAY_URL`, tmpfs를 가리키는 `HOME`, egress proxy를 가리키는 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`(대소문자 두 표기. `NO_PROXY`에는 proxy 자신의 이름이 들어간다), proxy의 credential route를 가리키는 `WORKER_EGRESS_CREDENTIAL_URL`([API 서버의 credential route 절](api-server.md#provider-키와-저장소-자격-증명은-worker에-가지-않는다)), 그리고 object store의 이름 — `S3_BUCKET`·`AWS_REGION`과 세션 prefix `WORKER_OBJECT_PREFIX`(`sessions/<sessionId>/`) — 를 받는다. scheduler는 bucket과 region이 없으면 기동하지 않는다. object store 자격 증명과 endpoint는 받지 않는다. 워커는 proxy의 object store route로만 object store에 닿으며, 경계는 그 route다(같은 절). 워커 쪽 `scopedCheckpointObjectStore`(`packages/storage`)는 prefix 밖 key를 요청 전에 거절하는 빠른 실패일 뿐이다. 워커 안에서 `@werft-ai/storage`를 import하는 파일은 `apps/worker/src/object-store.ts` 하나뿐이며 `tests/architecture.test.ts`가 이를 강제한다. Docker daemon 응답이 create 요청 본문을 되돌려 주는 경우에 대비해 backend는 오류 메시지에서 nonce를 지운다. `/tmp`·HOME tmpfs는 worker uid/gid 소유로 마운트된다. `/workspace` named volume은 Docker가 이미지의 같은 경로에서 초기화하므로 worker 이미지가 `/workspace`를 worker uid 소유로 미리 만들어 두어야 한다(이미지 계약). worker 이미지(`apps/worker/Dockerfile`)는 `WORKER_IMAGE`로 받는다. pass 전체는 Postgres session advisory lock(`scheduler:pass`)으로 직렬화되어 겹친 실행은 로그만 남기고 건너뛴다. 같은 Docker daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. scheduler는 이 값이 없으면 기동하지 않는다(adapter만 테스트용 기본값 `local`을 가짐). 같은 값을 쓰는 두 설치가 daemon을 공유하면 서로의 컨테이너를 orphan으로 회수한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
WORKER_IMAGE=agent-platform-worker:dev \
WORKER_GATEWAY_URL=http://host.docker.internal:3000 \
EXECUTION_SLOT_LIMIT=10 \
QUEUED_INPUT_LIMIT_PER_SESSION=20 \
STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 \
SESSION_COST_LIMIT_USD=25 \
PROVIDER_MAX_RETRIES=2 \
EXECUTION_INSTALLATION_ID=local \
EXECUTION_EGRESS_PROXY_URL=http://egress-proxy:3128 \
EXECUTION_WORKSPACE_QUOTA=off \
  bun run --cwd apps/control-host scheduler
```

worker 컨테이너는 scheduler가 execution마다 만드는 **전용 네트워크** `ap-net-<installationId>-<executionId>-g<generation>` 하나에만 붙는다. 이 네트워크는 bridge driver, `internal: true`, `EnableIPv6: false`, `com.docker.network.bridge.gateway_mode_ipv4=isolated`로 만들어진다. Docker가 이 네트워크에서 바깥으로 나가는 경로를 만들지 않고 host 쪽 bridge 주소(IPAM gateway)도 두지 않는다. 그래서 worker는 host·host에서 도는 프로세스·LAN·instance metadata(`169.254.169.254`)·다른 compose 서비스·다른 worker에 직접 닿지 못한다. 이 네트워크의 구성원은 worker 자신과 egress proxy 둘뿐이다. scheduler는 `agent-platform.egress-proxy=<installationId>` label이 붙은 **실행 중인 컨테이너 정확히 하나**를 그 설치의 proxy로 보고, 네트워크마다 `EXECUTION_EGRESS_PROXY_URL`의 host 이름을 alias로 붙여 connect한다. worker는 `HTTP_PROXY`/`HTTPS_PROXY`로 그 이름을 가리킨다. proxy 주소가 네트워크마다 다르므로 `EXECUTION_EGRESS_PROXY_URL`의 host는 이름이어야 하고, IP literal과 `localhost`는 거부한다. compose의 `egress-proxy` 서비스는 이 label을 달고 있다. worker에는 `host.docker.internal:host-gateway` 매핑이 없다 — gateway도 proxy를 거친다.

차단 정책은 proxy의 두 목록으로 버전 관리한다. `EGRESS_ALLOWLIST`는 공인 목적지(`host:port`)이고 해석된 주소가 전부 public unicast여야 통과한다. `EGRESS_PRIVATE_ALLOWLIST`는 사설 대역에 있다고 알고 허용하는 목적지(gateway)다. compose 기본값은 `EGRESS_ALLOWLIST`가 비어 있고 `EGRESS_PRIVATE_ALLOWLIST`가 `api:3000,host.docker.internal:3000`이다. provider·저장소·object store는 두 목록 어디에도 두지 않는다. forward proxy로 닿으면 각자의 credential route를 우회하기 때문이다. provider에는 worker가 가진 임의 key로 비용 계측 밖에서 닿고, Gitea·GitHub의 public 저장소는 token 없이 읽히며, object store에는 API가 각 요청을 검증하고 서명하는 route를 거쳐야 한다. 로컬 SeaweedFS도 SigV4를 검사하지만 저장소 인증만으로 세션별 prefix 권한을 대신할 수 없다. 이들은 credential route만 닿는 목록 `EGRESS_CREDENTIAL_ALLOWLIST`(compose 기본값 `api.anthropic.com:443`, GitHub 저장소를 쓰면 `github.com:443`을 더한다)·`EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`(compose 기본값 `gitea:3000,fake-messages:4010,localstack:4566`)에 둔다. credential 목록의 목적지가 forward 목록에도 있으면 proxy는 기동을 거부한다. 그래서 환경 파일의 forward 목록에 그런 값이 남아 있으면 지워야 proxy가 뜬다. 비교는 적힌 `host:port` 그대로이므로, 같은 upstream을 다른 이름이나 IP로 적으면 잡지 못한다. `.env.example`도 같은 값이다(`tests/images.test.ts`가 둘을 묶는다). 두 목록 모두 link-local(`169.254.0.0/16`·`fe80::/10`)·multicast·reserved로 해석되면 거부하므로 allowlist에 오른 이름이 metadata 주소로 해석되는 rebinding도 막힌다. 목록에 없는 host·port는 CONNECT·absolute-form 모두 `403`이고, absolute-form이 아닌 요청은 `/healthz` 외에는 `400`이다. 목록에 있는 이름이 조회되지 않으면(재시작 중인 `api` 컨테이너가 Docker DNS에서 잠시 빠질 때) 정책 거부가 아니라 `502`이고, 조회가 시간 안에 끝나지 않으면 `504`다. worker는 둘 다 재시도한다.

CONNECT 터널은 TLS만 나른다. proxy는 `200 Connection Established`를 쓴 뒤 클라이언트의 첫 바이트를 upstream에 흘리기 전에 TLS ClientHello로 읽어, DNS 이름 authority면 `server_name`이 그 authority와(대소문자만 무시하고) 같아야 하고, allowlist에 명시된 IP literal authority면 `server_name`이 없어야 한다. `encrypted_client_hello`(0xfe0d)는 GREASE 여부와 관계없이 거부한다 — proxy는 둘을 구별할 수 없고, 진짜 ECH는 검사 대상인 이름을 숨긴다. handshake가 아닌 첫 레코드, host_name이 둘인 hello, 최초 16KiB(record header 포함) 또는 15초(`handshakeTimeoutMs`) 안에 완성되지 않는 hello는 전부 연결을 끊는다. 거부는 200 뒤에 일어나므로 클라이언트에는 handshake 도중 연결 종료로 보인다.

이 관문의 한계:

* 검사 대상은 평문으로 보이는 **바깥** ClientHello의 SNI다. TLS를 종단하지 않으므로 그 안의 HTTP `Host`·경로·본문, 허용된 서비스가 다시 중계하는 곳은 보지 못한다. domain fronting을 CDN 쪽에서 막는 것은 별개의 통제다.
* IP literal allowlist는 `IP:port` 접근 권한이지 hostname 보장이 아니다. 공유 CDN edge 주소를 IP로 allowlist에 올리지 않는다.
* **Bun 1.3.10–1.3.13의 `fetch`·`node:https`는 GREASE ECH를 보내므로 이 proxy로 CONNECT하면 거부된다.** 1.3.14는 보내지 않는다(2026-09-25 실측). `egress.integration.test.ts`의 "Bun's own fetch handshakes through the tunnel"이 이를 고정한다. Bun `node:tls`·`Bun.connect({tls})`, Node, curl, 그리고 worker의 SDK가 spawn하는 Claude Code 바이너리도 보내지 않는다(2026-09-23 실측). worker의 object store는 CONNECT를 쓰지 않는다 — worker 네트워크 안의 proxy object store route에 평문 http로 보내고, upstream TLS는 proxy가 맺는다. AWS에서는 route가 virtual-hosted 이름으로 부르므로 `<bucket>.s3.<region>.amazonaws.com:443`이 `EGRESS_CREDENTIAL_ALLOWLIST`에 있어야 한다(점이 든 bucket 이름은 path-style `s3.<region>.amazonaws.com:443`). worker의 Bun HTTP 클라이언트로 https upstream을 CONNECT로 부르는 코드는 지원하지 않는다. 런타임·클라이언트 버전을 올리면 다시 측정한다.

**worker끼리는 서로 닿지 않는다.** 다른 worker와 같은 네트워크에 있지 않으므로 그 주소로 가는 경로가 없고, 컨테이너 이름도 풀리지 않는다. proxy를 거쳐 가려 해도 사설 주소는 `EGRESS_PRIVATE_ALLOWLIST`에 없으면 거부된다. 다른 설치의 worker와 proxy에도 닿지 않는다 — 네트워크와 proxy 선택이 모두 설치별이다. 통합 테스트(`egress.integration.test.ts`의 "workers do not reach one another")가 이를 확인한다. 같은 네트워크의 형제 컨테이너라면 열린 포트에 닿는다는 양성 대조와 함께 확인한다. 남은 한계:

* proxy는 모든 worker 네트워크에 붙는 신뢰 구성요소다. proxy가 침해되면 그 설치의 모든 worker에 닿는다. `EGRESS_PRIVATE_ALLOWLIST`에는 worker로 해석될 수 있는 이름을 넣지 않는다.

**host 프로세스에도 닿지 않는다.** 기본 gateway mode(`nat`)의 internal bridge는 host에 subnet의 첫 주소를 준다. 그러면 daemon host가 그 주소나 wildcard로 listen하는 **host 프로세스**(publish된 포트가 아니라 host에서 직접 띄운 프로세스)에 worker가 proxy 없이 닿는다. 그래서 worker 네트워크는 `gateway_mode_ipv4=isolated`로 만들어 host가 그 네트워크에 주소를 갖지 않게 한다. 이 모드는 **Docker 28(API 1.48) 이상**에만 있다. scheduler는 기동 preflight(`verifyNetworkIsolation`)에서 daemon의 API 버전이 1.48 미만이면 경고로 넘기지 않고 거부한다(`GatewayModeUnsupportedError`). 끄는 설정은 없다. 통합 테스트(`egress.integration.test.ts`의 "a host process on a wildcard address")는 두 가지를 함께 확인한다. 모드가 없는 internal 네트워크에서는 host listener에 닿는다(양성 대조). worker 네트워크에서는 닿지 않는다. native Linux(CI)에서는 테스트 프로세스 자신이 `0.0.0.0` listener다. Docker Desktop은 daemon이 VM 안에 있으므로 VM의 network namespace를 쓰는 `--network host` 컨테이너가 listener를 대신한다. IPv6는 worker 네트워크에서 꺼져 있어 해당하지 않는다.

scheduler는 pass 전에 그 설치의 proxy가 정확히 하나 떠 있는지 확인한다(`verifyNetworkIsolation`). 없거나 둘 이상이면 pass lock을 잡고 worker 네트워크 reconcile만 돌린다(orphan 회수, 둘 이상이면 proxy 분리). 그다음 아무것도 띄우지 않은 채 non-zero로 종료한다. worker 네트워크는 launch 때마다 검사한다. 이미 같은 이름의 네트워크가 있으면 새로 만들지 않고 다음을 확인한다. 하나라도 어긋나면 `NetworkIsolationError`로 launch를 거부한다(fail closed).

* bridge·internal·IPv6 꺼짐·소유 label(설치·execution·generation)이 맞는가
* host가 네트워크에 주소를 갖지 않는가 — `Options`의 `gateway_mode_ipv4`가 `isolated`이고 IPAM에 gateway가 없어야 한다. 모르는 옵션을 기록만 하고 gateway를 주는 옛 daemon이 있어서 두 조건을 모두 본다
* worker와 proxy 외의 구성원이 없는가

proxy attach 결과는 응답 코드가 아니라 proxy 컨테이너가 보고하는 attach·alias로 판정한다. 이미 붙어 있으면 403이 오고, alias 없이 붙어 있으면 DNS가 풀리지 않기 때문이다. 이미 있는 컨테이너를 adopt할 때는 그 컨테이너가 자기 네트워크(같은 id) **하나에만** 붙어 있어야 한다. 컨테이너는 네트워크 이름이 아니라 id로 만든다. 그래서 같은 이름으로 다시 만들어진 네트워크가 검사받은 네트워크를 대신할 수 없다.

예전 설정 `EXECUTION_DOCKER_NETWORK`·`EXECUTION_DOCKER_NETWORK_ALLOWLIST`는 더 이상 읽지 않는다. 값이 남아 있으면 조용히 무시하지 않고 기동을 거부한다. 환경 파일에서 지우고 proxy 컨테이너에 label을 단다.

컨테이너에는 만들어질 때의 격리 계약이 `agent-platform.isolation` label로 `<버전>:<지문>` 형태로 찍힌다. 지문은 proxy URL·credential route 포트·`NO_PROXY` 값·user·workspace/HOME 경로·tmpfs 크기·workspace quota 설정과 inode 상한·stop timeout·worker 상한(turn 시간, provider 재시도), 그리고 object store의 bucket·region의 해시라서, 코드를 바꾸지 않고 `EXECUTION_EGRESS_PROXY_URL`이나 `S3_BUCKET`만 바꿔도 값이 달라진다. object store endpoint와 자격 증명은 지문에 없다. worker는 둘 다 받지 않고 proxy의 object store route를 거치며, 그 요청은 API가 서명한다. 그래서 `AWS_ENDPOINT_URL`이나 key를 바꿔도 worker는 교체되지 않고, API를 재기동하면 다음 요청부터 새 값이 쓰인다. CPU·memory·pids 한도도 일부러 지문 밖에 둔다. 한도는 launch의 것이라 reserve 때 `worker_launches.resources`에 고정되고 `agent-platform.launch-spec` label로 대조된다. 그래서 한도를 낮추면 실행 중인 worker를 한꺼번에 교체하지 않고 다음 launch부터 적용된다. 단, `agent-platform.launch-spec` label이 없는 컨테이너는 대조 없이 adopt된다. 실행 중인 컨테이너의 격리는 제어 호스트를 올려도 바뀌지 않으므로, scheduler는 label이 현재 값과 다른 컨테이너를 `stale`로 보고 정지·제거한 뒤 저장된 intent로 다시 만든다(`ensureExecution`도 그런 컨테이너는 adopt하지 않는다). 버전이 **더 높은** 컨테이너는 롤백 중인 새 제어 호스트가 만든 것이다. 그 경계가 지금 요구하는 것과 같은지 알 수 없으므로 adopt도 교체도 하지 않고 `IsolationContractError`로 거절한다 — row는 살아 있고 pass는 non-zero로 끝나므로 운영자가 롤포워드하거나 직접 제거해야 한다. 격리의 모양 자체가 바뀌면 `ISOLATION_CONTRACT`를 올린다. 계약 5부터 worker 네트워크가 execution별이다. 그래서 계약 4 이하에서 업그레이드하면 공유 네트워크 위의 기존 컨테이너가 전부 stale로 교체된다. 교체 전 확인(`assertReplaceable`: 이미지·workspace·proxy·새 네트워크)이 실패하면, 보통은 옛 컨테이너를 그대로 두고 다음 pass에서 다시 시도한다. 하지만 계약 5 미만 컨테이너는 공유 네트워크에서 이웃 worker에 닿을 수 있다. 그래서 아직 claim되지 않은 그 컨테이너는 **모든 네트워크에서 떼어 낸** 채로 둔다. claim 전이라 진행 중인 turn은 없다. 확인이 통과하는 pass에서 정상 교체된다. 결과는 교체 실패 로그의 오류 메시지 끝에 붙는다. claim된 계약 5 미만 worker는 이 확인 없이 teardown되므로 여기서 건드리지 않는다. 확인과 disconnect를 한 번에 묶는 fence는 없다. 그래서 disconnect 뒤에 claim 여부를 한 번 더 확인하고, 그사이 claim됐으면 네트워크를 다시 붙여 scheduler의 teardown(SIGTERM으로 drain)에 맡긴다. disconnect가 이어지는 그 짧은 동안 claim 요청이 오가던 worker는 요청이 끊길 수 있다.

계약 6부터 worker 네트워크에 host 주소가 없다. 계약 5 컨테이너의 네트워크는 이름이 같지만 gateway mode는 제자리에서 바꿀 수 없으므로 교체는 다음 순서를 탄다.

* **교체 전 확인(`assertReplaceable`):** 같은 launch의 계약 5 worker가 그 네트워크에 실제로 붙어 있고 결함이 host 주소 하나뿐이면 옛 네트워크를 통과시킨다. 이어지는 teardown이 컨테이너와 함께 네트워크를 지운다. 그다음 `ensureExecution`이 `isolated`로 새로 만든다.
* **일반 launch 경로:** worker 없이 남은 옛 네트워크(teardown의 네트워크 제거가 실패한 경우)는 proxy만 붙어 있으면 지우고 다시 만든다. 다른 구성원이 있으면 거부한다. 옛 worker가 아직 붙어 있는 옛 네트워크에 새 컨테이너를 올리는 일은 없다.
* **`reconcileNetworks`:** 계약 5 worker가 붙은 옛 네트워크에서는 proxy를 떼지 않는다. claim된 worker는 확인 없이 drain·teardown되므로 그 전에 egress를 끊지 않기 위해서다. 계약 6 worker가 host 주소 있는 네트워크에 있으면 결함으로 보고 proxy를 뗀다.

이 교체도 claim된 worker는 아래의 turn 경계 drain 뒤에 닫는 규칙을 따른다. **배포 순서:** daemon을 먼저 Docker 28 이상으로 올린다. 옛 daemon에서는 preflight가 pass 전체를 막는다. 그러면 계약 5 worker도 교체되지 않고 그대로 돈다(새 admission만 fail-closed).

업그레이드 뒤 옛 공유 네트워크(`agent-platform-worker`, `EXECUTION_DOCKER_NETWORK`로 이름을 바꿨다면 그 이름)는 compose가 더 이상 선언하지 않는다. 그래도 저절로 지워지지는 않고, 주소 풀의 subnet 하나를 계속 차지한다. 계약 4 컨테이너가 모두 교체된 뒤 `docker network rm agent-platform-worker`로 지운다. 실행 중인 컨테이너가 붙어 있으면 Docker가 삭제를 거부한다(403). 그래서 쓰는 중인 네트워크를 실수로 지울 일은 없다. **이미 claim된 worker는 다시 만들 수 없으므로 turn 경계까지 drain한 뒤 teardown된다.** 아래 절을 따른다.

#### 계약이 오를 때 claim된 worker의 drain

claim된 컨테이너가 stale이면 scheduler는 바로 부수지 않는다.
1. 첫 pass가 `worker_launches.drain_requested_at`을 DB 시계로 기록한다. 그때부터 그 worker는 새 turn을 받지 않는다. 이미 받은 turn은 끝까지 돌고, 뒤에 온 입력은 queued로 남는다.
2. 도는 turn(`running`·`needs_input`)이 있거나 worker가 아직 첫 입력을 청하지 않았으면(workspace 준비·checkpoint 복원 중. 이때 끊으면 실패한 기동으로 센다) 컨테이너를 그대로 두고 pass summary의 `draining`(로그 `draining_count`, `Claimed execution draining before its replacement`)에 올린다.
3. turn이 끝난 뒤 첫 pass가 컨테이너를 teardown한다. turn의 checkpoint는 그 finalize에 실려 이미 확정됐다. SIGTERM을 받은 worker는 idle drain으로 release하고, queued 입력은 새 launch(현재 계약)가 받아 checkpoint에서 이어간다.
4. drain 기한이 지나도 turn이 열려 있거나 기동이 끝나지 않았으면 그대로 teardown한다. 이때 그 turn은 전처럼 `outcome_unknown`이 된다. 끝나지 않은 기동은 worker가 SIGTERM에 drain으로 release하면 세지 않고, release 없이 죽으면 실패 1회로 센다. pass summary의 `drainsOverdue`(로그 `drain_overdue_count`)와 경고 `Drain deadline passed with the worker still busy; replacing anyway` 한 줄이 남는다. 기한은 `MAX_TURN_SECONDS` + 5분이다. 어떤 turn도 `MAX_TURN_SECONDS`를 넘지 못하고, 5분은 그 turn을 끝내는 finalize·checkpoint 몫이다.

claim되지 않은 stale 컨테이너는 전처럼 곧바로 교체된다.

**롤아웃 절차:** 계약을 올리는 배포는 claim된 worker의 교체가 최대 drain 기한만큼 늦어진다. 그동안 옛 계약 컨테이너가 살아 있고, 그 세션에는 새 turn이 시작되지 않는다. 즉시 끊어야 하는 격리 결함이면 해당 세션을 terminate해 기다리지 않는다. 롤백으로 컨테이너가 다시 current가 되면 drain 요청은 남는다. 그 worker는 새 turn 없이 유휴 시간 뒤 스스로 끝나고, 세션은 다음 launch로 이어진다.

### checkpoint 복원이 계속 실패하는 세션

복원을 넘겨받은 worker가 ready를 보고하기 전에 끝나면 scheduler는 곧바로 다시 띄우지 않는다. 이런 종료가 두 번째까지는 30초, 60초를 기다린다. 세 번째에는 세션이 `recovery_required`로 멈추고 새 generation을 만들지 않는다. 기다리는 동안이나 멈춘 뒤의 세션 상세 attention은 `RESTORE_FAILED`다.
- `reason`: 마지막 worker가 남긴 오류다. release 없이 죽었으면 `execution_gone`이다.
- `failures`: 이어진 실패 횟수다.
- `retry_at`: 다음 시도 시각이다. 멈춘 뒤에는 null이다.

`INCOMPATIBLE_CHECKPOINT`는 재시도해도 같은 worker runtime·profile에서 성공할 수 없는 결정적 실패다. 이 경우 첫 launch 뒤 바로 `recovery_required`로 멈추며 attention과 `checkpoint_restore_failed` 이벤트의 `reason`은 `incompatible_checkpoint`, `failures`는 1, `retry_at`은 null이다. 운영자는 호환 runtime·profile로 되돌린 뒤 `retry_restore`로 같은 checkpoint를 다시 시도하거나, 이전 context를 버려도 되면 `start_fresh`를 선택하거나, 세션을 끝내려면 `close`를 선택한다.

이벤트 스트림에는 실패마다 system `checkpoint_restore_failed`가 남는다. worker 로그의 `worker.checkpoint.restore_refused`, `worker.failed`에서 원인을 확인한다. 저장소 응답 checksum 불일치(전송 중 손상)도 `CHECKPOINT_UNAVAILABLE`로 분류된다.
- 저장소나 egress-proxy `/object-store` 경로가 잠시 답하지 못한 것은 실패로 세지 않는다. 연결 실패·DNS 실패·request/body timeout·잘린 body와 HTTP 408·429·5xx가 일시 장애다. checkpoint 복원은 `worker.checkpoint.restore_unavailable`, checkpoint가 아직 없는 새 generation의 transcript 저장소 확인은 `worker.checkpoint.store_unavailable` 경고를 남긴다. 둘 다 같은 worker 안에서 1초부터 두 배씩, 최대 30초 간격으로 `WORKER_STARTUP_TIMEOUT_SEC`(기본 3600초)까지 다시 시도한다. 저장소가 돌아오면 그 worker가 이어가므로 generation을 새로 만들지 않는다.
- 시작 예산이 끝날 때까지 장애가 계속되면 그 worker 종료를 시작 실패 1회로 센다. 다음 generation은 30초, 60초의 세션 backoff 뒤에만 뜨고 세 번째 실패에서 `recovery_required`로 멈춘다. 따라서 저장소 장애가 worker의 무제한 즉시 재기동으로 바뀌지 않는다. `WORKER_STARTUP_TIMEOUT_SEC`는 scheduler가 worker에 별도 값을 넘기지 않으므로 현재 배포에서는 코드 기본값으로 고정이다.
- 객체가 실제로 없거나(404/`NoSuchKey`), 401·403으로 거절되거나, checksum·digest가 맞지 않는 경우는 일시 장애가 아니다. manifest나 manifest가 가리키는 객체가 없으면 `CHECKPOINT_UNAVAILABLE`이며 재시작으로 복구됐다고 간주하지 않는다. bucket 전체가 비었는데 DB pointer가 남은 경우는 API 기동 검사가 먼저 막는다. `restore_refused`는 저장소 경로가 아니라 checkpoint의 영구 손상·불일치 쪽을 조사하라는 신호다.
- 원인이 세션 밖에 있었다면(프록시의 전송 중 손상, 저장소 경로 설정 오류) 그것을 고친 뒤 `retry_restore`로 같은 checkpoint를 다시 복원한다. 횟수가 0으로 돌아가고 queued 입력이 다시 신호된다. 다음 worker는 실패하던 worker와 같은 pointer에서 복원 계획을 다시 받는다.
  ```sh
  # KEY: sessions:recover scope가 있는 API 키
  curl -X POST "$API/v1/sessions/$SESSION/recovery-decisions" \
    -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
    -H 'Content-Type: application/json' \
    -d '{"decision":"retry_restore","expected_revision":<revision>,"reason":"proxy fixed"}'
  ```
  한도에 닿아 멈춘 세션에만 받는다. backoff 중이거나 다른 이유(context gap, unknown turn, 복원 없는 `STARTUP_FAILED`)로 멈춘 세션은 409 `REQUEST_STALE`이다.
- checkpoint를 포기해도 되면 `start_fresh`로 이어간다. checkpoint 없이 새 engine session이 시작된다.
- 세션을 끝내려면 `close`를 쓴다.

### 시작 단계에서 계속 죽는 세션

checkpoint가 없는 세션도 같은 규칙을 따른다. worker가 claim 뒤 입력을 한 번도 청하지 않고 끝나면 실패 1회다. workspace 준비(git clone·fetch)나 엔진 기동에서 죽은 경우다. 두 번째까지는 30초, 60초를 기다리고, 세 번째에는 `recovery_required`로 멈춘다. attention은 `STARTUP_FAILED`이고 `reason`·`failures`·`retry_at`은 위와 같다. 이벤트 스트림에는 실패마다 system `startup_failed`가 남는다.
- 흔한 원인은 저장소 URL·branch가 사라졌거나 저장소 자격 증명이 거부된 경우, 그리고 worker의 object store·proxy 설정 오류다. worker 로그의 `worker.stopping kind=failed`, `worker.failed`에서 확인한다.
- 원인을 고친 뒤 `start_fresh`로 다시 띄운다. 이 세션에는 버릴 checkpoint가 없으므로 잃는 것이 없다. 세션을 끝내려면 `close`를 쓴다.
- pause, terminate, close, 실행 권한 회수로 끝난 worker는 세지 않는다.
- SIGTERM으로 drain된 worker도 세지 않는다. worker는 release에 `stop_kind: "drain"`을 싣는다. 이 필드를 모르는 옛 API는 strict schema라 400 `BAD_REQUEST`로 거절한다. 그러면 worker는 `worker.release.stop_kind_refused`를 로그에 남기고 필드 없이 한 번 더 release한다. 세션은 lease 만료를 기다리지 않고 바로 돌아온다. 다만 옛 API는 그 종료를 예전 규칙대로 센다. 복원이 걸린 claim이면 실패 1회다.
- **배포 순서:** 제어 호스트 이미지(`API_IMAGE`, api·scheduler 공용)를 먼저 올리고 `WORKER_IMAGE`는 그다음에 바꾼다. worker protocol의 요청 schema는 strict라서 새 worker가 보낸 새 필드를 옛 API가 400으로 거절한다. release 말고는 이런 대체 경로가 없다.

### interrupt 뒤 결과를 알 수 없는 turn

interrupt한 turn이 `interrupted`로 끝나려면 engine이 멈췄다는 응답과 그 turn까지 덮는 checkpoint가 함께 있어야 한다. 둘 중 하나라도 없으면 transcript에 무엇이 남았는지 아무도 말할 수 없다. 그래서 turn은 `outcome_unknown`이 되고, turn 조회(`GET /v1/sessions/{id}/turns/{turn_id}`)의 `terminal_reason`이 원인을 말한다.
- `interrupt_checkpoint_unavailable`: engine은 멈췄지만 checkpoint를 커밋하지 못했다. worker는 drain으로 내려간다.
- `interrupt_unanswered`: engine이 interrupt에 제때 답하지 않았다. worker 로그에 `gave no terminal within …ms of its interrupt` 또는 `ended before its interrupt was answered`가 남고, worker는 실패로 끝난다.

worker 로그의 `worker.turn.interrupt.stage`를 같은 `session_id`·`turn_id`·`control_id`로 모으면 `control_received` → `sdk_interrupt_called` → `sdk_interrupt_answered` → `engine_terminal` → `capture_started` → `capture_finished` → `finalize_started` → `finalize_finished` 순서와 interrupt 수신 뒤 `elapsed_ms`를 볼 수 있다. 최종 finalize 뒤에는 `control.result`가 `operation=interrupt`, 최종 turn `outcome`, 안정된 `reason_code`, durable 수락 시각부터 turn terminal까지의 `effect_ms`(`duration_ms`와 같음)를 남긴다. 이미 끝난 turn에 대한 no-op은 수락 transaction 직후 `effect_ms=0`으로, 기한까지 끝나지 않은 receipt는 `outcome=unknown`·`reason_code=deadline_exceeded`로 같은 event를 남긴다. SDK 응답이 engine terminal 뒤에 도착하면 정상 순서에 끼워 넣지 않고 `late_sdk_interrupt_answered`로 기록한다. `engine_terminal outcome=timeout`은 5초 grace 안에 SDK/engine terminal이 오지 않은 경우다. `capture_finished outcome=timeout`과 `budget_ms=30000`은 checkpoint 캡처 예산을 쓴 경우이고, `outcome=failed`의 `reason`은 저장소 요청 같은 캡처 자체의 실패다. 캡처가 끝났어도 `finalize_finished outcome=failed`에 `CHECKPOINT_UNAVAILABLE`이 있으면 API가 manifest나 그 ref를 거절한 경우이므로 캡처 시간 초과나 S3 요청 실패로 분류하지 않는다. 5초 grace는 바꾸지 않는다. timeout이면 다음 입력을 같은 engine에 주지 않고 worker를 실패로 내려 복구 결정을 요구한다.

어느 쪽이든 세션은 `status: failed`, `admission_state: recovery_required`가 되고 queued 입력은 dispatch되지 않는다. interrupt receipt는 `unknown`이고 error는 `RECOVERY_REQUIRED`다. 복구는 `sessions:recover` scope로 한다.
저장소가 다시 정상이어도 `outcome_unknown` turn은 자동 재실행하지 않는다. 저장소 복구는 다음 worker가 checkpoint를 읽을 수 있게 할 뿐, 이미 실행된 turn의 외부 효과를 판정하지 못하기 때문이다. 아래 `abandon`·`confirm_completed`·`close` 가운데 운영자가 고른 결정만 queue head를 정리한다.
1. `abandon`·`confirm_completed`는 worker가 사라진 것이 확인된 뒤에만 받는다. 그 전에는 409 `RECOVERY_REQUIRED`(`The previous execution has not been confirmed gone`)다. 다음 scheduler pass가 컨테이너 부재를 확인하면 받는다. `close`는 기다리지 않는다. 남은 execution에 종료를 요청하고 바로 받는다.
2. 그 turn의 도구가 바깥에 한 일을 확인한다. 파일 쓰기, push, 외부 호출은 되돌려지지 않는다.
3. 결정을 보낸다.
   ```sh
   # KEY: sessions:recover scope가 있는 API 키
   curl -X POST "$API/v1/sessions/$SESSION/recovery-decisions" \
     -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
     -H 'Content-Type: application/json' \
     -d '{"decision":"abandon","expected_revision":<revision>,"reason":"interrupt had no confirmed effect","target_turn_id":"<turn_id>"}'
   ```
   - `abandon`: turn을 `cancelled`로 닫는다.
   - `confirm_completed`: 커밋된 checkpoint가 그 turn까지 덮을 때만 받는다(`evidence_ref` 필수). `interrupt_checkpoint_unavailable`은 대개 그런 checkpoint가 없으므로 409 `CHECKPOINT_UNAVAILABLE`이다.
   - `close`: 세션을 끝낸다. 되돌릴 수 없다.
4. `abandon`·`confirm_completed` 뒤 세션은 `stopped`다. 결정 receipt의 `result.resumable`이 `true`면 resume한다. `false`면 이어받을 checkpoint가 없거나, 마지막 checkpoint 뒤에 돈 turn이 있어 그 context를 이어받을 수 없다는 뜻이다(세션 상세 attention `CONTEXT_GAP`). `start_fresh`로 그 context 없이 이어가거나 `close`한다.

## worker workspace의 상한과 회수

세션마다 `ap-ws-<installationId>-<sessionId>-<접미사>` volume 하나가 `/workspace`에 붙는다. 이 volume은 세대(generation)를 넘어 살아남는다 — 컨테이너를 교체해도 세션의 작업 트리는 그대로여야 하기 때문이다. 그래서 **컨테이너를 지우는 `terminate`는 volume을 건드리지 않고**, 회수는 pass의 ④단계가 따로 한다.

volume이 없어져도 세션은 마지막으로 commit된 checkpoint에서 이어 간다. 무엇이 남고 무엇이 사라지는지는 [workspace volume을 잃었을 때 남는 것](api-server.md#workspace-volume을-잃었을-때-남는-것)에 있다.

volume은 이제 backend가 `POST /volumes/create`로 **명시적으로** 만든다. mount spec에 이름만 적으면 Docker가 label도 상한도 없는 volume을 알아서 만들어 버리기 때문이다. 만들 때 `agent-platform.managed`·`.installation`·`.session-id`·`.workspace-quota` label을 찍고, GC는 이름을 파싱하지 않고 이 label만 본다.

**volume 이름은 1회용이다.** `local` 드라이버는 이미 quota를 걸었던 이름을 다시 만들면 `Options.size`는 그대로 돌려주면서 실제 project quota는 걸지 않는다. xfs+prjquota(Docker 27.5.1)에서 측정한 결과 — 처음 만든 이름은 컨테이너 안 `df` 총량이 설정값(64MiB)이지만, 같은 이름을 지웠다 다시 만들면 `Options.size`가 같은데도 `df`는 파일시스템 전체(8GiB)를 보고한다. Engine API로는 둘을 구분할 수 없으므로, 세션의 workspace는 이름으로 유도하지 않고 무작위 접미사를 붙여 만든 뒤 **label로 조회한다.** GC나 운영자가 volume을 지워도 다음 것은 새 이름을 받으므로 상한이 다시 선다. 한 세션에 workspace가 둘 보이면 어느 쪽이 작업 트리인지 판단하지 않고 보고만 한다. preflight probe도 같은 이유로 매번 새 이름을 쓰고, 이전 실행이 남긴 probe는 label로 회수하되 만든 지 10분과 `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC`의 20배 중 긴 쪽이 지난 것만 지운다. preflight는 pass lock 밖에서 돌기 때문에, 더 젊은 probe는 동시에 도는 다른 preflight(루프 옆의 단독 `--once`, scheduler 둘)가 쓰는 중일 수 있다.

CPU·메모리·PID·tmpfs와 달리 `/workspace`에는 상한이 없었다. `EXECUTION_WORKSPACE_QUOTA_MB`(기본 4096)가 `local` 드라이버의 `size` driver option으로 그 상한이 된다. 단 이 옵션은 **daemon의 저장소가 project quota를 감당할 때만**(xfs + `prjquota`) 동작하고, 그렇지 않으면 daemon이 create를 `400 quota size requested but no quota support`로 거절한다. scheduler는 pass 전에 probe volume을 하나 만들어 보는 것으로 이 능력을 확인하고(`verifyWorkspaceQuota`), 감당하지 못하는 daemon에서는 **아무것도 띄우지 않고 종료한다.** probe는 volume 하나를 만들고 CAP_SYS_ADMIN helper를 띄우는 일이라 pass마다 반복하지 않는다. 감독 루프의 pass는 probe를 통과하면 backend 설정 전체(`DOCKER_HOST`·`EXECUTION_*` 등)의 해시를 status file 옆 `<SCHEDULER_STATUS_FILE>.quota-verified`에 적는다. 이후 pass는 해시가 같으면 probe를 건너뛴다. 감독 루프는 기동할 때 이 파일을 지운다. 그래서 루프가 다시 뜨면(컨테이너 재시작, 연속 실패 뒤 재기동) 첫 pass가 다시 확인한다. 실패한 probe는 아무것도 적지 않으므로 다음 pass가 또 확인한다. 루프 밖에서 단독으로 돌린 pass(`main.ts scheduler --once`)는 이 기록을 쓰지도 믿지도 않고 매번 probe한다. 루프는 기록 위치를 `SCHEDULER_QUOTA_PREFLIGHT_MARKER`로 자기 pass에만 넘긴다. 조용히 무제한으로 떨어지는 경로는 없고, 무제한을 감수하려면 `EXECUTION_WORKSPACE_QUOTA=off`를 명시해야 한다 — 그 경우 scheduler pass마다 경고 1건이 남는다. `on`·`off` 외의 값(`false`, `0`, `no`)은 오타로 보고 거절한다.

**quota 최솟값은 1024 MiB다.** 이보다 작은 `EXECUTION_WORKSPACE_QUOTA_MB`는 기동 시 거절된다. checkpoint 복원이 workspace volume을 한때 이만큼 쓰기 때문이다. 복원은 root를 비운 뒤 아래 순서로 진행한다. 표의 기호는 다음과 같다.

- B: bundle 사슬 합계. control plane 상한은 256 MiB다.
- U: untracked 파일. capture 상한은 256 MiB다.
- W: workspace `.git`이 받은 객체. 대략 B다.
- I: instructions commit이 닿는 객체. W 이하다.
- T: checkout된 작업 트리와 index.

| 단계 | 동시에 차지하는 것 | 최대 |
| --- | --- | --- |
| 내려받기 | bundle 파일 B, U | 512 MiB |
| staging | bundle 파일 B, staged 저장소 ≈B, U | ≈768 MiB |
| workspace fetch | staged 저장소 ≈B, W, U (bundle 파일은 staging 직후 지운다) | ≈768 MiB |
| staged 저장소 축소 | W, I, U (staged 저장소를 먼저 지운다) | ≤768 MiB |
| checkout 이후, 세션 내내 | W, I, T, U | 2B + T + U |

checkout 전의 고정 비용은 bundle 상한 2배 + untracked 상한, 곧 768 MiB다. 1024 MiB는 여기에 pack index와 여유를 더한 값이다. incremental thin pack을 채우는 delta base 사본도 이 여유에 들어간다. checkout 뒤의 T는 세션의 작업 트리 자체라 상한이 없다. 그래서 최솟값은 세션과 무관한 checkout 전 비용만 보장한다. checkout 뒤의 W + I + T + U는 같은 quota 안에서 capture할 때 그 세션이 이미 쓰던 양과 비슷하다. capture 때는 workspace `.git`, 작업 트리, untracked, scratch 저장소의 snapshot 객체, bundle 파일(≤B)이 함께 있었다. I는 B 이하다. quota를 낮춘 뒤 새 volume에 복원하는 경우는 이 보장 밖이다. 이때는 복원이 checkout 중 ENOSPC로 실패할 수 있다.

기존 workspace를 다시 쓰는 fresh fetch(checkpoint 없이 재개하는 reuse)는 복원과 달리 root를 비우지 않는다. 워커는 origin 전체를 bare mirror로 받아 거기서 branch를 복사한다. mirror는 `.git/agent-platform-fetch-*` 아래에 만들고 fetch가 끝나면 지운다. `/tmp`와 HOME은 tmpfs라 컨테이너 메모리를 쓰기 때문이다. 표의 기호에 더해 M은 mirror가 디스크에서 차지하는 최대치다. origin 저장소의 pack 전체에 index·ref, 받는 동안의 임시 pack 파일이 더해진다. Δ는 workspace `.git`에 새로 들어오는 객체다. 아래 최대치는 이 추정을 더한 값이다.

| 단계 | 동시에 차지하는 것 | 최대 |
| --- | --- | --- |
| mirror clone과 로컬 fetch | 기존 W, I, T, U + mirror M + Δ | 세션 사용량 + M + Δ |
| fetch 뒤 | W + Δ, I, T, U (mirror는 지운다) | 세션 사용량 + Δ |

M에는 상한이 없다. M만큼 quota 여유가 있어야 reuse가 성공하고, 모자라면 fetch가 ENOSPC로 실패한다. 처음 clone(`clone`·`recreate`)은 mirror 없이 root에 바로 받으므로 W + T만 쓴다. 워커가 도중에 죽어 남긴 scratch(fetch·capture·publish의 `.git/agent-platform-<용도>-XXXXXX`)는 다음 reuse가 fetch 전에 지운다. `agent-platform-checkpoint`는 남긴다. checkout이 다른 곳의 객체를 빌려 쓰면(`objects/info/alternates`, `commondir`, 링크인 `objects`) 그 대상일 수 있으므로 지우지 않는다.

복원 뒤 `.git/agent-platform-checkpoint/checkpoint.git`에는 instructions commit이 닿는 객체(I)만 남는다. engine이 그 commit을 prune해도 다음 capture가 bundle할 수 있게 하려는 저장소다. 그 뒤의 commit, 커밋하지 않은 변경의 snapshot, 사슬의 이전 snapshot은 남기지 않는다. 단, instructions commit이 HEAD와 같으면 I는 committed 이력 전체다. engine이 커밋하지 않은 세션이 그렇다. 이때 줄어드는 것은 snapshot 몫뿐이다.

이 축소에는 대가가 있다. 다음 incremental capture는 사슬의 tip 중 아직 있는 것만 제외 대상으로 삼는다. 이전 base bundle만의 snapshot commit은 이제 남지 않는다. 마지막 bundle의 snapshot도 workspace `.git`에 참조 없이 들어 있을 뿐이다. 보통의 `git gc`는 2주 동안 이것을 지우지 않는다. 하지만 engine이 `git gc --prune=now`를 돌리면 사라진다. 그러면 남은 tip(이력에 남은 HEAD commit, instructions commit)을 기준으로 bundle을 만든다. 그 결과 bundle이 커지거나 전체 bundle로 되돌아갈 수 있다. 올바름은 그대로다. 전체 bundle이 상한을 넘는 저장소는 사슬이 32개나 상한에 닿아 재시작할 때도 어차피 거절된다.

**inode 상한도 같은 project에 건다.** byte 상한만으로는 빈 파일 수백만 개로 inode를 소진하는 경로가 남는다. xfs는 inode를 project의 block 사용량에 매기지 않으므로 4GiB 안에서도 된다. 그러면 같은 daemon의 다른 세션과 Postgres가 파일을 만들지 못한다. `local` 드라이버에는 inode 옵션이 없고, `o=loop`로 세션마다 파일시스템을 만드는 길도 막혀 있다. 드라이버가 `mount(8)`이 아니라 mount syscall을 부르기 때문이다(`data: loop: invalid argument`). 그래서 Docker가 `size`로 만든 xfs project에 우리가 `ihard`·`isoft`(`EXECUTION_WORKSPACE_QUOTA_INODES`, 기본 1,000,000)를 직접 건다.

- 거는 주체는 짧게 도는 helper 컨테이너(`workspace-inodes.ts`)다. 설정은 `CapDrop ALL` + `CapAdd SYS_ADMIN, MKNOD`, `NetworkMode none`, read-only rootfs이고 privileged는 아니다.
- helper는 volume의 project id를 읽는다. project 0(= project 없음)이면 거절한다. 0에 한도를 걸면 파일시스템 전체가 묶이기 때문이다.
- helper는 마운트 소스의 block device 노드를 자기 전용 `/dev`에 `mknod`로 만든 뒤 `xfs_quota`를 부른다.
- `xfs_quota`는 실패해도 0으로 끝난다. 그래서 성공 여부는 quota 보고의 hard·soft limit과 statfs `f_files`를 읽어서만 판정한다.
- Docker의 `SetQuota`는 BHARD/BSOFT만 쓰므로 이 값을 덮지 않는다.
- 이미지는 scheduler의 `WORKER_IMAGE`다. worker 이미지에 `xfsprogs`가 들어 있다. launch마다 다른 이미지를 고르게 두지 않는다. CAP_SYS_ADMIN을 받는 이미지는 카탈로그가 아니라 운영자가 정한다.

적용 시점은 셋이다.

- preflight probe(`verifyWorkspaceQuota`, 루프가 뜬 뒤 첫 통과까지, 그리고 설정이 바뀔 때만): 못 걸면 byte 상한과 같은 규칙으로 기동을 거절하고, opt-out은 같은 `EXECUTION_WORKSPACE_QUOTA=off` 하나다.
- 매 launch의 `ensureWorkspaceVolume`: 새 volume과 기존 volume 모두다. project id는 daemon 재시작 뒤 재사용될 수 있어 캐시하지 않고, 다시 거는 것은 멱등이다.
- 교체 전 `assertReplaceable`: 한도를 못 거는 volume이면 기존 worker를 내리기 전에 교체를 거절한다.
- `migrate-workspace`의 복사 전: 한도보다 파일이 많은 트리는 복사가 실패하고 원본이 남는다.

inode 한도는 in-place로 바꿀 수 있으므로 volume label(`workspace-quota`)에는 넣지 않는다. inode 한도 없이 만든 volume도 거절되지 않고 다음 launch에서 한도를 받는다. 대신 `isolationStampFor` 지문에 넣고 `ISOLATION_CONTRACT`를 7로 올린다. 이 버전 이전으로 롤백한 host는 이 worker들을 newer로 보고 건드리지 않는다. 그래서 한도가 생기거나 바뀌면 실행 중인 worker는 stale로 교체되고, 교체 경로의 ensure가 한도를 건다.

Docker Desktop은 커널 자체가 XFS quota 없이 빌드돼 있어(`XFS (loopN): quota support not available in this kernel`) 로컬에서는 `off`가 사실상 유일한 선택지다. GitHub Actions 러너의 daemon도 data root가 ext4라 마찬가지다. 그래서 실제 상한이 무는지는 CI의 `workspace-quota` job이 xfs + prjquota loop 파일을 data root로 쓰는 daemon을 따로 띄워 확인한다.

상한은 volume 하나에만 거는 것으로는 부족하다. Docker는 이미지가 선언한 `VOLUME` 경로마다 **쓰기 가능한 익명 volume**을 자동으로 붙이는데, 거기에는 상한도 label도 없다. 그래서 launch 전에 이미지를 조회해 `/workspace` 외의 `VOLUME` 선언이 있으면 거절하고(`ImageVolumeError`), 컨테이너를 지울 때는 `v=true`로 익명 volume을 함께 지운다(named volume인 workspace는 영향을 받지 않는다). 아직 pull되지 않은 이미지는 조회가 404이므로 그대로 두고 create가 같은 404를 내게 한다.

확인한 것과 실제로 띄우는 것 사이도 벌어질 수 있다. 태그는 가변이므로 컨테이너는 **조회한 이미지의 id**(`sha256:…`)로 만들고, volume은 create 직후 start 전에 한 번 더 확인한다 — 그 사이에 `docker volume prune`이 지나가면 Docker가 mount용으로 label도 상한도 없는 volume을 새로 만들어 주기 때문이다. 어긋나면 아직 아무것도 실행되지 않은 컨테이너를 지우고 실패시킨다.

quota preflight가 실패하면 **아무것도 띄우지 않되 회수는 한 번 돌린다.** probe도 디스크를 조금 쓰므로 이미 가득 찬 daemon은 preflight부터 실패하는데, 그 순간이 바로 끝난 세션의 workspace를 회수해야 할 때다. 그대로 종료하면 회수할 방법이 영영 없어진다. 이때 도는 것은 pass가 아니라 `reclaimWorkspaces` — 같은 advisory lock 아래에서 ④단계만 수행한다. slot limit 0짜리 pass로는 부족하다. 새 예약만 막힐 뿐 사라진 컨테이너를 재생성하고 stale 컨테이너를 교체하는 일은 그대로 하기 때문이다. 회수가 끝나면 원래 오류를 다시 던져 non-zero로 끝낸다.

volume의 quota label이 지금 설정과 다르면 — 예전에 암묵 생성된 label 없는 volume이거나, 다른 byte 상한으로 만들어진 volume이면 — 기동을 거절한다(`WorkspaceQuotaError`). 이름을 유도하던 시절의 `ap-ws-<installationId>-<sessionId>` volume도 계속 찾아본다. label이 없어 조회에는 걸리지 않지만, 못 본 척하고 새 workspace를 만들면 그 세션이 빈 트리로 시작하고 예전 트리는 묻히기 때문이다. volume의 byte quota는 나중에 바꿀 수 없고(inode 상한은 위에 적은 대로 제자리에서 바뀐다), 바꾸겠다고 지우면 그 세션의 작업 트리가 날아가기 때문이다. 작업 트리를 살린 채 새 계약으로 옮기려면 아래 [legacy workspace 마이그레이션](#legacy-workspace-마이그레이션) 절차를 쓴다. 이전 설정으로 되돌리는 것도 방법이다. 같은 이유로 quota 설정은 `agent-platform.isolation` 지문에도 들어간다 — 그러지 않으면 이미 떠 있는 컨테이너가 예전 상한을 그대로 들고 계속 산다.

이 거절은 **이미 돌고 있는 worker를 죽이기 전에** 일어나야 한다. 지문이 바뀌면 stale 판정 → `terminate` → 재생성 순서인데, 재생성이 volume에서 거절당하면 그 세션은 worker도 없고 되돌아갈 길도 없는 상태로 남는다. 그래서 `inspect`는 stale을 보고하기 전에 그 세션의 volume을 읽기 전용으로 확인하고, 쓸 수 없는 volume이면 stale 대신 예외를 던진다 — 컨테이너는 예전 상한 그대로 계속 돌고, pass는 `reconcileFailed`로 non-zero를 내며, 운영자가 volume을 옮길 때까지 그 상태가 유지된다. 옮기는 방법은 아래 [legacy workspace 마이그레이션](#legacy-workspace-마이그레이션)에 있다. inode 상한은 이 읽기 전용 확인이 아니라 교체 직전의 `assertReplaceable`이 실제로 걸어 보고, 못 걸면 기존 worker를 내리기 전에 교체를 거절한다.

④단계의 GC는 fail-safe 방향이다. **volume을 먼저 나열하고 그 다음 DB에 묻는다** — 순서를 뒤집으면 두 호출 사이에 생긴 세션의 volume을 지운다. 남기는 조건은 session row가 있고 admission state가 `closed`가 아니거나 살아 있는 execution row가 있는 것이다. `stopped`는 예외로, 아래의 만료 규칙을 따른다. session id label이 없거나 session id 모양이 아닌 volume, 아직 컨테이너가 물고 있는 volume(409), 다른 설치의 volume은 전부 **남기고 로그만 남긴다.** 예외는 이름을 유도하던 시절의 label 없는 `ap-ws-<installationId>-<sessionId>` volume이다. 이름에서 읽은 session id는 후보일 뿐이고, **그 id의 row가 있고 `closed`이며 slot을 쥔 launch가 없을 때만** 회수한다(`filterClosedLegacySessions`). row가 없는 경우는 남긴다. label이 있는 volume과 달리, 이름이 맞다는 것만으로는 우리 세션의 것이라는 증거가 되지 않기 때문이다. legacy volume에는 `stopped` TTL도 적용하지 않는다. 먼저 마이그레이션해야 만료 규칙을 탄다. `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC`(기본 3600)보다 어린 volume은 아예 후보가 아니다 — volume은 컨테이너보다 먼저 만들어지므로 그 사이에 회수해 버리면 진행 중인 launch를 깨뜨린다. **판단으로 남긴 것과 실패로 남은 것은 exit code가 다르다.** 아직 마운트돼 있거나(409) 다른 설치 것이라 남긴 volume은 정상 상태이므로 exit code를 바꾸지 않는다(`workspacesUnresolved`). 반면 목록을 못 읽었거나 DB가 답하지 않았거나(`workspaceScanFailed`) 삭제 호출이 던진 경우(`workspacesFailed`)는 아무도 보지 않은 채 디스크가 쌓이는 상태이므로 pass가 non-zero로 끝난다.

**`stopped` 세션의 workspace는 만료된다.** stop한 뒤 `EXECUTION_WORKSPACE_STOPPED_TTL_SEC`(기본 86400, 하루)이 지나면 회수 후보가 된다. 기준 시각은 `sessions.updated_at`이다. stop 전이가 이 값을 찍고, 회수 claim과 완료 기록은 이 값을 건드리지 않는다. 이미 `stopped`인 세션에 새 terminate가 받아들여지면 이 값이 바뀌어 TTL을 그때부터 다시 센다. 다만 terminate는 workspace를 붙잡는 수단이 아니다. 회수 claim이 이미 잡힌 뒤라면 그 회수는 그대로 진행된다. workspace가 필요하면 resume한다. resume만이 claim과 직렬화된다. slot을 쥔 launch가 남아 있으면 후보가 아니다. 하루면 밤사이 stop해 둔 세션은 그대로 돌아오고, 10-session soak처럼 stop이 쌓이는 경우에도 디스크가 끝없이 늘지 않는다. `0`은 다음 pass에서 바로 회수한다는 뜻이다.

resume은 committed checkpoint가 있어야만 받아들여지고, 워커는 claim에 restore pointer가 있으면 checkpoint에서 workspace를 복원한다(복원은 root를 비운 뒤 채운다). 그래서 TTL이 지난 stopped 세션의 volume은 캐시일 뿐이다. 반대로 **checkpoint가 없는 stopped 세션은 resume할 수 없고, 그 volume에만 남은 작업은 TTL이 지나면 사라진다.** 그 작업을 살려야 하면 TTL 안에 volume에서 직접 꺼내야 한다.

회수와 resume은 DB에서 직렬화된다. volume 목록에서 후보가 나오면 pass는 세션 row를 resume과 같은 순서(launch → session)로 잠그고 조건을 다시 확인한 뒤, **claim**(`sessions.workspace_reclaim_id`·`workspace_reclaim_workspace_id`)을 기록하고 commit한다. 그 다음에 volume을 지우고, 같은 claim id로 결과를 기록한다.

* 지워졌거나 이미 없으면 claim을 지우고 `workspace_reclaimed_at`을 찍는다.
* 마운트돼 있거나(409) 다른 설치 것이면 claim만 푼다.
* 삭제 호출이 던지면(timeout 포함) claim을 그대로 둔다. volume이 지워졌는지 알 수 없기 때문이다. 다음 pass는 volume 목록과 별개로 끝나지 않은 claim부터 다시 처리한다. 지워진 volume은 목록에 다시 나오지 않기 때문이다.

claim이 남아 있는 동안 resume은 **503 `BACKEND_UNAVAILABLE`(`retryable: true`)**로 거절된다. 이때 receipt도 idempotency 기록도 남기지 않으므로, 같은 요청을 다시 보내면 회수가 끝난 뒤 정상 처리된다. 반대로 resume이 먼저 commit되면 세션이 `active`가 되고 `updated_at`이 바뀌므로 claim이 거절되고, volume은 다음 launch가 그대로 쓴다. 재개에 성공하면 `workspace_reclaimed_at`은 지워진다. 순서별 동작은 `packages/db/src/workspace-reclaim.integration.test.ts`가 실제 PostgreSQL 위에서 고정한다.

#### legacy workspace 마이그레이션

label이 없는 옛 volume(`ap-ws-<installationId>-<sessionId>`)이나 다른 quota로 만들어진 volume을 가진 세션은 기동이 거절된다. 컨테이너를 잃으면 다시 뜨지도 못한다. 작업 트리를 살린 채 지금 설정의 quota로 옮기는 절차는 다음과 같다. pass가 자동으로 하지 않는 **명시적 운영 작업**이다.

```sh
# scheduler와 같은 환경 변수(DATABASE_URL, EXECUTION_*, DOCKER_HOST)로 실행한다
bun run --cwd apps/control-host migrate-workspace <session-id> [<session-id>...]
# compose(apps profile)라면
docker compose -f infra/compose.yml --profile apps run --rm scheduler \
  bun run apps/control-host/src/scheduler/migrate-workspace.ts <session-id>
```

전제 조건:

* **그 volume을 물고 있는 컨테이너가 없어야 한다.** 정지된 컨테이너도 포함한다(다시 시작되면 복사 중인 원본에 쓰기 때문이다). 있으면 이름을 알려 주고 거절한다. 돌고 있는 세션이면 먼저 terminate로 멈추고(컨테이너가 지워진다) 옮긴 뒤 resume한다. 컨테이너를 `docker rm`으로 직접 지우면 진행 중이던 turn이 끊기고, 그 세션은 컨테이너를 잃은 세션으로 처리된다.
* **scheduler pass lock을 잡는다.** pass가 도는 중이면 `A scheduler pass holds the lock`으로 끝난다. 끝나면 다시 실행한다. 복사하는 동안 pass는 돌지 않으므로 GC도 launch도 두 volume을 건드리지 않는다.
* 그 세션에 끝나지 않은 회수 claim이 없어야 한다. 있으면 다음 pass가 처리한 뒤 다시 실행한다.
* 세션 row가 있고 `closed`가 아니어야 한다. closed 세션의 legacy volume은 GC가 회수한다. row가 없는 세션의 legacy volume은 GC도 이 명령도 건드리지 않는다. 우리 것이라는 증거가 이름뿐이기 때문이다. 운영자가 확인하고 직접 지운다.
* helper 이미지는 **digest로 고정**돼 있어야 하고 daemon에 이미 있어야 한다. 기본값은 busybox 1.36(`DEFAULT_MIGRATION_HELPER_IMAGE`)이다. `docker pull busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662`을 먼저 실행한다. 바꾸려면 `--helper-image` 또는 `EXECUTION_WORKSPACE_MIGRATION_IMAGE`를 쓴다.
* quota preflight(`verifyWorkspaceQuota`)를 먼저 통과해야 한다. 새 volume은 지금 설정의 상한으로 만들어진다.

하는 일:

1. 새 volume을 지금 계약대로 만든다. label과 `size`를 붙이고, 원본 이름은 `agent-platform.migration-source` label로, 원본의 생성 시각은 `agent-platform.migration-source-created-at` label로 남긴다. 이름은 다른 workspace와 같은 1회용이다. workspace는 label로 찾으므로 이름을 바꿀 필요가 없다.
2. 시작하지 않는 pin 컨테이너(`ap-ws-migrate-pin-` 접두어)가 원본을 읽기 전용으로 붙잡는다. Docker는 컨테이너가 참조하는 volume을 지우지 않는다. 그래서 pass lock을 잃은 사이에 GC가 끼어들어도 이 실행이 끝날 때까지 원본은 남는다. pin 이름은 실행마다 다르고, 각 실행은 자기 pin만 지운다. 이어서 helper 컨테이너가 원본을 읽기 전용으로, 새 volume을 쓰기로 붙여 `cp -a`로 복사한다. helper는 root이지만 네트워크가 없고, 파일 복사에 필요한 capability(`CHOWN`·`DAC_OVERRIDE`·`FOWNER`·`FSETID`)만 가진다.
3. 같은 helper가 양쪽의 manifest를 비교한다. 비교 대상은 경로 집합, 종류, mode, uid/gid, symlink 대상, 일반 파일의 크기·mtime·SHA-256이다. 디렉터리의 크기와 시각, xattr와 ACL은 비교하지 않는다. busybox `cp -a`는 hard link를 보존하지 않으므로 hard link는 내용이 같은 별개 파일이 된다. 그만큼 디스크를 더 쓰므로 quota에 걸리면 복사가 실패한다. mtime은 초 단위까지만 비교한다.
4. 일치하면 원본을 지우기 전에 같은 원본의 다른 복사본이 있는지 다시 본다. 있으면 다른 실행이 아직 일하는 중이다. 그때는 자기 복사본을 버리고 실패한다. 원본이 다른 컨테이너에 붙잡혀 있을 때도 마찬가지다. 둘 다 아니면 helper와 pin을 지우고 **원본을 지운다.** 그 순간부터 새 volume이 그 세션의 workspace다.

중간에 실패하면 원본은 그대로다. 복사 실패(quota 초과, helper가 만들 수 없는 device 파일 등), 불일치, 시간 초과(`--deadline-sec`, 기본 3600), lock 유실이 모두 그렇다. 실패한 helper는 `docker logs`로 볼 수 있게 남겨 둔다. pin도 남아 원본을 계속 붙잡는다. 다시 실행하면 먼저 새 pin으로 원본을 붙잡는다. 그다음 남은 helper, 이전 pin, 미완성 복사본(`migration-source`이 같은 원본을 가리키는 것)을 지우고 처음부터 복사한다. 원본과 복사본이 함께 있는 동안에는 backend가 그 세션의 기동을 거절하고, GC는 둘 다 후보에서 뺀다. 그래서 반쯤 복사된 트리 위에서 worker가 뜨는 일도, 원본만 먼저 회수되는 일도 없다. 끝내지 않은 채 두면 두 volume이 그대로 남으므로, 다시 실행하거나 직접 정리한다. 원본 이름의 volume이 복사본을 만든 뒤에 다시 만들어졌을 수도 있다. Docker는 없는 이름을 mount하면 빈 volume을 만들기 때문이다. 이때 생성 시각이 맞지 않으므로, 명령은 그 복사본을 미완성으로 보고 지우지 않는다. 대신 거절한다. 복사본이 유일하게 온전한 workspace일 수 있으니 둘을 직접 비교해 정리한다. 원본이 지워지면 새 volume 위에서 worker를 다시 띄운다. 띄우는 것은 다음 pass이고, 그 전에 실패한 launch가 재시도 대기 중이면 대기가 끝난 뒤의 pass다. legacy volume 때문에 실패하는 launch도 다른 실패처럼 횟수가 쌓인다. 상한에 닿으면 세션이 `failed`가 되므로 되도록 빨리 옮긴다.

## worker 네트워크: 주소 풀, slot limit, 회수

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
* 구성원은 network inspect가 보여 주는 실행 중 endpoint만이 아니다. 멈췄거나 한 번도 시작하지 않은 컨테이너도 시작하는 순간 붙으므로 함께 센다(`network` 필터로 컨테이너를 조회).
* 살아 있는 네트워크에 남아도 되는 proxy는 **지금 실행 중인 하나**뿐이다. label이 붙은 다른 proxy(멈춘 이전 proxy 등)는 떼어 내고 `networksRepaired`로 센다. 시작되는 순간 같은 alias로 worker 앞에 다시 설 수 있기 때문이다. 실행 중인 proxy가 둘 이상이면 어느 쪽도 믿을 수 없으므로 label이 붙은 proxy를 모두 떼고 `networksFailed`로 보고한다. 하나도 실행 중이 아니면 보고만 하고 그대로 둔다. 혼자 시작한 proxy가 믿을 대상이기 때문이다. execution label이 없는 worker 네트워크도 proxy를 떼고 보고한다.
* 모르는 구성원이 붙은 네트워크에서는 그 구성원을 떼어 내지 않는다. 강제로 떼면 흔적이 사라지기 때문이다. 대신 **이 설치의 proxy를 뗀다.** 모르는 컨테이너가 이 설치의 allowlist를 쓰지 못하게 하기 위해서다. 그 네트워크의 worker도 egress를 잃는다. 이런 네트워크는 그대로 두고 `networksFailed`로 보고하며 pass는 exit 1로 끝난다.
* 목록 조회 자체가 실패하면(`networkScanFailed`) 역시 exit 1이다.
* 남은 네트워크는 주소 풀을 계속 차지한다. 운영자가 `docker network inspect <name>`으로 구성원을 확인하고 정리한다.
* proxy가 없으면 preflight에서 종료하므로 이 회수도 돌지 않는다. 대신 새 네트워크도 생기지 않아 누수가 늘지 않고, proxy가 돌아온 뒤 첫 pass가 회수한다.

같은 daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 주고, egress proxy도 설치마다 따로 두어 각자의 id로 label을 단다. worker 네트워크 이름·label에 설치 id가 들어가므로 설치 A의 worker 네트워크에는 A의 proxy만 붙는다. 하나의 proxy를 두 설치가 쓰면 두 설치의 worker가 같은 allowlist를 쓰게 된다.

compose의 proxy는 `apps/egress-proxy/Dockerfile`로 빌드한 이미지로 돈다. 소스가 이미지에 들어 있으므로 checkout을 옮겨도 떠 있는 proxy는 바뀌지 않고, 새 코드는 `up -d --build egress-proxy`로 다시 빌드해야 반영된다.
- proxy는 기동할 때 자기 소스(`src`의 테스트 아닌 `.ts`)의 sha256을 로그(`Egress proxy listening`의 `source`)와 `/healthz`(`ok source=<hex>`)로 알린다. 어떤 코드가 도는지는 이 값으로 확인한다.
- compose healthcheck(`src/healthcheck.ts`)는 이 값을 `/app/src`의 현재 소스와 비교하고, 다르면 `unhealthy`로 떨어진다. 이미지로 돌 때는 둘이 늘 같다. 누군가 소스 트리를 mount해 덮어쓴 뒤 그 checkout을 옮겼을 때만 이 검사가 발동한다. 다만 Docker는 연속 실패 12회(약 60초)가 쌓여야 상태를 바꾼다.

```bash
docker compose -f infra/compose.yml up -d --wait --build egress-proxy   # checkout을 옮긴 뒤
docker compose -f infra/compose.yml exec -T egress-proxy bun run /app/src/healthcheck.ts
docker network ls --filter label=agent-platform.worker-network=true \
  --format '{{.Name}} {{.Labels}}'
```

실제 Docker daemon 대상 테스트는 `DOCKER_BACKEND_TEST=1`로 opt-in한다(`busybox:1.36`을 sleep으로 띄움). local-docker의 `test:docker`는 패키지의 `*.integration.test.ts` 전부를 돌리므로 파일을 더해도 스크립트를 고치지 않는다. egress suite는 backend가 띄운 worker 셋(설치 둘)으로 worker 사이 차단과 proxy 재부착·orphan 네트워크 회수를 보고, internal 네트워크·바깥 네트워크·upstream 두 개·host `openssl`로 만든 인증서를 쓰는 TLS upstream·그 인증서로 LocalStack 앞에 세운 TLS front(https S3 endpoint)·`oven/bun:1.3.14`로 띄운 proxy를 직접 만들어 컨테이너 안에서 `wget`·`nc`·`curlimages/curl`로 확인하며 인터넷을 쓰지 않는다(이미지 pull 제외). scheduler의 15 세션 → 컨테이너 ≤ 10 검증은 `QUEUE_DATABASE_URL`까지 있어야 실행된다.

```bash
DOCKER_BACKEND_TEST=1 bun run --cwd packages/adapters/execution/local-docker test:docker
DOCKER_BACKEND_TEST=1 QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test apps/control-host/src/scheduler/main.integration.test.ts
```

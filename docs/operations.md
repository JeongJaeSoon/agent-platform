# 운영 참고 — 로컬 Docker 설치의 실행 기반

로컬 스택을 처음 띄우는 절차는 [quickstart](quickstart.md)에 있다. 이 문서는 그 스택의 각 구성요소가 무엇을 보장하고 어디서 멈추는지, 설정값과 운영자가 직접 하는 일을 적는다. 백업·복원은 [backup-restore.md](backup-restore.md), 의존 서비스만 띄우거나 API를 host에서 돌리는 개발 환경은 [development.md](development.md), CI는 [ci.md](ci.md)에 있다.

## reconciler·scheduler와 worker 격리

reconciler pass(`main.ts reconciler --once`, package script `reconciler`)는 한 batch만 처리한 뒤 종료한다. lease 기한은 스스로 해석하지 않는다 — API가 heartbeat를 받을 때 `workers.lease_expires_at`에 마감 시각을 적고 reconciler는 그 시각과 DB 시계를 비교한다. `HEARTBEAT_TTL_SEC`는 API만 읽으며(기본 30, 20 이하이거나 86400을 넘으면 기동 거부 — 아래 "API 설정" 참고), reconciler는 이 값이 설정돼 있으면 기동하지 않는다(94S-132). 실제 변경 전에 대상만 확인하려면 dry-run을 명시한다. 미처리 row 또는 `queued` turn만 자동 재전달하며, 실행 중이거나 상태를 증명할 수 없는 row는 session을 `failed`로 전환하고 명시적 복구 대상으로 남긴다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
RECONCILER_DRY_RUN=true \
  bun run --cwd apps/control-host reconciler

DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
RECONCILER_DRY_RUN=false \
  bun run --cwd apps/control-host reconciler
```

compose의 `apps` profile에서는 `reconciler` 서비스가 이 pass를 기본으로 반복 실행한다(94S-320). role 이름만 준 `main.ts reconciler`가 감독 루프(`apps/control-host/src/pass-loop`)이고, pass마다 `main.ts reconciler --once`를 자식 프로세스로 띄우므로 pass의 one-shot 계약은 그대로다. pass는 겹치지 않고 직렬로 돈다. healthcheck는 `main.ts reconciler --health`다. 루프가 SIGTERM을 받으면 새 pass를 시작하지 않고 진행 중 pass에 SIGTERM을 보낸 뒤 10초 뒤 SIGKILL한다. 쓰기마다 트랜잭션이라 어디서 끊겨도 잃는 것이 없다. compose `stop_grace_period`는 20s다.

| 설정 | 기본 | 의미 |
|---|---|---|
| `RECONCILER_INTERVAL_SEC` | 10 | pass가 끝난 뒤 다음 pass까지 쉬는 시간 |
| `RECONCILER_PASS_TIMEOUT_SEC` | 60 | 이 시간을 넘긴 pass는 SIGTERM, 10초 뒤 SIGKILL로 끝내고 실패로 센다. DB가 멈춘 pass가 pool timeout으로 스스로 끝나는 약 45초보다 크게 둔다 |
| `RECONCILER_MAX_CONSECUTIVE_FAILURES` | 3 | 실패 pass가 이만큼 이어지면 루프가 exit 1 하고 `restart: unless-stopped`가 재시작한다. 그보다 적으면 다음 pass가 곧 재시도다 |
| `RECONCILER_HEALTH_STALE_SEC` | 90 | healthcheck는 마지막으로 끝난 pass가 실패했거나, 진행 중인 pass가 제한 시간을 넘겼거나, 이 시간 동안 성공한 pass가 없으면 unhealthy다. 성공 직후 멈춘 pass도 제한 시간에서 바로 unhealthy가 된다. `RECONCILER_INTERVAL_SEC + RECONCILER_PASS_TIMEOUT_SEC`보다 커야 기동한다 |
| `RECONCILER_STATUS_FILE` | `/tmp/reconciler-status.json` | 루프가 pass마다 갱신하는 상태(`lastSuccessAt`·`lastDegradedAt`·`lastFailureAt`·`lastFailureReason`·`consecutiveFailures`·`lastPassDurationMs`, 진행 중인 pass의 `passDeadlineAt`). healthcheck가 읽는다 |
| `RECONCILER_BATCH_SIZE` | 100 | pass의 각 단계(orphan·lease·interrupt 회수, 기한을 넘긴 interrupt·terminate receipt의 `unknown` 마감, 입력 대기 알림)가 한 번에 처리하는 row 수 상한. 남은 row는 다음 pass가 처리한다(94S-399). scheduler의 terminate 기한 sweep은 이 값을 읽지 않고 한 번에 전부 처리한다 |

최근 성공·실패는 `docker compose -f infra/docker-compose.yml exec reconciler cat /tmp/reconciler-status.json`과 로그의 `Reconciler pass completed`/`Reconciler pass failed`로 본다. reconciler 서비스는 환경 파일을 읽지 않는다 — 환경 파일에 흔히 있는 `HEARTBEAT_TTL_SEC`를 받으면 기동을 거부하기 때문이다. 위 값은 `docker compose`를 실행하는 셸에서 준다. 단 compose는 `RECONCILER_STATUS_FILE`과 `RECONCILER_DRY_RUN`을 넘기지 않는다. 그래서 compose의 reconciler는 셸 값과 상관없이 기본 경로에 상태를 쓰고, 언제나 실제로 고친다. dry-run은 위 예시처럼 pass를 직접 한 번 돌려서 확인한다. reconciler 컨테이너에는 Docker socket이 없다. reconciler는 epoch fence와 `desired_state = terminated`만 DB에 적고, 컨테이너 제거와 부재 확인은 scheduler가 한다. 두 reconciler가 겹쳐 돌거나 pass 도중 재시작돼도 각 쓰기가 row lock 아래에서 다시 판정되므로 같은 lease·interrupt·orphan을 두 번 처리하지 않는다(`apps/control-host/src/reconciler/overlap.integration.test.ts`).

scheduler pass도 one-shot이다(`main.ts scheduler --once`, package script `scheduler`). compose `scheduler` 서비스는 같은 감독 루프로 이 pass를 반복 실행한다(`main.ts scheduler`, healthcheck `main.ts scheduler --health`). 설정은 `SCHEDULER_INTERVAL_SEC`(5)·`SCHEDULER_PASS_TIMEOUT_SEC`(180, `EXECUTION_DOCKER_STOP_TIMEOUT_SEC` + `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC`보다 커야 기동)·`SCHEDULER_MAX_CONSECUTIVE_FAILURES`(3)·`SCHEDULER_HEALTH_STALE_SEC`(200, interval + timeout보다 커야 기동)·`SCHEDULER_STATUS_FILE`(`/tmp/scheduler-status.json`, compose는 넘기지 않는다)이고 의미는 위 reconciler 표와 같다. 다른 pass가 lock을 쥐고 있어 건너뛴 pass는 exit 75로 끝나며 성공도 실패도 아니다. 건너뛰기만 이어지면 성공이 없으므로 stale 시간 뒤 unhealthy가 된다. 할 일은 다 했지만 이번 pass에서 도울 수 없는 세션을 남긴 pass — launch가 backoff 중이거나(`launch_backoff_count`), 방금 quarantine됐거나(`launch_quarantined_count`), 교체 한도를 다 쓴(`replacement_exhausted_count`) 세션 — 는 exit 76(degraded)으로 끝난다(94S-368). 그 상태는 DB에 있어 재시작으로 풀리지 않으므로 degraded는 연속 실패로 세지 않고 실패 streak를 끊는다. health는 최근 degraded pass를 healthy로 보되 reason에 `completed degraded`를 적고, status에는 `lastDegradedAt`으로 남는다(`lastSuccessAt`은 깨끗한 pass만). 같은 pass에 다른 실패가 하나라도 있으면 지금처럼 exit 1이다. 루프가 SIGTERM을 받으면 진행 중 pass는 다음 안전 지점(pass lock 상실 때 멈추는 자리와 같다)에서 멈춰 더 예약하지 않고, 30초 안에 끝나지 않으면 kill된다. pass가 기다리던 worker 정지는 kill돼도 daemon에서 계속된다(Engine 25부터 요청이 끊겨도 stop을 취소하지 않는다). compose `stop_grace_period`는 45s다. kill 의도(terminate, lease 만료, quarantine)를 수행할 때 pass는 worker가 turn을 drain하기를 기다리지 않는다(94S-385). stop을 요청하고 5초 안에 끝나지 않으면 그 컨테이너를 `kills_stopping_count`로 세고 넘어가며, 실패로 세지 않는다. daemon은 SIGTERM 뒤 `EXECUTION_DOCKER_STOP_TIMEOUT_SEC`가 지나면 SIGKILL하고, 다음 pass가 컨테이너가 사라진 것을 확인해 slot을 돌려준다. drain 기한을 넘긴 claimed worker의 교체와 launch intent 없는 orphan 컨테이너의 정지도 같다(orphan은 `orphan_stopping_count`로 세고 사라질 때까지 slot을 차지한다). unclaimed worker의 교체는 기다린다. turn이 없어 곧 끝나고, 교체를 시도할 때마다 교체 한도를 쓰기 때문이다. 그래도 unclaimed 컨테이너를 지우고 다시 만드는 경로에서는 pass가 정지 하나를 끝까지 기다릴 수 있다. 그래서 pass timeout이 stop timeout + request timeout보다 작으면 scheduler가 기동을 거부한다. 컨테이너 create·start 요청이 `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC` 안에 답을 받지 못하면 컨테이너가 생겼는지 알 수 없으므로 launch 실패로 세지 않는다(94S-393). nonce를 폐기하지 않고 backoff도 걸지 않는다. 그 pass는 실패(exit 1)로 끝난다. 다음 pass가 inspect해서 컨테이너가 있으면 채택한다(생성만 됐으면 시작한다). 없으면 그제야 launch 실패로 센다. 이때 nonce를 폐기하고 backoff를 걸어, 끝내 생기지 않는 create가 slot을 계속 붙잡지 않고 실패 한도에서 quarantine된다. 폐기 뒤에 늦게 생긴 컨테이너는 실패한 시도로 보고 지운다. daemon이 거절로 답한 경우(4xx·5xx)는 지금처럼 launch 실패로 센다. scheduler를 멈춰도 worker는 끝나지 않는다. slot은 pass가 worker 부재를 확인한 뒤에만 반환된다. 한 pass는 ① 살아 있는 `executions` row를 Docker와 대조(컨테이너가 없으면 같은 intent로 재생성, exit했으면 `terminated` 기록 후 제거) ② launch intent 없는 관리 컨테이너를 로그 후 정지하고, 컨테이너가 사라진 worker 네트워크를 지우거나 proxy가 떨어진 네트워크에 다시 붙임(94S-216) ③ `EXECUTION_SLOT_LIMIT` 안에서 unassigned session마다 intent 커밋 → 컨테이너 생성 ④ 끝난 session의 workspace volume 회수 순서로 진행한다. worker 컨테이너는 Docker socket·host HOME을 받지 않고 env는 bootstrap claim에 필요한 `WORKER_EXECUTION_ID`·`WORKER_EXECUTION_GENERATION`·`WORKER_BOOTSTRAP_NONCE`·`WORKER_GATEWAY_URL`, tmpfs를 가리키는 `HOME`, egress proxy를 가리키는 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`(대소문자 두 표기. `NO_PROXY`에는 proxy 자신의 이름이 들어간다), proxy의 credential route를 가리키는 `WORKER_EGRESS_CREDENTIAL_URL`(94S-252, 아래 절), 그리고 object store의 이름 — `S3_BUCKET`·`AWS_REGION`과 세션 prefix `WORKER_OBJECT_PREFIX`(`sessions/<sessionId>/`) — 를 받는다. scheduler는 bucket과 region이 없으면 기동하지 않는다. object store 자격 증명과 endpoint는 받지 않는다(94S-251). 워커는 proxy의 object store route로만 object store에 닿으며, 경계는 그 route다(아래 94S-252 절). 워커 쪽 `scopedCheckpointObjectStore`(`packages/storage`)는 prefix 밖 key를 요청 전에 거절하는 빠른 실패일 뿐이다. 워커 안에서 `@agent-platform/storage`를 import하는 파일은 `apps/worker/src/object-store.ts` 하나뿐이며 `tests/architecture.test.ts`가 이를 강제한다. Docker daemon 응답이 create 요청 본문을 되돌려 주는 경우에 대비해 backend는 오류 메시지에서 nonce를 지운다. `/tmp`·HOME tmpfs는 worker uid/gid 소유로 마운트된다. `/workspace` named volume은 Docker가 이미지의 같은 경로에서 초기화하므로 worker 이미지가 `/workspace`를 worker uid 소유로 미리 만들어 두어야 한다(이미지 계약). worker 이미지(`apps/worker/Dockerfile`)는 `WORKER_IMAGE`로 받는다. pass 전체는 Postgres session advisory lock(`scheduler:pass`)으로 직렬화되어 겹친 실행은 로그만 남기고 건너뛴다. 같은 Docker daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. scheduler는 이 값이 없으면 기동하지 않는다(adapter만 테스트용 기본값 `local`을 가짐). 같은 값을 쓰는 두 설치가 daemon을 공유하면 서로의 컨테이너를 orphan으로 회수한다.

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

worker 컨테이너는 scheduler가 execution마다 만드는 **전용 네트워크** `ap-net-<installationId>-<executionId>-g<generation>` 하나에만 붙는다(94S-216). 이 네트워크는 bridge driver, `internal: true`, `EnableIPv6: false`, `com.docker.network.bridge.gateway_mode_ipv4=isolated`로 만들어진다. Docker가 이 네트워크에서 바깥으로 나가는 경로를 만들지 않고 host 쪽 bridge 주소(IPAM gateway)도 두지 않는다. 그래서 worker는 host·host에서 도는 프로세스·LAN·instance metadata(`169.254.169.254`)·다른 compose 서비스·다른 worker에 직접 닿지 못한다. 이 네트워크의 구성원은 worker 자신과 egress proxy 둘뿐이다. scheduler는 `agent-platform.egress-proxy=<installationId>` label이 붙은 **실행 중인 컨테이너 정확히 하나**를 그 설치의 proxy로 보고, 네트워크마다 `EXECUTION_EGRESS_PROXY_URL`의 host 이름을 alias로 붙여 connect한다. worker는 `HTTP_PROXY`/`HTTPS_PROXY`로 그 이름을 가리킨다. proxy 주소가 네트워크마다 다르므로 `EXECUTION_EGRESS_PROXY_URL`의 host는 이름이어야 하고, IP literal과 `localhost`는 거부한다. compose의 `egress-proxy` 서비스는 이 label을 달고 있다. `host.docker.internal:host-gateway` 매핑은 worker에서 제거했다 — gateway도 proxy를 거친다.

차단 정책은 proxy의 두 목록으로 버전 관리한다. `EGRESS_ALLOWLIST`는 공인 목적지(`host:port`)이고 해석된 주소가 전부 public unicast여야 통과한다. `EGRESS_PRIVATE_ALLOWLIST`는 사설 대역에 있다고 알고 허용하는 목적지(gateway)다. compose 기본값은 `EGRESS_ALLOWLIST`가 비어 있고 `EGRESS_PRIVATE_ALLOWLIST`가 `api:3000,host.docker.internal:3000`이다. provider·저장소·object store는 두 목록 어디에도 두지 않는다(94S-383). forward proxy로 닿으면 각자의 credential route를 우회하기 때문이다. provider에는 worker가 가진 임의 key로 비용 계측 밖에서 닿고, Gitea의 public 저장소는 token 없이 읽히며, LocalStack은 서명을 검사하지 않으므로 다른 세션의 prefix까지 닿는다. 이들은 credential route만 닿는 목록 `EGRESS_CREDENTIAL_ALLOWLIST`(compose 기본값 `api.anthropic.com:443`)·`EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`(compose 기본값 `gitea:3000,fake-messages:4010,localstack:4566`)에 둔다(94S-251·94S-252). credential 목록의 목적지가 forward 목록에도 있으면 proxy는 기동을 거부한다. 그래서 수정 전 예시 값을 복사해 둔 설치는 업그레이드 뒤 자기 환경 파일의 forward 목록에서 그 값들을 지워야 proxy가 뜬다. 비교는 적힌 `host:port` 그대로이므로, 같은 upstream을 다른 이름이나 IP로 적으면 잡지 못한다. `.env.example`도 같은 값이다(`tests/images.test.ts`가 둘을 묶는다). 두 목록 모두 link-local(`169.254.0.0/16`·`fe80::/10`)·multicast·reserved로 해석되면 거부하므로 allowlist에 오른 이름이 metadata 주소로 해석되는 rebinding도 막힌다. 목록에 없는 host·port는 CONNECT·absolute-form 모두 `403`이고, absolute-form이 아닌 요청은 `/healthz` 외에는 `400`이다.

CONNECT 터널은 TLS만 나른다(94S-219). proxy는 `200 Connection Established`를 쓴 뒤 클라이언트의 첫 바이트를 upstream에 흘리기 전에 TLS ClientHello로 읽어, DNS 이름 authority면 `server_name`이 그 authority와(대소문자만 무시하고) 같아야 하고, allowlist에 명시된 IP literal authority면 `server_name`이 없어야 한다. `encrypted_client_hello`(0xfe0d)는 GREASE 여부와 관계없이 거부한다 — proxy는 둘을 구별할 수 없고, 진짜 ECH는 검사 대상인 이름을 숨긴다. handshake가 아닌 첫 레코드, host_name이 둘인 hello, 최초 16KiB(record header 포함) 또는 15초(`handshakeTimeoutMs`) 안에 완성되지 않는 hello는 전부 연결을 끊는다. 거부는 200 뒤에 일어나므로 클라이언트에는 handshake 도중 연결 종료로 보인다.

이 관문의 한계:

* 검사 대상은 평문으로 보이는 **바깥** ClientHello의 SNI다. TLS를 종단하지 않으므로 그 안의 HTTP `Host`·경로·본문, 허용된 서비스가 다시 중계하는 곳은 보지 못한다. domain fronting을 CDN 쪽에서 막는 것은 별개의 통제다.
* IP literal allowlist는 `IP:port` 접근 권한이지 hostname 보장이 아니다. 공유 CDN edge 주소를 IP로 allowlist에 올리지 않는다.
* **Bun 1.3.10–1.3.13의 `fetch`·`node:https`는 GREASE ECH를 보내므로 이 proxy로 CONNECT하면 거부된다.** 1.3.14는 보내지 않는다(2026-09-25 실측, 94S-441). `egress.integration.test.ts`의 "Bun's own fetch handshakes through the tunnel"이 이를 고정한다. Bun `node:tls`·`Bun.connect({tls})`, Node, curl, 그리고 worker의 SDK가 spawn하는 Claude Code 바이너리도 보내지 않는다(2026-09-23 실측). worker의 object store는 CONNECT를 쓰지 않는다 — worker 네트워크 안의 proxy object store route에 평문 http로 보내고, upstream TLS는 proxy가 맺는다(94S-251). AWS에서는 route가 virtual-hosted 이름으로 부르므로 `<bucket>.s3.<region>.amazonaws.com:443`이 `EGRESS_CREDENTIAL_ALLOWLIST`에 있어야 한다(점이 든 bucket 이름은 path-style `s3.<region>.amazonaws.com:443`). worker의 Bun HTTP 클라이언트로 https upstream을 CONNECT로 부르는 코드는 지원하지 않는다. 런타임·클라이언트 버전을 올리면 다시 측정한다.

**worker끼리는 서로 닿지 않는다(94S-216).** 다른 worker와 같은 네트워크에 있지 않으므로 그 주소로 가는 경로가 없고, 컨테이너 이름도 풀리지 않는다. proxy를 거쳐 가려 해도 사설 주소는 `EGRESS_PRIVATE_ALLOWLIST`에 없으면 거부된다. 다른 설치의 worker와 proxy에도 닿지 않는다 — 네트워크와 proxy 선택이 모두 설치별이다. 통합 테스트(`egress.integration.test.ts`의 "workers do not reach one another")가 이를 확인한다. 같은 네트워크의 형제 컨테이너라면 열린 포트에 닿는다는 양성 대조와 함께 확인한다. 남은 한계:

* proxy는 모든 worker 네트워크에 붙는 신뢰 구성요소다. proxy가 침해되면 그 설치의 모든 worker에 닿는다. `EGRESS_PRIVATE_ALLOWLIST`에는 worker로 해석될 수 있는 이름을 넣지 않는다.
* ~~internal bridge도 host 쪽 bridge 인터페이스에 주소를 가진다~~ — 94S-274에서 닫았다. 기본 gateway mode(`nat`)의 internal bridge는 host에 subnet의 첫 주소를 준다. 그래서 daemon host가 그 주소나 wildcard로 listen하는 **host 프로세스**(publish된 포트가 아니라 host에서 직접 띄운 프로세스)에 worker가 proxy 없이 닿았다. 이제 worker 네트워크는 `gateway_mode_ipv4=isolated`로 만들어져 host가 그 네트워크에 주소를 갖지 않는다. 이 모드는 **Docker 28(API 1.48) 이상**에만 있다. scheduler는 기동 preflight(`verifyNetworkIsolation`)에서 daemon의 API 버전이 1.48 미만이면 경고로 넘기지 않고 거부한다(`GatewayModeUnsupportedError`). 끄는 설정은 없다. 통합 테스트(`egress.integration.test.ts`의 "a host process on a wildcard address")는 두 가지를 함께 확인한다. 모드가 없는 internal 네트워크에서는 host listener에 닿는다(양성 대조). worker 네트워크에서는 닿지 않는다. native Linux(CI)에서는 테스트 프로세스 자신이 `0.0.0.0` listener다. Docker Desktop은 daemon이 VM 안에 있으므로 VM의 network namespace를 쓰는 `--network host` 컨테이너가 listener를 대신한다. IPv6는 worker 네트워크에서 꺼져 있어 해당하지 않는다.

scheduler는 pass 전에 그 설치의 proxy가 정확히 하나 떠 있는지 확인한다(`verifyNetworkIsolation`). 없거나 둘 이상이면 pass lock을 잡고 worker 네트워크 reconcile만 돌린다(orphan 회수, 둘 이상이면 proxy 분리). 그다음 아무것도 띄우지 않은 채 non-zero로 종료한다. worker 네트워크는 launch 때마다 검사한다. 이미 같은 이름의 네트워크가 있으면 새로 만들지 않고 다음을 확인한다. 하나라도 어긋나면 `NetworkIsolationError`로 launch를 거부한다(fail closed).

* bridge·internal·IPv6 꺼짐·소유 label(설치·execution·generation)이 맞는가
* host가 네트워크에 주소를 갖지 않는가 — `Options`의 `gateway_mode_ipv4`가 `isolated`이고 IPAM에 gateway가 없어야 한다. 모르는 옵션을 기록만 하고 gateway를 주는 옛 daemon이 있어서 두 조건을 모두 본다
* worker와 proxy 외의 구성원이 없는가

proxy attach 결과는 응답 코드가 아니라 proxy 컨테이너가 보고하는 attach·alias로 판정한다. 이미 붙어 있으면 403이 오고, alias 없이 붙어 있으면 DNS가 풀리지 않기 때문이다. 이미 있는 컨테이너를 adopt할 때는 그 컨테이너가 자기 네트워크(같은 id) **하나에만** 붙어 있어야 한다. 컨테이너는 네트워크 이름이 아니라 id로 만든다. 그래서 같은 이름으로 다시 만들어진 네트워크가 검사받은 네트워크를 대신할 수 없다.

예전 설정 `EXECUTION_DOCKER_NETWORK`·`EXECUTION_DOCKER_NETWORK_ALLOWLIST`는 더 이상 읽지 않는다. 값이 남아 있으면 조용히 무시하지 않고 기동을 거부한다. 환경 파일에서 지우고 proxy 컨테이너에 label을 단다.

컨테이너에는 만들어질 때의 격리 계약이 `agent-platform.isolation` label로 `<버전>:<지문>` 형태로 찍힌다. 지문은 proxy URL·credential route 포트·`NO_PROXY` 값·user·workspace/HOME 경로·tmpfs 크기·workspace quota 설정과 inode 상한·stop timeout·worker 상한(turn 시간, provider 재시도), 그리고 object store의 bucket·region의 해시라서, 코드를 바꾸지 않고 `EXECUTION_EGRESS_PROXY_URL`이나 `S3_BUCKET`만 바꿔도 값이 달라진다. object store endpoint와 자격 증명은 지문에 없다. worker는 둘 다 받지 않고 proxy의 object store route를 거치며, 그 요청은 API가 서명한다(94S-251). 그래서 `AWS_ENDPOINT_URL`이나 key를 바꿔도 worker는 교체되지 않고, API를 재기동하면 다음 요청부터 새 값이 쓰인다. CPU·memory·pids 한도도 일부러 지문 밖에 둔다. 한도는 launch의 것이라 reserve 때 `worker_launches.resources`에 고정되고 `agent-platform.launch-spec` label로 대조된다(94S-202). 그래서 한도를 낮추면 실행 중인 worker를 한꺼번에 교체하지 않고 다음 launch부터 적용된다. 단, label이 없는 94S-202 이전 컨테이너는 대조 없이 adopt된다. 실행 중인 컨테이너의 격리는 제어 호스트를 올려도 바뀌지 않으므로, scheduler는 label이 현재 값과 다른 컨테이너를 `stale`로 보고 정지·제거한 뒤 저장된 intent로 다시 만든다(`ensureExecution`도 그런 컨테이너는 adopt하지 않는다). 버전이 **더 높은** 컨테이너는 롤백 중인 새 제어 호스트가 만든 것이다. 그 경계가 지금 요구하는 것과 같은지 알 수 없으므로 adopt도 교체도 하지 않고 `IsolationContractError`로 거절한다 — row는 살아 있고 pass는 non-zero로 끝나므로 운영자가 롤포워드하거나 직접 제거해야 한다. 격리의 모양 자체가 바뀌면 `ISOLATION_CONTRACT`를 올린다. 94S-216이 계약을 5로 올렸다(execution별 네트워크). 그래서 업그레이드하면 공유 네트워크 위의 기존 컨테이너가 전부 stale로 교체된다. 교체 전 확인(`assertReplaceable`: 이미지·workspace·proxy·새 네트워크)이 실패하면, 보통은 옛 컨테이너를 그대로 두고 다음 pass에서 다시 시도한다. 하지만 계약 5 미만 컨테이너는 공유 네트워크에서 이웃 worker에 닿을 수 있다. 그래서 아직 claim되지 않은 그 컨테이너는 **모든 네트워크에서 떼어 낸** 채로 둔다. claim 전이라 진행 중인 turn은 없다. 확인이 통과하는 pass에서 정상 교체된다. 결과는 교체 실패 로그의 오류 메시지 끝에 붙는다. claim된 계약 5 미만 worker는 이 확인 없이 teardown되므로 여기서 건드리지 않는다. 확인과 disconnect를 한 번에 묶는 fence는 없다. 그래서 disconnect 뒤에 claim 여부를 한 번 더 확인하고, 그사이 claim됐으면 네트워크를 다시 붙여 scheduler의 teardown(SIGTERM으로 drain)에 맡긴다. disconnect가 이어지는 그 짧은 동안 claim 요청이 오가던 worker는 요청이 끊길 수 있다.

94S-274가 계약을 6으로 올렸다(host 주소 없는 네트워크). 계약 5 컨테이너의 네트워크는 이름이 같지만 gateway mode는 제자리에서 바꿀 수 없으므로 교체는 다음 순서를 탄다.

* **교체 전 확인(`assertReplaceable`):** 같은 launch의 계약 5 worker가 그 네트워크에 실제로 붙어 있고 결함이 host 주소 하나뿐이면 옛 네트워크를 통과시킨다. 이어지는 teardown이 컨테이너와 함께 네트워크를 지운다. 그다음 `ensureExecution`이 `isolated`로 새로 만든다.
* **일반 launch 경로:** worker 없이 남은 옛 네트워크(teardown의 네트워크 제거가 실패한 경우)는 proxy만 붙어 있으면 지우고 다시 만든다. 다른 구성원이 있으면 거부한다. 옛 worker가 아직 붙어 있는 옛 네트워크에 새 컨테이너를 올리는 일은 없다.
* **`reconcileNetworks`:** 계약 5 worker가 붙은 옛 네트워크에서는 proxy를 떼지 않는다. claim된 worker는 확인 없이 drain·teardown되므로 그 전에 egress를 끊지 않기 위해서다. 계약 6 worker가 host 주소 있는 네트워크에 있으면 결함으로 보고 proxy를 뗀다.

이 교체도 claim된 worker는 아래의 turn 경계 drain 뒤에 닫는 규칙(94S-250)을 따른다. **배포 순서:** daemon을 먼저 Docker 28 이상으로 올린다. 옛 daemon에서는 preflight가 pass 전체를 막는다. 그러면 계약 5 worker도 교체되지 않고 그대로 돈다(새 admission만 fail-closed).

업그레이드 뒤 옛 공유 네트워크(`agent-platform-worker`, `EXECUTION_DOCKER_NETWORK`로 이름을 바꿨다면 그 이름)는 compose가 더 이상 선언하지 않는다. 그래도 저절로 지워지지는 않고, 주소 풀의 subnet 하나를 계속 차지한다. 계약 4 컨테이너가 모두 교체된 뒤 `docker network rm agent-platform-worker`로 지운다. 실행 중인 컨테이너가 붙어 있으면 Docker가 삭제를 거부한다(403). 그래서 쓰는 중인 네트워크를 실수로 지울 일은 없다. **이미 claim된 worker는 다시 만들 수 없으므로 turn 경계까지 drain한 뒤 teardown된다(94S-250).** 아래 절을 따른다.

#### 계약이 오를 때 claim된 worker의 drain (94S-250)

claim된 컨테이너가 stale이면 scheduler는 바로 부수지 않는다.
1. 첫 pass가 `worker_launches.drain_requested_at`을 DB 시계로 기록한다. 그때부터 그 worker는 새 turn을 받지 않는다. 이미 받은 turn은 끝까지 돌고, 뒤에 온 입력은 queued로 남는다.
2. 도는 turn(`running`·`needs_input`)이 있거나 worker가 아직 첫 입력을 청하지 않았으면(workspace 준비·checkpoint 복원 중. 이때 끊으면 실패한 기동으로 센다) 컨테이너를 그대로 두고 pass summary의 `draining`(로그 `draining_count`, `Claimed execution draining before its replacement`)에 올린다.
3. turn이 끝난 뒤 첫 pass가 컨테이너를 teardown한다. turn의 checkpoint는 그 finalize에 실려 이미 확정됐다. SIGTERM을 받은 worker는 idle drain으로 release하고, queued 입력은 새 launch(현재 계약)가 받아 checkpoint에서 이어간다.
4. drain 기한이 지나도 turn이 열려 있거나 기동이 끝나지 않았으면 그대로 teardown한다. 이때 그 turn은 전처럼 `outcome_unknown`이 된다. 끝나지 않은 기동은 worker가 SIGTERM에 drain으로 release하면 세지 않고, release 없이 죽으면 실패 1회로 센다. pass summary의 `drainsOverdue`(로그 `drain_overdue_count`)와 경고 `Drain deadline passed with the worker still busy; replacing anyway` 한 줄이 남는다. 기한은 `MAX_TURN_SECONDS` + 5분이다. 어떤 turn도 `MAX_TURN_SECONDS`를 넘지 못하고, 5분은 그 turn을 끝내는 finalize·checkpoint 몫이다.

claim되지 않은 stale 컨테이너는 전처럼 곧바로 교체된다.

**롤아웃 절차:** 계약을 올리는 배포는 claim된 worker의 교체가 최대 drain 기한만큼 늦어진다. 그동안 옛 계약 컨테이너가 살아 있고, 그 세션에는 새 turn이 시작되지 않는다. 즉시 끊어야 하는 격리 결함이면 해당 세션을 terminate해 기다리지 않는다. 롤백으로 컨테이너가 다시 current가 되면 drain 요청은 남는다. 그 worker는 새 turn 없이 유휴 시간 뒤 스스로 끝나고, 세션은 다음 launch로 이어진다.

### checkpoint 복원이 계속 실패하는 세션 (94S-345)

복원을 넘겨받은 worker가 ready를 보고하기 전에 끝나면 scheduler는 곧바로 다시 띄우지 않는다. 이런 종료가 두 번째까지는 30초, 60초를 기다린다. 세 번째에는 세션이 `recovery_required`로 멈추고 새 generation을 만들지 않는다. 기다리는 동안이나 멈춘 뒤의 세션 상세 attention은 `RESTORE_FAILED`다.
- `reason`: 마지막 worker가 남긴 오류다. release 없이 죽었으면 `execution_gone`이다.
- `failures`: 이어진 실패 횟수다.
- `retry_at`: 다음 시도 시각이다. 멈춘 뒤에는 null이다.

이벤트 스트림에는 실패마다 system `checkpoint_restore_failed`가 남는다. worker 로그의 `worker.checkpoint.restore_refused`, `worker.failed`에서 원인을 확인한다. 저장소 응답 checksum 불일치(전송 중 손상)도 `CHECKPOINT_UNAVAILABLE`로 분류된다.
- 저장소나 egress-proxy `/object-store` 경로가 잠시 답하지 못한 것은 실패로 세지 않는다(94S-390). worker는 `worker.checkpoint.restore_unavailable` 경고를 남기고 시작 예산(`WORKER_STARTUP_TIMEOUT_SEC`) 안에서 복원을 다시 한다. 이 경고가 이어지면 checkpoint가 아니라 저장소와 경로를 본다. 예산을 넘겨야 실패 1회로 센다. `restore_refused`는 checkpoint 쪽 손상이다.
- 원인이 세션 밖에 있었다면(프록시의 전송 중 손상, 저장소 경로 설정 오류) 그것을 고친 뒤 `retry_restore`로 같은 checkpoint를 다시 복원한다(94S-348). 횟수가 0으로 돌아가고 queued 입력이 다시 신호된다. 다음 worker는 실패하던 worker와 같은 pointer에서 복원 계획을 다시 받는다.
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

### 시작 단계에서 계속 죽는 세션 (94S-302, 94S-347)

checkpoint가 없는 세션도 같은 규칙을 따른다. worker가 claim 뒤 입력을 한 번도 청하지 않고 끝나면 실패 1회다. workspace 준비(git clone·fetch)나 엔진 기동에서 죽은 경우다. 두 번째까지는 30초, 60초를 기다리고, 세 번째에는 `recovery_required`로 멈춘다. attention은 `STARTUP_FAILED`이고 `reason`·`failures`·`retry_at`은 위와 같다. 이벤트 스트림에는 실패마다 system `startup_failed`가 남는다.
- 흔한 원인은 저장소 URL·branch가 사라졌거나 저장소 자격 증명이 거부된 경우, 그리고 worker의 object store·proxy 설정 오류다. worker 로그의 `worker.stopping kind=failed`, `worker.failed`에서 확인한다.
- 원인을 고친 뒤 `start_fresh`로 다시 띄운다. 이 세션에는 버릴 checkpoint가 없으므로 잃는 것이 없다. 세션을 끝내려면 `close`를 쓴다.
- pause, terminate, close, 실행 권한 회수로 끝난 worker는 세지 않는다.
- SIGTERM으로 drain된 worker도 세지 않는다. worker는 release에 `stop_kind: "drain"`을 싣는다. 이 필드를 모르는 옛 API(94S-302 이전)는 strict schema라 400 `BAD_REQUEST`로 거절한다. 그러면 worker는 `worker.release.stop_kind_refused`를 로그에 남기고 필드 없이 한 번 더 release한다(94S-361). 세션은 lease 만료를 기다리지 않고 바로 돌아온다. 다만 옛 API는 그 종료를 예전 규칙대로 센다. 복원이 걸린 claim이면 실패 1회다.
- **배포 순서:** 제어 호스트 이미지(`API_IMAGE`, api·scheduler 공용)를 먼저 올리고 `WORKER_IMAGE`는 그다음에 바꾼다. worker protocol의 요청 schema는 strict라서 새 worker가 보낸 새 필드를 옛 API가 400으로 거절한다. release 말고는 이런 대체 경로가 없다.

### interrupt 뒤 결과를 알 수 없는 turn

interrupt한 turn이 `interrupted`로 끝나려면 engine이 멈췄다는 응답과 그 turn까지 덮는 checkpoint가 함께 있어야 한다. 둘 중 하나라도 없으면 transcript에 무엇이 남았는지 아무도 말할 수 없다. 그래서 turn은 `outcome_unknown`이 되고, turn 조회(`GET /v1/sessions/{id}/turns/{turn_id}`)의 `terminal_reason`이 원인을 말한다.
- `interrupt_checkpoint_unavailable`: engine은 멈췄지만 checkpoint를 커밋하지 못했다. worker는 drain으로 내려간다.
- `interrupt_unanswered`: engine이 interrupt에 제때 답하지 않았다. worker 로그에 `gave no terminal within …ms of its interrupt` 또는 `ended before its interrupt was answered`가 남고, worker는 실패로 끝난다.

어느 쪽이든 세션은 `status: failed`, `admission_state: recovery_required`가 되고 queued 입력은 dispatch되지 않는다. interrupt receipt는 `unknown`이고 error는 `RECOVERY_REQUIRED`다. 복구는 `sessions:recover` scope로 한다.
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

## provider 키와 저장소 자격 증명은 worker에 가지 않는다 (94S-252)

worker 컨테이너 env에도, claim 응답에도 provider 키와 저장소 로그인이 없다. claim은 attempt마다 새로 만든 **egress token** 세 개만 준다(`runtime_config.provider.auth = {kind: "egress_token", token}`, `workspace.repository.access`, `object_store.access`). 세 token은 session credential과 수명이 같다. claim 재생이면 폐기하고 다시 발급하며, heartbeat가 연장하고, attempt가 끝나면 폐기한다. 각 token은 claim 시점의 profile fingerprint, 저장소 binding, 세션 object prefix에 묶여 있다.

* **credential route:** egress proxy는 forward proxy(3128) 옆에 두 번째 listener `EGRESS_CREDENTIAL_PORT`(기본 3129)를 연다. 이 listener가 받는 요청은 아래 다섯 가지뿐이고, 나머지는 404다.
  * `POST /provider/v1/messages`
  * `POST /provider/v1/messages/count_tokens`(query는 없거나 `?beta=true`)
  * `GET /repository/info/refs?service=git-upload-pack`
  * `POST /repository/git-upload-pack`
  * `/object-store/<bucket>/<key>` 아래의 S3 요청(아래 object store route)
* **요청 하나의 처리:** proxy는 요청마다 API의 authorizer에 token을 묻는다. authorizer는 API의 별도 listener로, `EGRESS_AUTHORIZER_PORT`의 `POST /authorize`에서 `EGRESS_AUTHORIZER_TOKEN` bearer를 요구한다. 같은 listener의 `POST /usage`는 proxy가 Messages 호출의 usage를 보고하는 곳이다(94S-409, 아래 설치 상한 절). token이 지금 유효하면 authorizer는 upstream과 붙일 헤더를 돌려준다. 유효하다는 것은 lease가 DB 시계로 살아 있고 epoch가 맞으며 purpose가 일치한다는 뜻이다. proxy는 worker의 token을 떼고 카탈로그의 자격 증명을 붙여 upstream으로 보낸다.
* **fail-closed:** 긍정 응답은 캐시하지 않는다. 그래서 authorizer가 죽어 있으면 503이고, attempt를 잃은 token은 다음 요청부터 401·409다.
* **upstream 연결:** upstream은 forward proxy와 같은 allowlist·주소 규칙으로 판정한다. 연결은 판정한 주소에 하고, TLS 인증서는 카탈로그의 host 이름으로 요청을 보내기 전에 검증한다. redirect는 따라가지도 전달하지도 않는다(502). 오류 본문에 주입한 자격 증명이 되비쳐 있거나, 본문이 압축돼 있거나, 64 KiB를 넘으면 본문을 보류한다.
* **요청 본문 상한 (94S-388):** Bun은 handler가 읽지 않은 요청 본문도 소켓에서 곧바로 받아 메모리에 쌓는다. 그래서 proxy는 await 전에, 요청 head만 보고 받을지 정한다. provider·repository 본문은 요청당 32 MiB(Messages API 한도)이고, 넘게 선언하면 authorizer에 묻기 전에 413이다. chunked 본문은 32 MiB까지만 읽고 413이다. object store 본문은 길이를 선언해야 한다(chunked면 411). 받은 요청은 선언한 길이(chunked면 32 MiB)만큼 설치 전체 예산 512 MiB(`DEFAULT_MAX_BODY_BYTES_IN_FLIGHT`)에서 떼어 두고, 교환이 끝나면 돌려놓는다(upstream은 본문을 다 받기 전에 답할 수 있다). 받은 본문은 예약한 크기의 버퍼 하나에 모은다. 예산에 들어가지 않는 요청은 503 `too many request bytes in flight`다. authorizer도 요청 본문을 16 KiB까지만 읽고 413으로 끊는다.
* **proxy 컨테이너 (94S-388):** compose `egress-proxy`는 worker처럼 `read_only`·`cap_drop: [ALL]`·`no-new-privileges`로 돌고 `/tmp`만 tmpfs다. `mem_limit`은 3072 MiB다. 요청 본문 예산 512 MiB, 응답 큐 64 MiB, forward proxy 큐 2048 MiB(연결 256 × 2 × 4 MiB), Bun 256 MiB를 더한 상한이다. 측정값이 아니다. 이 상한들을 바꾸면 한도도 같이 바꾼다. 죽으면 `restart: unless-stopped`로 같은 컨테이너가 다시 뜨고, worker 네트워크 연결은 그대로 남는다.
* **object store route (94S-251):** 워커의 S3 SDK는 `object_store` token을 SigV4 access key id로(secret은 아무 값이나) 삼아 `<route>/object-store`에 path-style로 보낸다. proxy는 `Authorization`의 `Credential=`에서 token을 꺼내 요청의 method·target·헤더와 함께 authorizer에 묻는다. authorizer는 token과 generation fence를 확인하고 요청이 세션 prefix 안의 허용된 연산인지 판정한 뒤, API 자신의 키로 서명한 target과 헤더를 돌려준다. 허용하는 연산은 넷이다: prefix 안 object의 GetObject·HeadObject(버전 지정 포함), 새 key를 만드는 PutObject(`If-None-Match: *` 필수라서 덮어쓰기가 없다. checksum 헤더 허용), 세션 prefix의 ListObjectsV2. Delete, legal hold·retention·ACL, governance 우회, copy, multipart, version 목록, `aws-chunked` 본문, 인코딩된 `/`·dot segment는 전부 403 `AccessDenied`다. 모르는 token은 401 `InvalidAccessKeyId`다. proxy는 서명된 헤더와 target만 upstream에 보내고, PUT 본문은 서명된 길이만큼 흘려 보낸다(서명은 `UNSIGNED-PAYLOAD`, 요청당 512 MiB 상한). 비밀 키는 API를 떠나지 않는다. 다음 generation이 claim하면 이전 token의 새 요청은 곧바로 거부되고, 이미 열린 교환은 regrant 주기(30초) 안에 끊긴다. 그 사이에 끝나는 늦은 PUT도 create-only라서 이미 있는 object를 바꾸지 못하고, 커밋된 checkpoint가 가리키지 않는 object를 하나 더할 뿐이다. API는 checkpoint object store 설정(아래)으로 서명하며, `CHECKPOINT_OBJECT_STORE=disabled`면 이 route는 503이다.
* **engine:** `ANTHROPIC_BASE_URL`이 `<route>/provider`다. checkpoint fingerprint에는 여전히 카탈로그 endpoint가 들어가고, `auth_kind`는 `egress_token`이 된다. 따라서 이전에 만든 checkpoint는 fingerprint 불일치로 재개가 거부된다(출시 전이라 옮기지 않는다).
* **engine의 token은 env에 없다 (94S-410):** worker는 token을 env가 아니라 engine의 fd 3에 붙인 socket으로 준다(`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3`). engine은 첫 요청 전에 한 줄을 읽고 fd를 닫는다. 그래서 turn 안의 도구는 자기 env에서도, 같은 uid인 모든 프로세스의 `/proc/<pid>/environ`에서도 token을 찾지 못한다. socket이라 `/proc/<pid>/fd/3`으로 다시 열 수도 없다.
  * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`은 쓰지 않는다. bubblewrap이 필요하고, 워커 격리(`cap_drop: ALL`, `no-new-privileges`)에서는 namespace를 만들지 못한다. permission mode도 `default`로 강제한다(94S-394).
  * 남은 경로는 engine 메모리를 읽는 것(ptrace, `process_vm_readv`)이다. 도구는 engine의 자손이므로 host의 `kernel.yama.ptrace_scope`가 1 이상이면 막힌다. 0인 host에서는 막히지 않는다.
  * LiteLLM `bearer` 인증은 fd 경로가 없어 `ANTHROPIC_AUTH_TOKEN` env로 준다. worker는 늘 `egress_token`을 쓰므로 이 경우가 없다.
* **git:** `<route>/repository`로 clone하며 token은 git 자식 프로세스의 `http.extraHeader`로만 들어간다. `http.followRedirects=false`를 걸고, clone 직후 origin을 카탈로그 URL(userinfo 없음)로 되돌린다. push 경로는 없다.
* **이벤트에서 값 지우기:** engine의 도구는 worker 프로세스의 env를 읽을 수 있다. 그래서 worker는 자기가 가진 비밀을 값 그대로 찾아 `<redacted>`로 바꾼 뒤 이벤트·pending 요청을 내보낸다. 대상은 nonce, session credential, egress token 셋이다. base64처럼 다시 인코딩된 값은 걸러지지 않는다. token은 attempt 범위이고 worker 네트워크 밖에서는 쓸 수 없으므로 그 한계를 받아들인다.
* **이벤트·승인 요청의 가림 (94S-384):** worker는 그에 앞서 Claude adapter의 규칙(`packages/adapters/runtimes/claude/src/mapper.ts`)으로 tool event와 승인 요청의 `input`을 가린다. `authorization`·`cookie`·`secret`·`password`·`api_key` 같은 키의 값과 `Bearer …`·`sk-ant-…` 모양의 값은 `[REDACTED]`가 된다. 문자열 안의 `api_key=값`은 값이 끝나는 곳이 분명할 때만 값만 가린다. 값이 한 단어이고 뒤에 공백·`&`·`;`·`|`·`)`나 문자열 끝이 오거나, 값 전체가 펼칠 것 없는 따옴표 문자열 하나일 때다. 그 밖의 경우(`password: 값`, escape, `$'…'`, 이어 붙인 따옴표, 다음 줄에 오는 값)는 문자열 전체를 가린다. 경로(`file_path`·`path`·`notebook_path`·`cwd`)는 키 이름으로 가리지 않는다. 사용자가 어떤 파일을 쓰는 요청인지 보고 승인해야 하기 때문이다. 경로 안에 `api_key=…` 같은 조각이 있으면 다른 문자열처럼 그 값만 가린다. 승인 답을 맞춰 보는 `input_hash`는 가리기 전의 실제 인자로 계산한다.
* **로그 마스킹 (94S-386):** worker와 egress-proxy의 stdout 로그도 API와 같은 규칙(`packages/observability/src/redaction.ts`)으로 가린다. `authorization`·`token`·`secret`·`password`·`credential`·`api_key` 같은 키의 값, `Bearer …`·`sk-…`·`gh?_…`·`AKIA…` 모양의 값, `token=`·`password:` 같은 조각이 든 문자열은 `[REDACTED]`가 된다. URL의 login(`https://user:pass@host`)은 그 부분만 가린다. worker는 여기에 더해 위의 비밀 값을 `<redacted>`로 바꾼다. egress-proxy 이미지는 workspace 의존성을 싣지 않으므로 같은 파일의 사본(`apps/egress-proxy/src/redaction.ts`)을 쓰고, unit test가 두 파일이 같은지 확인한다. worker 로그 줄은 `{timestamp, level, event, ...fields}`이고, fields가 `timestamp`·`level`·`event`를 덮지 못한다. worker 로그 수준은 scheduler의 `LOG_LEVEL`을 따른다. scheduler가 worker 컨테이너를 만들 때 자기 값을 env로 넘긴다(94S-408). 이 값은 격리 계약 stamp에 들어가지 않으므로, 값을 바꾼 뒤 scheduler가 재시작하면서 adopt한 컨테이너는 만들어질 때의 수준을 그대로 쓴다. 새 수준은 다음에 새로 뜨는 worker부터 적용된다.
* **compose:** `api`는 `EGRESS_AUTHORIZER_PORT=3100`을 publish하지 않는다. 어느 worker allowlist에도 없으므로 compose 네트워크의 `egress-proxy`만 부른다. `EGRESS_AUTHORIZER_TOKEN`의 compose 기본값은 로컬 스택 전용이므로 다른 곳에서는 `../.env`로 바꾼다. host에서 띄운 API를 쓸 때는 `EGRESS_AUTHORIZER_URL=http://host.docker.internal:3100`을 준다. 두 값 중 하나만 있으면 API와 proxy 모두 기동을 거부한다. 둘 다 없으면 경고만 내고 뜨지만, 그 상태의 worker는 provider에도 저장소에도 닿지 못한다.

## worker workspace의 상한과 회수

세션마다 `ap-ws-<installationId>-<sessionId>-<접미사>` volume 하나가 `/workspace`에 붙는다. 이 volume은 세대(generation)를 넘어 살아남는다 — 컨테이너를 교체해도 세션의 작업 트리는 그대로여야 하기 때문이다. 그래서 **컨테이너를 지우는 `terminate`는 volume을 건드리지 않고**, 회수는 pass의 ④단계가 따로 한다.

volume은 이제 backend가 `POST /volumes/create`로 **명시적으로** 만든다. mount spec에 이름만 적으면 Docker가 label도 상한도 없는 volume을 알아서 만들어 버리기 때문이다. 만들 때 `agent-platform.managed`·`.installation`·`.session-id`·`.workspace-quota` label을 찍고, GC는 이름을 파싱하지 않고 이 label만 본다.

**volume 이름은 1회용이다.** `local` 드라이버는 이미 quota를 걸었던 이름을 다시 만들면 `Options.size`는 그대로 돌려주면서 실제 project quota는 걸지 않는다. xfs+prjquota(Docker 27.5.1)에서 측정한 결과 — 처음 만든 이름은 컨테이너 안 `df` 총량이 설정값(64MiB)이지만, 같은 이름을 지웠다 다시 만들면 `Options.size`가 같은데도 `df`는 파일시스템 전체(8GiB)를 보고한다. Engine API로는 둘을 구분할 수 없으므로, 세션의 workspace는 이름으로 유도하지 않고 무작위 접미사를 붙여 만든 뒤 **label로 조회한다.** GC나 운영자가 volume을 지워도 다음 것은 새 이름을 받으므로 상한이 다시 선다. 한 세션에 workspace가 둘 보이면 어느 쪽이 작업 트리인지 판단하지 않고 보고만 한다. preflight probe도 같은 이유로 매번 새 이름을 쓰고, 이전 실행이 남긴 probe는 label로 회수한다.

CPU·메모리·PID·tmpfs와 달리 `/workspace`에는 상한이 없었다. `EXECUTION_WORKSPACE_QUOTA_MB`(기본 4096)가 `local` 드라이버의 `size` driver option으로 그 상한이 된다. 단 이 옵션은 **daemon의 저장소가 project quota를 감당할 때만**(xfs + `prjquota`) 동작하고, 그렇지 않으면 daemon이 create를 `400 quota size requested but no quota support`로 거절한다. scheduler는 pass 전에 probe volume을 하나 만들어 보는 것으로 이 능력을 확인하고(`verifyWorkspaceQuota`), 감당하지 못하는 daemon에서는 **아무것도 띄우지 않고 종료한다.** probe는 volume 하나를 만들고 CAP_SYS_ADMIN helper를 띄우는 일이라 pass마다 반복하지 않는다(94S-393). 감독 루프의 pass는 probe를 통과하면 backend 설정 전체(`DOCKER_HOST`·`EXECUTION_*` 등)의 해시를 status file 옆 `<SCHEDULER_STATUS_FILE>.quota-verified`에 적는다. 이후 pass는 해시가 같으면 probe를 건너뛴다. 감독 루프는 기동할 때 이 파일을 지운다. 그래서 루프가 다시 뜨면(컨테이너 재시작, 연속 실패 뒤 재기동) 첫 pass가 다시 확인한다. 실패한 probe는 아무것도 적지 않으므로 다음 pass가 또 확인한다. 루프 밖에서 단독으로 돌린 pass(`main.ts scheduler --once`)는 이 기록을 쓰지도 믿지도 않고 매번 probe한다. 루프는 기록 위치를 `SCHEDULER_QUOTA_PREFLIGHT_MARKER`로 자기 pass에만 넘긴다. 조용히 무제한으로 떨어지는 경로는 없고, 무제한을 감수하려면 `EXECUTION_WORKSPACE_QUOTA=off`를 명시해야 한다 — 그 경우 scheduler pass마다 경고 1건이 남는다. `on`·`off` 외의 값(`false`, `0`, `no`)은 오타로 보고 거절한다.

**quota 최솟값은 1024 MiB다 (94S-370).** 이보다 작은 `EXECUTION_WORKSPACE_QUOTA_MB`는 기동 시 거절된다. checkpoint 복원이 workspace volume을 한때 이만큼 쓰기 때문이다. 복원은 root를 비운 뒤 아래 순서로 진행한다. 표의 기호는 다음과 같다.

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

기존 workspace를 다시 쓰는 fresh fetch(checkpoint 없이 재개하는 reuse)는 복원과 달리 root를 비우지 않는다. 워커는 origin 전체를 bare mirror로 받아 거기서 branch를 복사한다(94S-377). mirror는 `.git/agent-platform-fetch-*` 아래에 만들고 fetch가 끝나면 지운다. `/tmp`와 HOME은 tmpfs라 컨테이너 메모리를 쓰기 때문이다. 표의 기호에 더해 M은 mirror가 디스크에서 차지하는 최대치다. origin 저장소의 pack 전체에 index·ref, 받는 동안의 임시 pack 파일이 더해진다. Δ는 workspace `.git`에 새로 들어오는 객체다. 아래 최대치는 이 추정을 더한 값이다.

| 단계 | 동시에 차지하는 것 | 최대 |
| --- | --- | --- |
| mirror clone과 로컬 fetch | 기존 W, I, T, U + mirror M + Δ | 세션 사용량 + M + Δ |
| fetch 뒤 | W + Δ, I, T, U (mirror는 지운다) | 세션 사용량 + Δ |

M에는 상한이 없다. M만큼 quota 여유가 있어야 reuse가 성공하고, 모자라면 fetch가 ENOSPC로 실패한다. 처음 clone(`clone`·`recreate`)은 mirror 없이 root에 바로 받으므로 W + T만 쓴다. 워커가 도중에 죽어 남긴 scratch(fetch·capture·publish의 `.git/agent-platform-<용도>-XXXXXX`)는 다음 reuse가 fetch 전에 지운다. `agent-platform-checkpoint`는 남긴다. checkout이 다른 곳의 객체를 빌려 쓰면(`objects/info/alternates`, `commondir`, 링크인 `objects`) 그 대상일 수 있으므로 지우지 않는다.

복원 뒤 `.git/agent-platform-checkpoint/checkpoint.git`에는 instructions commit이 닿는 객체(I)만 남는다. engine이 그 commit을 prune해도 다음 capture가 bundle할 수 있게 하려는 저장소다. 그 뒤의 commit, 커밋하지 않은 변경의 snapshot, 사슬의 이전 snapshot은 남기지 않는다. 94S-370 전에는 이 저장소가 사슬 전체(≈B)를 세션 내내 들고 있었다. 단, instructions commit이 HEAD와 같으면 I는 committed 이력 전체다. engine이 커밋하지 않은 세션이 그렇다. 이때 줄어드는 것은 snapshot 몫뿐이다.

이 축소에는 대가가 있다. 다음 incremental capture는 사슬의 tip 중 아직 있는 것만 제외 대상으로 삼는다. 이전 base bundle만의 snapshot commit은 이제 남지 않는다. 마지막 bundle의 snapshot도 workspace `.git`에 참조 없이 들어 있을 뿐이다. 보통의 `git gc`는 2주 동안 이것을 지우지 않는다. 하지만 engine이 `git gc --prune=now`를 돌리면 사라진다. 그러면 남은 tip(이력에 남은 HEAD commit, instructions commit)을 기준으로 bundle을 만든다. 그 결과 bundle이 커지거나 전체 bundle로 되돌아갈 수 있다. 올바름은 그대로다. 전체 bundle이 상한을 넘는 저장소는 사슬이 32개나 상한에 닿아 재시작할 때도 어차피 거절된다.

**inode 상한도 같은 project에 건다 (94S-224).** byte 상한만으로는 빈 파일 수백만 개로 inode를 소진하는 경로가 남는다. xfs는 inode를 project의 block 사용량에 매기지 않으므로 4GiB 안에서도 된다. 그러면 같은 daemon의 다른 세션과 Postgres가 파일을 만들지 못한다. `local` 드라이버에는 inode 옵션이 없고, `o=loop`로 세션마다 파일시스템을 만드는 길도 막혀 있다. 드라이버가 `mount(8)`이 아니라 mount syscall을 부르기 때문이다(`data: loop: invalid argument`). 그래서 Docker가 `size`로 만든 xfs project에 우리가 `ihard`·`isoft`(`EXECUTION_WORKSPACE_QUOTA_INODES`, 기본 1,000,000)를 직접 건다.

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

inode 한도는 in-place로 바꿀 수 있으므로 volume label(`workspace-quota`)에는 넣지 않는다. 94S-224 전에 만든 volume도 거절되지 않고 다음 launch에서 한도를 받는다. 대신 `isolationStampFor` 지문에 넣고 `ISOLATION_CONTRACT`를 7로 올린다. 이 버전 이전으로 롤백한 host는 이 worker들을 newer로 보고 건드리지 않는다. 그래서 한도가 생기거나 바뀌면 실행 중인 worker는 stale로 교체되고, 교체 경로의 ensure가 한도를 건다.

Docker Desktop은 커널 자체가 XFS quota 없이 빌드돼 있어(`XFS (loopN): quota support not available in this kernel`) 로컬에서는 `off`가 사실상 유일한 선택지다. GitHub Actions 러너의 daemon도 data root가 ext4라 마찬가지다. 그래서 실제 상한이 무는지는 CI의 `workspace-quota` job이 xfs + prjquota loop 파일을 data root로 쓰는 daemon을 따로 띄워 확인한다.

상한은 volume 하나에만 거는 것으로는 부족하다. Docker는 이미지가 선언한 `VOLUME` 경로마다 **쓰기 가능한 익명 volume**을 자동으로 붙이는데, 거기에는 상한도 label도 없다. 그래서 launch 전에 이미지를 조회해 `/workspace` 외의 `VOLUME` 선언이 있으면 거절하고(`ImageVolumeError`), 컨테이너를 지울 때는 `v=true`로 익명 volume을 함께 지운다(named volume인 workspace는 영향을 받지 않는다). 아직 pull되지 않은 이미지는 조회가 404이므로 그대로 두고 create가 같은 404를 내게 한다.

확인한 것과 실제로 띄우는 것 사이도 벌어질 수 있다. 태그는 가변이므로 컨테이너는 **조회한 이미지의 id**(`sha256:…`)로 만들고, volume은 create 직후 start 전에 한 번 더 확인한다 — 그 사이에 `docker volume prune`이 지나가면 Docker가 mount용으로 label도 상한도 없는 volume을 새로 만들어 주기 때문이다. 어긋나면 아직 아무것도 실행되지 않은 컨테이너를 지우고 실패시킨다.

quota preflight가 실패하면 **아무것도 띄우지 않되 회수는 한 번 돌린다.** probe도 디스크를 조금 쓰므로 이미 가득 찬 daemon은 preflight부터 실패하는데, 그 순간이 바로 끝난 세션의 workspace를 회수해야 할 때다. 그대로 종료하면 회수할 방법이 영영 없어진다. 이때 도는 것은 pass가 아니라 `reclaimWorkspaces` — 같은 advisory lock 아래에서 ④단계만 수행한다. slot limit 0짜리 pass로는 부족하다. 새 예약만 막힐 뿐 사라진 컨테이너를 재생성하고 stale 컨테이너를 교체하는 일은 그대로 하기 때문이다. 회수가 끝나면 원래 오류를 다시 던져 non-zero로 끝낸다.

volume의 quota label이 지금 설정과 다르면 — 예전에 암묵 생성된 label 없는 volume이거나, 다른 byte 상한으로 만들어진 volume이면 — 기동을 거절한다(`WorkspaceQuotaError`). 이름을 유도하던 시절의 `ap-ws-<installationId>-<sessionId>` volume도 계속 찾아본다. label이 없어 조회에는 걸리지 않지만, 못 본 척하고 새 workspace를 만들면 그 세션이 빈 트리로 시작하고 예전 트리는 묻히기 때문이다. volume의 byte quota는 나중에 바꿀 수 없고(inode 상한은 위에 적은 대로 제자리에서 바뀐다), 바꾸겠다고 지우면 그 세션의 작업 트리가 날아가기 때문이다. 작업 트리를 살린 채 새 계약으로 옮기려면 아래 [legacy workspace 마이그레이션](#legacy-workspace-마이그레이션) 절차를 쓴다. 이전 설정으로 되돌리는 것도 방법이다. 같은 이유로 quota 설정은 `agent-platform.isolation` 지문에도 들어간다 — 그러지 않으면 이미 떠 있는 컨테이너가 예전 상한을 그대로 들고 계속 산다.

이 거절은 **이미 돌고 있는 worker를 죽이기 전에** 일어나야 한다. 지문이 바뀌면 stale 판정 → `terminate` → 재생성 순서인데, 재생성이 volume에서 거절당하면 그 세션은 worker도 없고 되돌아갈 길도 없는 상태로 남는다. 그래서 `inspect`는 stale을 보고하기 전에 그 세션의 volume을 읽기 전용으로 확인하고, 쓸 수 없는 volume이면 stale 대신 예외를 던진다 — 컨테이너는 예전 상한 그대로 계속 돌고, pass는 `reconcileFailed`로 non-zero를 내며, 운영자가 volume을 옮길 때까지 그 상태가 유지된다. 옮기는 방법은 아래 [legacy workspace 마이그레이션](#legacy-workspace-마이그레이션)에 있다. inode 상한은 이 읽기 전용 확인이 아니라 교체 직전의 `assertReplaceable`이 실제로 걸어 보고, 못 걸면 기존 worker를 내리기 전에 교체를 거절한다.

④단계의 GC는 fail-safe 방향이다. **volume을 먼저 나열하고 그 다음 DB에 묻는다** — 순서를 뒤집으면 두 호출 사이에 생긴 세션의 volume을 지운다. 남기는 조건은 session row가 있고 admission state가 `closed`가 아니거나 살아 있는 execution row가 있는 것이다. `stopped`는 예외로, 아래의 만료 규칙을 따른다. session id label이 없거나 session id 모양이 아닌 volume, 아직 컨테이너가 물고 있는 volume(409), 다른 설치의 volume은 전부 **남기고 로그만 남긴다.** 예외는 이름을 유도하던 시절의 label 없는 `ap-ws-<installationId>-<sessionId>` volume이다. 이름에서 읽은 session id는 후보일 뿐이고, **그 id의 row가 있고 `closed`이며 slot을 쥔 launch가 없을 때만** 회수한다(`filterClosedLegacySessions`). row가 없는 경우는 남긴다. label이 있는 volume과 달리, 이름이 맞다는 것만으로는 우리 세션의 것이라는 증거가 되지 않기 때문이다. legacy volume에는 `stopped` TTL도 적용하지 않는다. 먼저 마이그레이션해야 만료 규칙을 탄다. `EXECUTION_WORKSPACE_GC_MIN_AGE_SEC`(기본 3600)보다 어린 volume은 아예 후보가 아니다 — volume은 컨테이너보다 먼저 만들어지므로 그 사이에 회수해 버리면 진행 중인 launch를 깨뜨린다. **판단으로 남긴 것과 실패로 남은 것은 exit code가 다르다.** 아직 마운트돼 있거나(409) 다른 설치 것이라 남긴 volume은 정상 상태이므로 exit code를 바꾸지 않는다(`workspacesUnresolved`). 반면 목록을 못 읽었거나 DB가 답하지 않았거나(`workspaceScanFailed`) 삭제 호출이 던진 경우(`workspacesFailed`)는 아무도 보지 않은 채 디스크가 쌓이는 상태이므로 pass가 non-zero로 끝난다.

**`stopped` 세션의 workspace는 만료된다(94S-225).** stop한 뒤 `EXECUTION_WORKSPACE_STOPPED_TTL_SEC`(기본 86400, 하루)이 지나면 회수 후보가 된다. 기준 시각은 `sessions.updated_at`이다. stop 전이가 이 값을 찍고, 회수 claim과 완료 기록은 이 값을 건드리지 않는다. 이미 `stopped`인 세션에 새 terminate가 받아들여지면 이 값이 바뀌어 TTL을 그때부터 다시 센다. 다만 terminate는 workspace를 붙잡는 수단이 아니다. 회수 claim이 이미 잡힌 뒤라면 그 회수는 그대로 진행된다. workspace가 필요하면 resume한다. resume만이 claim과 직렬화된다. slot을 쥔 launch가 남아 있으면 후보가 아니다. 하루면 밤사이 stop해 둔 세션은 그대로 돌아오고, 10-session soak처럼 stop이 쌓이는 경우에도 디스크가 끝없이 늘지 않는다. `0`은 다음 pass에서 바로 회수한다는 뜻이다.

resume은 committed checkpoint가 있어야만 받아들여지고, 워커는 claim에 restore pointer가 있으면 checkpoint에서 workspace를 복원한다(복원은 root를 비운 뒤 채운다, 94S-246). 그래서 TTL이 지난 stopped 세션의 volume은 캐시일 뿐이다. 반대로 **checkpoint가 없는 stopped 세션은 resume할 수 없고, 그 volume에만 남은 작업은 TTL이 지나면 사라진다.** 그 작업을 살려야 하면 TTL 안에 volume에서 직접 꺼내야 한다.

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
docker compose -f infra/docker-compose.yml --profile apps run --rm scheduler \
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

중간에 실패하면 원본은 그대로다. 복사 실패(quota 초과, helper가 만들 수 없는 device 파일 등), 불일치, 시간 초과(`--deadline-sec`, 기본 3600), lock 유실이 모두 그렇다. 실패한 helper는 `docker logs`로 볼 수 있게 남겨 둔다. pin도 남아 원본을 계속 붙잡는다. 다시 실행하면 먼저 새 pin으로 원본을 붙잡는다. 그다음 남은 helper, 이전 pin, 미완성 복사본(`migration-source`이 같은 원본을 가리키는 것)을 지우고 처음부터 복사한다. 원본과 복사본이 함께 있는 동안에는 backend가 그 세션의 기동을 거절하고, GC는 둘 다 후보에서 뺀다. 그래서 반쯤 복사된 트리 위에서 worker가 뜨는 일도, 원본만 먼저 회수되는 일도 없다. 끝내지 않은 채 두면 두 volume이 그대로 남으므로, 다시 실행하거나 직접 정리한다. 원본 이름의 volume이 복사본을 만든 뒤에 다시 만들어졌을 수도 있다. Docker는 없는 이름을 mount하면 빈 volume을 만들기 때문이다. 이때 생성 시각이 맞지 않으므로, 명령은 그 복사본을 미완성으로 보고 지우지 않는다. 대신 거절한다. 복사본이 유일하게 온전한 workspace일 수 있으니 둘을 직접 비교해 정리한다. 원본이 지워지면 새 volume 위에서 worker를 다시 띄운다. 띄우는 것은 다음 pass이고, 그 전에 실패한 launch가 재시도 대기(94S-207) 중이면 대기가 끝난 뒤의 pass다. legacy volume 때문에 실패하는 launch도 다른 실패처럼 횟수가 쌓인다. 상한에 닿으면 세션이 `failed`가 되므로 되도록 빨리 옮긴다.

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

compose의 proxy는 `apps/egress-proxy/Dockerfile`로 빌드한 이미지로 돈다(94S-323). 소스가 이미지에 들어 있으므로 checkout을 옮겨도 떠 있는 proxy는 바뀌지 않고, 새 코드는 `up -d --build egress-proxy`로 다시 빌드해야 반영된다. 94S-323 이전에는 소스를 bind mount해서 돌렸다. 그래서 94S-319에서 qa-main이 checkout만 옮겨진 채 #141 이전 proxy를 몇 시간 돌렸다.
- proxy는 기동할 때 자기 소스(`src`의 테스트 아닌 `.ts`)의 sha256을 로그(`Egress proxy listening`의 `source`)와 `/healthz`(`ok source=<hex>`)로 알린다. 어떤 코드가 도는지는 이 값으로 확인한다.
- compose healthcheck(`src/healthcheck.ts`)는 이 값을 `/app/src`의 현재 소스와 비교하고, 다르면 `unhealthy`로 떨어진다. 이미지로 돌 때는 둘이 늘 같다. 누군가 소스 트리를 mount해 덮어쓴 뒤 그 checkout을 옮겼을 때만 이 검사가 발동한다. 다만 Docker는 연속 실패 12회(약 60초)가 쌓여야 상태를 바꾼다.

```bash
docker compose -f infra/docker-compose.yml up -d --wait --build egress-proxy   # checkout을 옮긴 뒤
docker compose -f infra/docker-compose.yml exec -T egress-proxy bun run /app/src/healthcheck.ts
docker network ls --filter label=agent-platform.worker-network=true \
  --format '{{.Name}} {{.Labels}}'
```

실제 Docker daemon 대상 테스트는 `DOCKER_BACKEND_TEST=1`로 opt-in한다(`busybox:1.36`을 sleep으로 띄움). egress suite는 backend가 띄운 worker 셋(설치 둘)으로 worker 사이 차단과 proxy 재부착·orphan 네트워크 회수를 보고, internal 네트워크·바깥 네트워크·upstream 두 개·host `openssl`로 만든 인증서를 쓰는 TLS upstream·그 인증서로 LocalStack 앞에 세운 TLS front(https S3 endpoint)·`oven/bun:1.3.14`로 띄운 proxy를 직접 만들어 컨테이너 안에서 `wget`·`nc`·`curlimages/curl`로 확인하며 인터넷을 쓰지 않는다(이미지 pull 제외). scheduler의 15 세션 → 컨테이너 ≤ 10 검증은 `QUEUE_DATABASE_URL`까지 있어야 실행된다.

```bash
DOCKER_BACKEND_TEST=1 bun run --cwd packages/adapters/execution/local-docker test:docker
DOCKER_BACKEND_TEST=1 QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test apps/control-host/src/scheduler/main.integration.test.ts
```

## 운영자 카탈로그 (Agent Profile · repository)

API는 기동 시 `PLATFORM_CONFIG_DIR`(기본: 저장소의 `config/`)에서 `profiles.yaml`과 `repositories.yaml`을 한 번 읽는다(94S-132). 파일이 없거나 schema에 맞지 않거나 자격 증명 참조가 풀리지 않으면 파일·경로를 적은 메시지와 함께 기동하지 않는다. 옛 `SESSION_CATALOG_JSON`은 더 읽지 않으며 설정돼 있으면 기동을 거부한다. 저장소의 `config/real-model/`은 실제 Messages API용 카탈로그이고, `--real-model` overlay(`infra/compose.real-model.yml`)가 `PLATFORM_CONFIG_DIR`를 그 디렉터리로 바꾼다([real-claude.md](real-claude.md)).

- profile의 `provider.auth`에는 값 대신 참조를 하나만 적는다: API 프로세스 환경 변수 `value_env`, 또는 Secrets Manager `secret_id`(`AWS_ENDPOINT_URL_SECRETS_MANAGER`로 endpoint 지정, `AWS_ENDPOINT_URL`은 따르지 않는다). 값은 기동 시 한 번 해석되고 worker에는 가지 않는다. egress proxy의 credential route가 요청마다 authorizer에 물어 upstream 요청에 붙인다(94S-252, 위 절).
- `repositories.<id>.profiles`가 그 저장소에서 돌 수 있는 profile allowlist다. `(profile, repository)` 쌍이 신뢰 단위이며, 목록에 없는 쌍이나 모르는 id로 `POST /v1/sessions`를 부르면 `422`다.
- 이미 만든 세션의 쌍이 빠졌거나, id가 다른 URL·branch를 가리키게 되거나(94S-280), 같은 profile id의 설정(model·tools·permission_mode·endpoint·runtime version·project_settings·자격 증명 참조 위치)이 세션을 만들 때와 달라지면(94S-253), 세션 상세의 `attention`이 `CATALOG_MISMATCH`가 되고 그 세션으로 뜬 worker의 첫 claim이 `409 CATALOG_MISMATCH`를 받는다. 그 자리에서 대기 중이던 turn은 `failed`(`terminal_reason: catalog_mismatch`), 해당 receipt는 `CATALOG_MISMATCH`, 세션은 `failed`가 되고 status 이벤트에 같은 코드가 남는다. worker는 claim timeout을 기다리지 않고 바로 나가며, 다음 scheduler pass가 슬롯을 돌려받아 다른 세션을 띄운다. 메시지에는 저장소 id만 적히고 URL은 나오지 않는다. `resuming` 중인 세션이면 resume이 `CATALOG_MISMATCH`로 실패해 `recovery_required`로 가고, 대기 중인 입력은 복구 결정을 위해 남는다(94S-138과 같은 경로).
- **카탈로그를 되돌려도 저절로 다시 실행되지는 않는다.** 되돌리면 `attention`이 사라지고, 그 세션에 새 메시지를 보내면 새 generation으로 다시 뜬다. 실패한 turn은 재시도되지 않으므로 필요한 입력은 다시 보낸다. 되돌리지 않은 채 메시지를 보내면 그 입력도 첫 claim에서 곧바로 같은 코드로 실패한다(추가 메시지를 422로 막지는 않는다 — 받은 입력은 receipt로 결말을 알린다).
- **이 즉시 실패는 권위 있는 카탈로그만 쓴다(94S-295).** 각 API는 기동 시 읽은 자기 카탈로그로 판단한다. 그래서 카탈로그가 다른 replica가 섞인 rolling update 동안에는 요청을 받은 replica에 따라, 다른 replica라면 돌릴 세션이 실패할 수 있다. 이를 막으려고 DB에 **활성 catalog revision**(`catalog_authority`, 행 하나)을 둔다. 기동 로그 `Session catalog loaded`의 `revision`이 활성 revision과 같은 replica만 세션을 실패시킨다. 다른 replica는 아무것도 쓰지 않고 claim에 `404 NOT_FOUND`(잡을 세션 없음)로 답한다. worker는 claim timeout 뒤 나가고, 94S-207의 launch 실패 횟수·격리가 안전망으로 남는다. 활성 revision은 API가 스스로 정하지 않고 운영자가 compare-and-swap으로만 바꾼다. API 기동은 이 행을 읽지 않고, 불일치 경로에서만 읽는다.
  - **한 replica(compose 기본):** 행이 없으면 모든 API가 권위 있는 것으로 본다. 활성화하지 않아도 94S-280 동작(첫 claim에 즉시 실패)은 그대로다.
  - **둘 이상 띄우기 전:** 지금 카탈로그의 revision을 활성화한다: `bun run catalog-authority activate <revision> --expected none`. compose 밖이라면 API 이미지 안에서 `DATABASE_URL`을 주고 `bun run apps/control-host/src/api/catalog-authority.ts …`로 같은 명령을 쓴다. 활성화한 뒤로는 행을 지우지 않는다.
  - **카탈로그 변경:** 활성화를 롤아웃의 첫 단계로 한다.
    1. 새 카탈로그로 replica 하나를 먼저 올리고, 기동 로그에서 새 revision을 읽는다.
    2. `bun run catalog-authority activate <새 revision> --expected <옛 revision>`으로 넘긴다. 이때부터 옛 replica는 권위가 없어 어떤 세션도 즉시 실패시키지 않는다. 롤아웃 동안 옛 replica가 비권위인 것은 의도된 안전 방향이다(권위 없는 쪽은 실패를 쓰지 않을 뿐 세션을 잃지 않는다).
    3. 나머지 replica를 올린다.
    - 새로 **추가**한 쌍으로 세션을 만드는 것은 2 뒤에 한다. 그 전에는 옛 revision이 활성이라, 그 쌍을 모르는 옛 replica가 새 replica에서 만든 세션을 실패시킬 수 있다.
    - 쌍을 **빼는** 변경은 2부터 새 replica가 빠진 쌍의 세션을 즉시 실패시킨다.
  - **롤백:** 같은 순서를 거꾸로 밟는다. 옛 카탈로그 replica 하나를 올린 뒤 `activate <옛 revision> --expected <새 revision>`을 실행하고 나머지를 되돌린다. `--expected`가 지금 값과 다르면 아무것도 바꾸지 않고 `conflict`와 지금 값을 출력하며 1로 끝난다. 지금 값은 `bun run catalog-authority show`로 본다.
  - **판단 기록:** 권위 없는 replica가 빠진 쌍의 세션을 claim까지 거절하지는 않는다. 쌍을 모르는 replica는 원래 그 세션을 claim하지 않는다. 쌍을 아는 옛 replica는 옛 카탈로그를 믿으므로 롤아웃 동안 한 번 더 돌릴 수 있다. 쌍을 빼는 일이 보안 경계라면(그 저장소에서 더는 돌면 안 되는 경우) 옛 replica를 먼저 내린 뒤 뺀다.
- 비공개 저장소는 `repositories.<id>.auth`에 로그인을 같은 방식의 참조로 적는다. `kind: basic`(`username` 필요) 또는 `kind: bearer`이고, `value_env`·`secret_id` 중 하나를 쓴다. worker는 이 값을 받지 않고 proxy의 저장소 route로 clone한다.
- 두 자격 증명 모두 8바이트보다 짧으면 API가 기동을 거부한다. proxy는 upstream 응답에 주입한 값이 되비치는지 검사하는데, 스트림 본문에서는 8바이트 이상인 값만 검사하기 때문이다.
- endpoint·저장소 URL은 `http://`·`https://`만 받는다(worker가 밖으로 나가는 길은 HTTP(S) egress proxy뿐이다). 자격 증명(userinfo, query string)이 들어 있으면 거절한다.
- profile마다 `sha256:` fingerprint(설정과 참조의 정규 JSON 해시, 값 제외)가 worker claim의 `profile_fingerprint`로 가고, 카탈로그 전체의 revision은 기동 로그 `Session catalog loaded`에 남는다. 같은 참조 뒤의 값만 회전하면 fingerprint는 바뀌지 않는다.
- 세션은 만들 때의 profile fingerprint를 저장하고, claim은 카탈로그의 같은 id가 그 fingerprint로 해시될 때만 세션을 묶는다(94S-253). 설정을 바꾸려면 **새 profile id**를 등록하고 새 세션을 그 id로 만든다. 기존 id를 고치면 그 id로 만든 세션은 모두 위의 `CATALOG_MISMATCH`가 되고, 되돌리면 다시 돈다. 자격 증명 값은 claim 때 카탈로그에서 읽으므로 같은 참조 뒤의 값 회전(그리고 API 재기동)은 기존 세션을 막지 않는다. 이 컬럼 전에 만든 세션은 fingerprint가 비어 있고 다음 claim이 그때의 fingerprint로 고정한다.

저장소의 `config/`는 외부 계정 없이 도는 로컬 예시다: compose `fake-messages`(fake Messages API)를 endpoint로, compose `secrets`(API 전용 LocalStack Secrets Manager, worker egress allowlist에 없음)에 심어 둔 placeholder 키를 `secret_id`로, compose Gitea의 `sample-app`을 저장소로 쓴다. Gitea의 `agent/sample-app`은 compose `gitea-init`(`infra/gitea/init-sample-repo.sh`)이 `apps` profile 기동 때 만든다(public, 이미 있으면 건너뜀).

```bash
docker compose -f infra/docker-compose.yml up -d secrets
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:4567 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
AUTH_MODE=none PORT=3000 CHECKPOINT_OBJECT_STORE=disabled \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/control-host start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

API는 checkpoint object store 설정을 기동 시 요구한다 — `S3_BUCKET`·`AWS_REGION`·`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`(+ 선택 `AWS_ENDPOINT_URL`)가 없으면 기동하지 않는다. 이 키는 워커의 object store route 요청을 서명하는 데도 쓰인다(94S-251). object store 없이 띄우려면 `CHECKPOINT_OBJECT_STORE=disabled`를 명시한다: 모든 checkpoint가 거절되고 워커 checkpoint 프로토콜은 409 `CHECKPOINT_UNAVAILABLE`로 답하며 기동 로그에 경고가 남는다. 빠진 bucket이 checkpoint 없는 finalize 뒤에 숨지 않도록 침묵 기본값을 두지 않았다. compose `apps` profile은 localstack 값을 기본으로 넣는다.

checkpoint 객체는 기본적으로 **version으로 고정되고 legal hold로 잠긴다**(`CHECKPOINT_OBJECT_PROTECTION=locked`, 94S-229). manifest의 모든 ref와 finalize의 `manifest_version`은 워커의 `putImmutable`이 돌려준 S3 VersionId를 싣는다. finalize는 그 version을 읽어 검증한 뒤 manifest·transcript part·bundle·untracked 파일의 각 version에 legal hold를 걸고 나서야 pointer를 올린다. pointer(`checkpoints.manifest_version`)와 restore plan도 같은 version을 들고 간다. 그래서 커밋 뒤 같은 key를 덮어쓰거나 지우거나 delete marker 뒤에 다시 올려도 복원 대상은 바뀌지 않고, hold가 걸린 version은 hold를 푸는 권한 없이는 지울 수 없다. hold 해제는 아래 checkpoint GC의 몫이다. hold를 걸 수 있는 권한은 풀 수도 있으므로 워커에게 주면 안 된다. 워커는 object store 자격 증명을 받지 않고, proxy의 object store route는 legal hold·retention 요청을 403으로 거절한다(94S-251, 위 94S-252 절). API는 기동 시 bucket의 versioning이 `Enabled`이고 Object Lock 설정이 있는지 확인하고, 아니면 기동하지 않는다. **versioning이 꺼진 bucket에서는 `CHECKPOINT_OBJECT_PROTECTION=unversioned`를 명시해야 한다. 이 저하된 모드는 key로만 읽고(manifest의 version은 무시하고 restore plan에서도 뺀다) hold를 걸지 않으므로, 커밋 뒤의 삭제·덮어쓰기를 막지 못하고 복원 때 digest 불일치로 발견할 뿐이다.** 기동 로그에 경고가 남는다. `unversioned`에서 `locked`로 바꾸면, `unversioned`로 커밋된 checkpoint는 첫 restore 때 version 단위로 다시 해시하고 hold를 건 뒤에 내준다. pointer에 version이 없는 checkpoint는 `CHECKPOINT_UNAVAILABLE`이 된다. compose의 localstack init은 `claude-sessions`를 Object Lock으로 만들고, 예전 volume에 남은 bucket에는 versioning과 Object Lock 설정을 켠다(그 전에 올라간 객체는 version이 없어 locked API가 거부한다).

**checkpoint 객체의 저장 시 암호화**(94S-337)는 bucket 기본 암호화 SSE-S3(`AES256`)에 맡긴다. 워커의 checkpoint 쓰기는 암호화 헤더를 싣지 않으므로 bucket 기본값이 곧 모든 객체의 암호화다. API는 object store가 켜져 있으면 보호 모드와 무관하게 기동 시 `GetBucketEncryption`을 읽고, 기본 규칙이 `AES256`이 아니면(설정 없음, `aws:kms` 포함) 기동하지 않는다. SSE-KMS를 받지 않는 이유는 워커 credential마다 KMS 키 권한이 붙어야 하기 때문이다(그 credential을 좁히는 일이 94S-251). 다른 설정으로 띄워야 하면 `CHECKPOINT_OBJECT_ENCRYPTION_CHECK=warn`을 명시한다. 그러면 기동 로그에 경고만 남는다. API credential에는 `s3:GetEncryptionConfiguration`이 필요하다. compose의 localstack init은 `claude-sessions`에 `AES256` 기본 암호화를 건다. `scripts/restore.sh`는 자기 LocalStack에 bucket을 만들 때 같은 설정을 걸고, 그 밖의 대상 bucket은 `AES256`이 아니면 거부한다. 결정 근거는 Obsidian `deployment.md`의 "checkpoint 객체의 저장 시 암호화" 절이다.

**비워진 bucket**(94S-422). object store가 켜져 있으면 API는 기동 때 DB에 `collected_at IS NULL`인 checkpoint 행이 있는지 본다. 있으면 `ListObjectVersions`로 bucket에 object version이 하나라도 남았는지 확인하고, 하나도 없으면(delete marker만 남은 경우 포함) 원인과 복구 명령(`scripts/local.sh reset`)을 적은 오류로 기동하지 않는다. 로컬 LocalStack은 S3를 메모리에만 두므로, raw `docker compose down`이나 Docker 재시작 뒤 postgres의 행만 남는 경우를 잡는 빠른 검사다. version별 무결성은 여전히 백업과 `scripts/verify-restore.sh`가 본다. API credential에는 `s3:ListBucketVersions`가 필요하다.

**checkpoint GC**(94S-281)는 `bun run apps/control-host/src/api/checkpoint-gc.ts`로 도는 one-shot이다. reconciler처럼 한 pass만 돌고 끝나며, api 이미지와 API의 object store 환경 변수에 `DATABASE_URL`을 더해 실행한다. `CHECKPOINT_GC_DRY_RUN=true`를 주면 지울 개수만 세고 아무것도 지우지 않는다.

GC를 주기적으로 도는 서비스는 없다. 운영자가 **주 1회**, 사용이 적은 시간에 돌린다. compose 설치에서는 떠 있는 api 컨테이너 안에서 실행한다. 이 컨테이너에는 필요한 환경 변수가 이미 들어 있다.

```bash
docker compose exec -T -e CHECKPOINT_GC_DRY_RUN=true api bun run apps/control-host/src/api/checkpoint-gc.ts   # 지울 개수만 본다
docker compose exec -T api bun run apps/control-host/src/api/checkpoint-gc.ts                                 # exit 0이면 끝
```

cron에 걸려면 `0 4 * * 0 cd <checkout> && docker compose exec -T api bun run apps/control-host/src/api/checkpoint-gc.ts`처럼 저장소 루트에서 부른다. 세션 하나라도 실패하면 exit 1이고, 로그에 `Checkpoint GC failed for a session`이 남는다. 백업과 겹치면 안 된다(아래). 백업은 api가 멈춰 있어야 시작하므로, api 컨테이너에서 도는 GC는 백업 중에 시작될 수 없다. 다만 GC가 도는 도중에 api를 멈추고 백업을 시작하면 겹칠 수 있다. 백업은 GC가 끝난 뒤에 받는다. test-ops 설치의 명령은 [test-ops.md](test-ops.md)의 점검표에 있다.

**알파 한계: checkpoint 바이트는 저장량에 세지 않는다.** `STORAGE_LIMIT_BYTES`는 보관한 입력 메시지 바이트만 센다(아래 "설치 상한"). checkpoint가 S3에 쓰는 바이트와 legal hold가 걸린 version은 계측하지도 제한하지도 않는다. `locked`에서는 모든 version에 hold가 걸려 있어, GC가 hold를 풀고 지우기 전까지는 bucket lifecycle 규칙으로도 줄지 않는다. 알파 동안 저장량은 주 1회 GC와 bucket 크기 관찰로 관리한다.

회수 범위는 세션마다 두 곳이다. `sessions/<id>/checkpoints/<rev>/<attempt>/` 아래의 version(manifest·bundle·untracked 파일), 그리고 `sessions/<id>/transcripts/generation-<n>/` 아래의 transcript part version이다(94S-326). 그 밖의 key는 건드리지 않는다. version 하나를 지우는 조건은 아래 두 가지가 모두 맞을 때다.

- 어떤 restore도 그 version을 읽지 않는다. pointer, pointer 아래 parent 체인의 `maxRestoreFallbacks`(3)개 revision, 세션이 마지막으로 폴백 복원한 base 가운데 어느 manifest도 그 version을 가리키지 않는다.
- 더 이상 finalize가 그 version을 커밋할 수 없다. checkpoint 디렉터리는 revision이 pointer 이하이거나, attempt가 fence를 잃었을 때다(`exited`/`lost` 상태이거나 epoch·generation·auth revision이 세션과 다르다). transcript part는 key의 generation이 세션의 `execution_generation`보다 작을 때다. 그 generation의 attempt는 모두 fence를 잃었다.

그래서 죽은 generation이 마지막 checkpoint 뒤에 쓴 tail, 폴백으로 버려진 history에만 있던 part, window 밖으로 밀려난 revision에만 있던 part가 회수된다. 살아 있는 generation의 part와, 보존 revision이 상속한 이전 generation의 part는 남는다. 94S-314의 병합으로 대체된 합본도 그 generation이 끝난 뒤 같은 규칙으로 회수된다.

finalize는 두 가지를 거부한다. 첫째, manifest가 자기 publish 디렉터리 밖의 checkpoint 디렉터리 객체를 가리키는 경우다. 둘째(`locked`만), 자기 attempt의 generation이 아닌 transcript part 중 후보가 딛고 선 checkpoint가 가리키지 않는 것을 가리키는 경우다. 딛고 선 checkpoint는 pointer(후보는 그다음 revision으로만 커밋된다)이거나, 폴백 복원한 attempt라면 pointer의 parent다. 둘 다 GC가 보존한다. 그래서 hold → GC → pointer CAS 순서로 경쟁해도, 커밋될 checkpoint의 version은 GC가 회수할 수 없는 곳에 있다. 지울 때는 legal hold를 먼저 풀고 그 version을 지운다. 지운 revision의 `checkpoints` 행에는 먼저 `collected_at`을 적는다. backup은 이 행을 건너뛰므로, GC를 backup과 동시에 돌리지 않는다.

**`versions_held=false`인 pointer**(`unversioned`로 커밋된 checkpoint)는 그 manifest가 가리키는 **key의 모든 version**을 보존한다. 이런 checkpoint는 restore가 key로 다시 해시하고 hold를 걸기 때문이다. 보존 대상 manifest를 읽지 못하거나 digest가 맞지 않는 세션은 통째로 건너뛴다.

**`unversioned`와 `CHECKPOINT_OBJECT_STORE=disabled` 배포**에서는 hold도 version 고정도 없으므로 GC가 아무것도 하지 않고, 로그만 남긴 뒤 0으로 끝난다.

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest와 scope만 저장한다. `--scopes`는 필수이며 `sessions:read`·`sessions:write`·`sessions:approve`·`sessions:control`·`sessions:recover` 중에서 고른다. `/v1` 요청은 route마다 OpenAPI 표(`API_ROUTE_SCOPES`)에 적힌 scope를 요구하고, 없으면 body나 세션을 읽기 전에 `403 FORBIDDEN`이다. `sessions:recover`(recovery-decisions)는 별도 scope라 `sessions:write`나 `sessions:control`에 포함되지 않는다. cookie 사용자는 role로 scope를 받는다(owner 전부, member는 recover 제외). scope 도입 전에 발급된 키(scope NULL)는 아무 scope도 없으므로 다시 발급한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/control-host keys create local-owner --scopes sessions:read,sessions:write
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/control-host start
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

### 세션 실행 권한 회수와 복구 (94S-321)

API key 폐기(`keys revoke`)는 그 key로 오는 요청과 열려 있던 SSE만 끊고, 이미 돌고 있는 세션의 worker는 건드리지 않는다. 한 세션의 실행을 거두려면 grants CLI를 쓴다. Grant 관리 API나 UI는 알파에 없다. keys CLI와 같은 곳(API 이미지 안, 같은 DB)에서 실행하고, `--reason`은 필수다. 이유는 세션 이벤트(`execution_revoked`·`execution_restored`)에 운영자 행위로 남는다.

```bash
# compose(apps profile): api 컨테이너 안에서 실행한다
bun run grants revoke <session_id> --reason "leaked credential"
bun run grants restore <session_id> --reason "rotated; safe to resume"
# host에서 도는 API라면
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/control-host grants revoke <session_id> --reason "…"
```

**revoke**는 한 transaction에서 다음을 한다. 다른 세션과 owner 계정은 건드리지 않는다.
- 세션의 auth_revision과 epoch를 올린다. 현재 binding의 fenced write는 무엇으로 인증했든 여기서부터 실패한다.
- 세션의 worker token을 폐기한다. worker의 다음 요청은 401이다.
- 현재 generation의 kill intent를 terminate와 같은 방식으로 남긴다.
- dispatch를 막는다. owner의 resume과 start_fresh도 403이다.

receipt는 execution이 사라진 것이 관측될 때까지 `accepted`로 남고, terminate 기한을 넘기면 `unknown`이 된다.

**restore**는 차단만 푼다. 올라간 auth_revision, 폐기된 token, 세션이 도달한 admission 상태(stopped 또는 recovery_required)는 그대로다. 이어서 하려면 terminate 뒤처럼 owner가 resume하거나 운영자가 recovery를 결정한다. 회수한 execution이 아직 살아 있을 수 있으면 restore는 거부된다. scheduler가 kill을 끝내고 execution이 사라진 것이 관측된 뒤 다시 실행한다.

결과는 아래 표의 한 줄이다. 성공이면 stdout에 쓰고 exit 0, 거부면 stderr에 쓰고 exit 1이다. 같은 명령을 다시 실행해도 안전하다. 인자 오류나 DB 오류는 표에 없는 여러 줄 오류(stack 포함)로 stderr에 나오고 exit 1이다.

| 줄 | exit | 뜻 |
|---|---|---|
| `revoked <id> owner=… auth_revision=… execution=<id\|none> credentials_revoked=<n> receipt=… receipt_status=<accepted\|succeeded>` | 0 | 회수했다. `receipt_status`는 kill을 기다릴 execution이 있으면 `accepted`, 없으면 곧바로 `succeeded`다 |
| `already_revoked <id> revoked_at=… reason="…"` | 0 | 이미 회수된 세션이다. 아무것도 바꾸지 않는다 |
| `restored <id> owner=…` | 0 | 차단을 풀었다 |
| `not_revoked <id>` | 0 | 지금 회수된 상태가 아니다(이미 복구된 세션 포함). 아무것도 바꾸지 않는다 |
| `session <id>: execution <id> has not been observed gone; restore once it has` | 1 | restore 거부. 잠시 뒤 다시 실행한다 |
| `session <id> not found` | 1 | 그런 세션이 없다 |
| `session <id> is closed` | 1 | 닫힌 세션은 회수할 것이 없다 |
| `session <id> runs on a legacy pod binding with no kill path` | 1 | legacy binding이라 kill 경로가 없다 |

`session_id`는 UUID여야 한다. 인자가 틀리거나 `--reason`이 비어 있으면 DB에 연결하기 전에 사용법이 담긴 오류로 끝난다. `DATABASE_URL`이 없어도 인자 검사가 먼저다.

## 설치 상한 (94S-131)

API와 scheduler는 아래 여섯 값이 없거나 형식이 틀리면 문제를 한 줄에 모두 로그로 남기고 기동하지 않는다. 두 프로세스는 같은 parser(`packages/platform/src/limits/installation-limits.ts`)를 쓴다. 코드에는 기본값이 없고, compose의 `x-installation-limits` 블록이 로컬 기본값을 준다. 떠 있는 API의 `/readyz`는 같은 검증을 `config` 체크로 다시 수행한다.

| 변수 | 의미 | 넘었을 때 |
|---|---|---|
| `EXECUTION_SLOT_LIMIT` | 동시에 슬롯을 잡는 worker 수. 0이면 접수만 받고 아무것도 띄우지 않는다 | 입력은 거부하지 않고 `queued`로 둔다 |
| `QUEUED_INPUT_LIMIT_PER_SESSION` | 세션 하나가 쌓아 둘 수 있는 `queued` turn 수 | `429 RATE_LIMITED`, `retryable:true`, `Retry-After: 5` |
| `STORAGE_LIMIT_BYTES` | 설치 전체가 보존하는 입력 message의 UTF-8 bytes. event·checkpoint object·worker 디스크는 세지 않는다(디스크는 workspace quota가 맡는다) | `413 STORAGE_LIMIT_EXCEEDED`, `retryable:false` |
| `MAX_TURN_SECONDS` | turn 하나의 벽시계 상한. 승인 대기도 포함한다. worker env `WORKER_MAX_TURN_SEC`로 전달된다 | turn `failed(turn_timeout)`. 엔진이 응답하지 않으면 `outcome_unknown(turn_timeout)` |
| `SESSION_COST_LIMIT_USD` | 세션 누적 비용(egress proxy가 계측한 Messages 호출별 usage를 플랫폼 가격표로 환산한 합, 추정치. 94S-409) | 새 turn을 dispatch하지 않는다. 세션 상세 `attention.code=BUDGET_EXCEEDED`가 뜨고 worker는 슬롯을 반납한다. 입력은 계속 `queued`로 받는다 |
| `PROVIDER_MAX_RETRIES` | 실패한 Messages 요청을 다시 보내는 횟수. worker env `WORKER_PROVIDER_MAX_RETRIES`를 거쳐 SDK `CLAUDE_CODE_MAX_RETRIES`로 전달된다. 0이면 첫 실패에서 turn이 끝난다 | turn `failed(api_error)`. turn 상세 `result`에 `api_error_status`·`provider_error`·`last_retry_status`가 남는다 |

- 세션 비용은 credential route가 센다(94S-409). proxy는 2xx `/v1/messages` 응답(JSON과 SSE 모두)에서 usage를 읽는다. 응답이 끝나거나 끊기면 authorizer listener의 `POST /usage`로 보고한다. `count_tokens`와 오류 응답은 세지 않는다.
  - 응답이 usage를 다 말하지 않으면 많게 추정한다. `message_stop` 전에 끊긴 stream은 전달한 content 한 글자를 token 하나로 쳐서 output에 넣고, 전달한 web search 결과 블록 하나를 검색 한 번으로 친다. usage를 읽지 못한 JSON 응답(끊김, 8 MiB 초과, JSON 아님)은 요청으로 센다. 요청 1 byte를 input token 하나로, `max_tokens`를 output 전부로 본다. 이런 호출은 proxy가 `Provider usage estimated` 경고를 남기고 ledger에 `estimated=true`로 적힌다.
  - API는 가격표로 USD를 구해 micro-dollar 단위로 올림한다. 그 금액을 `provider_usage`에 교환 하나당 한 줄로 쓰고, 같은 트랜잭션에서 세션 비용에 더한다. 그래서 ledger 합과 세션 비용이 맞는다.
  - engine의 호출과 도구가 engine의 token으로 직접 부른 호출을 똑같이 센다.
  - 보고에는 proxy가 교환마다 만든 id가 붙는다. authorizer가 답하지 못하면 1·5·15초 뒤에 다시 보내고, 같은 id는 한 번만 센다. 끝내 보고하지 못하면 proxy가 `Provider usage went unreported` 오류 로그를 남기고 그 교환은 세지 않는다.
- turn 종료 때 SDK가 알려 준 `total_cost_usd` 증분은 turn 결과(`cost_usd`)에만 남고 세션 비용에는 더하지 않는다. engine의 turn별 `maxBudgetUsd`는 그대로 SDK 값으로 판정한다. 94S-409 전에 만든 세션은 그때까지 SDK 값을 더한 비용을 이어받는다.
- 가격표는 플랫폼 코드(`packages/platform/src/limits/model-prices.ts`)가 소유한다. 모델 id별로 input, output, cache write(5분 1.25배, 1시간 2배), cache read 단가를 둔다. 모델이 추가되거나 가격이 바뀌면 릴리스와 함께 고친다.
  - fast mode는 따로 둔 fast 단가표로 센다(94S-451). 지금은 Opus 5.5($8/$40)와 Opus 5·Opus 4.8($10/$50)만 있다. cache 배수는 fast 단가 위에 그대로 곱한다. speed는 응답의 `usage.speed`를 따르고, 응답이 말하지 않으면 요청의 `speed`를 따른다. 둘 다 없으면 `standard`다.
  - 표에 없는 모델, fast 단가가 없는 모델의 fast 응답, 이름이 아닌 speed 값은 항목마다 두 표를 통틀어 최고 단가로 센다. authorizer가 `Provider usage priced at the fallback rate` 경고를 남기고, ledger에는 `priced_by=fallback`으로 적힌다.
  - 응답 `usage.server_tool_use`의 web search 한 번마다 $0.01(1,000회 $10)을 더한다. web fetch는 token 말고 요금이 없다. code execution은 더하지 않는다. web search·web fetch와 함께 쓰면 요금이 없고, 아니면 호출 수가 아니라 컨테이너 시간으로 과금되며 조직 무료 시간이 있기 때문이다. 세 횟수와 speed는 ledger(`provider_usage`)에 함께 적힌다.
  - 4.6 이후 모델은 US 전용 추론(`inference_geo: "us"`)이면 token 단가 전부(fast·cache 포함)에 1.1배를 곱한다(94S-454). web search 요금에는 곱하지 않는다. geo는 응답의 `usage.inference_geo`를 따르고, 응답이 말하지 않으면 요청의 `inference_geo`를 따른다. 둘 다 없으면 `unknown`이다. workspace 기본값이 `us`일 수 있어서다. `global`과 `us`가 아닌 값은 최고 단가에 1.1배로 센다(`priced_by=fallback`). geo는 ledger에 `inference_geo`로 적힌다. 94S-454 이전 API는 이 필드가 붙은 보고를 `400`으로 거절하고, proxy는 그 교환을 세지 못한다(`Provider usage went unreported`). 그래서 업그레이드할 때는 API(migration 포함)를 egress proxy보다 먼저 올린다. 새 API는 이 필드가 없는 옛 proxy의 보고도 받는다.
  - 4.6 이전 모델(Opus 4.5·4, Sonnet 4.5·4, Haiku 4.5)은 `inference_geo`를 받지 않으므로 geo와 상관없이 표준 단가로 센다. 이 모델들의 창은 200K이고 공개된 long-context 단가가 없다. 그래서 input·cache write·cache read 합이 200K를 넘는 호출은 최고 단가로 센다(`priced_by=fallback`). 4.6 이후 모델은 1M 전체가 표준 단가다.
  - batch는 credential route가 `/v1/messages/batches`를 열지 않아서 해당이 없다.
- 비용 상한은 호출이 끝난 뒤에 판정한다. 동시에 열린 호출은 모두 인가를 통과할 수 있고, 진행 중인 turn은 상한을 넘을 수 있다.
- 누적 비용이 상한 이상인 세션의 provider egress token은 authorizer가 403 `BUDGET_EXCEEDED`로 거절한다(94S-394). 새 provider 교환은 곧바로 거절되고, 이미 열린 교환은 다음 재인가(30초 주기)에서 끊긴다. repository·object store route는 거절하지 않는다.

## API 설정 (94S-389)

API는 설치 상한 말고도 아래 값을 기동 때 한 parser(`apps/control-host/src/api/api-settings.ts`)로 읽는다. 설정하지 않으면 기본값을 쓴다. 설정했는데 틀린 값이면(빈 문자열 포함) 기본값으로 돌아가지 않는다. 이때 `Refusing to start: API settings are invalid` 한 줄에 문제를 모두 남기고 기동하지 않는다. 떠 있는 API의 `/readyz`도 같은 검증을 `config` 체크로 다시 수행한다.

| 변수 | 기본값 | 허용 범위 |
|---|---|---|
| `HEARTBEAT_TTL_SEC` | 30 | 20 초과 86400 이하. worker는 lease가 끝나기 10초 전에 lease를 내려놓고(`WORKER_LEASE_SAFETY_MARGIN_SEC`), 10초마다 heartbeat를 보낸다(`WORKER_HEARTBEAT_INTERVAL_SEC`). 둘의 합 이하이면 모든 attempt가 첫 heartbeat 무렵 lease를 잃는다. launcher는 두 worker 값을 넘기지 않으므로 기본값을 기준으로 판정한다 |
| `PENDING_REQUEST_TTL_SEC` | 1800 | 정수 1–604800. 승인·질문 요청을 받는 기간이다. 등록된 요청은 worker가 이 값만큼 기다린다. worker의 `QUESTION_TIMEOUT_SEC`는 gateway가 등록을 확인하기 전에만 적용된다. turn 벽시계 `MAX_TURN_SECONDS`에는 대기 시간도 들어가므로, 대기는 그 상한을 넘지 못한다 |
| `SSE_MAX_STREAMS` · `SSE_MAX_STREAMS_PER_OWNER` · `SSE_REPLAY_MAX_BYTES` | 256 · 8 · 1 MiB | 양의 정수 |
| `LOG_LEVEL` | `info` | `debug`·`info`·`warn`·`error`(대소문자 무관, 빈 값은 `info`). scheduler·reconciler loop와 egress-proxy도 같은 규칙으로 기동을 거부한다. worker는 scheduler의 값을 받는다 |

`AUTH_MODE=none`은 egress authorizer(`EGRESS_AUTHORIZER_PORT`)와 함께 쓸 수 없다. authorizer가 켜져 있다는 것은 worker가 proxy를 거쳐 이 API에 닿는다는 뜻이다. `none` 모드에서는 worker 안의 코드가 `X-Owner-Id`로 아무 owner나 행세할 수 있으므로 기동을 거부한다. `AUTH_MODE` 값 자체(`none`|`api-key`)는 전처럼 readiness가 판정한다.

worker도 기동 때 교차 검사를 한다. `WORKER_PROVIDER_MAX_RETRIES`가 없으면 기동하지 않는다. 코드 기본값이 없는 설치 상한이고(94S-292), scheduler가 항상 넘긴다. `WORKER_NEXT_INPUT_WAIT_SEC`가 `WORKER_REQUEST_TIMEOUT_SEC` 이상이어도 기동하지 않는다. 그 설정에서는 모든 long poll이 요청 timeout에 잘린다. scheduler와 reconciler는 빈 `DATABASE_URL`을 설정하지 않은 것으로 보고 `QUEUE_DATABASE_URL`을 쓴다.

## scheduler·worker 컨테이너·egress 설정

scheduler가 worker 컨테이너를 만들 때 읽는 값이다. 없으면 기본값을 쓰고, 형식이 틀리면 기동하지 않는다. user, HOME·workspace 경로, tmpfs 크기, credential 포트, stop timeout은 `agent-platform.isolation` 지문에 들어간다(위 "reconciler·scheduler와 worker 격리"). 그래서 바꾸면 실행 중인 worker가 교체된다. CPU·메모리·PID 한도는 다음 launch부터 적용된다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `WORKER_CPUS` | 1 | worker 하나의 CPU 몫. 0.01 이상 |
| `WORKER_MEMORY_MB` | 2048 | worker 하나의 메모리 한도(MiB) |
| `WORKER_PIDS_LIMIT` | 512 | worker 하나의 PID 한도. compose는 넘기지 않는다 |
| `EXECUTION_DOCKER_USER` | `1000:1000` | worker의 숫자 `uid[:gid]`. uid나 gid가 0이면 기동을 거부한다. worker 이미지의 `/workspace` 소유자와 같아야 한다 |
| `EXECUTION_DOCKER_HOME_DIR` | `/home/worker` | tmpfs로 마운트하는 HOME. 절대 경로 |
| `EXECUTION_DOCKER_WORKSPACE_DIR` | `/workspace` | 세션 volume을 마운트하는 곳. 절대 경로이고 HOME과 달라야 하며 공백·역슬래시를 쓸 수 없다. worker에는 `WORKER_WORKSPACE_DIR`로 간다 |
| `EXECUTION_DOCKER_TMPFS_SIZE_MB` | 256 | HOME과 `/tmp` tmpfs 각각의 크기(MiB) |
| `EXECUTION_DOCKER_STOP_TIMEOUT_SEC` | 120 | SIGTERM에서 SIGKILL까지의 유예. 30 미만이면 기동을 거부한다. worker에는 `WORKER_STOP_GRACE_SEC`로 가고, worker는 drain을 그 안에 맞춘다 |
| `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC` | 30 | Docker Engine API 요청 하나의 기한 |
| `EXECUTION_DOCKER_COMMAND` | 없음 | 이미지 entrypoint 대신 돌릴 명령(공백으로 나눈다). 테스트용이다 |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker daemon 주소 |
| `DOCKER_API_VERSION` | `v1.44` | 요청에 쓰는 Engine API 버전 |
| `EXECUTION_EGRESS_CREDENTIAL_PORT` | 3129 | proxy credential route의 포트. proxy의 `EGRESS_CREDENTIAL_PORT`와 같아야 하고, `EXECUTION_EGRESS_PROXY_URL`의 포트와는 달라야 한다 |

`EXECUTION_DOCKER_NETWORK`·`EXECUTION_DOCKER_NETWORK_ALLOWLIST`는 더 이상 읽지 않는다. 값이 있으면 기동을 거부한다.

egress-proxy와 API의 authorizer listener는 아래 값을 읽는다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `EGRESS_PROXY_HOST` | `0.0.0.0` | proxy의 두 listener(forward, credential route)가 여는 주소 |
| `EGRESS_PROXY_PORT` | 3128 | forward proxy 포트 |
| `EGRESS_CREDENTIAL_PORT` | 3129 | credential route 포트 |
| `LOG_LEVEL` | `info` | proxy 로그 수준. 규칙은 위 API 설정과 같다 |
| `EGRESS_AUTHORIZER_HOST` | `0.0.0.0` | API의 authorizer listener(`EGRESS_AUTHORIZER_PORT`)가 여는 주소 |

compose는 세 포트를 서비스마다 따로 적는다. proxy의 `EGRESS_PROXY_PORT: "3128"`·`EGRESS_CREDENTIAL_PORT: "3129"`, api의 `EGRESS_AUTHORIZER_PORT: "3100"`, proxy의 `EGRESS_AUTHORIZER_URL`(`http://api:3100`), scheduler의 `EXECUTION_EGRESS_PROXY_URL`(`http://egress-proxy:3128`)이다. scheduler에는 `EXECUTION_EGRESS_CREDENTIAL_PORT`를 넘기지 않고 코드 기본값 3129를 쓴다. 포트 하나를 바꾸려면 그 짝을 모두 같은 값으로 바꾼다.

API 컨테이너의 메모리는 checkpoint bundle 검증이 정한다. 검증은 동시에 두 개까지 돌고, 검증마다 git fetch와 index-pack이 각자 `CHECKPOINT_GIT_MEMORY_MB`의 주소 공간 상한 아래에서 함께 돈다. 두 값은 함께 바꾼다. 상한만 올리면 OOM killer가 무엇을 죽일지 정하게 된다(94S-259). 계산은 `infra/compose.core.yml`의 api 서비스 주석에 있다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `API_MEMORY_MB` | 7168 | compose api 컨테이너의 `mem_limit`(MiB) |
| `CHECKPOINT_GIT_MEMORY_MB` | 1536 | bundle 검증 git 프로세스 하나의 주소 공간 상한(MiB). 512 미만이면 기동을 거부한다 |

compose의 Postgres는 `POSTGRES_USER`(`postgres`)·`POSTGRES_PASSWORD`(`dev`)·`POSTGRES_DB`(`sessions`)로 만들고, 모든 서비스가 같은 값으로 DSN을 만든다. 로컬 Gitea 예시 저장소의 agent 사용자 비밀번호는 `GITEA_AGENT_PASSWORD`이고, 비워 두면 아무도 모르는 무작위 값이 된다.

worker는 아래 값도 env로 읽는다. 하지만 scheduler가 넘기지 않으므로 운영에서는 코드 기본값으로 고정이다. `WORKER_ANSWER_POLL_SEC`(1), `WORKER_CLAIM_TIMEOUT_SEC`(60), `WORKER_DRAIN_TIMEOUT_SEC`(100, stop 유예 안으로 줄어든다), `WORKER_HEARTBEAT_INTERVAL_SEC`(10), `WORKER_IDLE_TIMEOUT_SEC`(1800), `WORKER_LEASE_SAFETY_MARGIN_SEC`(10), `WORKER_NEXT_INPUT_RETRY_SEC`(60), `WORKER_NEXT_INPUT_WAIT_SEC`(20), `WORKER_REQUEST_TIMEOUT_SEC`(30), `WORKER_STARTUP_TIMEOUT_SEC`(3600), `QUESTION_TIMEOUT_SEC`(1800), `WORKER_CLAUDE_CONFIG_DIR`(`$HOME/.claude`).

## 이미지와 Compose `apps` profile

앱 이미지는 `apps/{control-host,worker,egress-proxy}/Dockerfile` 셋이 정의한다(94S-117). 셋 다 저장소 루트를 context로 `oven/bun:1.3.14`의 multi-arch index digest 하나를 base로 pin한다(`tests/images.test.ts`가 digest 일치를 검사). control-host 이미지 하나가 api·scheduler·reconciler 세 role을 모두 돌린다 — compose에서는 `api`만 빌드하고 scheduler·reconciler는 같은 `API_IMAGE`를 쓴다. 같은 태그를 두 서비스가 함께 빌드하면 export가 경합하기 때문이다. control-host·worker는 `bun install --frozen-lockfile --production`으로 workspace closure만 설치한 뒤 runtime stage로 복사하고, egress-proxy는 `bun install` 없이 자기 소스만 담은 한 stage다(94S-323).

digest pin은 Bun 버전과 함께 베이스의 Debian 패키지도 고정한다. oven/bun은 발행한 tag를 다시 빌드하지 않아서, 2026-09-25 기준 `oven/bun:1.3.14`의 마지막 빌드는 2026-05-13이다. 그래서 세 이미지의 배포 stage는 `apt-get upgrade`로 Debian 보안 수정을 올린다(94S-363). Bun을 올리지 않고 수정을 받는 방법이 이것뿐이기 때문이다. 대가는 재현성이다. 같은 commit이라도 빌드한 날에 따라 Debian 패키지 버전이 다를 수 있다. 배포한 것은 release manifest가 image digest로 고정하고, 빌드마다 images.yml의 라이선스 대조와 Grype 검사가 그 이미지를 본다. layer cache는 `APT_UPGRADE_KEY` build arg가 가른다. images.yml은 UTC 날짜를 넘기고, 로컬 compose 빌드는 빈 값이라 한 번 만든 upgrade layer를 계속 쓴다. 로컬에서 새 수정을 받으려면 `--build-arg APT_UPGRADE_KEY=$(date -u +%F)`나 `--no-cache`로 빌드한다.

### worker 안에서 만든 commit의 작성자 (94S-423)

worker 이미지는 git system 설정(`/etc/gitconfig`)에 `user.name=agent-platform`, `user.email=noreply@agent-platform.invalid`를 둔다. 그래서 Claude가 workspace에서 만든 commit은 저장소나 세션이 따로 정하지 않는 한 author와 committer가 모두 `agent-platform <noreply@agent-platform.invalid>`다. 이 값이 없으면 git이 commit을 거부하고, Claude는 사용자에게 이름과 주소를 묻는다. `.invalid`는 어디에도 배달되지 않는 예약 도메인이라 실제 사람의 주소와 겹치지 않는다. checkpoint의 내부 commit은 이 값을 쓰지 않는다(`checkpoint@agent-platform.invalid`).

system 설정은 git 설정 중 우선순위가 가장 낮아서, 세션 안에서 정한 값이 있으면 그쪽이 이긴다. 세션의 작성자를 바꾸려면 workspace 저장소에 `git config user.name`·`git config user.email`을 쓴다. `git commit --author`는 author만 바꾸고 committer는 그대로 둔다. `git config --global`은 tmpfs HOME에 쓰이므로 worker가 바뀌면 사라진다. 저장소 설정도 checkpoint에서 복원한 worker에서는 사라진다. 복원이 workspace를 비우고 저장소를 새로 만들기 때문이다. 그때부터는 다시 기본 작성자로 commit된다. 카탈로그나 설치 설정으로 기본값을 바꾸는 기능은 두지 않았다. 사용자별 작성자를 기본값으로 쓰려면 사용자 주소를 worker에 넘겨야 하므로 제품 결정이 먼저다. 이미지 smoke(`.github/scripts/image-smoke.sh`)가 빈 저장소에서 commit해 이 작성자를 확인하고, e2e(`tests/e2e/alpha-path.e2e.ts`)가 실제 Claude Code의 Bash 도구로 같은 것을 확인한다.

### worker·control-host 롤백과 incremental checkpoint (94S-227)

[#217](https://github.com/JeongJaeSoon/agent-platform/pull/217)(`95b0e7b5`)부터 worker는 직전 checkpoint의 bundle 사슬 위에 새 객체만 담은 incremental bundle을 올린다. 그 사슬은 manifest의 `workspace.baseBundles`에 적힌다. manifest `version`은 그대로 2이고, incremental인지는 이 필드가 있는지로만 갈린다. **#217 이전 빌드로 롤백하면 이 필드가 있는 checkpoint를 복원하지 못한다.** 이전 빌드의 manifest 스키마는 모르는 키를 거절하기 때문이다.

- **옛 worker 이미지.** 복원할 때 manifest decode가 `Invalid Claude checkpoint manifest: workspace Unrecognized key: "baseBundles"`로 실패한다. 이 실패는 workspace를 비우거나 bundle을 받기 전에 나므로 반쯤 복원된 workspace는 남지 않는다. 대신 manifest가 고정돼 있어 다시 launch해도 같은 이유로 `worker.failed`가 된다.
- **옛 control-host.** 복원 계획이 `CHECKPOINT_UNAVAILABLE`로 거절되고, 앞 revision으로 물러나지 않는다. finalize도 incremental manifest를 거절해 pointer가 오르지 않는다. 새 worker와 섞여 있으면 첫 checkpoint처럼 홀로 선 bundle만 commit된다. 옛 GC는 decode되지 않는 세션을 건너뛰므로 base bundle을 지우지는 않는다.
- **영향 세션 찾기.** DB에는 manifest 내용이 없다. `sessions.checkpoint_revision`이 가리키는 `checkpoints` 행(`collected_at IS NULL`)의 `manifest_ref`·`manifest_version`으로 object store에서 manifest를 받아 `jq -e '.workspace.baseBundles | length > 0'`로 가른다. 복원이 `parent_revision`을 따라 물러날 수도 있으므로 부모 행도 같이 본다. worker 로그 `worker.checkpoint.published`의 `base_bundles`가 0보다 크면 incremental로 올린 것이다.
- **롤백 전에 할 일.** 영향 세션이 있으면 롤백하지 말고 롤포워드한다. 새 전체 bundle로 다시 checkpoint하게 하는 운영 수단(환경 변수·설정·CLI)은 아직 없다. worker는 사슬이 없거나 끊겼거나, 길이 32(`MAX_BUNDLE_CHAIN`)나 bundle 상한에 닿았을 때만 스스로 전체 bundle을 올린다. 그래서 롤백이 꼭 필요하면 영향 세션은 롤백 동안 복원되지 않는다. 롤포워드하면 그대로 복원된다.

### 외부 공개 전 법률 검토 질문 (94S-375)

배포 이미지의 제3자 고지(`THIRD_PARTY_NOTICES.md`와 이미지마다 `/app/DEBIAN_SOURCES.md`)는 업계 관행에 맞춘 초안이다. 최종 판단은 외부 공개 전에 사람이 한다. 판단할 질문은 아래와 같다. 괄호 안은 지금 고지가 택한 답이다.

1. **Debian GPL·LGPL 패키지의 소스를 snapshot.debian.org를 가리키는 것으로 제공해도 되는가.** (지금: 이미지마다 source package와 정확한 버전, snapshot 주소를 적어 가리킨다. written offer는 없다. images.yml은 빌드할 때 snapshot이 그 소스를 모두 갖고 있는지 확인하고, 릴리스에서는 하나라도 없으면 실패한다. 그러나 그 뒤로도 계속 남아 있는지는 보장하지 못한다.)
   - GPL-2.0 §3은 상업적 배포에서 소스를 함께 주거나(a) 3년 이상 유효한 서면 제공 약속을 붙이라고 한다(b). 이미지를 받은 곳에서 소스도 받게 하는 것도 소스 배포로 친다(§3 마지막 단락). 제3자 서버는 명시돼 있지 않다. https://www.gnu.org/licenses/old-licenses/gpl-2.0.html#section3
   - GPL-3.0 §6(d)는 다른 서버를 허용하지만, 필요한 기간 동안 그 소스가 계속 있도록 배포자가 보장해야 한다. snapshot.debian.org는 우리가 보장할 수 있는 서버가 아니다. https://www.gnu.org/licenses/gpl-3.0.html#section6
   - FSF FAQ: https://www.gnu.org/licenses/gpl-faq.html#SourceAndBinaryOnDifferentSites , https://www.gnu.org/licenses/gpl-faq.html#AnonFTPAndSendSources
   - 부족하다면 아래에서 고른다. 오케스트레이터 결정(2026-09-24)은 외부 공개 전까지 지금 방식을 유지하고, 법률 검토 결과에 따라 D나 B를 고르는 것이다. 개인 이메일은 쓰지 않는다.
     - A. written offer, 연락 경로는 이 저장소의 GitHub issue("소스 요청"). 비용은 없다. 저장소와 계정을 3년 동안 유지해야 한다.
     - B. written offer, 연락 경로는 역할 주소(oss@<회사 도메인>). 도메인과 메일함을 만들어 운영해야 한다.
     - C. written offer, 연락 경로는 법인 우편 주소. 법인이 있어야 한다.
     - D. written offer 없이 릴리스마다 대응 소스를 받아 이미지와 같은 registry(ghcr)에 함께 올린다. GPL-2.0 §3의 "같은 곳"에 해당하는 가장 강한 방식이다. 저장 비용과 CI 시간이 든다.
2. **Bun의 LGPL-2.1 정적 링크(JavaScriptCore·WebCore·TinyCC)를 Oven이 공개한 소스와 빌드 절차로 충족하는가.** (지금: Bun commit, WebKit·TinyCC commit, 재링크 절차 링크, 이미지 안의 LGPL-2.1 전문을 적는다.)
   - 근거는 LGPL-2.1 §6이다. 재링크할 수 있는 형태를 주거나, (c) 3년 이상 유효한 서면 제공 약속을 붙이거나, (d) 같은 곳에서 받을 수 있게 해야 한다. https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html#SEC6
   - Bun은 전체가 공개 소스(MIT)라서 누구나 다시 빌드할 수 있다. 그래도 소스는 우리 서버가 아니라 GitHub(oven-sh)에 있다. 이 점은 질문 1과 같은 쟁점이다.
   - Bun의 LICENSE.md가 적은 재링크 절차(`make jsc`, `zig build`)는 낡았다. 고지에는 CONTRIBUTING.md의 "Building WebKit locally"를 적었다. https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md
3. **번들 Claude Code 실행 파일 안의 Bun 1.4.3 런타임(JavaScriptCore, LGPL-2.1)에 대해 재배포자인 우리에게 의무가 있는가.** (지금: 내장 사실과 버전만 적는다.)
   - 이 실행 파일은 독점 소프트웨어라 우리는 재링크 수단을 줄 수 없다.
   - Bun 1.4.3은 2026-09-24 현재 oven-sh/bun에 공개 tag가 없다. 그래서 대응 WebKit commit도 우리가 특정할 수 없다. 확인은 Anthropic에 해야 한다. https://github.com/oven-sh/bun/releases
4. **worker 이미지를 외부에 배포할 때 Anthropic의 별도 허락이 필요한가.** (지금: 별도 허락 없이, Claude Code를 제품에 싣는 공개 조건을 따른다고 적는다.)
   - Claude Code 법률 고지의 "Can customers offer Claude Code in their products?"는 제품에 미리 설치하거나 실행하는 것을 허용한다. 조건은 Commercial Terms에 동의하는 것, 실행 파일을 수정하지 않는 것, 내장된 인증 방식을 제거·비활성화·제한하지 않는 것이다. https://code.claude.com/docs/en/legal-and-compliance
   - Agent SDK의 이용 조건도 같은 Commercial Terms다. https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms , https://www.anthropic.com/legal/commercial-terms
   - 확인할 것 하나: worker는 credential route(§ provider 키, 94S-252)로만 provider에 닿는다. egress proxy의 기본 allowlist는 `api.anthropic.com:443`뿐이라 Claude 계정 로그인(OAuth) 경로가 열려 있지 않다. 이것이 "인증 방식을 제한하지 않는다"는 조건에 어긋나는가.
5. **provider 키를 누가 소유하는가.** 이것은 제품 방향이 정할 문제다.
   - 같은 고지는 최종 사용자의 사용을 대신 결제하거나 재판매·중개하지 말라고 한다. 사용자마다 자기 API key, Claude 구독 자격 증명, 3P provider 자격 증명으로 인증해야 한다.
   - 고객이 자기 key를 자기 사용자에게 쓰게 하는 설정은 명시적으로 허용된다.
   - credential route는 카탈로그에 있는 운영자 key를 모든 세션에 붙인다. 그래서 고객이 자기 key로 직접 운영하는 형태는 허용 범위다. 우리가 key를 쥐고 여러 고객에게 서비스하는 형태는 별도 계약 없이는 어긋날 수 있다.
6. **이름 사용.** "Claude Code를 실행한다"는 평이한 서술은 허용된다. 제품명이나 로고에 Claude Code·Anthropic을 쓰는 것은 허락이 필요하다. 외부 문서와 UI가 이 선을 지키는지 본다. https://code.claude.com/docs/en/legal-and-compliance , https://www.anthropic.com/legal/trademark-guidelines
7. **라이선스 전문을 대신 싣거나 링크로 가리키는 것으로 충분한가.** (지금: npm 패키지는 자기 라이선스 파일을 `/app/node_modules/<패키지>/`에 싣는다. 싣지 않은 11개는 고지가 package.json의 저작권자와 MIT 전문, 또는 이미지 안 Apache-2.0 사본을 대신 싣는다. Bun 자체의 MIT 고지는 LICENSE.md 링크만 있다.)
   - MIT는 저작권 표시와 허락 문구를 사본에 포함하라고 한다. package.json의 author가 실제 저작권자와 다를 수 있다. https://opensource.org/license/mit
   - Apache-2.0 §4(a)는 라이선스 사본을 주라고 한다. https://www.apache.org/licenses/LICENSE-2.0#redistribution
   - Bun의 LICENSE.md에는 MIT 전문이 없다("Bun itself is MIT-licensed"). 전문을 우리가 만들어 넣어야 하는가.

### 공급망 취약점 정책 (94S-363)

2026-09-24 사용자 결정이다. **수정판이 있는 high·critical 취약점만 막는다.** 수정판이 없는 발견은 보고만 하고 실패시키지 않는다.

- **무엇을 보나.** 세 이미지(Grype, Debian 패키지와 `/app`의 npm 패키지)와 `bun.lock` 전체(`bun audit`, dev 의존성 포함)다. "수정판이 있다"는 이미지에서는 Grype의 `fix.state`가 `fixed`인 것이고, npm에서는 GitHub advisory database에서 잠긴 버전을 포함하는 범위에 `first_patched_version`이 있는 것이다. Debian의 `not-fixed`·`wont-fix`와 수정판 없는 npm advisory는 막지 않는다.
- **어디서 막나.** images.yml의 `supply-chain` job이 판정하고, branch protection의 required check다. PR, main push, 매일 03:17 UTC 실행, 수동 실행, `v*` tag에서 모두 돈다. tag의 `publish`는 `supply-chain`을 기다리고, 승격할 digest를 다시 검사해 같은 기준으로 막는다.
- **검사가 답을 못 받으면.** Grype DB나 advisory 서비스가 응답하지 않은 `error`는 PR과 main push에서 경고만 남긴다. 외부 서비스 장애로 모든 머지가 멈추면 안 되기 때문이다. 매일 실행과 tag에서는 실패한다. 이미지가 빌드되지 않아 결과가 아예 없으면 어디서든 실패한다.
- **보고.** 수정판 없는 high·critical도 각 검사의 step summary(접힌 목록)와 `supply-chain-results` artifact(검사마다 JSON 하나, 항목마다 `fix`가 null)에 남는다. 매일 실행이나 수동 실행이 실패하면 `ci-supply-chain` 라벨 이슈가 열린다.
- **밤사이 새 advisory.** 수정판이 있는 advisory가 새로 나오면 main을 포함해 모든 PR의 `supply-chain`이 한꺼번에 빨개진다. 의도한 동작이다. 의존성이나 base를 올리는 PR 하나로 푼다. Debian 패키지는 다음 날의 `APT_UPGRADE_KEY`로 새 빌드가 받는다. 당일에 받으려면 수동 실행(`gh workflow run Images`)이 그날 key로 빌드한다.
- **예외.** 올릴 수 없는 수정(예: `upgrade`가 보류한 Debian 패키지, 코드 경로가 닿지 않는 advisory)은 `.github/vulnerability-exceptions.json`에 `{"id", "package", "reason", "expires"}`로 적는다. `id`는 검사 결과의 `id`(CVE-… 또는 GHSA-…), `package`는 패키지 이름이다. `reason`과 `expires`(YYYY-MM-DD, 그날까지 적용)가 없으면 npm 검사가 `error`가 된다. 만료되면 다시 막는다. 예외는 PR 리뷰를 거친다.

```bash
bun .github/scripts/npm-audit.ts /tmp/sc && cat /tmp/sc/npm.txt   # npm 판정을 로컬에서
.github/scripts/supply-chain-verdict.sh /tmp/sc warn              # 결과 파일 넷(control-host·worker·egress-proxy·npm)의 판정
```

| 이미지 | 내용 | 실행 주체 |
|---|---|---|
| `agent-platform-control-host` | `apps/control-host` 실행물 하나로 api·scheduler·reconciler role을 모두 돌린다. `--filter`로 그 앱의 closure만 설치하며 Agent SDK·Claude Code executable을 담지 않는다(빌드가 `node_modules/@anthropic-ai` 부재를 확인). 기본 uid 1000, scheduler role만 compose `user: "0:0"`로 root가 되어 Docker socket을 쥔다 | `bun run apps/control-host/src/main.ts <role>` (CMD 기본은 `api`) |
| `agent-platform-worker` | SDK 0.3.270과 번들 Claude Code 2.1.270, git, non-root(uid 1000), `/workspace`를 1000 소유로 미리 생성(LocalDockerBackend의 volume 계약). 빌드 시 `resolvePinnedClaudeExecutable()`로 executable 경로를 확정해 `/usr/local/bin/claude`로 걸고 `claude --version`을 실행한다 | `bun run apps/worker/src/main.ts` — scheduler가 env로 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프를 돈다 |
| (scheduler role) | Docker socket을 mount하는 유일한 서비스이며 root로 실행한다(socket 소유자는 어차피 daemon host의 root와 같고, socket gid는 daemon마다 달라 고정 uid가 이식성을 깎기만 한다) | compose에서는 감독 루프(`main.ts scheduler`)가 `SCHEDULER_INTERVAL_SEC`(기본 5초)마다 `--once` pass를 자식 프로세스로 실행한다. 실패 pass가 `SCHEDULER_MAX_CONSECUTIVE_FAILURES`(3)번 이어지면(degraded exit 76은 세지 않는다) 루프가 exit 1 해 `restart: unless-stopped`가 재시작하고(`compose ps`에 드러남), `SCHEDULER_HEALTH_STALE_SEC`(200초) 동안 완료 pass(성공 또는 degraded)가 없으면 healthcheck(`main.ts scheduler --health`)가 unhealthy가 된다. DB가 멈추면 pass가 스스로 exit 1로 끝난다: scheduler·reconciler pool은 API와 같은 timeout(connect 5초·statement 10초·read 20초, `packages/db/src/pool.ts`의 `JOB_POOL_TIMEOUTS`)을 쓰고, 연결을 한 번 잃은 뒤의 store 호출은 기다리지 않고 바로 실패하므로 DB 대기는 실패한 statement(5+20초)와 pass lock 해제(20초)를 합친 약 45초가 상한이다(실측: pass 전 정지 5초, pass 중 정지 약 40초). `SCHEDULER_PASS_TIMEOUT_SEC`(180초)는 이 45초와 worker 정지 한 번(stop timeout 120초 + request timeout 30초)보다 크게 두는 바깥 watchdog이며, 그 밖의 hang을 kill해 실패로 센다(unhealthy만으로는 Docker가 재시작하지 않는다). pool timeout을 늘리면 이 값도 `connect + 2 × read`보다 크게 올린다 |
| `agent-platform-egress-proxy` | `apps/egress-proxy`의 소스만(의존성 없음, 한 stage). 코드는 root 소유로 두고 uid 1000으로 실행해 proxy가 다음 기동의 코드를 고치지 못한다(94S-323) | `bun run src/main.ts` — compose `egress-proxy`, 모든 worker 네트워크에 붙는 유일한 바깥 경로 |

```bash
docker compose -f infra/docker-compose.yml --profile worker build          # WORKER_IMAGE(agent-platform-worker:dev)
docker compose -f infra/docker-compose.yml --profile worker run --rm worker claude --version
docker compose -f infra/docker-compose.yml --profile apps up -d --build      # migrate → api(/readyz) → worker 이미지 smoke → scheduler 루프, reconciler 루프
curl -s http://127.0.0.1:3000/readyz
```

`apps` profile의 값은 전부 기본값이 있어 환경 파일 없이 뜬다. `DATABASE_URL`만은 예외로 항상 compose의 postgres를 가리킨다 — `up`이 migrate를 실행하므로 셸이나 환경 파일에 있는 다른 DSN이 로컬 스택 기동만으로 migrate되면 안 된다. `AUTH_MODE` 기본값은 `api-key`다 — 워커가 proxy 경유로 `api:3000`에 닿으므로 `none`이면 워커 안의 코드가 `X-Owner-Id`로 아무 owner 행세를 할 수 있다(`/internal` 워커 라우트는 자체 인증). 키는 `bun run keys create <owner> --scopes …`(compose `api` 컨테이너 안에서 key CLI를 실행)로 발급한다. 발급한 key의 id는 stderr에 `key_id <uuid>`로 나온다(stdout은 평문 key 한 줄 그대로다). 폐기는 `bun run keys revoke <key_id>`다. 폐기된 key는 다음 요청부터 401을 받고, 열려 있던 SSE는 keepalive 주기 안에 끊긴다. 같은 owner가 진행 중인 작업은 취소하지 않는다. 세션의 실행 권한을 거두는 것은 별도 운영 명령 `bun run grants revoke <session_id> --reason <text>`다(94S-321). 이 명령은 한 transaction 안에서 auth_revision과 epoch를 올리고, worker token을 폐기하고, kill intent를 남기고, dispatch를 차단한다. owner의 resume과 start_fresh도 거부된다(403). 차단은 `bun run grants restore <session_id> --reason <text>`로만 풀리며, 풀 수 있는 시점은 이전 execution이 사라진 것이 확인된 뒤다. API 포트는 `127.0.0.1:3000`에만 바인드한다. `EXECUTION_WORKSPACE_QUOTA`는 compose에서 기본 `off`다 — Docker Desktop은 project quota를 감당하지 못하므로(94S-215) 로컬 스택은 무제한 workspace를 감수하고 scheduler pass마다 경고 1건이 남는다; xfs+prjquota daemon이면 `on`으로 되돌린다. 나머지 값은 `.env` 없이 뜬다. `.env`가 있으면 읽되(`required: false`) 만들거나 덮어쓰지 않는다. 카탈로그는 저장소 `config/`를 `/app/config`로 mount해 읽는다 — 이미지에는 카탈로그가 없어 mount 없이 띄운 API는 기동하지 않는다. `secrets`(API 전용 Secrets Manager, 호스트 `127.0.0.1:4567`)와 `fake-messages`가 함께 뜬다. worker 컨테이너는 compose 서비스가 아니라 scheduler가 세션마다 띄운다. compose의 `worker` 항목은 그 이미지를 빌드하고 `claude --version`으로 한 번 확인한 뒤 끝나는 one-shot이다(`network_mode: none`). scheduler가 이것의 성공을 기다리므로 `apps` profile의 `up`이 worker 이미지까지 빌드한다. 워커는 forward proxy로 `api:3000`(`EGRESS_PRIVATE_ALLOWLIST` 기본값)에만 닿고, `gitea:3000`·`fake-messages:4010`·`localstack:4566`에는 credential route로만 닿는다(`secrets`에는 닿지 않는다). 직접 연결과 metadata 주소는 internal 네트워크가 막는다.

같은 daemon에 두 설치를 올리면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. compose의 `egress-proxy` label은 이 값을 따르므로 설치마다 자기 proxy가 붙는다. 다른 worktree의 compose project가 기본 포트를 잡고 있으면 `-p <name>`과 `ports: !override` override 파일로 분리한다.

`.github/workflows/images.yml`은 PR·main push마다 세 이미지를 빌드하고 worker에서 `claude --version`이 2.1.270인지, api·scheduler에 `@anthropic-ai`가 없는지 확인한 뒤 digest JSON을 `image-digest-<app>` artifact로 남긴다. `v*` tag의 **push 이벤트**에서만(`workflow_dispatch`는 어떤 ref든 지정할 수 있어 이벤트도 본다) `publish`·`promote` job이 `ghcr.io/<owner>/agent-platform-<app>`으로 게시한다. 두 job만 package write 권한을 가지며 `release` environment에서 돌고, tag가 가리키는 commit이 `main`의 조상이 아니면 실패한다(tag는 리뷰가 아니다). `publish`는 이미지마다 run 전용 staging tag로 push한 뒤 그 digest를 pull해 같은 smoke(`.github/scripts/image-smoke.sh`)를 통과시키고, `promote`가 세 digest가 모두 통과한 뒤에야 `vX`·`sha-…` tag로 retag한다(registry-side, 재빌드 없음). 이 run의 staged digest가 release candidate다. 기존 tag가 다른 digest를 가리키면 아무 tag도 쓰기 전에 실패하고(한 버전이 두 build attempt의 이미지로 섞이지 않는다), 조회 자체가 실패하면(인증·rate limit·5xx) "없음"으로 보지 않고 중단한다(fail-closed). tag를 쓴 뒤 여섯 reference(세 이미지 × 두 tag)를 다시 읽어 candidate와 같을 때만 `image-digests-published` artifact를 만든다. retag는 저장소별로 순서대로 일어나므로 중간에 실패하면 세트가 반만 tag된 채 남는다 — 그때는 **같은 run의 "Re-run failed jobs"**로 채운다(publish job은 다시 돌지 않아 staged artifact와 digest가 그대로다). tag를 다시 push하면 새 build(worker의 apt layer는 pin되지 않는다)라 거부된다. 세 digest를 한 번에 커밋하는 소비자용 release manifest는 D5이며, 그 전까지는 초록 run의 `image-digests-published` artifact가 세트의 기록이다. `release` environment의 required reviewer·deployment branch 규칙은 저장소 설정에서 건다. registry CD는 D5다.

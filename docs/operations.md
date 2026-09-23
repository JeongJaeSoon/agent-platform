# 운영 참고 — 로컬 Docker 설치의 실행 기반

로컬 스택을 처음 띄우는 절차는 [quickstart](quickstart.md)에 있다. 이 문서는 그 스택의 각 구성요소가 무엇을 보장하고 어디서 멈추는지, 설정값과 운영자가 직접 하는 일을 적는다. 백업·복원은 [backup-restore.md](backup-restore.md), CI는 [ci.md](ci.md)에 있다.

## reconciler·scheduler와 worker 격리

reconciler는 스케줄러를 내장하지 않고 한 batch만 처리한 뒤 종료한다. lease 기한은 스스로 해석하지 않는다 — API가 heartbeat를 받을 때 `workers.lease_expires_at`에 마감 시각을 적고 reconciler는 그 시각과 DB 시계를 비교한다. `HEARTBEAT_TTL_SEC`는 API만 읽으며(기본 30, 양수가 아니면 기동 거부), reconciler는 이 값이 설정돼 있으면 기동하지 않는다(94S-132). 실제 변경 전에 대상만 확인하려면 dry-run을 명시한다. 미처리 row 또는 `queued` turn만 자동 재전달하며, 실행 중이거나 상태를 증명할 수 없는 row는 session을 `failed`로 전환하고 명시적 복구 대상으로 남긴다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
RECONCILER_DRY_RUN=true \
  bun run --cwd apps/reconciler start

DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
RECONCILER_DRY_RUN=false \
  bun run --cwd apps/reconciler start
```

scheduler도 one-shot이다. 한 pass는 ① 살아 있는 `executions` row를 Docker와 대조(컨테이너가 없으면 같은 intent로 재생성, exit했으면 `terminated` 기록 후 제거) ② launch intent 없는 관리 컨테이너를 로그 후 정지하고, 컨테이너가 사라진 worker 네트워크를 지우거나 proxy가 떨어진 네트워크에 다시 붙임(94S-216) ③ `EXECUTION_SLOT_LIMIT` 안에서 unassigned session마다 intent 커밋 → 컨테이너 생성 ④ 끝난 session의 workspace volume 회수 순서로 진행한다. worker 컨테이너는 Docker socket·host HOME을 받지 않고 env는 bootstrap claim에 필요한 `WORKER_EXECUTION_ID`·`WORKER_EXECUTION_GENERATION`·`WORKER_BOOTSTRAP_NONCE`·`WORKER_GATEWAY_URL`, tmpfs를 가리키는 `HOME`, egress proxy를 가리키는 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`(대소문자 두 표기), 그리고 object store 접근(94S-244) — 제어 호스트와 같은 이름의 `S3_BUCKET`·`AWS_REGION`·`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`·`AWS_ENDPOINT_URL`(없으면 AWS 자체. http·https 모두 되며 https는 아래 egress 절의 전용 transport를 탄다)과 세션 prefix `WORKER_OBJECT_PREFIX`(`sessions/<sessionId>/`) — 를 받는다. scheduler는 이 값들이 없으면 기동하지 않는다. 자격 증명은 bucket 전체에 미치고 워커는 `scopedCheckpointObjectStore`(`packages/storage`)로 스스로 prefix 밖 key를 거절한다. 이것은 클라이언트 쪽 가드이지 자격 증명 경계가 아니다 — 세션·generation 범위 STS 자격 증명은 identity provider가 있는 배치(EKS/MVM)로 미룬다. 워커 안에서 `@agent-platform/storage`를 import하는 파일은 `apps/worker/src/object-store.ts` 하나뿐이며 `tests/architecture.test.ts`가 이를 강제한다. Docker daemon 응답이 create 요청 본문을 되돌려 주는 경우에 대비해 backend는 오류 메시지에서 nonce와 secret key를 지운다. `/tmp`·HOME tmpfs는 worker uid/gid 소유로 마운트된다. `/workspace` named volume은 Docker가 이미지의 같은 경로에서 초기화하므로 worker 이미지가 `/workspace`를 worker uid 소유로 미리 만들어 두어야 한다(이미지 계약). worker 이미지(`apps/worker/Dockerfile`)는 `WORKER_IMAGE`로 받는다. pass 전체는 Postgres session advisory lock(`scheduler:pass`)으로 직렬화되어 겹친 실행은 로그만 남기고 건너뛴다. 같은 Docker daemon을 여러 설치가 공유하면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. scheduler는 이 값이 없으면 기동하지 않는다(adapter만 테스트용 기본값 `local`을 가짐). 같은 값을 쓰는 두 설치가 daemon을 공유하면 서로의 컨테이너를 orphan으로 회수한다.

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
  bun run --cwd apps/scheduler start
```

worker 컨테이너는 scheduler가 execution마다 만드는 **전용 네트워크** `ap-net-<installationId>-<executionId>-g<generation>` 하나에만 붙는다(94S-216). 이 네트워크는 bridge driver, `internal: true`, `EnableIPv6: false`, `com.docker.network.bridge.gateway_mode_ipv4=isolated`로 만들어진다. Docker가 이 네트워크에서 바깥으로 나가는 경로를 만들지 않고 host 쪽 bridge 주소(IPAM gateway)도 두지 않는다. 그래서 worker는 host·host에서 도는 프로세스·LAN·instance metadata(`169.254.169.254`)·다른 compose 서비스·다른 worker에 직접 닿지 못한다. 이 네트워크의 구성원은 worker 자신과 egress proxy 둘뿐이다. scheduler는 `agent-platform.egress-proxy=<installationId>` label이 붙은 **실행 중인 컨테이너 정확히 하나**를 그 설치의 proxy로 보고, 네트워크마다 `EXECUTION_EGRESS_PROXY_URL`의 host 이름을 alias로 붙여 connect한다. worker는 `HTTP_PROXY`/`HTTPS_PROXY`로 그 이름을 가리킨다. proxy 주소가 네트워크마다 다르므로 `EXECUTION_EGRESS_PROXY_URL`의 host는 이름이어야 하고, IP literal과 `localhost`는 거부한다. compose의 `egress-proxy` 서비스는 이 label을 달고 있다. `host.docker.internal:host-gateway` 매핑은 worker에서 제거했다 — gateway도 proxy를 거친다.

차단 정책은 proxy의 두 목록으로 버전 관리한다. `EGRESS_ALLOWLIST`는 공인 목적지(`host:port`)이고 해석된 주소가 전부 public unicast여야 통과한다. `EGRESS_PRIVATE_ALLOWLIST`는 사설 대역에 있다고 알고 허용하는 목적지(gateway, gitea, 그리고 워커의 object store인 localstack)다. compose의 localstack은 이 때문에 S3만 켠다 — 허용된 port 위의 서비스는 전부 워커가 부를 수 있는 서비스다. 두 목록 모두 link-local(`169.254.0.0/16`·`fe80::/10`)·multicast·reserved로 해석되면 거부하므로 allowlist에 오른 이름이 metadata 주소로 해석되는 rebinding도 막힌다. 목록에 없는 host·port는 CONNECT·absolute-form 모두 `403`이고, absolute-form이 아닌 요청은 `/healthz` 외에는 `400`이다.

CONNECT 터널은 TLS만 나른다(94S-219). proxy는 `200 Connection Established`를 쓴 뒤 클라이언트의 첫 바이트를 upstream에 흘리기 전에 TLS ClientHello로 읽어, DNS 이름 authority면 `server_name`이 그 authority와(대소문자만 무시하고) 같아야 하고, allowlist에 명시된 IP literal authority면 `server_name`이 없어야 한다. `encrypted_client_hello`(0xfe0d)는 GREASE 여부와 관계없이 거부한다 — proxy는 둘을 구별할 수 없고, 진짜 ECH는 검사 대상인 이름을 숨긴다. handshake가 아닌 첫 레코드, host_name이 둘인 hello, 최초 16KiB(record header 포함) 또는 15초(`handshakeTimeoutMs`) 안에 완성되지 않는 hello는 전부 연결을 끊는다. 거부는 200 뒤에 일어나므로 클라이언트에는 handshake 도중 연결 종료로 보인다.

이 관문의 한계:

* 검사 대상은 평문으로 보이는 **바깥** ClientHello의 SNI다. TLS를 종단하지 않으므로 그 안의 HTTP `Host`·경로·본문, 허용된 서비스가 다시 중계하는 곳은 보지 못한다. domain fronting을 CDN 쪽에서 막는 것은 별개의 통제다.
* IP literal allowlist는 `IP:port` 접근 권한이지 hostname 보장이 아니다. 공유 CDN edge 주소를 IP로 allowlist에 올리지 않는다.
* **Bun 1.3의 `fetch`·`node:https`는 GREASE ECH를 보내므로 이 proxy로 CONNECT하면 거부된다**(Bun `node:tls`·`Bun.connect({tls})`, Node, curl, 그리고 worker의 SDK가 spawn하는 Claude Code 바이너리는 보내지 않는다 — 2026-09-23 실측). 그래서 worker의 object store는 https 요청(https endpoint, 그리고 endpoint가 없는 AWS)에 Bun의 HTTP 클라이언트를 쓰지 않는다. `packages/storage`의 `TlsTunnelHttpHandler`가 `HTTPS_PROXY`로 CONNECT 터널을 열고 `node:tls`로 TLS를 직접 맺은 뒤 HTTP/1.1을 말한다(94S-254). http endpoint(compose의 localstack)는 예전처럼 Bun `node:http`가 `HTTP_PROXY`로 absolute-form을 보낸다. 이 transport는 요청마다 연결 하나(`connection: close`, pooling 없음)이고 바이트 본문만 보낸다. IP 주소로 된 https endpoint는 워커·scheduler가 시작 단계에서 거부한다 — Bun `node:tls`는 IP host에 SNI `localhost`를 보내고 그 이름으로 인증서를 검증하기 때문이다. endpoint를 비우면(AWS) SDK가 virtual-hosted 이름으로 부르므로 proxy의 `EGRESS_ALLOWLIST`에 `<bucket>.s3.<region>.amazonaws.com:443`이 있어야 하고, 사설 CA를 쓰는 https S3-compatible 저장소라면 worker 이미지에 `NODE_EXTRA_CA_CERTS`로 CA를 넣는다. object store 밖에서 worker의 Bun HTTP 클라이언트로 https upstream을 부르는 코드는 여전히 지원하지 않는다. 런타임·클라이언트 버전을 올리면 다시 측정한다.

**worker끼리는 서로 닿지 않는다(94S-216).** 다른 worker와 같은 네트워크에 있지 않으므로 그 주소로 가는 경로가 없고, 컨테이너 이름도 풀리지 않는다. proxy를 거쳐 가려 해도 사설 주소는 `EGRESS_PRIVATE_ALLOWLIST`에 없으면 거부된다. 다른 설치의 worker와 proxy에도 닿지 않는다 — 네트워크와 proxy 선택이 모두 설치별이다. 통합 테스트(`egress.integration.test.ts`의 "workers do not reach one another")가 이를 확인한다. 같은 네트워크의 형제 컨테이너라면 열린 포트에 닿는다는 양성 대조와 함께 확인한다. 남은 한계:

* proxy는 모든 worker 네트워크에 붙는 신뢰 구성요소다. proxy가 침해되면 그 설치의 모든 worker에 닿는다. `EGRESS_PRIVATE_ALLOWLIST`에는 worker로 해석될 수 있는 이름을 넣지 않는다.
* ~~internal bridge도 host 쪽 bridge 인터페이스에 주소를 가진다~~ — 94S-274에서 닫았다. 기본 gateway mode(`nat`)의 internal bridge는 host에 subnet의 첫 주소를 준다. 그래서 daemon host가 그 주소나 wildcard로 listen하는 **host 프로세스**(publish된 포트가 아니라 host에서 직접 띄운 프로세스)에 worker가 proxy 없이 닿았다. 이제 worker 네트워크는 `gateway_mode_ipv4=isolated`로 만들어져 host가 그 네트워크에 주소를 갖지 않는다. 이 모드는 **Docker 28(API 1.48) 이상**에만 있다. scheduler는 기동 preflight(`verifyNetworkIsolation`)에서 daemon의 API 버전이 1.48 미만이면 경고로 넘기지 않고 거부한다(`GatewayModeUnsupportedError`). 끄는 설정은 없다. 통합 테스트(`egress.integration.test.ts`의 "a host process on a wildcard address")는 두 가지를 함께 확인한다. 모드가 없는 internal 네트워크에서는 host listener에 닿는다(양성 대조). worker 네트워크에서는 닿지 않는다. native Linux(CI)에서는 테스트 프로세스 자신이 `0.0.0.0` listener다. Docker Desktop은 daemon이 VM 안에 있으므로 VM의 network namespace를 쓰는 `--network host` 컨테이너가 listener를 대신한다. IPv6는 worker 네트워크에서 꺼져 있어 해당하지 않는다.

scheduler는 pass 전에 그 설치의 proxy가 정확히 하나 떠 있는지 확인한다(`verifyNetworkIsolation`). 없거나 둘 이상이면 pass lock을 잡고 worker 네트워크 reconcile만 돌린다(orphan 회수, 둘 이상이면 proxy 분리). 그다음 아무것도 띄우지 않은 채 non-zero로 종료한다. worker 네트워크는 launch 때마다 검사한다. 이미 같은 이름의 네트워크가 있으면 새로 만들지 않고 다음을 확인한다. 하나라도 어긋나면 `NetworkIsolationError`로 launch를 거부한다(fail closed).

* bridge·internal·IPv6 꺼짐·소유 label(설치·execution·generation)이 맞는가
* host가 네트워크에 주소를 갖지 않는가 — `Options`의 `gateway_mode_ipv4`가 `isolated`이고 IPAM에 gateway가 없어야 한다. 모르는 옵션을 기록만 하고 gateway를 주는 옛 daemon이 있어서 두 조건을 모두 본다
* worker와 proxy 외의 구성원이 없는가

proxy attach 결과는 응답 코드가 아니라 proxy 컨테이너가 보고하는 attach·alias로 판정한다. 이미 붙어 있으면 403이 오고, alias 없이 붙어 있으면 DNS가 풀리지 않기 때문이다. 이미 있는 컨테이너를 adopt할 때는 그 컨테이너가 자기 네트워크(같은 id) **하나에만** 붙어 있어야 한다. 컨테이너는 네트워크 이름이 아니라 id로 만든다. 그래서 같은 이름으로 다시 만들어진 네트워크가 검사받은 네트워크를 대신할 수 없다.

예전 설정 `EXECUTION_DOCKER_NETWORK`·`EXECUTION_DOCKER_NETWORK_ALLOWLIST`는 더 이상 읽지 않는다. 값이 남아 있으면 조용히 무시하지 않고 기동을 거부한다. 환경 파일에서 지우고 proxy 컨테이너에 label을 단다.

컨테이너에는 만들어질 때의 격리 계약이 `agent-platform.isolation` label로 `<버전>:<지문>` 형태로 찍힌다. 지문은 proxy URL·user·workspace/HOME 경로·tmpfs 크기, 그리고 object store의 bucket·endpoint·region·access key id의 해시라서, 코드를 바꾸지 않고 `EXECUTION_EGRESS_PROXY_URL`이나 `S3_BUCKET`만 바꿔도 값이 달라진다. secret access key는 지문에 넣지 않는다 — 같은 key id로 secret만 바꾼 경우 실행 중인 컨테이너는 그대로이고, 교체는 운영자가 직접 한다. 실행 중인 컨테이너의 격리는 제어 호스트를 올려도 바뀌지 않으므로, scheduler는 label이 현재 값과 다른 컨테이너를 `stale`로 보고 정지·제거한 뒤 저장된 intent로 다시 만든다(`ensureExecution`도 그런 컨테이너는 adopt하지 않는다). 버전이 **더 높은** 컨테이너는 롤백 중인 새 제어 호스트가 만든 것이다. 그 경계가 지금 요구하는 것과 같은지 알 수 없으므로 adopt도 교체도 하지 않고 `IsolationContractError`로 거절한다 — row는 살아 있고 pass는 non-zero로 끝나므로 운영자가 롤포워드하거나 직접 제거해야 한다. 격리의 모양 자체가 바뀌면 `ISOLATION_CONTRACT`를 올린다. 94S-216이 계약을 5로 올렸다(execution별 네트워크). 그래서 업그레이드하면 공유 네트워크 위의 기존 컨테이너가 전부 stale로 교체된다. 교체 전 확인(`assertReplaceable`: 이미지·workspace·proxy·새 네트워크)이 실패하면, 보통은 옛 컨테이너를 그대로 두고 다음 pass에서 다시 시도한다. 하지만 계약 5 미만 컨테이너는 공유 네트워크에서 이웃 worker에 닿을 수 있다. 그래서 아직 claim되지 않은 그 컨테이너는 **모든 네트워크에서 떼어 낸** 채로 둔다. claim 전이라 진행 중인 turn은 없다. 확인이 통과하는 pass에서 정상 교체된다. 결과는 교체 실패 로그의 오류 메시지 끝에 붙는다. claim된 계약 5 미만 worker는 이 확인 없이 teardown되므로 여기서 건드리지 않는다. 확인과 disconnect를 한 번에 묶는 fence는 없다. 그래서 disconnect 뒤에 claim 여부를 한 번 더 확인하고, 그사이 claim됐으면 네트워크를 다시 붙여 scheduler의 teardown(SIGTERM으로 drain)에 맡긴다. disconnect가 이어지는 그 짧은 동안 claim 요청이 오가던 worker는 요청이 끊길 수 있다.

94S-274가 계약을 6으로 올렸다(host 주소 없는 네트워크). 계약 5 컨테이너의 네트워크는 이름이 같지만 gateway mode는 제자리에서 바꿀 수 없으므로 교체는 다음 순서를 탄다.

* **교체 전 확인(`assertReplaceable`):** 같은 launch의 계약 5 worker가 그 네트워크에 실제로 붙어 있고 결함이 host 주소 하나뿐이면 옛 네트워크를 통과시킨다. 이어지는 teardown이 컨테이너와 함께 네트워크를 지운다. 그다음 `ensureExecution`이 `isolated`로 새로 만든다.
* **일반 launch 경로:** worker 없이 남은 옛 네트워크(teardown의 네트워크 제거가 실패한 경우)는 proxy만 붙어 있으면 지우고 다시 만든다. 다른 구성원이 있으면 거부한다. 옛 worker가 아직 붙어 있는 옛 네트워크에 새 컨테이너를 올리는 일은 없다.
* **`reconcileNetworks`:** 계약 5 worker가 붙은 옛 네트워크에서는 proxy를 떼지 않는다. claim된 worker는 확인 없이 drain·teardown되므로 그 전에 egress를 끊지 않기 위해서다. 계약 6 worker가 host 주소 있는 네트워크에 있으면 결함으로 보고 proxy를 뗀다.

이 교체도 claim된 worker는 drain 후 닫는 기존 규칙(94S-250에서 다룰 drain·교체 동작 포함)을 따른다. **배포 순서:** daemon을 먼저 Docker 28 이상으로 올린다. 옛 daemon에서는 preflight가 pass 전체를 막는다. 그러면 계약 5 worker도 교체되지 않고 그대로 돈다(새 admission만 fail-closed).

업그레이드 뒤 옛 공유 네트워크(`agent-platform-worker`, `EXECUTION_DOCKER_NETWORK`로 이름을 바꿨다면 그 이름)는 compose가 더 이상 선언하지 않는다. 그래도 저절로 지워지지는 않고, 주소 풀의 subnet 하나를 계속 차지한다. 계약 4 컨테이너가 모두 교체된 뒤 `docker network rm agent-platform-worker`로 지운다. 실행 중인 컨테이너가 붙어 있으면 Docker가 삭제를 거부한다(403). 그래서 쓰는 중인 네트워크를 실수로 지울 일은 없다. **이미 claim된 worker는 교체되지 않고 teardown된다.** 진행 중이던 turn은 `outcome_unknown`으로 닫힌다. 업그레이드는 진행 중인 turn이 없을 때 한다. 계약이 바뀔 때 claim된 worker를 drain하는 경로는 94S-250이다.

## worker workspace의 상한과 회수

세션마다 `ap-ws-<installationId>-<sessionId>-<접미사>` volume 하나가 `/workspace`에 붙는다. 이 volume은 세대(generation)를 넘어 살아남는다 — 컨테이너를 교체해도 세션의 작업 트리는 그대로여야 하기 때문이다. 그래서 **컨테이너를 지우는 `terminate`는 volume을 건드리지 않고**, 회수는 pass의 ④단계가 따로 한다.

volume은 이제 backend가 `POST /volumes/create`로 **명시적으로** 만든다. mount spec에 이름만 적으면 Docker가 label도 상한도 없는 volume을 알아서 만들어 버리기 때문이다. 만들 때 `agent-platform.managed`·`.installation`·`.session-id`·`.workspace-quota` label을 찍고, GC는 이름을 파싱하지 않고 이 label만 본다.

**volume 이름은 1회용이다.** `local` 드라이버는 이미 quota를 걸었던 이름을 다시 만들면 `Options.size`는 그대로 돌려주면서 실제 project quota는 걸지 않는다. xfs+prjquota(Docker 27.5.1)에서 측정한 결과 — 처음 만든 이름은 컨테이너 안 `df` 총량이 설정값(64MiB)이지만, 같은 이름을 지웠다 다시 만들면 `Options.size`가 같은데도 `df`는 파일시스템 전체(8GiB)를 보고한다. Engine API로는 둘을 구분할 수 없으므로, 세션의 workspace는 이름으로 유도하지 않고 무작위 접미사를 붙여 만든 뒤 **label로 조회한다.** GC나 운영자가 volume을 지워도 다음 것은 새 이름을 받으므로 상한이 다시 선다. 한 세션에 workspace가 둘 보이면 어느 쪽이 작업 트리인지 판단하지 않고 보고만 한다. preflight probe도 같은 이유로 매번 새 이름을 쓰고, 이전 실행이 남긴 probe는 label로 회수한다.

CPU·메모리·PID·tmpfs와 달리 `/workspace`에는 상한이 없었다. `EXECUTION_WORKSPACE_QUOTA_MB`(기본 4096)가 `local` 드라이버의 `size` driver option으로 그 상한이 된다. 단 이 옵션은 **daemon의 저장소가 project quota를 감당할 때만**(xfs + `prjquota`) 동작하고, 그렇지 않으면 daemon이 create를 `400 quota size requested but no quota support`로 거절한다. scheduler는 pass 전에 probe volume을 하나 만들어 보는 것으로 이 능력을 확인하고(`verifyWorkspaceQuota`), 감당하지 못하는 daemon에서는 **아무것도 띄우지 않고 종료한다.** 조용히 무제한으로 떨어지는 경로는 없고, 무제한을 감수하려면 `EXECUTION_WORKSPACE_QUOTA=off`를 명시해야 한다 — 그 경우 기동 로그에 경고 1건이 남는다. `on`·`off` 외의 값(`false`, `0`, `no`)은 오타로 보고 거절한다.

Docker Desktop은 커널 자체가 XFS quota 없이 빌드돼 있어(`XFS (loopN): quota support not available in this kernel`) 로컬에서는 `off`가 사실상 유일한 선택지다. GitHub Actions 러너의 daemon도 data root가 ext4라 마찬가지다. 그래서 실제 상한이 무는지는 CI의 `workspace-quota` job이 xfs + prjquota loop 파일을 data root로 쓰는 daemon을 따로 띄워 확인한다.

상한은 volume 하나에만 거는 것으로는 부족하다. Docker는 이미지가 선언한 `VOLUME` 경로마다 **쓰기 가능한 익명 volume**을 자동으로 붙이는데, 거기에는 상한도 label도 없다. 그래서 launch 전에 이미지를 조회해 `/workspace` 외의 `VOLUME` 선언이 있으면 거절하고(`ImageVolumeError`), 컨테이너를 지울 때는 `v=true`로 익명 volume을 함께 지운다(named volume인 workspace는 영향을 받지 않는다). 아직 pull되지 않은 이미지는 조회가 404이므로 그대로 두고 create가 같은 404를 내게 한다.

확인한 것과 실제로 띄우는 것 사이도 벌어질 수 있다. 태그는 가변이므로 컨테이너는 **조회한 이미지의 id**(`sha256:…`)로 만들고, volume은 create 직후 start 전에 한 번 더 확인한다 — 그 사이에 `docker volume prune`이 지나가면 Docker가 mount용으로 label도 상한도 없는 volume을 새로 만들어 주기 때문이다. 어긋나면 아직 아무것도 실행되지 않은 컨테이너를 지우고 실패시킨다.

quota preflight가 실패하면 **아무것도 띄우지 않되 회수는 한 번 돌린다.** probe도 디스크를 조금 쓰므로 이미 가득 찬 daemon은 preflight부터 실패하는데, 그 순간이 바로 끝난 세션의 workspace를 회수해야 할 때다. 그대로 종료하면 회수할 방법이 영영 없어진다. 이때 도는 것은 pass가 아니라 `reclaimWorkspaces` — 같은 advisory lock 아래에서 ④단계만 수행한다. slot limit 0짜리 pass로는 부족하다. 새 예약만 막힐 뿐 사라진 컨테이너를 재생성하고 stale 컨테이너를 교체하는 일은 그대로 하기 때문이다. 회수가 끝나면 원래 오류를 다시 던져 non-zero로 끝낸다.

상한은 **byte에만** 걸린다. Docker `local` 드라이버가 노출하는 것이 `size`뿐이고 daemon의 quota 구조체에 inode 필드가 없어서, Engine API로는 inode 상한을 표현할 방법이 없다. 작은 파일 수백만 개로 inode를 소진하는 경로는 아직 열려 있다(94S-224).

volume의 quota label이 지금 설정과 다르면 — 예전에 암묵 생성된 label 없는 volume이거나, 다른 상한으로 만들어진 volume이면 — 기동을 거절한다(`WorkspaceQuotaError`). 이름을 유도하던 시절의 `ap-ws-<installationId>-<sessionId>` volume도 계속 찾아본다. label이 없어 조회에는 걸리지 않지만, 못 본 척하고 새 workspace를 만들면 그 세션이 빈 트리로 시작하고 예전 트리는 묻히기 때문이다. volume의 quota는 나중에 바꿀 수 없고, 바꾸겠다고 지우면 그 세션의 작업 트리가 날아가기 때문이다. 작업 트리를 살린 채 새 계약으로 옮기려면 아래 [legacy workspace 마이그레이션](#legacy-workspace-마이그레이션) 절차를 쓴다. 이전 설정으로 되돌리는 것도 방법이다. 같은 이유로 quota 설정은 `agent-platform.isolation` 지문에도 들어간다 — 그러지 않으면 이미 떠 있는 컨테이너가 예전 상한을 그대로 들고 계속 산다.

이 거절은 **이미 돌고 있는 worker를 죽이기 전에** 일어나야 한다. 지문이 바뀌면 stale 판정 → `terminate` → 재생성 순서인데, 재생성이 volume에서 거절당하면 그 세션은 worker도 없고 되돌아갈 길도 없는 상태로 남는다. 그래서 `inspect`는 stale을 보고하기 전에 그 세션의 volume을 읽기 전용으로 확인하고, 쓸 수 없는 volume이면 stale 대신 예외를 던진다 — 컨테이너는 예전 상한 그대로 계속 돌고, pass는 `reconcileFailed`로 non-zero를 내며, 운영자가 volume을 옮길 때까지 그 상태가 유지된다. 옮기는 방법은 아래 [legacy workspace 마이그레이션](#legacy-workspace-마이그레이션)에 있다.

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
bun run --cwd apps/scheduler migrate-workspace <session-id> [<session-id>...]
# compose(apps profile)라면
docker compose -f infra/docker-compose.yml --profile apps run --rm scheduler \
  bun run apps/scheduler/src/migrate-workspace.ts <session-id>
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

실제 Docker daemon 대상 테스트는 `DOCKER_BACKEND_TEST=1`로 opt-in한다(`busybox:1.36`을 sleep으로 띄움). egress suite는 backend가 띄운 worker 셋(설치 둘)으로 worker 사이 차단과 proxy 재부착·orphan 네트워크 회수를 보고, internal 네트워크·바깥 네트워크·upstream 두 개·host `openssl`로 만든 인증서를 쓰는 TLS upstream·그 인증서로 LocalStack 앞에 세운 TLS front(https S3 endpoint)·`oven/bun:1.3.10`으로 띄운 proxy를 직접 만들어 컨테이너 안에서 `wget`·`nc`·`curlimages/curl`로 확인하며 인터넷을 쓰지 않는다(이미지 pull 제외). scheduler의 15 세션 → 컨테이너 ≤ 10 검증은 `QUEUE_DATABASE_URL`까지 있어야 실행된다.

```bash
DOCKER_BACKEND_TEST=1 bun run --cwd packages/adapters/execution/local-docker test:docker
DOCKER_BACKEND_TEST=1 QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test apps/scheduler/src/main.integration.test.ts
```

## 의존 서비스만 띄우기와 host에서 도는 API

로컬 의존 서비스만 기동하려면 다음을 사용한다. 기본 포트 5432·4566·3001이 이미 사용 중인지 먼저 확인한다.

```bash
docker compose -f infra/docker-compose.yml up -d postgres localstack gitea egress-proxy
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml run --rm migrate
```

compose가 host에 게시하는 포트는 전부 `127.0.0.1`에만 묶이고, host 프로세스가 쓰는 것만 게시한다(94S-323): postgres `5432`, LocalStack `4566`, API 전용 Secrets Manager `4567`, Gitea 웹 UI·HTTP clone `3001`, API `3000`. Gitea SSH는 게시하지 않는다(워커는 proxy 경유 HTTP로 clone한다). 다른 머신에서 이 서비스에 붙어야 하면 compose를 고치지 말고 SSH 터널을 쓴다. 이미지는 전부 multi-arch index digest로 고정하거나(`postgres`·`localstack`·`gitea`·`gitea-init`·`fake-messages`, Bun은 app Dockerfile과 같은 digest) 저장소에서 빌드한다(`egress-proxy`·`api`·`migrate`(API Dockerfile)·`scheduler`·`worker`). egress proxy는 `apps/egress-proxy/Dockerfile`로 빌드한 이미지로 뜨고 소스를 mount하지 않으므로, proxy 코드를 고친 뒤에는 재시작이 아니라 `docker compose -f infra/docker-compose.yml up -d --build egress-proxy`로 다시 빌드해야 반영된다. 배포는 `EGRESS_PROXY_IMAGE`를 images.yml이 낸 digest(`<name>@sha256:…`)로 주고 `--build` 없이 `up -d`로 띄운다. compose는 빌드 결과에 `image:` 값을 태그로 붙이는데 digest 참조는 태그가 될 수 없어서, `--build`를 붙이면 빌드가 실패한다. `API_IMAGE`·`SCHEDULER_IMAGE`·`WORKER_IMAGE`도 마찬가지다.

기존 환경 파일이나 volume을 덮어쓰거나 삭제하지 않는다. host에서 실행하는 테스트는 컨테이너 DNS 이름이 아니라 host에 공개된 endpoint를 사용한다. PostgreSQL integration fixture는 임시 DB 생성 권한이 필요하므로 전용 로컬 테스트 DB만 지정한다. LocalStack fixture는 `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`의 로컬 테스트 설정을 요구한다. 운영 DB·운영 credential로 실행하지 않는다.

API를 로컬 인증 비활성 모드로 띄울 때만 `X-Owner-Id`를 사용할 수 있다. 이 모드는 기동 시 경고를 출력하며 기본값이 아니다.

## 운영자 카탈로그 (Agent Profile · repository)

API는 기동 시 `PLATFORM_CONFIG_DIR`(기본: 저장소의 `config/`)에서 `profiles.yaml`과 `repositories.yaml`을 한 번 읽는다(94S-132). 파일이 없거나 schema에 맞지 않거나 자격 증명 참조가 풀리지 않으면 파일·경로를 적은 메시지와 함께 기동하지 않는다. 옛 `SESSION_CATALOG_JSON`은 더 읽지 않으며 설정돼 있으면 기동을 거부한다.

- profile의 `provider.auth`에는 값 대신 참조를 하나만 적는다: API 프로세스 환경 변수 `value_env`, 또는 Secrets Manager `secret_id`(`AWS_ENDPOINT_URL_SECRETS_MANAGER`로 endpoint 지정, `AWS_ENDPOINT_URL`은 따르지 않는다). 값은 기동 시 한 번 해석되고 worker에는 nonce로 인증된 claim 응답으로만 전달된다 — worker 컨테이너 env에는 없다.
- `repositories.<id>.profiles`가 그 저장소에서 돌 수 있는 profile allowlist다. `(profile, repository)` 쌍이 신뢰 단위이며, 목록에 없는 쌍이나 모르는 id로 `POST /v1/sessions`를 부르면 `422`다.
- 이미 만든 세션의 쌍이 빠졌거나 id가 다른 URL·branch를 가리키게 되면(94S-280), 세션 상세의 `attention`이 `CATALOG_MISMATCH`가 되고 그 세션으로 뜬 worker의 첫 claim이 `409 CATALOG_MISMATCH`를 받는다. 그 자리에서 대기 중이던 turn은 `failed`(`terminal_reason: catalog_mismatch`), 해당 receipt는 `CATALOG_MISMATCH`, 세션은 `failed`가 되고 status 이벤트에 같은 코드가 남는다. worker는 claim timeout을 기다리지 않고 바로 나가며, 다음 scheduler pass가 슬롯을 돌려받아 다른 세션을 띄운다. 메시지에는 저장소 id만 적히고 URL은 나오지 않는다. `resuming` 중인 세션이면 resume이 `CATALOG_MISMATCH`로 실패해 `recovery_required`로 가고, 대기 중인 입력은 복구 결정을 위해 남는다(94S-138과 같은 경로).
- **카탈로그를 되돌려도 저절로 다시 실행되지는 않는다.** 되돌리면 `attention`이 사라지고, 그 세션에 새 메시지를 보내면 새 generation으로 다시 뜬다. 실패한 turn은 재시도되지 않으므로 필요한 입력은 다시 보낸다. 되돌리지 않은 채 메시지를 보내면 그 입력도 첫 claim에서 곧바로 같은 코드로 실패한다(추가 메시지를 422로 막지는 않는다 — 받은 입력은 receipt로 결말을 알린다).
- 이 즉시 실패는 API가 **한 프로세스**일 때를 전제로 한다. 각 API는 기동 시 읽은 자기 카탈로그로 판단하므로, 카탈로그가 다른 replica가 섞인 rolling update 동안에는 요청을 받은 replica에 따라 세션이 실패할 수 있다. API를 둘 이상 띄우기 전에 94S-295(운영자가 활성화한 catalog revision으로만 판단)가 필요하다.
- endpoint·저장소 URL은 `http://`·`https://`만 받는다(worker가 밖으로 나가는 길은 HTTP(S) egress proxy뿐이다). 자격 증명(userinfo, query string)이 들어 있으면 거절한다.
- profile마다 `sha256:` fingerprint(설정과 참조의 정규 JSON 해시, 값 제외)가 worker claim의 `profile_fingerprint`로 가고, 카탈로그 전체의 revision은 기동 로그 `Session catalog loaded`에 남는다. 같은 참조 뒤의 값만 회전하면 fingerprint는 바뀌지 않는다.

저장소의 `config/`는 외부 계정 없이 도는 로컬 예시다: compose `fake-messages`(fake Messages API)를 endpoint로, compose `secrets`(API 전용 LocalStack Secrets Manager, worker egress allowlist에 없음)에 심어 둔 placeholder 키를 `secret_id`로, compose Gitea의 `sample-app`을 저장소로 쓴다. Gitea의 `agent/sample-app`은 compose `gitea-init`(`infra/gitea/init-sample-repo.sh`)이 `apps` profile 기동 때 만든다(public, 이미 있으면 건너뜀).

```bash
docker compose -f infra/docker-compose.yml up -d secrets
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:4567 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
AUTH_MODE=none PORT=3000 CHECKPOINT_OBJECT_STORE=disabled \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/api start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

API는 checkpoint object store 설정을 기동 시 요구한다 — `S3_BUCKET`·`AWS_REGION`·`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`(+ 선택 `AWS_ENDPOINT_URL`, scheduler·worker와 같은 이름)가 없으면 기동하지 않는다. object store 없이 띄우려면 `CHECKPOINT_OBJECT_STORE=disabled`를 명시한다: 모든 checkpoint가 거절되고 워커 checkpoint 프로토콜은 409 `CHECKPOINT_UNAVAILABLE`로 답하며 기동 로그에 경고가 남는다. 빠진 bucket이 checkpoint 없는 finalize 뒤에 숨지 않도록 침묵 기본값을 두지 않았다. compose `apps` profile은 localstack 값을 기본으로 넣는다.

checkpoint 객체는 기본적으로 **version으로 고정되고 legal hold로 잠긴다**(`CHECKPOINT_OBJECT_PROTECTION=locked`, 94S-229). manifest의 모든 ref와 finalize의 `manifest_version`은 워커의 `putImmutable`이 돌려준 S3 VersionId를 싣는다. finalize는 그 version을 읽어 검증한 뒤 manifest·transcript part·bundle·untracked 파일의 각 version에 legal hold를 걸고 나서야 pointer를 올린다. pointer(`checkpoints.manifest_version`)와 restore plan도 같은 version을 들고 간다. 그래서 커밋 뒤 같은 key를 덮어쓰거나 지우거나 delete marker 뒤에 다시 올려도 복원 대상은 바뀌지 않고, hold가 걸린 version은 hold를 푸는 권한 없이는 지울 수 없다. hold 해제는 아직 없는 GC의 몫이다. 그때까지 checkpoint 객체는 영구 보존되며, GC는 진행 중인 finalize가 hold를 건 version을 풀어서는 안 된다. hold를 걸 수 있는 권한은 풀 수도 있으므로 워커에게 주면 안 된다 — 지금 compose의 워커는 bucket 전체 자격 증명을 공유하며, 이것을 좁히는 일은 94S-251이다. API는 기동 시 bucket의 versioning이 `Enabled`이고 Object Lock 설정이 있는지 확인하고, 아니면 기동하지 않는다. **versioning이 꺼진 bucket에서는 `CHECKPOINT_OBJECT_PROTECTION=unversioned`를 명시해야 한다. 이 저하된 모드는 key로만 읽고(manifest의 version은 무시하고 restore plan에서도 뺀다) hold를 걸지 않으므로, 커밋 뒤의 삭제·덮어쓰기를 막지 못하고 복원 때 digest 불일치로 발견할 뿐이다.** 기동 로그에 경고가 남는다. `unversioned`에서 `locked`로 바꾸면, `unversioned`로 커밋된 checkpoint는 첫 restore 때 version 단위로 다시 해시하고 hold를 건 뒤에 내준다. pointer에 version이 없는 checkpoint는 `CHECKPOINT_UNAVAILABLE`이 된다. compose의 localstack init은 `claude-sessions`를 Object Lock으로 만들고, 예전 volume에 남은 bucket에는 versioning과 Object Lock 설정을 켠다(그 전에 올라간 객체는 version이 없어 locked API가 거부한다).

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest와 scope만 저장한다. `--scopes`는 필수이며 `sessions:read`·`sessions:write`·`sessions:approve`·`sessions:control`·`sessions:recover` 중에서 고른다. `/v1` 요청은 route마다 OpenAPI 표(`API_ROUTE_SCOPES`)에 적힌 scope를 요구하고, 없으면 body나 세션을 읽기 전에 `403 FORBIDDEN`이다. `sessions:recover`(recovery-decisions)는 별도 scope라 `sessions:write`나 `sessions:control`에 포함되지 않는다. cookie 사용자는 role로 scope를 받는다(owner 전부, member는 recover 제외). scope 도입 전에 발급된 키(scope NULL)는 아무 scope도 없으므로 다시 발급한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/api keys create local-owner --scopes sessions:read,sessions:write
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
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

## 설치 상한 (94S-131)

API와 scheduler는 아래 여섯 값이 없거나 형식이 틀리면 문제를 한 줄에 모두 로그로 남기고 기동하지 않는다. 두 프로세스는 같은 parser(`packages/platform/src/limits/installation-limits.ts`)를 쓴다. 코드에는 기본값이 없고, compose의 `x-installation-limits` 블록이 로컬 기본값을 준다. 떠 있는 API의 `/readyz`는 같은 검증을 `config` 체크로 다시 수행한다.

| 변수 | 의미 | 넘었을 때 |
|---|---|---|
| `EXECUTION_SLOT_LIMIT` | 동시에 슬롯을 잡는 worker 수. 0이면 접수만 받고 아무것도 띄우지 않는다 | 입력은 거부하지 않고 `queued`로 둔다 |
| `QUEUED_INPUT_LIMIT_PER_SESSION` | 세션 하나가 쌓아 둘 수 있는 `queued` turn 수 | `429 RATE_LIMITED`, `retryable:true`, `Retry-After: 5` |
| `STORAGE_LIMIT_BYTES` | 설치 전체가 보존하는 입력 message의 UTF-8 bytes. event·checkpoint object·worker 디스크는 세지 않는다(디스크는 workspace quota가 맡는다) | `413 STORAGE_LIMIT_EXCEEDED`, `retryable:false` |
| `MAX_TURN_SECONDS` | turn 하나의 벽시계 상한. 승인 대기도 포함한다. worker env `WORKER_MAX_TURN_SEC`로 전달된다 | turn `failed(turn_timeout)`. 엔진이 응답하지 않으면 `outcome_unknown(turn_timeout)` |
| `SESSION_COST_LIMIT_USD` | 세션 누적 비용(SDK `total_cost_usd`에서 구한 turn별 증분의 합, 추정치) | 새 turn을 dispatch하지 않는다. 세션 상세 `attention.code=BUDGET_EXCEEDED`가 뜨고 worker는 슬롯을 반납한다. 입력은 계속 `queued`로 받는다 |
| `PROVIDER_MAX_RETRIES` | 실패한 Messages 요청을 다시 보내는 횟수. worker env `WORKER_PROVIDER_MAX_RETRIES`를 거쳐 SDK `CLAUDE_CODE_MAX_RETRIES`로 전달된다. 0이면 첫 실패에서 turn이 끝난다 | turn `failed(api_error)`. turn 상세 `result`에 `api_error_status`·`provider_error`·`last_retry_status`가 남는다 |

- 비용 상한은 turn이 끝난 뒤에 판정한다. 그래서 진행 중인 turn은 상한을 넘을 수 있다.
- 비용이 보고되지 않은 turn(`outcome_unknown` 등)은 0으로 더해진다.

## 이미지와 Compose `apps` profile

앱 이미지는 `apps/{api,worker,scheduler,egress-proxy}/Dockerfile` 넷이 정의한다. 넷 다 저장소 루트를 context로 `oven/bun:1.3.10`의 multi-arch index digest 하나를 base로 pin한다(`tests/images.test.ts`가 digest 일치를 검사). api·worker·scheduler는 `bun install --frozen-lockfile --production`으로 workspace closure만 설치한 뒤 runtime stage로 복사하고, egress-proxy는 `bun install` 없이 자기 소스만 담은 한 stage다(94S-323).

| 이미지 | 내용 | 실행 주체 |
|---|---|---|
| `agent-platform-api` | `apps/api` 서버 + `apps/reconciler` one-shot. `--filter`로 두 앱의 closure만 설치하며 Agent SDK·Claude Code executable을 담지 않는다(빌드가 `node_modules/@anthropic-ai` 부재를 확인). uid 1000 | `bun run apps/api/src/server.ts` (reconciler는 `bun run apps/reconciler/src/main.ts`) |
| `agent-platform-worker` | SDK 0.3.270과 번들 Claude Code 2.1.270, git, non-root(uid 1000), `/workspace`를 1000 소유로 미리 생성(LocalDockerBackend의 volume 계약). 빌드 시 `resolvePinnedClaudeExecutable()`로 executable 경로를 확정해 `/usr/local/bin/claude`로 걸고 `claude --version`을 실행한다 | `bun run apps/worker/src/main.ts` — scheduler가 env로 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프를 돈다 |
| `agent-platform-scheduler` | `apps/scheduler` one-shot. Docker socket을 mount하는 유일한 서비스이며 root로 실행한다(socket 소유자는 어차피 daemon host의 root와 같고, socket gid는 daemon마다 달라 고정 uid가 이식성을 깎기만 한다) | compose에서는 `sh` 루프가 `SCHEDULER_INTERVAL_SEC`(기본 5초)마다 한 pass를 실행. 앱 자체는 one-shot 계약을 유지한다. 실패 pass가 `SCHEDULER_MAX_CONSECUTIVE_FAILURES`(3)번 이어지면 루프가 exit 1 해 `restart: unless-stopped`가 재시작하고(`compose ps`에 드러남), `SCHEDULER_HEALTH_STALE_SEC`(60초) 동안 성공 pass가 없으면 healthcheck가 unhealthy가 된다. DB가 멈추면 pass가 스스로 exit 1로 끝난다: scheduler·reconciler pool은 API와 같은 timeout(connect 5초·statement 10초·read 20초, `packages/db/src/pool.ts`의 `JOB_POOL_TIMEOUTS`)을 쓰고, 연결을 한 번 잃은 뒤의 store 호출은 기다리지 않고 바로 실패하므로 DB 대기는 실패한 statement(5+20초)와 pass lock 해제(20초)를 합친 약 45초가 상한이다(실측: pass 전 정지 5초, pass 중 정지 약 40초). `SCHEDULER_PASS_TIMEOUT_SEC`(120초)는 이 45초보다 크게 두는 바깥 watchdog이며, 상한이 없는 Docker 호출 등 그 밖의 hang을 kill해 실패로 센다(unhealthy만으로는 Docker가 재시작하지 않는다). pool timeout을 늘리면 이 값도 `connect + 2 × read`보다 크게 올린다 |

```bash
docker compose -f infra/docker-compose.yml --profile worker build          # WORKER_IMAGE(agent-platform-worker:dev)
docker compose -f infra/docker-compose.yml --profile worker run --rm worker claude --version
docker compose -f infra/docker-compose.yml --profile apps up -d --build      # migrate → api(/readyz) → worker 이미지 smoke → scheduler 루프
curl -s http://127.0.0.1:3000/readyz
```

`apps` profile의 값은 전부 기본값이 있어 환경 파일 없이 뜬다. `DATABASE_URL`만은 예외로 항상 compose의 postgres를 가리킨다 — `up`이 migrate를 실행하므로 셸이나 환경 파일에 있는 다른 DSN이 로컬 스택 기동만으로 migrate되면 안 된다. `AUTH_MODE` 기본값은 `api-key`다 — 워커가 proxy 경유로 `api:3000`에 닿으므로 `none`이면 워커 안의 코드가 `X-Owner-Id`로 아무 owner 행세를 할 수 있다(`/internal` 워커 라우트는 자체 인증). 키는 `bun run keys create <owner> --scopes …`(compose `api` 컨테이너 안에서 key CLI를 실행)로 발급한다. API 포트는 `127.0.0.1:3000`에만 바인드한다. `EXECUTION_WORKSPACE_QUOTA`는 compose에서 기본 `off`다 — Docker Desktop은 project quota를 감당하지 못하므로(94S-215) 로컬 스택은 무제한 workspace를 감수하고 기동 로그에 경고 1건이 남는다; xfs+prjquota daemon이면 `on`으로 되돌린다. 나머지 값은 `.env` 없이 뜬다. `.env`가 있으면 읽되(`required: false`) 만들거나 덮어쓰지 않는다. 카탈로그는 저장소 `config/`를 `/app/config`로 mount해 읽는다 — 이미지에는 카탈로그가 없어 mount 없이 띄운 API는 기동하지 않는다. `secrets`(API 전용 Secrets Manager, 호스트 `127.0.0.1:4567`)와 `fake-messages`가 함께 뜬다. worker 컨테이너는 compose 서비스가 아니라 scheduler가 세션마다 띄운다. compose의 `worker` 항목은 그 이미지를 빌드하고 `claude --version`으로 한 번 확인한 뒤 끝나는 one-shot이다(`network_mode: none`). scheduler가 이것의 성공을 기다리므로 `apps` profile의 `up`이 worker 이미지까지 빌드한다. 워커는 proxy 경유로 `api:3000`(`EGRESS_PRIVATE_ALLOWLIST` 기본값에 포함)·`gitea:3000`·`localstack:4566`·`fake-messages:4010`에 닿고(`secrets`에는 닿지 않는다), 직접 연결과 metadata 주소는 internal 네트워크가 막는다.

같은 daemon에 두 설치를 올리면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. compose의 `egress-proxy` label은 이 값을 따르므로 설치마다 자기 proxy가 붙는다. 다른 worktree의 compose project가 기본 포트를 잡고 있으면 `-p <name>`과 `ports: !override` override 파일로 분리한다.

`.github/workflows/images.yml`은 PR·main push마다 네 이미지를 빌드하고 worker에서 `claude --version`이 2.1.270인지, api·scheduler에 `@anthropic-ai`가 없는지 확인한 뒤 digest JSON을 `image-digest-<app>` artifact로 남긴다. `v*` tag의 **push 이벤트**에서만(`workflow_dispatch`는 어떤 ref든 지정할 수 있어 이벤트도 본다) `publish`·`promote` job이 `ghcr.io/<owner>/agent-platform-<app>`으로 게시한다. 두 job만 package write 권한을 가지며 `release` environment에서 돌고, tag가 가리키는 commit이 `main`의 조상이 아니면 실패한다(tag는 리뷰가 아니다). `publish`는 이미지마다 run 전용 staging tag로 push한 뒤 그 digest를 pull해 같은 smoke(`.github/scripts/image-smoke.sh`)를 통과시키고, `promote`가 네 digest가 모두 통과한 뒤에야 `vX`·`sha-…` tag로 retag한다(registry-side, 재빌드 없음). 이 run의 staged digest가 release candidate다. 기존 tag가 다른 digest를 가리키면 아무 tag도 쓰기 전에 실패하고(한 버전이 두 build attempt의 이미지로 섞이지 않는다), 조회 자체가 실패하면(인증·rate limit·5xx) "없음"으로 보지 않고 중단한다(fail-closed). tag를 쓴 뒤 여섯 reference를 다시 읽어 candidate와 같을 때만 `image-digests-published` artifact를 만든다. retag는 저장소별로 순서대로 일어나므로 중간에 실패하면 세트가 반만 tag된 채 남는다 — 그때는 **같은 run의 "Re-run failed jobs"**로 채운다(publish job은 다시 돌지 않아 staged artifact와 digest가 그대로다). tag를 다시 push하면 새 build(worker의 apt layer는 pin되지 않는다)라 거부된다. 네 digest를 한 번에 커밋하는 소비자용 release manifest는 D5이며, 그 전까지는 초록 run의 `image-digests-published` artifact가 세트의 기록이다. `release` environment의 required reviewer·deployment branch 규칙은 저장소 설정에서 건다. registry CD는 D5다.

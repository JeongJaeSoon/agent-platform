# 개발 환경과 검증

이 저장소를 고치는 사람을 위한 문서다. 로컬 스택을 사용자로 띄우는 절차는 [quickstart.md](../quickstart.md)에, 구성요소와 경계는 [architecture.md](architecture.md)에, CI가 어느 job에서 무엇을 도는지는 [ci.md](ci.md)에 있다.

## 준비물

저장소 루트에서 Bun 1.3.14와 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다. 아래 [진입점](#e2egatesoak-도구-진입점)의 스크립트는 Docker Engine 28 이상에서 돈다.

## `bun run check`

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 workspace typecheck → Biome → 패키지·앱 Bun 테스트다(CI는 이 셋을 역할별 job으로 나눠 동시에 돈다). `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. 이 두 opt-in 변수와 fake Messages API·격리 workspace fixture는 `packages/testkit`([모듈 목록](architecture.md#패키지와-앱))이 제공하며, 각 패키지는 devDependency로만 참조한다(`tests/architecture.test.ts`가 검사). API의 실제 PostgreSQL·키 CLI·HTTP 프로세스 검증은 CI와 로컬에서 별도 명령으로 실행한다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다. CI가 어느 job에서 어떤 변수를 켜는지는 [ci.md](ci.md)에 있다.

`bun test`는 루트 `bunfig.toml`의 preload로 `packages/db/src/pglite-release.ts`를 먼저 읽는다. 이 preload는 닫은 PGlite가 WebAssembly memory를 놓게 한다. Linux의 Bun은 모든 ArrayBuffer를 약 60 GiB 고정 예약 안에 두는데, PGlite 하나가 그중 약 4 GiB를 쓴다. preload가 없으면 닫고도 참조가 남은 PGlite가 쌓여 뒤 테스트의 할당이 `RangeError: Out of memory`로 실패한다. 저장소 루트 밖에서 `bun test`를 돌리면 preload가 빠진다.

워커 adapter의 단위 테스트와 실제 SDK·로컬 fake Messages API 테스트는 분리해서 실행할 수 있다. `test:unit`은 `src`에서 `*.integration.test.ts`를 뺀 전부를, `test:direct-local`은 `*.integration.test.ts` 전부를 고르므로 파일을 더해도 스크립트를 고치지 않는다. 후자는 실제 번들 Claude Code subprocess를 띄워 같은 process의 후속 턴과 새 process의 resume을 확인하지만 유료 모델 API는 호출하지 않는다.

```bash
bun run --cwd packages/adapters/runtimes/claude test:unit
bun run --cwd packages/adapters/runtimes/claude test:direct-local
```

실제 LiteLLM proxy를 거친 SDK 왕복은 호환 harness가 따로 확인한다. harness는 자기 의존성과 LiteLLM을 따로 설치해야 하므로, 설치와 실행 순서는 [harness README](../../scripts/agent-sdk-compat/README.md#실행)를 따른다.

terminate 수락 지연은 PostgreSQL 임시 DB에서 동시 세션 10개(terminate 5개와 pause 5개)를 섞어 재현한다. 기본 20라운드의 terminate 100표본에서 nearest-rank p95가 500ms를 넘으면 실패하며, 결과에는 단계별 p95도 함께 나온다. `BENCH_ROUNDS`는 표본을 더 모을 때만 늘린다.

```bash
QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd packages/db bench:terminate
```

실제 Docker daemon 대상 테스트(`DOCKER_BACKEND_TEST=1`)는 [execution.md § worker 네트워크](../operator/execution.md#worker-네트워크-주소-풀-slot-limit-회수)에 있다.

## 의존 서비스만 띄우기와 host에서 도는 API

로컬 의존 서비스만 기동하려면 다음을 사용한다. 기본 포트 5432·4566·3001이 이미 사용 중인지 먼저 확인한다.

```bash
docker compose -f infra/docker-compose.yml up -d postgres localstack gitea egress-proxy
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml run --rm migrate
```

compose가 host에 게시하는 포트는 전부 `127.0.0.1`에만 묶이고, host 프로세스가 쓰는 것만 게시한다: postgres `5432`, LocalStack `4566`, API 전용 Secrets Manager `4567`(`--fake-model`일 때만), Gitea 웹 UI·HTTP clone `3001`, API `3000`. Gitea SSH는 게시하지 않는다(워커는 proxy의 repository route로 HTTP clone한다). Gitea 가입은 꺼 두고(`GITEA__service__DISABLE_REGISTRATION`) 계정은 admin CLI로만 만든다. 다른 머신에서 이 서비스에 붙어야 하면 compose를 고치지 말고 SSH 터널을 쓴다. 이미지는 전부 multi-arch index digest로 고정하거나(`postgres`·`localstack`·`gitea`·`gitea-init`·`fake-messages`, Bun은 app Dockerfile과 같은 digest) 저장소에서 빌드한다(`egress-proxy`·`api`·`migrate`(API Dockerfile)·`worker`, scheduler는 `api`가 빌드한 control-host 이미지를 같이 쓴다). egress proxy는 `apps/egress-proxy/Dockerfile`로 빌드한 이미지로 뜨고 소스를 mount하지 않으므로, proxy 코드를 고친 뒤에는 재시작이 아니라 `docker compose -f infra/docker-compose.yml up -d --build egress-proxy`로 다시 빌드해야 반영된다. 배포는 `EGRESS_PROXY_IMAGE`를 images.yml이 낸 digest(`<name>@sha256:…`)로 주고 `--build` 없이 `up -d`로 띄운다. compose는 빌드 결과에 `image:` 값을 태그로 붙이는데 digest 참조는 태그가 될 수 없어서, `--build`를 붙이면 빌드가 실패한다. `API_IMAGE`(api·scheduler 공용)·`WORKER_IMAGE`도 마찬가지다.

기존 환경 파일이나 volume을 덮어쓰거나 삭제하지 않는다. host에서 실행하는 테스트는 컨테이너 DNS 이름이 아니라 host에 공개된 endpoint를 사용한다. PostgreSQL integration fixture는 임시 DB 생성 권한이 필요하므로 전용 로컬 테스트 DB만 지정한다. LocalStack fixture는 `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`의 로컬 테스트 설정을 요구한다. 운영 DB·운영 credential로 실행하지 않는다.

API를 로컬 인증 비활성 모드로 띄울 때만 `X-Owner-Id`를 사용할 수 있다. 이 모드는 기동 시 경고를 출력하며 기본값이 아니다.

## e2e·gate·soak 도구 진입점

`quickstart.sh`를 빼면 자기 compose project로 떠서 기본 스택(`agent-platform`)과 겹치지 않는다. `quickstart.sh`는 문서 그대로 기본 project와 기본 포트를 쓴다. 무거우므로 하나씩 돌린다. 각 스크립트의 머리 주석에 knob과 기록 위치가 있다.

| 명령 | 확인하는 것 | CI | 더 읽을 곳 |
|---|---|---|---|
| `tests/e2e/run.sh` | fake 모델(`infra/compose.fake-model.yml`)로 세션 경로 전체(생성 → 이벤트 → 권한 응답 → 후속 메시지 → interrupt → pause → resume(복원) → terminate → 복구 결정 → resume)와 pause 경계 케이스 | `e2e` job | [quickstart.md § 4](../quickstart.md#4-명령-하나로-자동-검증) |
| `tests/e2e/quickstart.sh` | `docs/quickstart.md`의 `bash` 블록을 그대로 실행하고 `jq -e` 줄을 단언한다. **기본 project(`agent-platform`)와 그 데이터를 지운다** | `quickstart` job | [quickstart.md § 4](../quickstart.md#4-명령-하나로-자동-검증) |
| `tests/e2e/run.sh --real-model` | 실제 Claude로 세션 경로 한 번. 실행자의 `ANTHROPIC_API_KEY`가 필요하고 유료다 | 없음 | [real-claude.md](../real-claude.md) |
| `tests/e2e/run.sh --local-model` | 같은 경로를 이 컴퓨터의 Ollama 모델로, 직접과 LiteLLM 경유 두 번. Ollama가 필요하고 무료다 | 없음 | [local-model.md](local-model.md) |
| `tests/e2e/restore-resume.sh` | 세션 두 turn → pause → 백업 → 원본 삭제 → 새 project에 복원·검증 → resume해서 같은 Claude 세션으로 이어지는지 | 없음 | [backup-restore.md § 실스택에서 복원 뒤 재개 확인](../operator/backup-restore.md#실스택에서-복원-뒤-재개-확인) |
| `tests/e2e/db-restart.sh` | Postgres가 새 주소로 재시작한 뒤 API가 따라붙는지(`/readyz`, 요청 pool, 이벤트 listener) | 없음 | 스크립트 머리 주석 |
| `scripts/d2-gate/run.sh` | D2 gate(A–E, R1–R2, H1–H5) | `D2 gate` workflow(nightly, required 아님) | [ci.md § D2 gate](ci.md#d2-gate-nightly) |
| `scripts/soak/rc.sh <rc-sha>` | RC 판정 흐름: D2 gate → 이미지 기록 → 장애·경합 campaign → 24시간 soak | 없음 | 스크립트 머리 주석 |
| `scripts/soak/stack.sh up\|reset\|down\|logs`, `scripts/soak/campaign.sh [campaign-id …]` | soak 스택이나 campaign을 띄운다 | 없음 | 스크립트 머리 주석 |
| `bun scripts/bun-http-stall/client.ts` | Bun `node:http` 클라이언트가 동시 keep-alive 응답 body 도중에 멈추는지. S3 client가 이 경로로 읽으므로 Bun을 올릴 때 다시 잰다. `node`가 필요하다 | 없음(수동) | 스크립트 머리 주석 |

## PR 미리보기

`deploy/preview/preview.sh`는 PR 하나를 OrbStack 내장 Kubernetes의 namespace `pr-<번호>`에 fake 모델로 띄운다. OrbStack의 Kubernetes가 켜져 있어야 한다(켜면 Docker 엔진이 재시작되어 떠 있던 compose 스택이 멈춘다).

```bash
deploy/preview/preview.sh up 123     # PR head를 꺼내 이미지 3종(태그 pr-123)을 빌드하고 설치·업그레이드
deploy/preview/preview.sh list       # 떠 있는 미리보기의 URL·head·메모리·/readyz
deploy/preview/preview.sh down 123   # namespace, 이미지 태그, checkout을 지운다
deploy/preview/preview.sh reap       # PR이 닫혔거나 머지됐거나 TTL이 지난 미리보기를 down한다
```

- 설치는 PR head의 트리(Dockerfile·chart·대역 서비스)를 이 checkout의 `deploy/kind/up.sh`(orbstack 모드)로 한다. up.sh를 PR checkout에 복사해 돌리므로 orbstack 모드가 없는 오래된 head도 뜬다. 값은 `deploy/preview/values.yaml`을 얹는다(api·egress proxy를 1개로, worker 메모리를 fake 모델에 맞게 낮춘다).
- 진입점은 미리보기 전체가 같이 쓰는 Traefik 하나다. 없으면 `up`이 namespace `preview-ingress`에 chart 42.1.3으로 한 번 설치한다(IngressClass `preview`, LoadBalancer 18180 http·18543 https). Traefik CRD는 설치하지 않는다. OrbStack은 LoadBalancer 포트를 Mac의 `127.0.0.1`에만 연다. `k8s.expose_services`가 켜져 있으면 `up`이 멈춘다.
- 각 namespace에 Ingress `preview-pr-<번호>`가 Host `pr-<번호>.preview.94soon.dev`를 api로 보낸다. Ingress 이름이 namespace마다 같으면 Traefik router가 충돌해 두 번째 host가 404가 된다. 바깥 DNS·인증서가 없을 때는 `curl --resolve pr-123.preview.94soon.dev:18543:127.0.0.1 -k https://pr-123.preview.94soon.dev:18543/readyz`로 확인한다.
- 새 미리보기를 띄우기 전에 노드 allocatable 메모리에서 Pod requests 합을 뺀 값이 `PREVIEW_MEMORY_MI`(기본 2560: 미리보기 Deployment requests 1792Mi와 worker 하나 768Mi)보다 작으면 이유를 적고 멈춘다. `MAX_MEMORY_MI`는 allocatable 대신 셀 값이다. 이미 있는 미리보기를 다시 `up`할 때는 세지 않는다.
- namespace에는 label `agent-platform.dev/preview=true`, annotation `agent-platform.dev/preview-head`(설치한 head)·`agent-platform.dev/preview-up-at`(마지막 `up` 시작 시각, UTC)이 붙는다. `down`은 이 label이 없는 namespace를 지우지 않는다.
- checkout과 up.sh 상태는 `PREVIEW_HOME`(기본 `~/.cache/agent-platform/preview`) 아래 `pr-<번호>`에, PR head는 ref `refs/preview/pr-<번호>`에 둔다. 둘 다 `down`이 지운다.

### 미리보기 자동 정리

`reap`은 label `agent-platform.dev/preview=true`가 붙고 이름이 `pr-<번호>`인 namespace만 본다. 하나씩 다음 순서로 판단하고, 지울 때는 `down <번호>`를 부른다.

1. `preview-up-at`이 `PREVIEW_TTL_HOURS`(기본 24)시간보다 오래됐으면 PR 상태와 상관없이 지운다. annotation이 없거나 읽을 수 없으면 TTL은 건너뛴다.
2. 이 checkout에서 `gh pr view <번호> --json state`로 PR 상태를 읽어 `CLOSED`·`MERGED`면 지운다. `OPEN`이면 남긴다.
3. 조회가 실패하면(네트워크, 인증, 없는 PR) 닫힘으로 읽지 않고 남기며, gh가 낸 오류를 로그에 적는다.

`up`과 `down`은 미리보기마다 잠금(`PREVIEW_HOME/pr-<번호>.lock`, 잡은 프로세스의 pid를 가리키는 symlink)을 잡고, 잡은 프로세스가 살아 있으면 다른 `up`·`down`은 75로 끝난다. 잡은 프로세스가 없으면 `pr-<번호>.lock.reclaim`을 잡은 프로세스 하나만 그 잠금을 넘겨받는다. 넘겨받는 도중 죽어 `.reclaim`이 남으면 그 미리보기는 계속 75로 끝나니, 그 파일을 손으로 지운다. `reap`이 부른 `down`은 잠금을 잡은 뒤 `preview-up-at`이 `reap`이 읽은 값과 다르면(그 사이에 다시 `up`했으면) 지우지 않는다. 이 두 경우 `reap`은 그 namespace를 남기고 다음 실행에서 다시 판단한다.

실행마다 시각, namespace별 판단, 지운 namespace 목록(`reap deleted: …`)을 출력한다. `down`이 하나라도 실패하면 나머지를 마저 본 뒤 0이 아닌 값으로 끝난다.

이 Mac에서는 LaunchAgent `dev.94soon.agent-platform.preview-reap`이 15분마다 `reap`을 돌린다. 작업용 worktree는 지워지거나 브랜치가 바뀌므로, `reap` 전용 detached checkout `~/.cache/agent-platform/preview-reap/checkout`을 만들어 거기서 돌린다. 실행마다 그 checkout만 `git fetch origin` 뒤 `origin/main`으로 옮기고, 실패하면 이유를 로그에 적고 가진 코드로 `reap`을 돌린다. 그 checkout은 손으로 고치지 않는다.

```bash
# 이 저장소의 아무 checkout에서
git fetch origin
git worktree add --detach ~/.cache/agent-platform/preview-reap/checkout origin/main
mkdir -p ~/Library/Logs/agent-platform
sed -e "s|@CHECKOUT@|$HOME/.cache/agent-platform/preview-reap/checkout|g" -e "s|@HOME@|$HOME|g" \
  deploy/preview/preview-reap.plist > ~/Library/LaunchAgents/dev.94soon.agent-platform.preview-reap.plist
plutil -lint ~/Library/LaunchAgents/dev.94soon.agent-platform.preview-reap.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.94soon.agent-platform.preview-reap.plist

launchctl print gui/$(id -u)/dev.94soon.agent-platform.preview-reap   # 상태·마지막 종료 코드
tail ~/Library/Logs/agent-platform/preview-reap.log                    # 실행 기록

# 해제
launchctl bootout gui/$(id -u)/dev.94soon.agent-platform.preview-reap
rm ~/Library/LaunchAgents/dev.94soon.agent-platform.preview-reap.plist
git worktree remove ~/.cache/agent-platform/preview-reap/checkout
```

설치하면 바로 한 번 돌고, 그 뒤 15분마다 돈다. gh는 로그인한 사용자의 keychain 토큰을 쓰므로 GUI 세션의 LaunchAgent로만 설치한다. 로그는 지워지지 않고 쌓이니 필요하면 손으로 비운다.

## 테스트·스크립트 배치

- 한 패키지·앱 안에서 닫히는 테스트는 대상 소스 옆에 `*.test.ts`로 둔다. PostgreSQL·LocalStack·Docker·실제 SDK가 필요한 테스트는 `*.integration.test.ts`다. 예외로 `packages/storage`의 `*.localstack.test.ts` 둘과, unit 파일 안에 opt-in LocalStack 블록을 둔 파일이 있다. 그래서 CI는 파일 이름이 아니라 opt-in 변수로 나눈다([ci.md](ci.md)). `__tests__` 디렉터리는 쓰지 않는다.
- 여러 앱·패키지를 엮는 흐름 테스트와 저장소·CI·`scripts`를 검사하는 테스트는 루트 `tests/`에 둔다. 루트 `scripts/`와 `.github/` 안의 테스트는 `bun test` 필터에 걸리지 않아 돌지 않는다.
- 실행 도구는 `scripts/<이름>/`에, 그 테스트는 `tests/<이름>/`에 짝으로 둔다. `d2-gate`는 스택 전체를 띄우는 harness이고, `tests/soak`는 `scripts/soak` 판정 함수의 단위 테스트다. e2e는 실행기와 테스트를 함께 `tests/e2e`에 둔다.
- 자기 lock으로 SDK를 고정한 호환 harness는 `scripts/<이름>/`에 두고 CI 전용 job이 돌린다. `scripts/agent-sdk-compat`이 그렇고, 제품과 같은 SDK 버전인지는 짝 테스트 `tests/agent-sdk-compat`이 검사한다.
- 테스트 전용 도우미는 대상의 `src/testing/`에 둔다(예: `apps/egress-proxy/src/testing`). 여러 패키지가 쓰는 fixture는 `packages/testkit`에 둔다. 예외: 다른 패키지에 `./testing` export로 내주는 도우미는 파일 하나(`local-docker/src/testing.ts`)이고, `packages/ui`는 happy-dom 도우미를 `src/test-support/`에, 스냅샷 fixture를 `src/__fixtures__/`에 둔다. runtime-claude의 제어 가능한 fake(`src/fake-adapter.ts`)는 제품 barrel로 export된다.
- 수동 벤치는 `<패키지>/bench/`에 두고 그 패키지 tsconfig의 include에 넣는다. 테스트 파일 이름을 쓰지 않는다.
- 새 루트 `tests/*.test.ts`는 ci.yml `integration-domain`의 `paths`에 접두어가 있어야 한다. 없으면 integration job이 모두 실패한다([ci.md](ci.md)).
- 서비스가 필요한 테스트는 opt-in 변수(`localstackEnabled()`, `QUEUE_DATABASE_URL` 등)가 꺼지면 `describe.skip`·`skipIf`로 skip된다. 그 skip은 해당 변수를 켜는 integration job에서 사라져야 한다. 그 밖의 이유로 skip하는 코드(플랫폼 조건 등)를 새로 넣으면 integration job이 선언되지 않은 skip으로 실패시키므로 ci.yml `skips`에 선언한다.
- 루트 `tests/`·`scripts/`·`.github/scripts`의 `.ts`는 어느 tsconfig에도 들어 있지 않아 `bun run typecheck`가 보지 않는다. 고친 파일은 직접 실행해 확인한다.
- 운영자와 개발자가 부르는 도구는 `scripts/`에, workflow만 부르는 helper는 `.github/scripts/`에 둔다.

## 문서 쓰기

- 문서에는 지금 동작만 적는다. 티켓 번호, PR 번호, "예전에는 …였다"·"~에서 바꿨다" 같은 작업 경위는 쓰지 않는다. 경위는 커밋·PR·티켓에 남는다.
- heading에 번호나 날짜를 넣지 않는다. heading이 바뀌면 anchor가 바뀌어, 그 anchor를 가리키는 문서와 `infra/datadog` monitor 메시지의 링크가 깨진다.
- 문서는 독자별 디렉터리에 둔다. 사용자 문서(quickstart·API 가이드)는 `docs/` 바로 아래, 운영자 문서는 `docs/operator/`, 기여자 문서는 `docs/contributing/`, 채택·선택 결정의 결론은 `docs/contributing/decisions/`에 둔다. 새 문서는 [docs/README.md](../README.md) 색인에 넣는다.
- 조사용 코드(spike)는 저장소에 남기지 않는다. 결론은 결정 기록에 적고, 계속 지킬 계약은 제품 테스트나 `scripts/<이름>/` harness로 옮긴 뒤 지운다.
- `tests/docs-links.test.ts`가 추적 중인 Markdown의 Linear 티켓 번호(`94S-` 뒤 숫자), 깨진 상대 링크, 맞지 않는 heading anchor를 검사한다. PR 번호와 작업 경위는 검사하지 않으니 리뷰에서 본다.

## migration 만들기

스키마(`packages/db/src/schema.ts`)를 고친 뒤 `bun run --cwd packages/db db:generate`로 다음 번호의 migration을 만든다. drizzle-kit generate에 인자를 그대로 넘기고, 생성된 `migrations/meta`를 Biome 형식으로 맞춘다. 다른 migration이 main에 먼저 들어가 번호가 겹치면, 커밋을 하나로 합치고 `origin/main`에 rebase한 뒤 `bun run --cwd packages/db db:restack`으로 번호·snapshot·journal을 다시 만든다. 직접 쓴 SQL(backfill, trigger 등)은 새 base에 맞는지 읽은 뒤에만 `--keep-handwritten`으로 남긴다. 사용법과 충돌 처리는 `packages/db/scripts/restack-migration.ts` 머리 주석에 있다.

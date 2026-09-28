# 개발 환경과 검증

이 저장소를 고치는 사람을 위한 문서다. 로컬 스택을 사용자로 띄우는 절차는 [quickstart.md](quickstart.md)에, 구성요소와 경계는 [architecture.md](architecture.md)에, CI가 어느 job에서 무엇을 도는지는 [ci.md](ci.md)에 있다.

## 준비물

저장소 루트에서 Bun 1.3.14와 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다. 아래 [진입점](#e2egate와-과거-soak-도구-진입점)의 스크립트는 Docker Engine 28 이상에서 돈다.

## `bun run check`

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 workspace typecheck → Biome → 패키지·앱 Bun 테스트다(CI는 이 셋을 역할별 job으로 나눠 동시에 돈다). `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. 이 두 opt-in 변수와 fake Messages API·격리 workspace fixture는 `packages/testkit`([모듈 목록](architecture.md#패키지와-앱))이 제공하며, 각 패키지는 devDependency로만 참조한다(`tests/architecture.test.ts`가 검사). API의 실제 PostgreSQL·키 CLI·HTTP 프로세스 검증은 CI와 로컬에서 별도 명령으로 실행한다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다. CI가 어느 job에서 어떤 변수를 켜는지는 [ci.md](ci.md)에 있다.

`bun test`는 루트 `bunfig.toml`의 preload로 `packages/db/src/pglite-release.ts`를 먼저 읽는다. 이 preload는 닫은 PGlite가 WebAssembly memory를 놓게 한다. Linux의 Bun은 모든 ArrayBuffer를 약 60 GiB 고정 예약 안에 두는데, PGlite 하나가 그중 약 4 GiB를 쓴다. 닫고도 참조가 남은 PGlite가 쌓이면 뒤 테스트의 할당이 `RangeError: Out of memory`로 실패했다(94S-436). 저장소 루트 밖에서 `bun test`를 돌리면 preload가 빠진다.

워커 adapter의 단위 테스트와 실제 SDK·로컬 fake Messages API 테스트는 분리해서 실행할 수 있다. `test:unit`은 `src`에서 `*.integration.test.ts`를 뺀 전부를, `test:direct-local`은 `*.integration.test.ts` 전부를 고르므로 파일을 더해도 스크립트를 고치지 않는다. 후자는 실제 번들 Claude Code subprocess를 띄워 같은 process의 후속 턴과 새 process의 resume을 확인하지만 유료 모델 API는 호출하지 않는다.

```bash
bun run --cwd packages/adapters/runtimes/claude test:unit
bun run --cwd packages/adapters/runtimes/claude test:direct-local
bun test spikes/94s-91/src/litellm-transport.test.ts
```

terminate 수락 지연은 PostgreSQL 임시 DB에서 동시 세션 10개(terminate 5개와 pause 5개)를 섞어 재현한다. 기본 20라운드의 terminate 100표본에서 nearest-rank p95가 500ms를 넘으면 실패하며, 결과에는 단계별 p95도 함께 나온다. `BENCH_ROUNDS`는 표본을 더 모을 때만 늘린다.

```bash
QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd packages/db bench:terminate
```

실제 Docker daemon 대상 테스트(`DOCKER_BACKEND_TEST=1`)는 [operations.md § worker 네트워크](operations.md#worker-네트워크-주소-풀-slot-limit-회수)에 있다.

## 의존 서비스만 띄우기와 host에서 도는 API

로컬 의존 서비스만 기동하려면 다음을 사용한다. 기본 포트 5432·4566·3001이 이미 사용 중인지 먼저 확인한다.

```bash
docker compose -f infra/docker-compose.yml up -d postgres localstack gitea egress-proxy
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml run --rm migrate
```

compose가 host에 게시하는 포트는 전부 `127.0.0.1`에만 묶이고, host 프로세스가 쓰는 것만 게시한다(94S-323): postgres `5432`, LocalStack `4566`, API 전용 Secrets Manager `4567`, Gitea 웹 UI·HTTP clone `3001`, API `3000`. Gitea SSH는 게시하지 않는다(워커는 proxy의 repository route로 HTTP clone한다). Gitea 가입은 꺼 두고(`GITEA__service__DISABLE_REGISTRATION`) 계정은 admin CLI로만 만든다. 다른 머신에서 이 서비스에 붙어야 하면 compose를 고치지 말고 SSH 터널을 쓴다. 이미지는 전부 multi-arch index digest로 고정하거나(`postgres`·`localstack`·`gitea`·`gitea-init`·`fake-messages`, Bun은 app Dockerfile과 같은 digest) 저장소에서 빌드한다(`egress-proxy`·`api`·`migrate`(API Dockerfile)·`worker`, scheduler는 `api`가 빌드한 control-host 이미지를 같이 쓴다). egress proxy는 `apps/egress-proxy/Dockerfile`로 빌드한 이미지로 뜨고 소스를 mount하지 않으므로, proxy 코드를 고친 뒤에는 재시작이 아니라 `docker compose -f infra/docker-compose.yml up -d --build egress-proxy`로 다시 빌드해야 반영된다. 배포는 `EGRESS_PROXY_IMAGE`를 images.yml이 낸 digest(`<name>@sha256:…`)로 주고 `--build` 없이 `up -d`로 띄운다. compose는 빌드 결과에 `image:` 값을 태그로 붙이는데 digest 참조는 태그가 될 수 없어서, `--build`를 붙이면 빌드가 실패한다. `API_IMAGE`(api·scheduler 공용)·`WORKER_IMAGE`도 마찬가지다.

기존 환경 파일이나 volume을 덮어쓰거나 삭제하지 않는다. host에서 실행하는 테스트는 컨테이너 DNS 이름이 아니라 host에 공개된 endpoint를 사용한다. PostgreSQL integration fixture는 임시 DB 생성 권한이 필요하므로 전용 로컬 테스트 DB만 지정한다. LocalStack fixture는 `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`의 로컬 테스트 설정을 요구한다. 운영 DB·운영 credential로 실행하지 않는다.

API를 로컬 인증 비활성 모드로 띄울 때만 `X-Owner-Id`를 사용할 수 있다. 이 모드는 기동 시 경고를 출력하며 기본값이 아니다.

## e2e·gate와 과거 soak 도구 진입점

`quickstart.sh`를 빼면 자기 compose project로 떠서 기본 스택(`agent-platform`)과 겹치지 않는다. `quickstart.sh`는 문서 그대로 기본 project와 기본 포트를 쓴다. 무거우므로 하나씩 돌린다. 각 스크립트의 머리 주석에 knob과 기록 위치가 있다.

soak 도구는 2026-09-27에 종료한 94S-135 판정의 재현·조사용으로 남아 있으며 현재 알파 gate가 아니다. 결과와 남은 검증 범위는 [과거 알파 부하 검증 결과](soak.md)에 있다.

| 명령 | 확인하는 것 | CI | 더 읽을 곳 |
|---|---|---|---|
| `tests/e2e/run.sh` | 알파 경로 전체(생성 → 이벤트 → 권한 응답 → 후속 메시지 → interrupt → pause → resume(복원) → terminate → 복구 결정 → resume)와 pause 경계 케이스 | `e2e` job | [quickstart.md § 4](quickstart.md#4-명령-하나로-자동-검증) |
| `tests/e2e/quickstart.sh` | `docs/quickstart.md`의 `bash` 블록을 그대로 실행하고 `jq -e` 줄을 단언한다. **기본 project(`agent-platform`)와 그 데이터를 지운다** | `quickstart` job | [quickstart.md § 4](quickstart.md#4-명령-하나로-자동-검증) |
| `tests/e2e/run.sh --real-model` | 실제 Claude로 알파 경로 한 번. 실행자의 `ANTHROPIC_API_KEY`가 필요하고 유료다 | 없음 | [real-claude.md](real-claude.md) |
| `tests/e2e/restore-resume.sh` | 세션 두 turn → pause → 백업 → 원본 삭제 → 새 project에 복원·검증 → resume해서 같은 Claude 세션으로 이어지는지 | 없음 | [backup-restore.md § 실스택에서 복원 뒤 재개 확인](backup-restore.md#실스택에서-복원-뒤-재개-확인-94s-324) |
| `tests/e2e/db-restart.sh` | Postgres가 새 주소로 재시작한 뒤 API가 따라붙는지(`/readyz`, 요청 pool, 이벤트 listener) | 없음 | 스크립트 머리 주석 |
| `scripts/d2-gate/run.sh` | D2 gate(94S-247의 A–E, 94S-320의 R1–R2, 94S-117의 H1–H5) | `D2 gate` workflow(nightly, required 아님) | [ci.md § D2 gate](ci.md#d2-gate-nightly-94s-404) |
| `scripts/soak/rc.sh <rc-sha>` | 과거 RC 판정 흐름 재현: D2 gate → 이미지 기록 → 장애·경합 campaign → 24시간 soak | 없음 | [과거 soak 결과](soak.md), 스크립트 머리 주석 |
| `scripts/soak/stack.sh up\|reset\|down\|logs`, `scripts/soak/campaign.sh [campaign-id …]` | 과거 soak 스택이나 campaign을 재현한다 | 없음 | [과거 soak 결과](soak.md), 스크립트 머리 주석 |
| `bun scripts/bun-http-stall/client.ts` | Bun `node:http` 클라이언트가 동시 keep-alive 응답 body 도중에 멈추는지(94S-441). S3 client가 이 경로로 읽으므로 Bun을 올릴 때 다시 잰다. `node`가 필요하다 | 없음(수동) | 스크립트 머리 주석 |

## 테스트·스크립트 배치

- 한 패키지·앱 안에서 닫히는 테스트는 대상 소스 옆에 `*.test.ts`로 둔다. PostgreSQL·LocalStack·Docker·실제 SDK가 필요한 테스트는 `*.integration.test.ts`다. `__tests__` 디렉터리는 쓰지 않는다.
- 여러 앱·패키지를 엮는 흐름 테스트와 저장소·CI·`scripts`를 검사하는 테스트는 루트 `tests/`에 둔다. 루트 `scripts/`와 `.github/` 안의 테스트는 `bun test` 필터에 걸리지 않아 돌지 않는다.
- 스택 전체를 띄우는 harness는 실행 도구를 `scripts/<이름>/`에, 테스트를 `tests/<이름>/`에 짝으로 둔다(`d2-gate`, `soak`). e2e는 실행기와 테스트를 함께 `tests/e2e`에 둔다.
- 테스트 전용 도우미는 대상의 `src/testing/`에 둔다(예: `apps/egress-proxy/src/testing`). 여러 패키지가 쓰는 fixture는 `packages/testkit`에 둔다.
- 수동 벤치는 `<패키지>/bench/`에 두고 그 패키지 tsconfig의 include에 넣는다. 테스트 파일 이름을 쓰지 않는다.
- 새 루트 `tests/*.test.ts`는 ci.yml `integration-domain`의 `paths`에 접두어가 있어야 한다. 없으면 integration job이 모두 실패한다([ci.md](ci.md)).
- 환경 변수에 따라 테스트를 skip하는 코드(`skipIf` 등)를 새로 넣지 않는다. integration job이 선언되지 않은 skip으로 실패시킨다. skip이 꼭 필요하면 ci.yml에 선언한다.
- 루트 `tests/`·`scripts/`·`.github/scripts`의 `.ts`는 어느 tsconfig에도 들어 있지 않아 `bun run typecheck`가 보지 않는다(94S-518). 고친 파일은 직접 실행해 확인한다.
- 운영자와 개발자가 부르는 도구는 `scripts/`에, workflow만 부르는 helper는 `.github/scripts/`에 둔다.

## migration 만들기

스키마(`packages/db/src/schema.ts`)를 고친 뒤 `bun run --cwd packages/db db:generate`로 다음 번호의 migration을 만든다. drizzle-kit generate에 인자를 그대로 넘기고, 생성된 `migrations/meta`를 Biome 형식으로 맞춘다. 다른 migration이 main에 먼저 들어가 번호가 겹치면, 커밋을 하나로 합치고 `origin/main`에 rebase한 뒤 `bun run --cwd packages/db db:restack`으로 번호·snapshot·journal을 다시 만든다. 직접 쓴 SQL(backfill, trigger 등)은 새 base에 맞는지 읽은 뒤에만 `--keep-handwritten`으로 남긴다. 사용법과 충돌 처리는 `packages/db/scripts/restack-migration.ts` 머리 주석에 있다.

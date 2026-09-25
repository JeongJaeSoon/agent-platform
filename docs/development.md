# 개발 환경과 검증

이 저장소를 고치는 사람을 위한 문서다. 로컬 스택을 사용자로 띄우는 절차는 [quickstart.md](quickstart.md)에, 구성요소와 경계는 [architecture.md](architecture.md)에, CI가 어느 job에서 무엇을 도는지는 [ci.md](ci.md)에 있다.

## 준비물

저장소 루트에서 Bun 1.3.14와 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다. 아래 [진입점](#e2egatesoak-진입점)의 스크립트는 Docker Engine 28 이상에서 돈다.

## `bun run check`

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 workspace typecheck → Biome → 패키지·앱 Bun 테스트다(CI는 이 셋을 역할별 job으로 나눠 동시에 돈다). `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. 이 두 opt-in 변수와 fake Messages API·격리 workspace fixture는 `packages/testkit`(`fake-anthropic`·`postgres`·`localstack`·`workspace`)이 제공하며, 각 패키지는 devDependency로만 참조한다(`tests/architecture.test.ts`가 검사). API의 실제 PostgreSQL·키 CLI·HTTP 프로세스 검증은 CI와 로컬에서 별도 명령으로 실행한다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다. CI가 어느 job에서 어떤 변수를 켜는지는 [ci.md](ci.md)에 있다.

워커 adapter의 단위 테스트와 실제 SDK·로컬 fake Messages API 테스트는 분리해서 실행할 수 있다. 후자는 실제 번들 Claude Code subprocess를 띄워 같은 process의 후속 턴과 새 process의 resume을 확인하지만 유료 모델 API는 호출하지 않는다.

```bash
bun run --cwd packages/adapters/runtimes/claude test:unit
bun run --cwd packages/adapters/runtimes/claude test:direct-local
bun test spikes/94s-91/src/litellm-transport.test.ts
```

```bash
QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test ./apps/control-host/src/api/server.integration.ts
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

## e2e·gate·soak 진입점

`quickstart.sh`를 빼면 자기 compose project로 떠서 기본 스택(`agent-platform`)과 겹치지 않는다. `quickstart.sh`는 문서 그대로 기본 project와 기본 포트를 쓴다. 대부분 이 checkout에서 이미지를 빌드하지만, `rc.sh`는 인자로 받은 RC commit에서 빌드하고 `campaign.sh`는 `stack.sh up`이 빌드한 이미지를 쓴다. 무거우므로 하나씩 돌린다. 각 스크립트의 머리 주석에 knob과 기록 위치가 있다.

| 명령 | 확인하는 것 | CI | 더 읽을 곳 |
|---|---|---|---|
| `tests/e2e/run.sh` | 알파 경로 전체(생성 → 이벤트 → 권한 응답 → 후속 메시지 → interrupt → pause → resume(복원) → terminate → 복구 결정 → resume)와 pause 경계 케이스 | `e2e` job | [quickstart.md § 4](quickstart.md#4-명령-하나로-자동-검증) |
| `tests/e2e/quickstart.sh` | `docs/quickstart.md`의 `bash` 블록을 그대로 실행하고 `jq -e` 줄을 단언한다. **기본 project(`agent-platform`)와 그 데이터를 지운다** | `quickstart` job | [quickstart.md § 4](quickstart.md#4-명령-하나로-자동-검증) |
| `tests/e2e/run.sh --real-model` | 실제 Claude로 알파 경로 한 번. 실행자의 `ANTHROPIC_API_KEY`가 필요하고 유료다 | 없음 | [real-claude.md](real-claude.md) |
| `tests/e2e/restore-resume.sh` | 세션 두 turn → pause → 백업 → 원본 삭제 → 새 project에 복원·검증 → resume해서 같은 Claude 세션으로 이어지는지 | 없음 | [backup-restore.md § 실스택에서 복원 뒤 재개 확인](backup-restore.md#실스택에서-복원-뒤-재개-확인-94s-324) |
| `tests/e2e/db-restart.sh` | Postgres가 새 주소로 재시작한 뒤 API가 따라붙는지(`/readyz`, 요청 pool, 이벤트 listener) | 없음 | 스크립트 머리 주석 |
| `scripts/d2-gate/run.sh` | D2 gate(94S-247의 A–E, 94S-320의 R1–R2, 94S-117의 H1–H5) | `D2 gate` workflow(nightly, required 아님) | [ci.md § D2 gate](ci.md#d2-gate-nightly-94s-404) |
| `scripts/soak/rc.sh <rc-sha>` | release candidate 판정: D2 gate → 이미지 기록 → 장애·경합 campaign → 24시간 soak | 없음 | 스크립트 머리 주석 |
| `scripts/soak/stack.sh up\|reset\|down\|logs`, `scripts/soak/campaign.sh [campaign-id …]` | soak 스택을 따로 다루거나 campaign만 돌린다 | 없음 | 스크립트 머리 주석 |

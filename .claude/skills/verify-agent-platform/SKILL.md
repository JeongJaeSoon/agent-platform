---
name: verify-agent-platform
description: Drive the agent-platform stack the way a user does — launch it locally with scripts/local.sh under a project of its own (fake model, ephemeral ports), then exercise the web login API, API keys from the key CLI, and the sessions API with curl, and tear down only what it started. Use to prove a user-facing change in this repo (API route, auth, key CLI, session flow) in the running app, not only in tests.
---

# verify-agent-platform

이 저장소의 사용자 표면을 실제로 띄워 사용자가 하듯 몬다. 지금 있는 표면은 셋이다.

| 표면 | 무엇 | 몰기 |
|---|---|---|
| web 로그인 API | `/v1/auth/bootstrap`·`login`·`me`·`logout` (cookie 세션). 웹 화면(`apps/web`)은 아직 없다 | `ap_web` (curl + CSRF 헤더 + cookie) |
| API | `/v1/sessions/**`, `/v1/receipts`, `/v1/limits`, `/docs`, `/readyz` | `ap_get`·`ap_post` (Bearer key) |
| CLI | key CLI(`apps/control-host/src/api/keys.ts`)의 `create`·`revoke` | `ap_key`·`ap_revoke` |

기능별 절차는 [features/README.md](features/README.md)에 있다. 증명할 때는 map에 적힌 진입점을 모두 몬다.

## 원칙

- **자기 스택만.** `up.sh`가 새 compose project(`verify-ap-<run id>`)와 installation id를 만들고, 모든 단계가 그 project에만 compose를 건다. 기본 project `agent-platform`이나 다른 사람의 스택은 몰지도 내리지도 않는다.
- **실제 모델 없이.** 항상 `--fake-model`이다. 세션은 프롬프트에 적은 GATE-SPEC 대본대로 돈다(`docs/quickstart.md` § 스크립트된 프롬프트). 실제 Claude(`local.sh up` 옵션 없음)는 유료라 이 스킬은 쓰지 않는다.
- **비밀값을 출력하지 않는다.** API key는 변수에만 담고 앞 12자만 보인다. bootstrap token은 이 run이 만든 일회용 테스트 값이고 `state.env`(700 디렉터리)에만 있다.
- **프로세스는 PID·project로.** `pkill`·`killall`·이름 패턴 종료는 쓰지 않는다. 내릴 때는 `down.sh`가 이 run의 project와 installation label만 지운다.

## 상태 파일

Claude Code의 Bash 호출은 매번 새 셸이다. 그래서 `up.sh`가 run 디렉터리를 만들고 거기에 상태를 쓴다.

- run 디렉터리: `${VERIFY_AP_ROOT:-$TMPDIR/verify-agent-platform}/<run id>/`
- `latest`: 같은 root의 `latest` 파일이 마지막 run 디렉터리를 가리킨다
- `state.env`: `COMPOSE_PROJECT_NAME`, `EXECUTION_INSTALLATION_ID`, `COMPOSE_FILE`(compose.yaml + 이 run의 ports overlay), `VERIFY_API`, `VERIFY_BOOTSTRAP_TOKEN`
- `evidence/`: 증거. 내린 뒤에도 남는다

드라이브하는 Bash 호출은 매번 이렇게 시작한다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh   # 인자로 run 디렉터리를 주면 latest 대신 그것
```

## Launch

```sh
.claude/skills/verify-agent-platform/scripts/up.sh
```

- Orca 프로그램 안에서 돌면 무거운 작업 잠금으로 감싼다: `orch heavy <program> -- .claude/skills/verify-agent-platform/scripts/up.sh`. 내릴 때도 같다.
- 하는 일: run 디렉터리와 `ports.yml`(postgres·localstack·gitea·api 포트를 `127.0.0.1::<port>` ephemeral로, secrets는 비공개, api에 이 run의 `BOOTSTRAP_TOKEN`)을 만들고 `COMPOSE_PROJECT_NAME=verify-ap-… EXECUTION_INSTALLATION_ID=… COMPOSE_FILE=compose.yaml:ports.yml scripts/local.sh up --fake-model`을 돌린다. 끝나면 `docker compose port api 3000`으로 API 주소를 `state.env`에 적고 run 디렉터리를 stdout에 출력한다.
- 준비 표시: stderr 끝에 `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`. 로그는 `evidence/up.log`.
- 시간: 첫 빌드는 5–10분. 이 checkout에서 이미지를 매번 다시 빌드한다. bash 도구의 timeout을 15분으로 주거나 background로 돌린다.
- 왜 ephemeral 포트인가: 기본 포트(3000·5432·4566·4567·3001)는 다른 스택이 쓰고 있을 수 있다. 이 머신에서는 3000을 다른 컨테이너가 쥐고 있어 기본값으로는 `local.sh`의 포트 점검에서 멈춘다. overlay는 `tests/e2e/compose.yml`과 같은 `ports: !override` 방식이다.

## Doctor

```sh
.claude/skills/verify-agent-platform/scripts/doctor.sh
```

run, project, checkout SHA, API 주소, 서비스별 상태, `/readyz`를 보여 준다. ready가 아니면 exit 1. 이상해 보이면 먼저 이것을 돌린다. `api`·`scheduler`·`reconciler`·`postgres`·`localstack`·`gitea`·`egress-proxy`·`fake-messages`·`secrets`가 `running`이면 정상이다(`migrate`·`gitea-init`·`worker`는 한 번 돌고 끝나 목록에 없다).

## Drive

`lib.sh`가 주는 함수. 모든 응답은 본문 뒤 마지막 줄에 HTTP 상태 코드를 붙인다.

| 함수 | 용도 |
|---|---|
| `ap_web METHOD PATH [JSON]` | 브라우저처럼 부른다: `x-requested-with: agent-platform-web` 헤더, `$VERIFY_RUN/cookie`의 세션 cookie를 보내고 응답의 `__Host-ap_session`을 저장한다 |
| `ap_key <owner> --scopes a,b` | key CLI로 key를 발급한다. stdout에 key, stderr에 `key_id …` |
| `ap_revoke <key_id>` | key 폐기 |
| `ap_get PATH` / `ap_post PATH JSON` | `$KEY`로 Bearer 호출. `ap_post`는 `Idempotency-Key`를 새로 붙인다 |
| `ap_compose …` | 이 run의 project에만 거는 `docker compose` (`logs api`, `ps` 등) |

기능별 명령과 기대 결과는 `features/*.md`에 있다. 가장 짧은 한 바퀴는 [web-login.md](features/web-login.md)다.

## Evidence

- 위치: `$VERIFY_RUN/evidence/`. `up.log`, `down.log`, `leftovers.txt`는 스크립트가 쓴다. 드라이브 출력은 기능 이름으로 `tee`한다(예: `| tee "$EVIDENCE/web-login.txt"`).
- 행동과 결과를 같이 남긴다: 요청(메서드·경로), 응답 본문, 상태 코드. 바뀐 상태는 다른 경로로 다시 읽어 확인한다(로그인 뒤 `GET /v1/auth/me`, key 폐기 뒤 같은 key로 401, 세션 생성 뒤 `GET /v1/sessions/{id}`).
- 사용자 경로만 쓴다. `/internal/**`나 DB 직접 쓰기로 상태를 만들지 않는다. DB는 읽기 확인에만 쓴다(`ap_compose exec -T postgres psql -U postgres -d sessions -c '…'`).
- mock은 fake model(외부 Messages API 경계)뿐이다.
- key·cookie 값은 증거에 넣지 않는다. 남기기 전에 `sed -E 's/(csp_[A-Za-z0-9_]{2})[A-Za-z0-9_-]+/\1…/g'`처럼 가린다.

## Cleanup

```sh
.claude/skills/verify-agent-platform/scripts/down.sh   # 인자로 run 디렉터리를 주면 그 run
```

- `scripts/local.sh down`을 같은 env로 돌린다(volume까지 지우고, installation label이 붙은 worker 컨테이너·네트워크·volume도 지운다).
- 이어서 `--profile apps --profile fake-model`과 `-f compose.yaml -f ports.yml -f infra/compose.fake-model.yml`로 `down -v --remove-orphans`를 한 번 더 한다. profile이나 fake-model overlay가 빠지면 api·scheduler·reconciler와 `fake-messages`, `<project>_default` 네트워크가 남는 일이 있었다.
- 마지막에 `docker ps -a --filter label=com.docker.compose.project=<project>`와 installation label로 남은 컨테이너를 보여 주고 `evidence/leftovers.txt`에 쓴다. 남은 것이 있으면 exit 1.
- `ports.yml`(token이 든 파일)은 지우고, `evidence/`는 남긴다. 실패한 시도 뒤에도 매번 `down.sh`를 돌린다.

## 알려진 함정

- host bun이 `package.json`의 `packageManager`(bun 1.3.14)와 다르면 main에서도 실패하는 로컬 테스트가 있다. 이 스킬은 bun을 host에서 쓰지 않는다(key CLI도 api 컨테이너 안에서 돈다). 테스트 판정은 CI가 기준이다.
- `local.sh status`·`key`·`down`은 env의 `COMPOSE_PROJECT_NAME`·`COMPOSE_FILE`을 따른다. `lib.sh`를 source하지 않은 셸에서 부르면 기본 project `agent-platform`을 건드린다.
- `__Host-` cookie는 `Secure`라 curl이 http에서 저장하지 않는다. `ap_web`이 `Set-Cookie`에서 직접 꺼내 보낸다.
- 로그인은 실패가 쌓이면 잠긴다(429 `RATE_LIMITED`, `Retry-After`). 틀린 비밀번호 시험은 한두 번만.
- bootstrap은 사용자가 0명일 때 한 번만 된다. 두 번째는 409 `BOOTSTRAP_DONE`. 처음부터 다시 하려면 `down.sh` 뒤 `up.sh`.
- macOS에는 `timeout`이 없다. 필요하면 `perl -e 'alarm N; exec @ARGV' <cmd>`.

## 유지

기능이 바뀌면 [features/](features/)를 고친다. 주기 점검은 `maintain-verification-skill`로 한다.

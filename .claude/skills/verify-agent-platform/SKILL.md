---
name: verify-agent-platform
description: Drive the agent-platform stack the way a user does — launch it locally with scripts/local.sh under a project of its own (fake model, ephemeral ports, optional mock Slack IdP), then exercise the web login API, the web console in a browser, members, teams, agents, scoped API keys, the key CLI, and the sessions API with curl, and tear down only what it started. Use to prove a user-facing change in this repo (API route, auth, web screen, key CLI, session flow) in the running app, not only in tests.
---

# verify-agent-platform

이 저장소의 사용자 표면을 실제로 띄워 사용자가 하듯 몬다. 지금 있는 표면은 넷이다.

| 표면 | 무엇 | 몰기 |
|---|---|---|
| web API (cookie) | `/v1/auth/**`(bootstrap·login-methods·login·me·logout, Google), 초대·구성원·팀·에이전트·권한별 key·연동 계정·공유·감사 열람·워크스페이스 설정 | `ap_web` (curl + CSRF 헤더 + cookie), 자격 값이 본문에 드는 요청은 `web-user.mjs` |
| 웹 콘솔 | `apps/web`을 API가 같은 origin에서 서빙: `/login`·`/bootstrap`·`/`·`/members`·`/invite/{token}`·`/sessions`·`/members/teams`·`/agents`·`/usage`·`/settings/*` | 이 run의 headless Chrome(`browser.mjs`: 폭·다크·오류·로딩 스크린샷), 서빙 헤더는 curl |
| API | `/v1/sessions/**`, `/v1/receipts/{id}`, `/v1/usage/summary`, `/v1/sessions/counts`, `/docs`, `/readyz` (`/v1/limits`는 owner cookie로 `ap_web`) | `ap_get`·`ap_post` (Bearer key) |
| CLI | key CLI(`apps/control-host/src/api/keys.ts`)의 `create`·`revoke` | `ap_key`·`ap_revoke` |

기능 map은 [features/README.md](features/README.md), 한 스택에서 순서대로 실행할 절차는 [features/procedures.md](features/procedures.md)에 있다. 이 스킬을 수정할 때는 구현과 대조하고 실행 결과와 구분한다. 증명할 때는 map에 적힌 진입점을 모두 몬다.

## 원칙

- **자기 스택만.** `up.sh`가 새 compose project(`verify-ap-<run id>`)와 installation id를 만들고, 모든 단계가 그 project에만 compose를 건다. 기본 project `agent-platform`이나 다른 사람의 스택은 몰지도 내리지도 않는다.
- **실제 모델 없이.** 항상 `--fake-model`이다. 세션은 프롬프트에 적은 GATE-SPEC 대본대로 돈다(`docs/quickstart.md` § 스크립트된 프롬프트). 실제 Claude(`local.sh up` 옵션 없음)는 유료라 이 스킬은 쓰지 않는다.
- **비밀값을 출력하지 않는다.** API key는 변수에만 담고 앞 12자만 보인다. bootstrap token은 이 run이 만든 일회용 테스트 값이고 `state.env`(700 디렉터리)에만 있다.
- **자격 값을 명령에 쓰지 않는다.** 명령 텍스트에 비밀번호 JSON 리터럴이 있으면 agent-guard PreToolUse hook이 "secret-like value detected in shell command"로 그 호출을 거부한다. bootstrap·login·초대 수락·웹 key 발급은 `web-user.mjs`가 run 디렉터리의 값으로 보내고, 화면 로그인·수락은 `browser.mjs`가 같은 값을 칸에 넣는다.
- **프로세스는 PID·project로.** `pkill`·`killall`·이름 패턴 종료는 쓰지 않는다. 내릴 때는 `down.sh`가 이 run의 project와 installation label만 지운다.
- **run은 항상 이름으로.** 같은 머신의 여러 세션이 같은 root에 run을 만든다. 그래서 "마지막 run" 같은 기본값은 없다. `up.sh`가 출력한 run id를 기록해 두고 `lib.sh`·`doctor.sh`·`down.sh`에 매번 넘긴다. 인자 없이 부르면 사용법과 살아 있는 run 목록만 출력하고 exit 2로 끝난다(아무것도 내리지 않는다). 목록의 다른 run은 다른 세션의 것이니 넘기지 않는다.

## 상태 파일

Claude Code의 Bash 호출은 매번 새 셸이다. 그래서 `up.sh`가 run 디렉터리를 만들고 거기에 상태를 쓴다.

- run 디렉터리: `${VERIFY_AP_ROOT:-$TMPDIR/verify-agent-platform}/<run id>/`
- `state.env`: `COMPOSE_PROJECT_NAME`, `EXECUTION_INSTALLATION_ID`, `COMPOSE_FILE`(compose.yaml + 이 run의 ports overlay), `API_IMAGE`·`WORKER_IMAGE`·`EGRESS_PROXY_IMAGE`(run별 태그), `VERIFY_API`, `VERIFY_BOOTSTRAP_TOKEN`
- `users/<who>`(이메일·무작위 비밀번호), `users/<who>.invite`(초대 token), `keys/<who>`(웹에서 발급한 key secret), `cookie.<who>`: `web-user.mjs`가 쓴다. 모두 0600이고 `down.sh`가 지운다
- `browser/`: `browser.mjs`의 Chrome profile과 `pid`. `stop`(또는 `down.sh`)이 그 PID만 끝내고 profile을 지운다
- `evidence/`: 증거. 내린 뒤에도 남는다

드라이브하는 Bash 호출은 매번 이렇게 시작한다. `<run id>`는 `up.sh`가 출력한 값(예: `20261011-133324-76616`)이다. run 디렉터리 경로나 project 이름(`verify-ap-<run id>`)도 받는다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
```

## Launch

```sh
.claude/skills/verify-agent-platform/scripts/up.sh
```

- 선택형 overlay는 인자로 더한다: `up.sh infra/compose.mock-slack.yml`. mock Slack 하나가 Sign in with Slack IdP와 Slack Web API의 가짜(config token 발급 `/fake/config-tokens`, 앱 생성, 설치 동의 `/fake/oauth/authorize`)를 맡고, api의 `SLACK_OIDC_REDIRECT_URI`·`SLACK_API_URL`을 그쪽으로 돌린다. fallback OIDC client는 비워 두므로 계정 연결은 워크스페이스의 link 앱으로 한다. `COMPOSE_FILE`에 이어 붙으므로 이후 `lib.sh`·`down.sh`도 같은 스택을 본다.
- Slack 비밀값(config token, 앱의 secret·bot token)은 master key가 있어야 저장된다. Slack 시나리오([musterrolle.md](features/musterrolle.md) c·g, [web-settings.md](features/web-settings.md) 4)는 run마다 `openssl rand -hex 32`로 만든 버리는 값을 `PLATFORM_SECRET_KEY`로 export하고 같은 Bash 호출에서 `up.sh`를 부른다(그 문서의 한 줄). 사람의 Keychain 항목은 읽지 않는다. 그 밖의 시나리오는 key 없이 띄우고, api 로그에 `Secret store is off` 경고 한 줄이 남은 채 ready다.
- Orca 프로그램 안에서 돌면 무거운 작업 잠금으로 감싼다: `orch heavy <program> -- .claude/skills/verify-agent-platform/scripts/up.sh`. 내릴 때도 같다.
- 하는 일: run 디렉터리와 `ports.yml`(postgres·localstack·gitea·api 포트를 `127.0.0.1::<port>` ephemeral로, secrets는 비공개, api에 이 run의 `BOOTSTRAP_TOKEN`)을 만들고 `COMPOSE_PROJECT_NAME=verify-ap-… EXECUTION_INSTALLATION_ID=… COMPOSE_FILE=compose.yaml:ports.yml LOCAL_DEMO_ACCOUNTS=0 scripts/local.sh up --fake-model`을 돌린다(데모 계정 없이: 기능 절차가 bootstrap부터 한다). 끝나면 `docker compose port api 3000`으로 API 주소를 `state.env`에 적고 run 디렉터리를 stdout에, `run id: …`를 stderr에 출력한다. run id는 시작할 때도 stderr에 한 번 나온다. **이 run id를 기록한다.** 이후 모든 단계와 내릴 때 이것을 넘긴다. 빌드가 중간에 실패해도 시작할 때 나온 run id로 `down.sh`를 돌린다.
- 준비 표시: stderr 끝에 `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`. 로그는 `evidence/up.log`.
- 이미지 태그도 run마다 따로 둔다(`agent-platform-*:verify-ap-…`, `tests/e2e/run.sh`와 같은 방식). 기본 `:dev` 태그를 덮어쓰면 다른 스택의 scheduler가 이 checkout의 worker를 띄우게 된다. `down.sh`가 이 태그만 지운다.
- 시간: 첫 빌드는 5–10분. 이 checkout에서 이미지를 매번 다시 빌드한다. bash 도구의 timeout을 15분으로 주거나 background로 돌린다.
- 왜 ephemeral 포트인가: 기본 포트(3000·5432·4566·4567·3001)는 다른 스택이 쓰고 있을 수 있다. 이 머신에서는 3000을 다른 컨테이너가 쥐고 있어 기본값으로는 `local.sh`의 포트 점검에서 멈춘다. overlay는 `tests/e2e/compose.yml`과 같은 `ports: !override` 방식이다.

## Doctor

```sh
.claude/skills/verify-agent-platform/scripts/doctor.sh <run id>
```

run, project, 이미지를 빌드한 소스(`up.sh` 때의 HEAD + 커밋하지 않은 변경 digest, `scripts/tree-id.sh`)와 지금 checkout, API 주소, 서비스별 상태, `/readyz`를 보여 준다. ready가 아니거나 `up.sh` 뒤 HEAD나 커밋하지 않은 변경(`.claude/` 밖)이 바뀌었으면 exit 1(바뀐 코드는 `down.sh` 뒤 `up.sh`로 다시 빌드한다). 이상해 보이면 먼저 이것을 돌린다. `api`·`scheduler`·`reconciler`·`postgres`·`localstack`·`gitea`·`egress-proxy`·`fake-messages`·`secrets`가 모두 `running`(healthcheck가 있으면 `healthy`)이 아니면 exit 1이다. `/readyz`는 database·schema·config만 보므로 scheduler가 죽어도 ready다. `up.sh` 직후에는 scheduler가 몇 초 `starting`일 수 있으니 잠시 뒤 다시 돌린다(`migrate`·`gitea-init`·`worker`는 한 번 돌고 끝나 목록에 없다).

## Drive

`lib.sh`가 주는 함수. 모든 응답은 본문 뒤 마지막 줄에 HTTP 상태 코드를 붙인다.

| 함수 | 용도 |
|---|---|
| `ap_web METHOD PATH [JSON]` | 브라우저처럼 부른다: `x-requested-with: agent-platform-web` 헤더, `$VERIFY_RUN/cookie`의 세션 cookie를 보내고 응답의 `__Host-ap_session`을 저장한다. cookie 파일은 하나라 여러 사람을 몰 때는 사람마다 복사해 둔다([musterrolle.md](features/musterrolle.md) Preconditions). `Idempotency-Key`는 붙이지 않는다: 세션 POST(생성·메시지·답·제어·관리 종료)는 그 헤더를 더한 curl로 보낸다 |
| `ap_key <owner> --scopes a,b` | key CLI로 key를 발급한다. stdout에 key, stderr에 `key_id …` |
| `ap_revoke <key_id>` | key 폐기 |
| `ap_get PATH` / `ap_post PATH JSON` | `$KEY`로 Bearer 호출. `ap_post`는 `Idempotency-Key`를 새로 붙인다 |
| `ap_compose …` | 이 run의 project에만 거는 `docker compose` (`logs api`, `ps` 등) |
| `ap_as <who>` | `web-user.mjs`가 로그인시킨 사람의 cookie로 바꾸고, 그 사람의 웹 key가 있으면 `$KEY`에 담는다(길이만 출력) |

자격 값이 드는 요청과 화면은 node 스크립트로 몬다(host의 `node`, 의존성 없음). 둘 다 첫 인자가 run id다.

| 스크립트 | 용도 |
|---|---|
| `node scripts/web-user.mjs <run id> <command> <who> …` | `bootstrap`·`bootstrap-bad-token`·`login`·`login-wrong`·`login-no-csrf`·`invite <inviter> <who> <role>`·`accept`·`key <who> <personal\|service> <scopes>`. 비밀번호·token·secret은 run 디렉터리에만 두고, 응답 본문(그 칸은 `(saved, N chars)`)과 상태 코드를 출력한다. [web-login.md](features/web-login.md) |
| `node scripts/browser.mjs <run id> <command> …` | 이 run 전용 headless Chrome(CDP): `start`·`stop`, `open`, `login <who>`·`accept <who>`·`bootstrap <who>`, `shot`(`W`·`THEME` env), `blockshot`(오류 상태), `slowshot`(로딩 상태), `click`·`press`(포커스 후 키)·`type`·`select`·`key`·`eval`, `measure`(간격·폭·정렬 실측, `layout-report.mjs`가 v35 규칙 표로). [web-console.md](features/web-console.md) |

기능별 명령과 기대 결과는 `features/*.md`에 있다. 가장 짧은 한 바퀴는 [web-login.md](features/web-login.md)다.

## Evidence

- 위치: `$VERIFY_RUN/evidence/`. `up.log`, `down.log`, `leftovers.txt`는 스크립트가 쓴다. 드라이브 출력은 기능 이름으로 `tee`한다(예: `| tee "$EVIDENCE/web-login.txt"`).
- 행동과 결과를 같이 남긴다: 요청(메서드·경로), 응답 본문, 상태 코드. 바뀐 상태는 다른 경로로 다시 읽어 확인한다(로그인 뒤 `GET /v1/auth/me`, key 폐기 뒤 같은 key로 401, 세션 생성 뒤 `GET /v1/sessions/{id}`).
- 사용자 경로만 쓴다. `/internal/**`나 DB 직접 쓰기로 상태를 만들지 않는다. DB는 읽기 확인에만 쓴다(`ap_compose exec -T postgres psql -U postgres -d sessions -c '…'`).
- 기본 mock은 fake model이다. Slack 절차는 명시적으로 `infra/compose.mock-slack.yml`을 더해 외부 Slack 경계도 대체한다.
- key·cookie 값은 증거에 넣지 않는다. 남기기 전에 `sed -E 's/(csp_[A-Za-z0-9_]{2})[A-Za-z0-9_-]+/\1…/g'`처럼 가린다.

## Cleanup

```sh
.claude/skills/verify-agent-platform/scripts/down.sh <run id>
```

- run id는 필수다. 인자 없이, 또는 없는 run으로 부르면 사용법과 살아 있는 run 목록(run id, project, 실행 중인 컨테이너 수)을 stderr에 보이고 exit 2로 끝난다. 이때 compose는 하나도 부르지 않는다.

- `scripts/local.sh down`을 같은 env로 돌린다(volume까지 지우고, installation label이 붙은 worker 컨테이너·네트워크·volume도 지운다).
- 이어서 `--profile apps --profile fake-model`과 `-f compose.yaml -f ports.yml -f infra/compose.fake-model.yml`로 `down -v --remove-orphans --rmi local`(compose가 이름 붙인 `<project>-migrate` 이미지까지)을 한 번 더 한다. profile이나 fake-model overlay가 빠지면 api·scheduler·reconciler와 `fake-messages`, `<project>_default` 네트워크가 남는 일이 있었다.
- 마지막에 `docker ps -a --filter label=com.docker.compose.project=<project>`와 installation label로 남은 컨테이너를 보여 주고 `evidence/leftovers.txt`에 쓴다. 남은 것이 있으면 exit 1.
- 처음에 `browser/pid`가 있으면 `browser.mjs stop`으로 그 Chrome만 끝낸다.
- 다 성공하면 `ports.yml`(token이 든 파일), cookie, `users/`·`keys/`를 지우고, `evidence/`는 남긴다. 정리 명령이나 남은 컨테이너 조회가 하나라도 실패하면(Docker daemon 응답 없음 등) `ports.yml`을 남기고 exit 1이다. Docker를 살린 뒤 `down.sh <run id>`를 다시 돌린다. 실패한 시도 뒤에도 매번 `down.sh`를 돌린다.
- `lib.sh`와 `down.sh`는 run 상태(`state.env`, `verify-ap-*` project)를 읽지 못하면 아무 helper도 정의하지 않거나 아무것도 지우지 않고 멈춘다. 기본 project나 다른 세션의 run으로 넘어가지 않게 하려는 것이다.
- 예전 판의 스킬은 공유 `latest` 파일을 따라가 인자 없는 `down.sh`가 다른 세션의 스택을 volume까지 지웠다. 지금 스크립트는 `latest`를 쓰지도 읽지도 않는다. root에 남은 `latest` 파일은 예전 판이 쓴 것이다.

## 알려진 함정

- 절차는 zsh(Claude Code Bash 도구) 또는 bash 4 이상에서 실행한다. macOS `/bin/bash` 3.2는 중첩 command substitution의 GATE-SPEC JSON 인용을 깨뜨려 `unterminated GATE-SPEC`·`api_error`를 만들 수 있다.

- host bun이 `package.json`의 `packageManager`(bun 1.3.14)와 다르면 main에서도 실패하는 로컬 테스트가 있다. 이 스킬은 bun을 host에서 쓰지 않는다(key CLI도 api 컨테이너 안에서 돈다). 테스트 판정은 CI가 기준이다.
- `local.sh status`·`key`·`down`은 env의 `COMPOSE_PROJECT_NAME`·`COMPOSE_FILE`을 따른다. `lib.sh`를 source하지 않은 셸에서 부르면 기본 project `agent-platform`을 건드린다.
- `__Host-` cookie는 `Secure`라 curl이 http에서 저장하지 않는다. `ap_web`이 `Set-Cookie`에서 직접 꺼내 보낸다.
- 로그인은 실패가 쌓이면 잠긴다(429 `RATE_LIMITED`, `Retry-After`). 틀린 비밀번호 시험은 한두 번만.
- bootstrap은 사용자가 0명일 때 한 번만 된다. 두 번째는 409 `BOOTSTRAP_DONE`. 처음부터 다시 하려면 `down.sh` 뒤 `up.sh`.
- macOS에는 `timeout`이 없다. 필요하면 `perl -e 'alarm N; exec @ARGV' <cmd>`.

## 유지

기능이 바뀌면 [features/](features/)를 고친다. 주기 점검은 `maintain-verification-skill`로 한다.

## 데모와 추가 드라이버

기본 `up.sh`는 `LOCAL_DEMO_ACCOUNTS=0`이다. bootstrap 검증과 데모 검증은 별도 run이다.

```sh
VERIFY_DEMO_ACCOUNTS=1 .claude/skills/verify-agent-platform/scripts/up.sh
```

이 모드는 `local.sh`에 `LOCAL_DEMO_ACCOUNTS=1`을 넘긴다. `LOCAL_DEMO_DATA=0`을 함께 주면 계정만 만든다. 기본값은 fake model 데모 에이전트·세션도 만든다. 절차는 `P-DEMO-SEED`다. 기존 사용자·데이터를 덮어쓰지 않는다.

`web-user.mjs <run id> demo-login owner|member`는 소스의 데모 계정으로 로그인하고 `users/demo-owner|demo-member`와 cookie를 저장한다. 비밀번호를 명령에 적지 않는다.
`web-user.mjs <run id> slack-config owner <workspace id>`는 mock config token을 컨테이너 안에서 받아 저장한다.
`web-user.mjs <run id> slack-event <agent id> <challenge|event|duplicate|bad|stale|malformed|bot>`는 이 run의 Slack 앱 signing secret을 컨테이너 안에서 읽어 HMAC을 계산한다. secret을 출력하지 않는다. `event`는 `EvVerify1`, `duplicate`는 같은 event id다. 새 overlay run에서 한 번 실행한다. mock overlay가 아니면 거절한다. 상세 전제는 `P-SLACK-INBOUND`다.

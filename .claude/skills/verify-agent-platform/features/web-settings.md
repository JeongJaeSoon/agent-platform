# 웹 로그인 선택·팀·연동 계정·API key·워크스페이스 설정

로그인 화면은 비밀번호와 Google 중 고르게 한다(Google을 설정했을 때만 Google 버튼). 로그인한 사람은 메뉴에서 팀(owner·admin), 연동 계정, API key, 워크스페이스 설정(owner·admin)으로 간다. 화면 전체를 못 쓰는 메뉴는 `GET /v1/auth/me`의 `permissions`로 숨기고, 화면 안에서 역할이 못 쓰는 버튼은 보이되 비활성이며 서버 403과 같은 이유(`"<action> 권한이 있어야 할 수 있습니다. 지금 역할: <역할>."`)가 붙는다. 서버가 판정한다.

## Sub-features

- `login-choice` `/login`에 비밀번호 폼과 "또는" 아래 "Google로 로그인". `GET /v1/auth/login-methods`가 `password`만 주면 Google 버튼은 없다.
- `google-callback` Google이 `/auth/google/callback?code&state`로 돌려보내면 한 번만 교환하고 로그인 전 경로(없으면 `/`)로 간다. 401·403·409(`LOGIN_LINK_REQUIRED`)·취소는 각자의 문구.
- `menu-by-role` member 메뉴: 홈·구성원·에이전트·연동 계정·API key. owner·admin은 팀과 워크스페이스 설정이 더 있다.
- `teams` `/teams` 만들기(같은 이름 409 안내) → `/teams/{id}` 이름 바꾸기, 구성원 추가(수락 없음)·빼기, 삭제(확인 대화상자).
- `agent-admins` `/agents/{id}` 끝의 "에이전트 관리자": 사람·팀 지정과 해제. 관리자가 아니면 이유만 보이고 관리자 목록을 묻지 않는다.
- `linked-slack` `/settings/linked-accounts` "Slack 계정 연결" → Slack 동의 → `/settings/linked-accounts/slack` 콜백이 목록으로 돌아온다 → "연결 해제". 연결은 Slack 워크스페이스마다 하나라, 연결이 있어도 버튼은 남는다(다른 워크스페이스 연결).
- `api-keys` `/settings/api-keys` 개인 key(지금 가진 scope 안에서), 서비스 key 영역의 "발급자가 떠나도 유효", "워크스페이스 서비스 key 발급"(api_key.manage 없으면 비활성+이유), "에이전트 전용 key 발급"(관리하는 에이전트, owner·admin은 전체에서 고름. `sessions:approve`는 빼고 보낸다). 발급한 값은 한 번만 보이고 "복사했으니 닫기"로 사라진다. 목록에서 폐기(확인).
- `audit-retention` `/settings/workspace` 감사 기록 보존 기간. owner만 저장, admin은 입력·저장이 비활성+이유. 29일은 서버 400 → "감사 기록은 30일보다 짧게 보존할 수 없습니다…".

## How to get to it (user POV)

- 상단 nav의 "팀"·"연동 계정"·"API key"·"워크스페이스 설정", 에이전트 상세 페이지 끝.
- member·admin은 [web-members-agents.md](./web-members-agents.md)의 초대·수락으로 만든다. 사람마다 cookie 파일을 둔다(`cp "$VERIFY_RUN/cookie" "$VERIFY_RUN/cookie.<이름>"`).

## Driving it with lib.sh

Preconditions: `up.sh infra/compose.mock-slack.yml`로 띄웠다(Orca에서는 `orch heavy <program> -- …`). owner bootstrap 뒤 `ap_web POST /v1/auth/login`(bootstrap은 cookie를 주지 않는다), member 초대·수락. `orch hold browser --note "<what>"`.

1. **Google 선택지.** 기본 스택은 Google이 꺼져 있다(`login-methods` → `["password"]`). 켜려면 host에서 mock IdP를 띄우고(PID를 적는다) api만 Google env로 다시 만든다. 이때 `COMPOSE_FILE`에 `infra/compose.fake-model.yml`을 꼭 더하고(빠지면 api가 `ANTHROPIC_API_KEY`를 찾다 죽는다), api 포트를 run의 포트로 고정한다(빠지면 새 임의 포트로 떠 `$API`가 어긋난다).

   ```sh
   MOCK_OIDC_PORT=4031 MOCK_OIDC_ISSUER=http://host.docker.internal:4031 MOCK_OIDC_PUBLIC_URL=http://127.0.0.1:4031 \
     nohup bun run packages/testkit/src/mock-oidc-main.ts > "$VERIFY_RUN/mock-google.log" 2>&1 & echo $! > "$VERIFY_RUN/mock-google.pid"
   cat > "$VERIFY_RUN/google.yml" <<EOF
   services:
     api:
       environment:
         GOOGLE_OIDC_CLIENT_ID: mock-client
         GOOGLE_OIDC_CLIENT_SECRET: mock-secret
         GOOGLE_OIDC_ISSUER: http://host.docker.internal:4031
         GOOGLE_OIDC_REDIRECT_URI: $API/auth/google/callback
       ports: !override
         - "127.0.0.1:${API##*:}:3000"
   EOF
   export COMPOSE_FILE="$COMPOSE_FILE:$VERIFY_REPO/infra/compose.fake-model.yml:$VERIFY_RUN/google.yml"
   orch heavy <program> -- bash -c 'cd "$0" && docker compose --profile apps --profile fake-model up -d --no-build --no-deps --wait api' "$VERIFY_REPO"
   curl -sS "$API/v1/auth/login-methods"     # {"methods":["password","google"]}
   ```

   owner가 `google@example.test`를 초대해 두고, `/login`에서 "Google로 로그인"을 누른다. mock은 `login_hint`(claims JSON의 base64url)가 없으면 `bad authorization request`이므로, 이동한 URL 끝에 붙여 다시 연다: `{"sub":"g-verify-1","email":"google@example.test","email_verified":true,"hd":"example.test","name":"Google Member"}`. 콜백 화면을 거쳐 `/`에 "Google Member(google@example.test)으로 로그인했습니다". 끝나면 `kill "$(cat "$VERIFY_RUN/mock-google.pid")"`.
2. **팀과 관리자.** owner로 `/teams`에서 팀을 만들고 상세에서 member를 추가 → "아직 구성원이 없습니다" 자리에 그 사람. 에이전트(`ap_web POST /v1/agents`·`/releases`로 만든 `research`) 상세 끝 "관리자로 지정할 팀"에서 그 팀 → "…을(를) 관리자로 지정했습니다".
3. **에이전트 전용 key.** member로 `/settings/api-keys`: "워크스페이스 서비스 key 발급"은 비활성이고 이유 `api_key.manage 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.`(같은 요청을 `ap_web POST /v1/api-keys '{"kind":"service","scopes":["sessions:read"]}'`로 보내면 `403` `This principal does not hold api_key.manage`). 에이전트 select에는 관리하는 `research`만. `sessions:write`를 더해 발급 → "새 key" 영역. 값은 화면에 찍지 말고 `orca eval --expression 'document.querySelector("section[aria-label=\"새 key\"] input").value'`를 `umask 077` 파일로만 받는다. 그 key로 `ap_post /v1/sessions` 본문에 `research` release → `201`, 다른 에이전트 release → `403` `agent_ceiling`.
4. **Slack.** mock 발급자(`http://mock-slack:4020`)는 compose 안에서만 닿고, overlay의 리디렉션 주소는 `127.0.0.1:3000`이다. 버튼을 누르면 화면이 동의 URL로 떠나 `chrome-error://`가 된다(시작 요청과 이동까지는 확인된다). 같은 탭을 `orca goto --url "$API/settings/linked-accounts"`로 돌려놓고(상대 경로 fetch가 API origin에서 돌아야 한다), 브라우저 cookie를 그대로 쓰도록 페이지 안에서 시작한다: `orca eval --expression 'fetch("/v1/linked-accounts/slack/start",{method:"POST",headers:{"x-requested-with":"agent-platform-web"}}).then(r=>r.json()).then(j=>j.authorize_url)'` → `ap_compose exec -T api bun -e 'const r = await fetch(process.argv[1], { redirect: "manual" }); console.log(r.headers.get("location"))' "$AUTH"` → 결과의 `127.0.0.1:3000`을 `$API` 호스트:포트로 바꿔 `orca goto`. 콜백 화면이 목록으로 돌아와 `Slack 사용자 U0MOCK (워크스페이스 T0MOCK)`, "연결 해제" → "Slack 계정 연결을 해제했습니다.", DB `revoked | unlinked | 2`. 설치 행은 [musterrolle.md](./musterrolle.md) c처럼 repository로 만든다.
5. **감사 보존.** owner로 `/settings/workspace`, 값 `29` → 저장 → alert "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요."와 api 로그 `POST … audit-retention 400`. member가 같은 API를 부르면 `403` `Only an owner can change audit retention`, member 메뉴에는 "워크스페이스 설정"이 없다.

- 2026-10-11 run `20261011-232746-64155`에서 이 순서대로 확인했다. 스크린샷 `evidence/m10-*.png`, API 출력 `evidence/m10-*.txt`.

## Gotchas

- `orca click`은 화면 밖 요소를 스크롤하지 않고 그 좌표의 `<html>`을 누른다. 아무 일도 안 일어나면 `orca eval --expression '<요소>.scrollIntoView({block:"center"})'` 뒤 다시 누른다. 같은 탭에서 이런 일이 쌓이면 `orca tab close` 뒤 새 탭을 연다(cookie는 남는다).
- 입력은 `orca click`으로 포커스한 뒤 `orca type`이 확실하다. `fill`은 값을 바꾸고도 React가 못 보는 일이 있었다. select는 `orca select`(label이 아니라 option의 value).
- select를 바꾼 직후 버튼이 아직 비활성일 수 있다. 다시 snapshot해 `disabled`가 빠진 것을 보고 누른다.
- 비밀값(key `csp_…`, invite token, bootstrap token)이 snapshot·state 출력에 섞인다. 화면에 key가 떠 있는 동안 snapshot을 출력하지 말고, 그 상태로 스크린샷을 남기지 않는다. 노출했으면 확인이 끝난 뒤 그 key를 폐기한다.
- Google env를 넣어 api를 다시 만든 스택은 `down.sh`가 그대로 지운다. host의 mock IdP는 `down.sh`가 모르므로 적어 둔 PID로 끈다.

# 웹 로그인

웹 사용자는 이메일·비밀번호로(설정했으면 Google로도) 로그인해 `__Host-ap_session` cookie를 받고, 웹 앱은 `GET /v1/auth/me`로 누가 어느 workspace에서 어떤 scope·권한(`permissions`)으로 로그인했는지 읽는다. 로그인 화면은 `GET /v1/auth/login-methods`로 고를 수 있는 수단을 읽는다. 설치 직후 첫 owner와 workspace는 bootstrap token으로 한 번만 만든다. 여기서는 브라우저가 보내는 요청을 curl로 그대로 보낸다. 화면으로 모는 절차는 [web-console.md](./web-console.md)다.

## Sub-features

- `bootstrap` 사용자가 0명일 때 token으로 첫 owner와 workspace를 만든다.
- `bootstrap-once` 두 번째 bootstrap은 409 `BOOTSTRAP_DONE`.
- `bootstrap-bad-token` 틀린 token은 401.
- `login` 맞는 비밀번호로 200, role·scopes·expires_at과 cookie.
- `login-csrf` `x-requested-with` 헤더가 없으면 403.
- `login-bad-password` 틀린 비밀번호는 401 `Invalid email or password`.
- `login-methods` `GET /v1/auth/login-methods` → `{"methods":["password"]}`. Google env(`GOOGLE_OIDC_CLIENT_ID`·`SECRET`·`REDIRECT_URI`)가 있으면 `["password","google"]`.
- `google-off` Google을 설정하지 않은 스택에서 `POST /v1/auth/google/start`·`/callback` → `404` `Google sign-in is not configured`(CSRF 헤더가 없으면 그 전에 `403`). Google로 실제 로그인하는 절차는 [web-settings.md](./web-settings.md)의 mock IdP다.
- `me` cookie로 principal·user·workspace(`settings` 포함)·scopes·`permissions`를 읽는다. cookie가 없으면 401.
- `logout` 204, 그 뒤 `me`는 401.

## How to get to it (user POV)

- 웹 콘솔의 `/bootstrap` 화면이 `POST /v1/auth/bootstrap`을 부른다.
- 웹 콘솔의 `/login` 화면이 `GET /v1/auth/login-methods`와 `POST /v1/auth/login`(Google을 고르면 `POST /v1/auth/google/start`, 돌아온 `/auth/google/callback`이 `POST /v1/auth/google/callback`)을, 앱 부팅이 `GET /v1/auth/me`를, 로그아웃이 `POST /v1/auth/logout`을 부른다.
- 이 파일은 위 요청을 `ap_web`으로 보낸다. API reference(`/docs`)에도 같은 경로가 있다.

## Driving it with lib.sh

Preconditions:

- 이 run에서 bootstrap을 아직 하지 않았다(새 `up.sh` 직후).
- `$VERIFY_BOOTSTRAP_TOKEN`이 `state.env`에 있다. 값은 출력하지 않는다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
OWNER=$(jq -nc --arg t "$VERIFY_BOOTSTRAP_TOKEN" '{bootstrap_token:$t, email:"owner@example.test", password:"verify-owner-pass-1", display_name:"Verify Owner", workspace_name:"Verify", workspace_slug:"verify"}')
```

- **로그인 전.** `ap_web GET /v1/auth/me` → `401`, `error.code` `UNAUTHORIZED`.
- **로그인 수단.** `ap_web GET /v1/auth/login-methods` → `200` `{"methods":["password"]}`. `ap_web POST /v1/auth/google/start` → `404` `Google sign-in is not configured`.
- **틀린 token.** `ap_web POST /v1/auth/bootstrap "$(echo "$OWNER" | jq -c '.bootstrap_token="0000000000000000000000000000000000000000"')"` → `401` `Bootstrap token is invalid`.
- **bootstrap.** `ap_web POST /v1/auth/bootstrap "$OWNER"` → `201`, `role: "owner"`, `workspace.slug: "verify"`.
- **두 번째.** 같은 명령 → `409` `BOOTSTRAP_DONE`.
- **CSRF.** `curl -sS -w '\n%{http_code}\n' "$API/v1/auth/login" -H 'Content-Type: application/json' -d '{"email":"owner@example.test","password":"verify-owner-pass-1"}'` → `403` `Refused: x-requested-with header is required`.
- **틀린 비밀번호.** `ap_web POST /v1/auth/login '{"email":"owner@example.test","password":"wrong-password-123"}'` → `401` `Invalid email or password`.
- **로그인.** `ap_web POST /v1/auth/login '{"email":"owner@example.test","password":"verify-owner-pass-1"}'` → `200`, `role: "owner"`, scopes 다섯 개(`sessions:read`·`write`·`approve`·`control`·`recover`). `$VERIFY_RUN/cookie`가 생긴다.
- **me.** `ap_web GET /v1/auth/me` → `200`, `principal.kind: "user"`, `user.email: "owner@example.test"`, `workspace.slug: "verify"`, `workspace.settings`(`audit_retention_days: 90`, `slack_guest_enabled: false` 등), owner의 `permissions` 열다섯(`member.manage`, `api_key.manage` 등).
- **로그아웃.** `ap_web POST /v1/auth/logout` → `204`. 이어서 `ap_web GET /v1/auth/me` → `401`.
- **증거.** 위 블록을 `{ …; } 2>&1 | tee "$EVIDENCE/web-login.txt"`로 감싼다. cookie 값은 출력되지 않는다.

## Gotchas

- `__Host-` cookie는 `Secure`라 curl의 cookie jar(`-c`/`-b`)가 http에서 저장하지 않는다. `ap_web`을 쓴다.
- 로그인 실패가 쌓이면 잠긴다(429 `RATE_LIMITED`). 틀린 비밀번호는 한 번만 시험한다.
- 비밀번호는 12자 이상이다. 짧으면 400.
- bootstrap token 없이 띄운 스택(기본 `local.sh up`)은 token을 api 로그(stderr)에 한 번 찍는다. 이 스킬은 run마다 token을 정해 넣으므로 로그를 읽지 않는다.
- member 초대·수락·역할 변경은 [musterrolle.md](./musterrolle.md) a, 화면은 [web-members-agents.md](./web-members-agents.md).
- `ap_web`은 `__Host-ap_session`만 저장한다. Google 시작 cookie(`__Host-ap_google_login`)는 나르지 않으니 Google 흐름은 브라우저로 몬다.

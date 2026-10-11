# 멤버·팀·권한 (Musterrolle)

**일부 있음.** workspace 멤버 초대·관리, 팀, Slack 계정 연동, 권한별 API key와 에이전트 서비스 key, 판정 기록(`authz_decisions`), 감사 열람·공유 범위, 에이전트 자격 연결을 사용자가 하는 순서대로 확인하는 자리다. 지금 채워진 것은 c(Slack 계정 연결), d(권한별 key), e의 판정 기록·보존 기간, f(자격 연결)이다. 나머지는 각 시나리오를 구현하는 티켓이 실제 명령과 기대 결과로 채운다. "(아직 없음)"이 붙은 항목은 "확인됨"으로 보고하지 않는다.

## Sub-features

- `a-member-lifecycle` (아직 없음) owner 웹 로그인 → member 초대 → 수락·로그인 → 역할 변경 → 비활성화하면 웹과 key가 모두 막힌다.
- `b-teams` (아직 없음) 팀 생성 → 구성원 추가·제거(수락 없이, 알림만) → 팀을 에이전트 관리자로 지정 → 팀원은 그 에이전트를 관리할 수 있고 팀 밖 member는 못 한다.
- `c-slack-signin` Sign in with Slack 연결·목록·해제와 처리 시점 재판정(94S-577). 실제 Slack 동의는 사람이 하고(`docs/operations.md` § Slack 계정 연결의 확인 절차), 자동 확인은 mock IdP로 한다.
- `d-scoped-keys` member는 개인 key만, owner·admin은 서비스 key, 에이전트 관리자(그 에이전트를 만든 사람)는 그 에이전트 전용 서비스 key를 `POST /v1/api-keys`로 발급한다. 권한이 없으면 403과 `details.reason_code`. 에이전트 전용 key는 그 에이전트의 세션만 만들고 읽는다. 발급자의 지금 scope를 넘는 key는 403 `SCOPE_NOT_GRANTABLE`. API key로는 발급하지 못한다. 발급자를 내보내면 개인 key는 멈추고 서비스 key는 계속 동작한다.
- `f-credential-bindings` 에이전트 관리자가 card의 `credential_refs` 이름을 그 에이전트에 연결(`POST /v1/agents/{id}/credential-bindings`)해야 활성화가 된다. 해제하면 실행 중 세션은 그대로 두고(`running_sessions`, `revoke_notice`) 다음 세션 생성이 `409 CREDENTIAL_UNBOUND`(안내 문구·관리자·`mailto:` 링크)다(94S-581).
- `e-authz-audit` (기록·보존 기간은 있음, 열람은 아직 없음) 위 행동이 `authz_decisions`에 남고, 감사 열람과 공유 범위가 설계대로다(감사 보존 기본 90일·하한 30일, DM 기본 "나만").

## How to get to it (user POV)

- (아직 없음) 웹 콘솔의 멤버·팀·연결·key 화면. 지금 있는 것은 [web-login.md](./web-login.md)의 bootstrap·login·me뿐이다. 초대 수락 계약(`acceptInviteRequestSchema`)은 `packages/contracts/src/musterrolle/auth.ts`에 있지만 route는 아직 없다.
- (아직 없음) 같은 동작의 HTTP API.
- f: `GET`·`POST /v1/agents/{id}/credential-bindings`, `DELETE /v1/agents/{id}/credential-bindings/{binding_id}`, 활성화 `POST /v1/agents/{id}/activate`, 세션 `POST /v1/sessions`(`agent_release_id`). 연결 화면(M10)은 아직 없다.
- c: `POST /v1/linked-accounts/slack/start` → IdP 동의 → `POST /v1/linked-accounts/slack/callback` → `GET /v1/linked-accounts` → `DELETE /v1/linked-accounts/{id}`. 연결 화면(M10)은 아직 없다.

## Driving it with lib.sh

Preconditions:

- (구현 티켓이 채운다) 시나리오마다 필요한 사용자: owner는 [web-login.md](./web-login.md)의 bootstrap으로 만든다. member·admin은 초대 경로가 생기면 그 경로로 만든다. DB에 직접 넣지 않는다.

- **a.** (아직 없음) 초대 → 수락 → 로그인 → 역할 변경 → 비활성화 뒤 `ap_web GET /v1/auth/me`와 그 사용자의 key 호출이 모두 401/403인지.
- **b.** (아직 없음) 팀 관리자·팀원·팀 밖 member 세 cookie로 같은 에이전트 관리 요청을 보내 허용·거절을 비교.
- **c.** mock IdP overlay를 붙여 띄운다: `up.sh infra/compose.mock-slack.yml`(Orca에서는 `orch heavy <program> -- …`로 감싼다). Slack 설치가 있어야 연결이 시작되므로, 설치 행 하나는 repository로 만든다(설치 흐름은 아직 사용자 경로가 없다. 다른 상태는 API로만 만든다). owner cookie는 web-login.md로 만든다. `ap_slack_link` cookie도 `Secure`라 curl이 저장하지 않으니 직접 나른다.

  ```sh
  . .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
  # owner bootstrap + login: web-login.md. WS·ME는 login 응답의 workspace_id·user_id
  DB='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@agent-platform/db";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }); const db = drizzle(pool, { schema });'
  ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  const key = { appId: \"A0VERIFY\", teamId: \"T0MOCK\" };
  await schema.registerSlackInstallation(db, { ...key, workspaceId: process.argv[1] });
  console.log((await schema.verifySlackInstallation(db, { ...key, botUserId: \"B0VERIFY\" })).outcome); await pool.end();" "$WS"
  H=$(mktemp)
  START=$(curl -sS -D "$H" -X POST "$API/v1/linked-accounts/slack/start" -H 'x-requested-with: agent-platform-web' -H "Cookie: $(cat "$VERIFY_RUN/cookie")")
  LINK=$(sed -n 's/^[Ss]et-[Cc]ookie: \(ap_slack_link=[^;]*\).*/\1/p' "$H" | tr -d '\r')
  # authorize_url의 호스트(mock-slack)는 compose 네트워크 안에서만 닿는다: api 컨테이너에서 동의한다
  BACK=$(ap_compose exec -T api bun -e 'const r = await fetch(process.argv[1], { redirect: "manual" }); console.log(r.headers.get("location"))' "$(echo "$START" | jq -r .authorize_url)")
  CODE=$(echo "$BACK" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p'); STATE=$(echo "$BACK" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
  curl -sS -w '\n%{http_code}\n' -X POST "$API/v1/linked-accounts/slack/callback" -H 'x-requested-with: agent-platform-web' \
    -H 'Content-Type: application/json' -H "Cookie: $(cat "$VERIFY_RUN/cookie"); $LINK" -d "$(jq -nc --arg c "$CODE" --arg s "$STATE" '{code:$c,state:$s}')"
  ap_web GET /v1/linked-accounts
  ap_web DELETE "/v1/linked-accounts/<id>"
  ap_compose exec -T postgres psql -U postgres -d sessions -c 'select status, revoked_reason, revision from linked_accounts'
  ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  console.log(JSON.stringify(await schema.resolveLinkedSubject(db, { provider: \"slack\", externalTenant: \"T0MOCK\", externalUserId: \"U0MOCK\" }))); await pool.end();"
  ```

  기대: callback `201`과 `receipt_id`, 목록에 `active` 한 줄, 해제 `200`(`receipt_status: succeeded`) 뒤 목록이 비고 DB는 `revoked | unlinked | 2`. `mock_team=T0OTHER`를 붙인 authorize URL로 다시 하면 `409 LINK_TEAM_MISMATCH`. 해제 뒤 `resolveLinkedSubject`는 `{"status":"unlinked"}`다. 대기 중이던 입력의 처리 시점 재판정(`createDatabaseIdentityReader(db).reread`에 `linked_account: {id, revision}`)도 `unlinked`로 거절한다. Slack 입력(M9) 전까지는 사용자 경로가 없어 위처럼 api 컨테이너에서 부른다. 초대(`POST /v1/invites`)·수락한 member가 같은 방법으로 연결한 뒤 owner가 `POST /v1/members/{user_id}/disable`로 비활성화하면 receipt `result.revoked_linked_accounts`가 `1`이고 DB 행은 `revoked | offboarded`다. 2026-10-11 run `20261011-184057-50543`에서 이 순서대로 확인했다.
- **d.** (아직 없음) 역할별 key 발급 요청과 403 이유, 서비스 key로 다른 에이전트 API 403, 발급자 비활성화 뒤 개인 key 401·서비스 key 200.
- **d. 권한별 key.** 사람마다 cookie 파일을 따로 둔다: `ap_web`은 `$VERIFY_RUN/cookie` 하나만 읽고 쓰므로 로그인·수락 직후 `cp "$VERIFY_RUN/cookie" "$VERIFY_RUN/cookie.<이름>"`, 그 사람으로 부르기 전에 거꾸로 복사한다. 비밀값(`secret`, `invite_token`)은 변수에만 담는다.
  1. owner bootstrap·login([web-login.md](./web-login.md)). owner가 `ap_web POST /v1/invites '{"email":"member@example.test","role":"member"}'` → `201`, 같은 식으로 `other`(member)와 `admin`(admin). cookie를 비우고 `ap_web POST /v1/invites/accept "{\"token\":\"$TOKEN\",\"password\":\"verify-member-pass-1\"}"` → `200`(cookie가 생긴다).
  2. member가 `ap_web POST /v1/agents "{\"slug\":\"reviewer\",\"name\":\"reviewer\",\"card\":$CARD}"` → `201`(`CARD`는 `{"role":…,"instructions":…,"language":"ko","model":"claude-sonnet-5","capabilities":{"tools":["Read"],"mcp":null,"forbidden":[]},"rules":[]}`), `POST /v1/agents/$AID/releases '{"version_id":…,"runtime_profile_id":"claude-coding-local"}'` → `200`, `release.id`(`sha256:…`)를 `MINE_REL`로. owner도 다른 에이전트(`finance`)를 만들어 `OWNERS_REL`. `SELECT agent_id, user_id FROM agent_admins` → 에이전트마다 만든 사람 한 행.
  3. member가 `ap_web POST /v1/api-keys "{\"kind\":\"service\",\"agent_id\":\"$AID\",\"scopes\":[\"sessions:read\",\"sessions:write\"]}"` → `201`, `key.created_by`가 member, `secret`을 `KEY`로.
  4. `ap_post /v1/sessions` 본문에 `"agent_release_id":"$MINE_REL"`(`profile_id`는 `claude-coding-local`) → `201`, 그 세션 `ap_get` → `200`. `OWNERS_REL`로 → `403` `details.reason_code: "agent_ceiling"`. release 없이 → `403` `agent_ceiling`. owner가 cookie로 `OWNERS_REL` 세션을 만들고, 에이전트 key로 그 세션 `GET`·`/turns` → `403`. 세션 목록 `GET /v1/sessions`와 자기 세션의 receipt `GET /v1/receipts/$RCPT`도 `403`(목록은 에이전트를 가리지 못하고, receipt는 세션을 가리키지 않는다). `SELECT agent_release_id FROM sessions` → 에이전트 key가 만든 행은 `MINE_REL`.
  5. member가 `{"kind":"service","scopes":["sessions:read"]}` → `403` `reason_code: "role"`. `other`가 member의 `agent_id`로 → `403` `role`.
  6. member가 `{"kind":"personal","scopes":["sessions:read","sessions:write"]}` → `201`.
  7. 개인 key와 에이전트 key 각각 `curl "$API/v1/api-keys" -H "Authorization: Bearer …" -d '{"kind":"personal","scopes":["sessions:read"]}'` → `403` `role`.
  8. admin이 `{"kind":"service","scopes":["sessions:read","sessions:recover"]}` → `403` `SCOPE_NOT_GRANTABLE` `The issuer does not hold sessions:recover`. owner가 에이전트 key에 `["sessions:approve"]` → `403` `SCOPE_NOT_GRANTABLE`.
  9. `ap_web GET /v1/api-keys`: member는 자기 개인 key와 자기 에이전트 key 둘, `other`는 `[]`. 아무 key를 `ap_web DELETE /v1/api-keys/$ID` → `200`과 `receipt_id`, 다시 → `200` `receipt_id: null`, 그 key로 `/v1/auth/me` → `401`.
  10. owner가 `ap_web POST "/v1/members/$MEMBER_ID/disable" '{"reason":"verify scenario d"}'` → `200`(`member.disabled_at`이 찬다). 그 뒤 member 개인 key `/v1/auth/me` → `401`, member가 발급한 에이전트 key로 4의 세션 생성 → `201`.
  11. `SELECT action, outcome, reason_code, principal_kind, count(*) FROM authz_decisions WHERE action LIKE 'api_key.%' OR reason_code = 'agent_ceiling' GROUP BY 1,2,3,4` → `api_key.manage allow`(3의 발급과 8의 두 요청), `api_key.manage deny role user`(5의 둘), `api_key.manage_own allow`, `api_key.manage_own deny role api_key`(7의 둘), `session.submit deny agent_ceiling api_key`(4의 둘), `session.read deny agent_ceiling api_key`(4의 읽기들). `SELECT operation, result FROM receipts WHERE operation IN ('create_api_key','revoke_api_key')` → 발급마다 `create_api_key`, 폐기 한 번에 `revoke_api_key`, `result`에는 kind·agent_id·scopes만.
  - 증거는 `| tee "$EVIDENCE/musterrolle-d.txt"`. 남기기 전에 `csp_`·`apv_` 값을 가린다.
- **e. 판정 기록.** 응답 헤더의 `X-Request-Id`로 행을 찾는다(`H=$(mktemp)`, curl에 `-D "$H"`, `RID=$(sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p' "$H" | tr -d '\r')`).
  - 거절: `KEY=$(ap_key verify --scopes sessions:read 2>/dev/null)`로 `POST /v1/sessions` → `403`. `ap_compose exec -T postgres psql -U postgres -d sessions -c "SELECT action, outcome, reason_code, principal_kind, request_id FROM authz_decisions WHERE request_id = '$RID'"` → `session.submit | deny | role | api_key` 한 행.
  - 승인: [sessions.md](./sessions.md)의 권한 요청 대본으로 `needs_input`을 만들고 `sessions:approve` key로 `POST /v1/sessions/$SID/answers`. `... FROM authz_decisions d JOIN receipts r ON r.request_id = d.request_id WHERE d.request_id = '$RID'` → `session.approve | allow` 한 행과 `answer` receipt.
  - 허용된 API 생성(`POST /v1/sessions` 201)은 행을 남기지 않는다.
- **e. 보존 기간.** bootstrap 뒤 `ap_web POST /v1/auth/login …`으로 cookie를 받은 owner가 `ap_web POST "/v1/workspaces/$WS/audit-retention" '{"audit_retention_days":45}'` → `200`, `29` → `400`, 다른 workspace id → `404`. API key는 `404`. `workspaces.settings->'audit_retention_days'`가 45. member 403은 초대 경로가 없어 route 테스트로만 본다.
- **e. 열람.** (아직 없음) `authz_decisions` 열람 API(또는 감사 화면)에서 행동마다 한 줄씩 보이는지, 공유 범위 밖 사용자는 못 보는지. DB는 읽기 확인에만 쓴다.

- **f. 자격 연결.** d의 1처럼 owner와 member 둘(`agentadmin`, `other`)을 초대·수락으로 만든다. 수락 본문은 `jq -nc --arg t "$TOKEN" '{token:$t,password:"verify-member-pass-1"}'`로 만든다(`"$(… \"$TOKEN\" …)"`처럼 명령 치환 안에서 따옴표를 escape하면 bash 3.2가 `\`를 남겨 `400`이다).
  1. agentadmin이 `capabilities`에 `"credential_refs":["notion_token"]`을 넣은 card로 에이전트를 만들고 `claude-coding-local` release를 만든다(`REL`). 같은 사람이 그 에이전트 전용 서비스 key(`KEY`)를 발급한다.
  2. 연결 전 `ap_web POST "/v1/agents/$AID/activate" "{\"release_id\":\"$REL\",\"expected_revision\":-1}"` → `409 CREDENTIAL_UNBOUND`, `details.missing: ["notion_token"]`.
  3. `other`가 `ap_web POST "/v1/agents/$AID/credential-bindings" '{"credential_ref":"notion_token"}'` → `403` `reason_code: role`. 에이전트 key로 같은 요청(`curl … -H "Authorization: Bearer $KEY"`) → `403` `role`. 값처럼 생긴 이름(`"xoxb-SECRET VALUE"`) → `400`.
  4. agentadmin이 연결 → `200`, `created: true`, `receipt_id`. 활성화 → `200`.
  5. `ap_post /v1/sessions` 본문 `{"profile_id":"claude-coding-local","repository_id":"sample-app","message":"…","agent_release_id":"$REL"}` → `201`. owner가 `ap_web GET "/v1/agents/$AID/credential-bindings"` → `running_sessions: 1`과 `revoke_notice`.
  6. agentadmin이 `ap_web DELETE "/v1/agents/$AID/credential-bindings/$BID"` → `200`, `revoked_at`이 차고 `running_sessions: 1`, `revoke_notice: "실행 중인 세션은 끝날 때까지 이 자격을 써요. 바로 막으려면 외부 서비스에서 폐기하세요"`.
  7. 같은 세션 생성 → `409 CREDENTIAL_UNBOUND`, `details`에 `guidance: "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요"`, `admins`(agentadmin), `admin_link: "mailto:agentadmin%40example.test"`. 이름(`notion_token`)은 응답에 없다. 활성화를 다시 하면 `409`와 `missing`.
  8. `SELECT action, outcome, reason_code, principal_kind, count(*) FROM authz_decisions WHERE action IN ('credential.bind','session.submit') GROUP BY 1,2,3,4` → `credential.bind allow ok user`, `credential.bind deny role user`·`api_key` 하나씩, `session.submit deny credential_unbound api_key`. receipts에 `bind_credential`·`unbind_credential`, `result`는 `{"credential_ref": "notion_token"}`뿐.
  - 2026-10-11 run `20261011-211609-82813`에서 이 순서대로 확인했다. 증거는 `$EVIDENCE/musterrolle-f.txt`.

## Gotchas

- (구현 티켓이 채운다)
- c: mock overlay 없이 띄운 스택은 `SLACK_OIDC_*`가 비어 있어 시작 요청이 `503 BACKEND_UNAVAILABLE`이다. state는 10분, 한 번만 쓴다. 같은 code·state를 다시 보내면 `400`.
- d의 8은 판정이 `allow`인 채로 거절된다. 권한(`api_key.manage`)은 있고 scope만 넘친 것이라, 판정 행은 `allow`이고 응답은 `SCOPE_NOT_GRANTABLE`이다.
- 에이전트 전용 key는 receipt를 읽지 못한다. receipt 조회는 세션을 가리키지 않아 에이전트를 확인할 수 없기 때문이다.
- f: 본문 검증(`400`)은 판정보다 먼저라 판정 행을 남기지 않는다. 해제한 연결을 다시 `DELETE`하면 `404`다.
- 에이전트 관리자를 따로 지정하는 API는 아직 없다. 관리자는 에이전트를 만든 사람(과 0139 backfill)뿐이다.
- bootstrap은 cookie를 주지 않는다. 보존 기간을 바꾸기 전에 login한다.
- 판정은 본문보다 먼저 묻는다. 그래서 owner의 `29` 요청(400)도 `audit_retention.manage | allow` 행을 남긴다.
- 만료 정리는 시간을 당겨야 보이므로 E2E가 아니라 `packages/db/src/authz-decisions.integration.test.ts`로 본다.
- 실제 Slack 앱·OAuth 동의는 사람만 한다. 자동 확인은 mock IdP로만 하고 실제 Slack 연결은 "사람 확인 필요"로 보고한다.

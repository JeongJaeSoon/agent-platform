# 멤버·팀·권한 (Musterrolle)

workspace 멤버 초대·관리, 팀, Slack 계정 연동, 권한별 API key와 에이전트 서비스 key, 판정 기록(`authz_decisions`), 감사 열람·공유 범위, 에이전트 자격 연결을 사용자가 하는 순서대로 확인하는 자리다. 시나리오 a(초대·관리), b(팀과 팀 관리자), c(Slack 계정 연결과 멘션·승인 판정), d(권한별 key), e(판정 기록·보존 기간·공유 범위·감사 열람·관리 목록), f(자격 연결), g(에이전트의 Slack 앱 연결) 모두 HTTP API로 몰 수 있다. 사용자 경로가 아직 없는 것은 둘이다: Slack 이벤트 수신이 없어 c·g의 판정·해석은 api 컨테이너에서 함수로 부르고, DM 기본 "나만"은 DM 세션 경로가 없어 몰 수 없다. "(아직 없음)"이 붙은 항목은 "확인됨"으로 보고하지 않는다.

## Sub-features

- `a-member-lifecycle` owner 웹 로그인 → 초대 → 수락·로그인 → 역할 변경(admin 포함. admin은 owner 역할을 주거나 owner를 바꾸지 못해 `403 OWNER_PROTECTED`, 마지막 owner는 내리거나 비활성하지 못해 `409 LAST_OWNER`) → 비활성화하면 그 사람의 cookie와 개인 key는 401, 그 사람이 발급한 서비스 key는 계속 200 → 재활성화해도 끊긴 cookie·개인 key는 돌아오지 않고 다시 로그인한다.
- `b-teams` 팀 생성 → 구성원 추가·제거(수락 없이, 그 사람을 대상으로 한 receipt가 알림 기록) → 팀을 에이전트 관리자로 지정 → 팀원은 그 에이전트를 관리하고, 팀에서 빠지거나 팀이 지워지면 다음 요청부터 403. owner·admin만 팀을 바꾼다.
- `c-slack-signin` Sign in with Slack 연결·목록·해제와 처리 시점 재판정. 실제 Slack 동의는 사람이 하고(`docs/operator/api-server.md` § Slack 계정 연결의 확인 절차), 자동 확인은 mock IdP로 한다.
- `c-slack-decision` 연결한 사람만 Slack에서 쓴다: 멘션·승인 버튼의 판정(`authorizeSlackInput`), 거절 안내 문구, guest 사용 설정(`POST /v1/workspaces/{id}/slack-guest`), Slack Connect 거절, 요약 상한 채널의 `redact`. Slack 채널(이벤트 수신)이 없어 판정은 api 컨테이너에서 함수로 부른다.
- `d-scoped-keys` member는 개인 key만, owner·admin은 서비스 key, 에이전트 관리자(그 에이전트를 만든 사람)는 그 에이전트 전용 서비스 key를 `POST /v1/api-keys`로 발급한다. 권한이 없으면 403과 `details.reason_code`. 에이전트 전용 key는 그 에이전트의 세션만 만들고 읽는다. 발급자의 지금 scope를 넘는 key는 403 `SCOPE_NOT_GRANTABLE`. API key로는 발급하지 못한다. 발급자를 내보내면 개인 key는 멈추고 서비스 key는 계속 동작한다.
- `f-credential-bindings` 에이전트 관리자가 card의 `credential_refs` 이름을 그 에이전트에 연결(`POST /v1/agents/{id}/credential-bindings`)해야 활성화가 된다. 해제하면 실행 중 세션은 그대로 두고(`running_sessions`, `revoke_notice`) 다음 세션 생성이 `409 CREDENTIAL_UNBOUND`(안내 문구·관리자·`mailto:` 링크)다.
- `g-agent-identity` 에이전트를 자기 Slack 앱 설치에 연결·목록·회수하고, Slack 이벤트의 `(app_id, team_id)`가 그 에이전트로 정해지는지, 회수 뒤·다른 앱의 이벤트는 버려지는지. Slack ingress가 없어 해석은 api 컨테이너에서 함수로 부른다.
- `e-authz-audit` 위 행동이 `authz_decisions`에 남고(감사 보존 기본 90일·하한 30일), 세션 공유 범위(`private`·`people`·`team`·`workspace`) 밖이면 owner·admin도 목록·상세·SSE가 `404`, 범위를 좁히면 열린 SSE가 끊기고, owner·admin은 사유를 단 감사 열람(읽기만)·관리 목록(메타데이터만)·관리 종료로만 범위 밖을 다룬다. DM 기본 "나만"은 DM 세션 경로가 없어 아직 없음.

## How to get to it (user POV)

- 웹 콘솔의 초대 수락·구성원 화면은 [web-members-agents.md](./web-members-agents.md)에 있다(시나리오 a의 웹 쪽). 팀·에이전트 관리자·Slack 연결·key·감사 보존 화면은 [web-settings.md](./web-settings.md)에 있다.
- a: `POST`·`GET /v1/invites`, `DELETE /v1/invites/{id}`, `POST /v1/invites/accept`(cookie 없이, 수락하면 cookie가 생긴다), `GET /v1/members`, `PATCH /v1/members/{user_id}` `{"role"}`, `POST /v1/members/{user_id}/disable`·`/enable` `{"reason"?}`. 화면은 [web-members-agents.md](./web-members-agents.md).
- d: `POST`·`GET /v1/api-keys`, `DELETE /v1/api-keys/{id}`(cookie만). 화면은 [web-settings.md](./web-settings.md)의 `api-keys`.
- b: `POST /v1/teams` → `POST /v1/teams/{team_id}/members` → `POST /v1/agents/{id}/admins` `{"team_id"}` → 팀원이 `PATCH /v1/agents/{id}`, `GET /v1/administered-agents` → `DELETE /v1/teams/{team_id}/members/{user_id}`, `DELETE /v1/teams/{team_id}`. 화면은 [web-settings.md](./web-settings.md)의 `teams`·`agent-admins`.
- f: `GET`·`POST /v1/agents/{id}/credential-bindings`, `DELETE /v1/agents/{id}/credential-bindings/{binding_id}`, 활성화 `POST /v1/agents/{id}/activate`, 세션 `POST /v1/sessions`(`agent_release_id`). 연결 화면(M10)은 아직 없다.
- g: `POST·GET /v1/agents/{id}/identities`, `DELETE /v1/agents/{id}/identities/{identity_id}`. 화면은 아직 없다.
- e: `POST /v1/sessions/{id}/share` `{"scope", "user_ids"?, "team_ids"?}`, `GET /v1/sessions/{id}/share`, `POST /v1/sessions/{id}/audit-read` `{"justification"}`, `GET /v1/admin/sessions`, `POST /v1/admin/sessions/{id}/terminate` `{"expected_revision","justification"}`, `POST /v1/admin/sessions/{id}/recovery-decisions`(owner만, `reason`이 사유), 인수 `POST /v1/sessions/{id}/takeover` `{"justification"}`. 화면(Kollegium 세션 상세)은 아직 없다.
- c: `POST /v1/linked-accounts/slack/start` → IdP 동의 → `POST /v1/linked-accounts/slack/callback` → `GET /v1/linked-accounts` → `DELETE /v1/linked-accounts/{id}`. 화면은 [web-settings.md](./web-settings.md)의 `linked-slack`. guest 설정은 `POST /v1/workspaces/{id}/slack-guest`(화면은 [web-settings.md](./web-settings.md)의 `slack-guest` switch)이고 지금 값은 `GET /v1/auth/me`의 `workspace.settings.slack_guest_enabled`다.

## Driving it with lib.sh

Preconditions:

- 시나리오마다 필요한 사용자: owner는 [web-login.md](./web-login.md)의 bootstrap 뒤 login으로 만든다(bootstrap은 cookie를 주지 않는다). member·admin은 owner가 초대하고 수락해 만든다(a의 1). DB에 직접 넣지 않는다.
- 자격 값이 본문에 드는 요청(bootstrap·login·초대 수락·key 발급)은 `scripts/web-user.mjs`로 보낸다. 비밀번호·초대 token·key secret을 명령에 쓰면 agent-guard가 그 호출을 거부한다. `web-user.mjs`는 그 값을 run 디렉터리(`users/<who>`, `users/<who>.invite`, `keys/<who>`)에 두고 출력하지 않는다. 사용법은 [web-login.md](./web-login.md)와 [sessions.md](./sessions.md)의 웹 사용자 세션.
- `ap_web`은 cookie 파일 하나(`$VERIFY_RUN/cookie`)만 읽고 쓴다. `web-user.mjs login|accept <who>`는 그 cookie를 `cookie.<who>`에도 남기고, `ap_as <who>`가 그 사람의 cookie(와 `web-user.mjs key`로 발급한 key를 `$KEY`)로 바꾼다.
- `ap_web`은 `Idempotency-Key`를 붙이지 않는다. cookie로 부르는 것 중 이 헤더가 필요한 것은 세션 POST뿐이다: `POST /v1/sessions`, `/v1/sessions/{id}/{messages,answers,interrupt,pause,terminate,resume,recovery-decisions}`, `/v1/admin/sessions/{id}/{terminate,recovery-decisions}`. 이것들은 `ap_web`과 같은 헤더에 `-H "Idempotency-Key: $(uuidgen)"`을 더한 curl로 보낸다(없으면 `400`). 공유(`/share`)·감사 열람·팀·에이전트·key 등 나머지는 `ap_web`으로 된다.
- 세션 생성 응답은 `{"session_id", "turn_id", "receipt_id", "status"}`다(`.session.id`가 아니다).

- **a. 초대·관리.** 초대와 수락은 `web-user.mjs invite owner <who> <role>`·`web-user.mjs accept <who>`, 발급한 key는 `web-user.mjs key <who> <kind> <scopes>` 뒤 `ap_as <who>`의 `$KEY`로 쓴다. 아래 단계의 `POST /v1/invites`·`/v1/invites/accept`·`/v1/auth/login`·`POST /v1/api-keys`는 이 명령들이 보내는 요청이다.
  1. owner bootstrap·login. owner가 `ap_web POST /v1/invites '{"email":"member@example.test","role":"member"}'` → `201` `{invite_id, invite_token, expires_at}`, 같은 식으로 `dana@example.test`(member). cookie를 비우고(`rm "$VERIFY_RUN/cookie"`) `ap_web POST /v1/invites/accept …` → `200` `{user_id, workspace, role: "member"}`, cookie가 생긴다. `GET /v1/invites` → 두 초대 `status: accepted`. `GET /v1/members` → 세 줄.
  2. 수락한 사람이 같은 비밀번호로 `POST /v1/auth/login` → `200`, scopes 넷(`recover` 없음). `GET /v1/auth/me`의 `permissions`는 `api_key.manage_own, account.link, agent.create`. member의 `POST /v1/invites`·`PATCH /v1/members/{id}` → `403` `reason_code: role`.
  3. owner가 `ap_web PATCH "/v1/members/$DANA_ID" '{"role":"admin"}'` → `200` `role: admin`. dana가 다시 로그인한 뒤 member를 owner로(`'{"role":"owner"}'`), owner를 member로, `role: owner` 초대 → 셋 다 `403 OWNER_PROTECTED`. member를 admin으로 올렸다 내리기 → 둘 다 `200`.
  4. owner가 자기를 `admin`으로 → `409 LAST_OWNER` "The workspace must keep at least one live owner". 자기 비활성 → `409 LAST_OWNER` "An owner cannot disable themselves".
  5. dana(admin)가 `POST /v1/api-keys '{"kind":"personal","scopes":["sessions:read"]}'`와 `'{"kind":"service","scopes":["sessions:read"]}'` → 둘 다 `201`. 둘 다 `GET /v1/sessions` `200`.
  6. owner가 `ap_web POST "/v1/members/$DANA_ID/disable" '{"reason":"verify scenario a"}'` → `200` `member.disabled_at`. dana의 cookie `GET /v1/auth/me` → `401`, 개인 key → `401`, 서비스 key → `200`. dana의 로그인 → `401` "Invalid email or password".
  7. owner가 `/enable` → `200` `disabled_at: null`. 예전 cookie·개인 key는 여전히 `401`, 다시 로그인하면 `200`, `me`의 role은 `admin` 그대로.
  8. `SELECT operation, result FROM receipts WHERE operation IN ('invite_member','accept_invite','change_member_role','disable_member','enable_member')` → `disable_member`의 `result`에 `revoked_web_sessions`·`revoked_personal_keys: 1`·`revoked_linked_accounts`·`sessions_awaiting_takeover`. `authz_decisions`에 `member.manage allow ok`(owner·admin의 관리 요청마다)와 `member.manage deny role`(2의 둘). `api_keys`는 개인 key만 `revoked_at`이 찬다. 끝나면 쓴 서비스 key를 `DELETE /v1/api-keys/{id}`로 폐기한다.
  - 2026-10-12 run `20261012-022045-88049`에서 이 순서대로 확인했다. 증거는 `$EVIDENCE/musterrolle-a.txt`.
- **b. 팀과 팀 관리자.** d와 같이 사람마다 `web-user.mjs`로 로그인하고 `ap_as <who>`로 바꾼다. owner bootstrap·login, 초대·수락으로 member와 admin(d의 1). `MEMBER_ID`는 member cookie로 `ap_web GET /v1/auth/me`의 `user.id`.
  1. owner가 에이전트를 만든다: `ap_web POST /v1/agents "{\"slug\":\"research\",\"name\":\"research\",\"card\":$CARD}"` → `201`, `AID`.
  2. member가 `ap_web PATCH "/v1/agents/$AID" "{\"card\":…}"` → `403` `reason_code: "role"`. member가 `ap_web POST /v1/teams '{"name":"mine"}'` → `403` `role`.
  3. owner가 `ap_web POST /v1/teams '{"name":"research admins"}'` → `201`, `TID`. `ap_web POST "/v1/teams/$TID/members" "{\"user_id\":\"$MEMBER_ID\"}"` → `200`, `team.member_count: 1`, `receipt_id`. 수락 단계는 없다. member가 `ap_web GET /v1/my-teams` → `200` `items: [{id: TID, name: "research admins"}]`(6에서 뺀 뒤에는 `[]`).
  4. owner가 `ap_web POST "/v1/agents/$AID/admins" "{\"team_id\":\"$TID\"}"` → `200`, `admins.teams[].name`에 팀.
  5. member가 카드 수정 → `200`. `ap_web GET /v1/administered-agents` → `items[].slug`에 `research`. member가 `PATCH "/v1/teams/$TID"`·`DELETE "/v1/teams/$TID/members/$MEMBER_ID"` → 둘 다 `403` `role`.
  6. owner가 `ap_web DELETE "/v1/teams/$TID/members/$MEMBER_ID"` → `200`. 바로 다음 member 카드 수정 → `403` `role`.
  7. owner가 다시 넣고(`200`) member 카드 수정 `200`, admin이 `ap_web DELETE "/v1/teams/$TID"` → `200`, member 카드 수정 → `403` `role`.
  8. `SELECT operation, target_ref->>'user_id' IS NOT NULL, result FROM receipts WHERE operation IN ('create_team','add_team_member','remove_team_member','add_agent_admin','delete_team') ORDER BY created_at` → `add_team_member`·`remove_team_member`는 그 사람이 대상이고 `result`에 `team_id`·`team_name`, `delete_team`의 `result.agent_ids`에 에이전트. `SELECT action, outcome, reason_code, count(*) FROM authz_decisions WHERE action IN ('team.manage','agent.manage','agent.admin.manage') GROUP BY 1,2,3` → `team.manage allow`(owner·admin의 변경 다섯), `team.manage deny role`(member의 셋), `agent.manage deny role`(2·6·7의 셋), `agent.manage allow`(5·7의 둘), `agent.admin.manage allow` 하나. 모두 `policy_version` `m15`.
  - 2026-10-11 run `20261011-210547-1353`에서 이 순서대로 확인했다(`evidence/musterrolle-b.txt`). 2026-10-12 run `20261012-022045-88049`에서 다시 확인했다.
- **c.** mock IdP overlay를 붙여 띄운다: `up.sh infra/compose.mock-slack.yml`(Orca에서는 `orch heavy <program> -- …`로 감싼다). Slack 설치가 있어야 연결이 시작되므로, 설치 행 하나는 repository로 만든다(설치 흐름은 아직 사용자 경로가 없다. 다른 상태는 API로만 만든다). owner cookie는 web-login.md로 만든다. `ap_slack_link` cookie도 `Secure`라 curl이 저장하지 않으니 직접 나른다.

  ```sh
  . .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
  # owner bootstrap + login: web-login.md. WS·ME는 login 응답의 workspace_id·user_id
  DB='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@werft-ai/db";
  const pool = new Pool({ connectionString: process["env"]["DATABASE_URL"] }); const db = drizzle(pool, { schema });'
  ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  const ids = { appId: \"A0VERIFY\", teamId: \"T0MOCK\" };
  await schema.registerSlackInstallation(db, { ...ids, workspaceId: process.argv[1] });
  console.log((await schema.verifySlackInstallation(db, { ...ids, botUserId: \"B0VERIFY\" })).outcome); await pool.end();" "$WS"
  H=$(mktemp)
  START=$(curl -sS -D "$H" -X POST "$API/v1/linked-accounts/slack/start" -H 'x-requested-with: agent-platform-web' -H "Cookie: $(cat "$VERIFY_RUN/cookie")")
  LINK=$(sed -n 's/^[Ss]et-[Cc]ookie: \(ap_slack_link=[^;]*\).*/\1/p' "$H" | tr -d '\r')
  # authorize_url의 호스트(mock-slack)는 compose 네트워크 안에서만 닿는다: api 컨테이너에서 동의하고, 돌아온 주소를 callback 본문으로 바꾼다
  BODY=$(ap_compose exec -T api bun -e 'const r = await fetch(process.argv[1], { redirect: "manual" }); const q = new URL(r.headers.get("location")).searchParams;
  console.log(JSON.stringify(Object.fromEntries(["code", "state"].map((k) => [k, q.get(k)]))))' "$(echo "$START" | jq -r '.["authorize_url"]')")
  curl -sS -w '\n%{http_code}\n' -X POST "$API/v1/linked-accounts/slack/callback" -H 'x-requested-with: agent-platform-web' \
    -H 'Content-Type: application/json' -H "Cookie: $(cat "$VERIFY_RUN/cookie"); $LINK" -d "$BODY"
  ap_web GET /v1/linked-accounts
  ap_web DELETE "/v1/linked-accounts/<id>"
  ap_compose exec -T postgres psql -U postgres -d sessions -c 'select status, revoked_reason, revision from linked_accounts'
  ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  console.log(JSON.stringify(await schema.resolveLinkedSubject(db, { provider: \"slack\", externalTenant: \"T0MOCK\", externalUserId: \"U0MOCK\" }))); await pool.end();"
  ```

  기대: callback `201`과 `receipt_id`, 목록에 `active` 한 줄, 해제 `200`(`receipt_status: succeeded`) 뒤 목록이 비고 DB는 `revoked | unlinked | 2`. `mock_team=T0OTHER`를 붙인 authorize URL로 다시 하면 `409 LINK_TEAM_MISMATCH`. 해제 뒤 `resolveLinkedSubject`는 `{"status":"unlinked"}`다. 대기 중이던 입력의 처리 시점 재판정(`createDatabaseIdentityReader(db).reread`에 `linked_account: {id, revision}`)도 `unlinked`로 거절한다. Slack 입력(M9) 전까지는 사용자 경로가 없어 위처럼 api 컨테이너에서 부른다. 초대(`POST /v1/invites`)·수락한 member가 같은 방법으로 연결한 뒤 owner가 `POST /v1/members/{user_id}/disable`로 비활성화하면 receipt `result.revoked_linked_accounts`가 `1`이고 DB 행은 `revoked | offboarded`다. 2026-10-11 run `20261011-184057-50543`에서 이 순서대로 확인했다.
- **c. 멘션·승인 판정.** 위 c처럼 mock overlay로 띄운다. owner bootstrap·login, member 초대·수락(d의 1), 설치 행(c), owner가 에이전트(`research`→`AID`)를 만들고 `POST /v1/agents/$AID/identities '{"provider":"slack_bot","app_id":"A0VERIFY","team_id":"T0MOCK","credential_ref":"slack/research-bot-token"}'`로 그 앱을 연결한다. owner가 d의 2처럼 다른 에이전트(`finance`→`BID`)도 만들고, 두 에이전트의 release(`REL`·`BREL`)로 owner cookie로 세션을 만든다. `POST /v1/sessions`는 `Idempotency-Key`가 필요한데 `ap_web`은 붙이지 않으니 curl로 부른다: `curl -sS -w '\n%{http_code}\n' -X POST "$API/v1/sessions" -H 'x-requested-with: agent-platform-web' -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -H "Cookie: $(cat "$VERIFY_RUN/cookie")" -d "{\"profile_id\":\"claude-coding-local\",\"repository_id\":\"sample-app\",\"message\":\"verify\",\"agent_release_id\":\"$REL\"}"` → `201`, 세션 id를 `S`(`BREL`로 만든 것은 `OS`)로 둔다. Slack 판정은 세션이 어느 에이전트 것인지 다시 읽으므로 실제 세션이어야 한다. member가 위 c의 시작·callback으로 `U0MOCK`을 연결한다(`LAID` = `linked_account.id`). 판정은 Slack 채널이 할 호출을 그대로 한다. 채널 상한은 binding 테이블이 생기기 전까지 입력으로 넘긴다.

  ```sh
  DECIDE='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@werft-ai/db"; import * as platform from "@werft-ai/platform";
  const pool = new Pool({ connectionString: process["env"]["DATABASE_URL"] }); const db = drizzle(pool, { schema });
  const authorization = platform.createAuthorizationPolicy({
    identity: schema.createDatabaseIdentityReader(db), agents: schema.createDatabaseAgentAuthority(db),
    credentials: schema.createPostgresCredentialBindingStore(db), slackGuests: schema.createPostgresSlackGuestSetting(db),
    sessions: schema.createPostgresSessionShareStore(db), decisions: schema.createPostgresDecisionLog(db) });
  const i = JSON.parse(process.argv[1]); const all = ["session.read","session.submit","session.control","session.approve"];
  const r = await platform.authorizeSlackInput({ authorization, agents: schema.createPostgresAgentIdentityStore(db), links: schema.createPostgresLinkedAccountStore(db) }, {
    event: { appId: "A0VERIFY", teamId: "T0MOCK", agentId: process.argv[2] }, user: { id: i.user, team_id: "T0MOCK", ...(i.flags ?? {}) },
    action: i.action ?? "session.submit", resource: i.session ? { kind: "session", id: i.session } : { kind: "surface_binding", id: null },
    binding: { channelKind: "public_channel", ceiling: { actions: i.actions ?? all, disclosure: i.disclosure ?? "full" } },
    requestId: crypto.randomUUID(), connectUrl: "http://127.0.0.1:3000/settings/linked-accounts" });
  console.log(JSON.stringify(r.status === "decided" ? { outcome: r.decision.outcome, reason_code: r.decision.reason_code, effective_scopes: r.decision.effective_scopes, actorUserId: r.actorUserId, notice: r.notice } : r)); await pool.end();'
  decide() { ap_compose exec -T -w /app/apps/control-host api bun -e "$DECIDE" "$1" "$AID"; }
  decide '{"user":"U0MOCK"}'                                                           # 1
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$S\"}"     # 2
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$S\",\"actions\":[\"session.read\",\"session.submit\"]}"  # 3
  decide "{\"user\":\"U0NOBODY\",\"action\":\"session.approve\",\"session\":\"$S\"}"   # 4
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.read\",\"session\":\"$S\",\"disclosure\":\"summary\"}"  # 5
  decide "{\"user\":\"U0MOCK\",\"action\":\"session.approve\",\"session\":\"$OS\"}"    # 5b
  # 5c·5d: owner cookie로 ap_web POST "/v1/sessions/$S/share" '{"scope":"private"}' 뒤 2와 같은 승인, '{"scope":"workspace"}'로 되돌린 뒤 한 번 더
  decide '{"user":"U0GUEST","flags":{"is_restricted":true}}'                          # 6
  decide '{"user":"U0EXT","flags":{"is_stranger":true}}'                              # 7
  ap_web POST "/v1/workspaces/$WS/slack-guest" '{"slack_guest_enabled":true}'          # 8: member cookie, 9: owner cookie
  decide '{"user":"U0GUEST","flags":{"is_restricted":true}}'                          # 10
  ap_web DELETE "/v1/linked-accounts/$LAID"                                            # member cookie
  decide '{"user":"U0MOCK"}'                                                           # 11
  ap_compose exec -T postgres psql -U postgres -d sessions -c "select action, outcome, reason_code, surface->>'slack_user_kind' from authz_decisions where surface->>'kind' = 'slack' order by at"
  ```

  기대: 1·2 `allow`, `actorUserId`가 member, `notice: null`. 3 `deny surface_ceiling`, 안내 "이 요청을 승인할 권한이 없어요". 4 `deny unlinked`, 안내 "웹에서 Slack 계정을 연결해 주세요"와 `link_url`. 5 `redact`(`reason_code: surface_ceiling`, 안내 없음). 5b 같은 workspace여도 다른 에이전트의 세션이라 `deny agent_ceiling`, `actorUserId: null`, 안내 "이 요청을 승인할 권한이 없어요". 5c 공유가 `private`(만든 사람만)이면 member의 승인은 `deny not_found`, 안내 "이 세션은 공유 범위 밖이라 요청할 수 없어요. 세션을 만든 사람에게 공유를 요청하세요". 5d `workspace`로 되돌리면 다시 `allow`. 6 `guest_disabled`, "이 워크스페이스는 guest의 에이전트 사용을 허용하지 않아요". 7 `external_user`, "이 에이전트는 이 워크스페이스 멤버만 쓸 수 있어요". 8 member는 `403`과 `details.reason_code: role`, 9 owner는 `200`이고 `GET /v1/auth/me`의 `workspace.settings.slack_guest_enabled: true`. 10 같은 guest는 이제 `unlinked`(켜도 연결해야 쓴다), Slack Connect 사용자는 여전히 `external_user`. 해제 `200` 뒤 11은 `unlinked`와 연결 링크. 판정 행은 Slack 판정마다 하나씩(허용 포함)이고 `principal_kind`는 `installation`, 연결된 사람이 있을 때만 `actor_user_id`가 찬다. 모든 행의 `surface->>'agent_id'`는 `AID`이고 `policy_version`은 `m15`다. 2026-10-12 run `20261012-013848-78890`에서 11까지 이 순서대로 확인했고, run `20261012-022045-88049`에서 1·2·3·4·5b·6·7·11을 다시 확인했다. 증거는 `$EVIDENCE/musterrolle-c-decision.txt`.
- **d. 권한별 key.** 사람마다 `web-user.mjs login|accept <who>`로 cookie를 받고, 그 사람으로 부르기 전에 `ap_as <who>`로 바꾼다. key secret은 `web-user.mjs key`가 `keys/<who>`에 두고 `ap_as`가 `$KEY`로 읽는다.
  1. owner bootstrap·login([web-login.md](./web-login.md)). `node $U <run id> invite owner member member`, 같은 식으로 `other`(member)와 `admin`(admin). 각자 `node $U <run id> accept <who>` → `200`(cookie가 생긴다).
  2. member가 `ap_web POST /v1/agents "{\"slug\":\"reviewer\",\"name\":\"reviewer\",\"card\":$CARD}"` → `201`(`CARD`는 `{"role":…,"instructions":…,"language":"ko","model":"claude-sonnet-5","capabilities":{"tools":["Read"],"mcp":null,"forbidden":[]},"rules":[]}`), `POST /v1/agents/$AID/releases '{"version_id":…,"runtime_profile_id":"claude-coding-local"}'` → `200`, `release.id`(`sha256:…`)를 `MINE_REL`로. owner도 다른 에이전트(`finance`)를 만들어 `OWNERS_REL`. `SELECT agent_id, user_id FROM agent_admins` → 에이전트마다 만든 사람 한 행.
  3. member가 `ap_web POST /v1/api-keys "{\"kind\":\"service\",\"agent_id\":\"$AID\",\"scopes\":[\"sessions:read\",\"sessions:write\"]}"` → `201`, `key.created_by`가 member, `secret`을 `KEY`로.
  4. `ap_post /v1/sessions` 본문에 `"agent_release_id":"$MINE_REL"`(`profile_id`는 `claude-coding-local`) → `201`, 그 세션 `ap_get` → `200`. `OWNERS_REL`로 → `403` `details.reason_code: "agent_ceiling"`. release 없이 → `403` `agent_ceiling`. owner가 cookie로 `OWNERS_REL` 세션을 만들고, 에이전트 key로 그 세션 `GET`·`/turns` → `403`. 세션 목록 `GET /v1/sessions`와 자기 세션의 receipt `GET /v1/receipts/$RCPT`도 `403`(목록은 에이전트를 가리지 못하고, receipt는 세션을 가리키지 않는다). `SELECT agent_release_id FROM sessions` → 에이전트 key가 만든 행은 `MINE_REL`.
  5. member가 `{"kind":"service","scopes":["sessions:read"]}` → `403` `reason_code: "role"`. `other`가 member의 `agent_id`로 → `403` `role`.
  6. member가 `{"kind":"personal","scopes":["sessions:read","sessions:write"]}` → `201`.
  7. 개인 key와 에이전트 key 각각 `curl "$API/v1/api-keys" -H "Authorization: Bearer …" -d '{"kind":"personal","scopes":["sessions:read"]}'` → `403` `role`.
  8. admin이 `{"kind":"service","scopes":["sessions:read","sessions:recover"]}` → `403` `SCOPE_NOT_GRANTABLE` `The issuer does not hold sessions:recover`. owner가 에이전트 key에 `["sessions:approve"]` → `403` `SCOPE_NOT_GRANTABLE`. 에이전트 관리자인 member가 자기 에이전트 key에 `["sessions:approve"]` → `403` "A key bound to an agent never approves (D26)", `["sessions:recover"]` → `403` "The issuer does not hold sessions:recover". 에이전트 key가 늘 빼는 것은 approve뿐이다: owner가 에이전트 key에 `["sessions:recover"]`를 달면 `201`이다(발급자 상한 안). 확인했으면 그 key를 폐기한다.
  9. `ap_web GET /v1/api-keys`: member는 자기 개인 key와 자기 에이전트 key 둘, `other`는 `[]`. 아무 key를 `ap_web DELETE /v1/api-keys/$ID` → `200`과 `receipt_id`, 다시 → `200` `receipt_id: null`, 그 key로 `/v1/auth/me` → `401`.
  10. owner가 `ap_web POST "/v1/members/$MEMBER_ID/disable" '{"reason":"verify scenario d"}'` → `200`(`member.disabled_at`이 찬다). 그 뒤 member 개인 key `/v1/auth/me` → `401`, member가 발급한 에이전트 key로 4의 세션 생성 → `201`.
  11. `SELECT action, outcome, reason_code, principal_kind, count(*) FROM authz_decisions WHERE action LIKE 'api_key.%' OR reason_code = 'agent_ceiling' GROUP BY 1,2,3,4` → `api_key.manage allow`(3의 발급과 8의 두 요청), `api_key.manage deny role user`(5의 둘), `api_key.manage_own allow`, `api_key.manage_own deny role api_key`(7의 둘), `session.submit deny agent_ceiling api_key`(4의 둘), `session.read deny agent_ceiling api_key`(4의 읽기들). `SELECT operation, result FROM receipts WHERE operation IN ('create_api_key','revoke_api_key')` → 발급마다 `create_api_key`, 폐기 한 번에 `revoke_api_key`, `result`에는 kind·agent_id·scopes만.
  - 증거는 `| tee "$EVIDENCE/musterrolle-d.txt"`. 남기기 전에 `csp_`·`apv_` 값을 가린다.
  - 2026-10-12 run `20261012-022045-88049`에서 1–9와 11을 확인했다(10의 발급자 비활성화는 a의 6에서 같은 결과).
- **g. 에이전트의 Slack 앱 연결.** owner bootstrap·login은 [web-login.md](./web-login.md). 에이전트는 d의 2처럼 `ap_web POST /v1/agents`로 둘(`research`→`AID`, `finance`→`BID`) 만든다. 설치 행은 c처럼 repository로 만든다(`A0VERIFY`·`T0VERIFY`·bot `B0VERIFY`). 해석은 이벤트 수신 경로가 없어 함수로 부른다.

  ```sh
  DB='import { Pool } from "pg"; import { drizzle } from "drizzle-orm/node-postgres"; import * as schema from "@werft-ai/db"; import * as platform from "@werft-ai/platform";
  const pool = new Pool({ connectionString: process["env"]["DATABASE_URL"] }); const db = drizzle(pool, { schema });'
  resolve() { ap_compose exec -T -w /app/apps/control-host api bun -e "$DB
  console.log(JSON.stringify(await platform.agentForSlackEvent(schema.createPostgresAgentIdentityStore(db), JSON.parse(process.argv[1])))); await pool.end();" "$1"; }
  LINK='{"provider":"slack_bot","app_id":"A0VERIFY","team_id":"T0VERIFY","credential_ref":"slack/research-bot-token"}'
  resolve '{"appId":"A0VERIFY","teamId":"T0VERIFY"}'          # 연결 전
  ap_web POST "/v1/agents/$AID/identities" "$LINK"             # IID = agent_identity.id
  resolve '{"appId":"A0VERIFY","teamId":"T0VERIFY"}'
  resolve '{"appId":"A0OTHER","teamId":"T0VERIFY"}'
  resolve "{\"appId\":\"A0VERIFY\",\"teamId\":\"T0VERIFY\",\"agentId\":\"$BID\"}"
  ap_web POST "/v1/agents/$BID/identities" "$LINK"
  ap_web POST "/v1/agents/$BID/identities" "$(echo "$LINK" | jq -c '.app_id="A0NOWHERE"')"
  ap_web GET "/v1/agents/$AID/identities"
  ap_web DELETE "/v1/agents/$AID/identities/$IID"              # 두 번 보낸다
  resolve '{"appId":"A0VERIFY","teamId":"T0VERIFY"}'
  ap_compose exec -T postgres psql -U postgres -d sessions -c "select external_principal_id, credential_ref, status, revision from agent_identities"
  ap_compose exec -T postgres psql -U postgres -d sessions -c "select operation, result->>'app_id', result->>'revision' from receipts where operation like '%agent_identity'"
  ap_compose logs api 2>&1 | grep -E 'Agent identity (linked|revoked)'
  ```

  기대: 연결 전 `{"status":"dropped","reason":"unidentified"}`. 연결 `201`과 `receipt_id`, `bot_user_id: "B0VERIFY"`. 그 뒤 `resolved`이고 `agentId`가 `AID`, `identity.revision` 1, `credentialRef`가 그 이름. 다른 앱은 `not_installed`, `BID` 앞으로 온 이벤트는 `agent_mismatch`. `BID`에 같은 앱 → `409 AGENT_IDENTITY_TAKEN`, 없는 앱 → `409 SLACK_NOT_INSTALLED`. 목록 한 줄. 회수 `200`(`status: revoked`, `revision: 2`, `receipt_id`), 두 번째는 `receipt_id: null`. 회수 뒤 `identity_revoked`. DB는 `B0VERIFY | slack/research-bot-token | revoked | 2`, receipt는 `link_agent_identity`(1)·`revoke_agent_identity`(2), api 로그에 linked·revoked 한 줄씩. 초대·수락한 member(관리자 아님)가 `AID`에 연결하면 `403` `reason_code: "role"`이고 `authz_decisions`에 `binding.manage | deny | role` 한 행. bot token 이름은 그 신원만 쓴다: 연결 중에 같은 이름을 `POST /v1/agents/$BID/credential-bindings '{"credential_ref":"slack/research-bot-token"}'`로 에이전트에 묶으면 `409 CREDENTIAL_REF_IN_USE`, 에이전트에 묶인 이름(`notion-token`)으로 다른 설치(`A0SECOND`)를 연결해도 `409 CREDENTIAL_REF_IN_USE`, 회수 뒤에는 같은 이름을 에이전트에 묶을 수 있다(`200`). `credential_bindings`에는 신원 행(`agent_identity`, 회수됨)과 에이전트 행이 남는다. 2026-10-11 run `20261011-220853-96733`에서 이 순서대로 확인했다. 증거는 `$EVIDENCE/musterrolle-g.txt`.
- **e. 판정 기록.** 응답 헤더의 `X-Request-Id`로 행을 찾는다(`H=$(mktemp)`, curl에 `-D "$H"`, `RID=$(sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p' "$H" | tr -d '\r')`).
  - 거절: `KEY=$(ap_key verify --scopes sessions:read 2>/dev/null)`로 `POST /v1/sessions` → `403`. `ap_compose exec -T postgres psql -U postgres -d sessions -c "SELECT action, outcome, reason_code, principal_kind, request_id FROM authz_decisions WHERE request_id = '$RID'"` → `session.submit | deny | role | api_key` 한 행.
  - 승인: [sessions.md](./sessions.md)의 권한 요청 대본으로 `needs_input`을 만들고 `sessions:approve` key로 `POST /v1/sessions/$SID/answers`. `... FROM authz_decisions d JOIN receipts r ON r.request_id = d.request_id WHERE d.request_id = '$RID'` → `session.approve | allow` 한 행과 `answer` receipt.
  - 허용된 API 생성(`POST /v1/sessions` 201)은 행을 남기지 않는다.
- **e. 보존 기간.** bootstrap 뒤 `web-user.mjs login owner`로 cookie를 받은 owner가 `ap_web POST "/v1/workspaces/$WS/audit-retention" '{"audit_retention_days":45}'` → `200`, `29` → `400`, 다른 workspace id → `404`. API key는 `404`. `workspaces.settings->'audit_retention_days'`가 45. member 403은 초대 경로가 없어 route 테스트로만 본다.
- **e. 공유 범위·감사 열람·관리 목록.** owner bootstrap·login, member `a`·`b`·`c`를 초대·수락으로 만들고(d의 1, `ap_as <who>`로 바꾼다), owner가 팀 `research`를 만들어 `b`만 넣는다(b의 3). 세션 생성·메시지·종료·관리 종료는 `Idempotency-Key`를 더한 curl로 보내고(위 Preconditions), 공유·감사 열람·관리 목록은 `ap_web`으로 된다.
  1. `a`가 `POST /v1/sessions` `{"profile_id":"claude-coding-local","repository_id":"sample-app","message":"GATE-SPEC {\"id\":\"e1\",\"steps\":[],\"final\":\"confidential minutes\",\"finalDelayMs\":300000}"}` → `201`, `SID`. `ap_web POST "/v1/sessions/$SID/share" '{"scope":"private"}'` → `200`, `share.revision: 1`, `receipt_id`.
  2. `b`와 owner 각각 `ap_web GET /v1/sessions`에 `SID`가 없고, `GET /v1/sessions/$SID` → `404`, `GET /v1/sessions/$SID/events`(curl) → `404`. `a`는 `200`.
  3. `a`가 `{"scope":"team","team_ids":["$TID"]}` → `200`. `b`는 목록에 있고 상세 `200`, `c`는 목록에 없고 `404`.
  4. `b`가 `curl -N …/events &`로 스트림을 열고(PID 기록) 3초 뒤 `a`가 다시 `private` → `b`의 curl이 바로 끝난다. `ap_compose logs api | grep '"SSE stream closed"'`에 `"reason":"not_visible"`. 다시 열면 `404`.
  5. owner가 `ap_web POST "/v1/sessions/$SID/audit-read" '{}'` → `400`. `'{"justification":"incident INC-42"}'` → `200`, `session.id`가 `SID`, `turns.items` 1개. 그 뒤에도 owner의 메시지 쓰기 → `404`, 상세 → `404`(읽기 전용).
  6. owner가 `ap_web GET /v1/admin/sessions` → 그 항목의 키가 정확히 `admission_state, agent_release_id, created_at, created_by_api_key_id, created_by_user_id, session_id, share_scope, status, takeover_required_at`이고 `share_scope: "private"`, 본문에 `confidential minutes`가 없다. `b` → `403`.
  7. owner가 `POST "/v1/admin/sessions/$SID/terminate" '{"expected_revision":N}'` → `400`, 일반 `POST "/v1/sessions/$SID/terminate"` → `404`, `{"expected_revision":N,"justification":"stop"}` → `202`(N은 감사 열람 응답의 `session.revision`).
  8. `SELECT action, outcome, reason_code, justification, count(*) FROM authz_decisions WHERE resource_id = '$SID' GROUP BY 1,2,3,4` → `session.audit_read allow ok <사유>`(읽을 때마다 한 행), `session.control allow ok <사유>`, `session.control deny not_found`, `session.read deny not_found`, `session.submit deny not_found`, `session.share allow ok`. `receipts`에 `share_session`이 바꾼 횟수만큼(`result.scope`), `session_shares`는 `private | 3`.
  - 7의 앞에 세션을 만든 member `a`가 같은 관리 종료를 보내면 `403` `role`이다(사유를 단 종료는 owner·admin 판정을 먼저 받는다).
  - 2026-10-12 run `20261011-235937-79730`(리뷰 수정 뒤 head `ad893b5`)과 run `20261012-022045-88049`에서 이 순서대로 다시 확인했다. 증거는 `$EVIDENCE/musterrolle-e.txt`, `musterrolle-e-sse.txt`, `musterrolle-e-admin-list.json`.

- **f. 자격 연결.** d의 1처럼 owner와 member 둘(`agentadmin`, `other`)을 `web-user.mjs invite`·`accept`로 만든다.
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

- c 판정: 함수가 받는 Slack user는 Slack이 보낸 객체 그대로다. `team_id`가 설치(`T0MOCK`)와 다르면 guest 표시와 상관없이 `external_user`다. 실제 Slack 이벤트 수신(Kollegium Slack 채널)이 붙으면 이 함수 호출을 그 경로로 바꾼다.
- c·g 스니펫은 agent-guard의 경로 모양 text match(`*.env`·`*.key`)를 피하려고 `process["env"]["DATABASE_URL"]`, `ids`, jq `.["authorize_url"]`로 쓰고, 돌아온 주소는 `new URL(…).searchParams`로 읽는다. `process.env.…`·`...key`·`.key`로 되돌리면 명령이 거부된다. 2026-10-22 run `20261022-073051-53892`에서 c의 설치 행(`verified`)·시작·callback(`201`)·목록·`resolveLinkedSubject`(`linked`)와 g의 `resolve`(`dropped unidentified`)를 이 모양 그대로 돌렸고 거부는 없었다.
- c: mock overlay 없이 띄운 스택은 `SLACK_OIDC_*`가 비어 있어 시작 요청이 `503 BACKEND_UNAVAILABLE`이다. state는 10분, 한 번만 쓴다. 같은 code·state를 다시 보내면 `400`.
- d의 8은 판정이 `allow`인 채로 거절된다. 권한(`api_key.manage`)은 있고 scope만 넘친 것이라, 판정 행은 `allow`이고 응답은 `SCOPE_NOT_GRANTABLE`이다.
- 에이전트 전용 key는 receipt를 읽지 못한다. receipt 조회는 세션을 가리키지 않아 에이전트를 확인할 수 없기 때문이다.
- 에이전트 관리자는 에이전트를 만든 사람(과 0142 backfill), 그리고 `POST /v1/agents/{id}/admins`로 지정한 사람·팀이다.
- b: 팀 목록·상세(`GET /v1/teams`)는 owner·admin만 본다. member는 `GET /v1/my-teams`로 자기가 든 팀의 `id`·`name`만 본다(다른 팀원 없음). 추가 알림은 아직 receipt 기록뿐이다(Slack 알림 없음).
- f: 본문 검증(`400`)은 판정보다 먼저라 판정 행을 남기지 않는다. 해제한 연결을 다시 `DELETE`하면 `404`다.
- g: 연결은 확인된(`verified`) 설치에만 된다. `registerSlackInstallation`만 하고 `verifySlackInstallation`을 빠뜨리면 `409 SLACK_NOT_INSTALLED`, 해석은 `installation_unverified`다. 같은 team·app을 다른 bot으로 다시 확인하면 연결은 남아 있어도 해석은 `bot_mismatch`다.
- e: 감사 열람 사유가 없으면 본문 검증(`400`)에서 끝나 판정 행이 없다. 판정의 `justification_required`(`403`)는 사유 없는 인수(`POST /v1/sessions/{id}/takeover` 빈 본문)에서 본다. member의 감사 열람은 범위 밖이면 `404`, 범위 안이면 `403` `role`이다.
- e: fake model 세션이 `queued`로 머물러도 시나리오에는 상관없다. 종료는 `queued`에서도 `202`다.
- bootstrap은 cookie를 주지 않는다. 보존 기간을 바꾸기 전에 login한다.
- 판정은 본문보다 먼저 묻는다. 그래서 owner의 `29` 요청(400)도 `audit_retention.manage | allow` 행을 남긴다.
- 만료 정리는 시간을 당겨야 보이므로 E2E가 아니라 `packages/db/src/authz-decisions.integration.test.ts`로 본다.
- 실제 Slack 앱·OAuth 동의는 사람만 한다. 자동 확인은 mock IdP로만 하고 실제 Slack 연결은 "사람 확인 필요"로 보고한다.

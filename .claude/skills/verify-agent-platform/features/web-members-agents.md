# 웹 초대·구성원·에이전트

owner·admin은 웹 콘솔 `/members`에서 초대 링크를 만들어 건네고, 받은 사람은 `/invite/{token}`에서 비밀번호를 정해 들어온다. 같은 화면에서 역할을 바꾸고(owner 역할을 주거나 owner를 바꾸는 것은 owner만) 비활성화·재활성화한다. `/agents`에서는 빈 카드로 에이전트를 만들고(member도 만든다. 만든 사람이 그 에이전트의 관리자가 된다), `/agents/{id}`에서 카드를 고쳐 새 version을 저장하고, release를 만들어 활성화한다. release의 `policy_pins`는 서버가 카드에서 정하고 승인 대기 상태는 없다(첫 활성화가 `approved_by`를 채운다). 두 탭이 같은 활성화를 다투면 늦은 탭은 덮어쓰지 않고 409를 안내한다. 홈 checklist의 "팀원 초대"·"에이전트 만들기"는 이 상태를 그대로 보인다.

## Sub-features

- `invite-create` `/members`의 초대 폼(이메일, 역할은 contracts의 역할 값)을 내면 `<origin>/invite/<token>` 링크가 한 번만 보인다. 대기 중 초대 목록에 생기고 "회수"로 지운다.
- `invite-accept` 로그인하지 않은 브라우저로 링크를 열면 비밀번호·이름 폼. 내면 `/`에 그 사람 이름으로 로그인된다.
- `invite-signed-in` 이미 로그인한 브라우저로 링크를 열면 "이미 이 워크스페이스의 구성원입니다" 안내와 "로그아웃하고 다른 계정으로 수락" 버튼.
- `invite-used` / `invite-expired` 이미 쓴 링크는 409 "이미 수락한 초대입니다", 회수했거나 없는 링크는 410 "만료됐거나 회수된 초대입니다". 폼 대신 안내만 남는다.
- `member-forbidden` member로 `/members`를 열면 서버 403 문구와 함께 권한 없음 화면, 초대 버튼은 꺼진 채 이유가 붙는다.
- `role-change` 역할 select를 바꾸면 바로 PATCH, 마지막 owner를 내리면 409 LAST_OWNER 문구.
- `disable` "비활성화"는 확인 대화상자를 거친다. 비활성화된 사람은 다음 `me` 조회에서 로그인 화면으로 간다. "다시 활성화"는 바로 된다.
- `agent-create` `/agents/new`는 빈 카드 폼(이름·주소 이름·역할·지시 사항·말투·언어·모델·도구·금지 도구). 모델은 카탈로그 모델 select다(로컬 스택은 `claude-sonnet-5`). owner·admin·member 모두 만든다(`me.permissions`의 `agent.create`). 만들면 상세로 가서 "에이전트를 만들었습니다(version 1). release를 만들고 활성화해야 세션에서 쓸 수 있습니다."
- `agent-save` 카드를 고쳐 저장하면 "저장했습니다 — version N. 아직 활성화되지 않았습니다"와 두 version의 차이. 바뀐 것 없으면 새 version이 없다고 말한다. release 폼은 방금 저장한 version을 고른다.
- `release-activate` release 폼은 version select와 runtime profile select(`GET /v1/profiles`의 카탈로그, 로컬 스택은 "claude-coding-local · claude-sonnet-5")다. "release 만들기" → "release를 만들었습니다(version 1). 아직 활성화되지 않았습니다.", 그 release의 "활성화" → "활성화됐습니다 — 이제 새 세션은 version 1 · claude-coding-local(으)로 시작합니다." 저장·release·활성화 문구는 서로 다르다.
- `activate-conflict` 다른 탭이 먼저 활성화했으면 409 "다른 곳에서 먼저 활성화를 바꿨습니다 … 덮어쓰지 않고 멈췄습니다". "최신 상태 불러오기" 뒤 "보던 화면의 활성 release: …. 지금 활성 release: …."와 두 카드의 차이가 보이고, 그다음에야 다시 활성화된다.
- `checklist` 홈의 "팀원 초대"는 구성원이 둘 이상이거나 초대가 있으면, "에이전트 만들기"는 활성 release가 있는 에이전트가 있으면 완료. 조회가 실패하면 "확인할 수 없음".

## How to get to it (user POV)

- owner로 `$VERIFY_API/`에 로그인해 상단 nav의 "구성원"·"에이전트"로 간다. member도 "에이전트" → "새 에이전트"로 `/agents/new`에 간다.
- 초대받는 사람은 owner와 cookie를 나누지 않는 다른 브라우저(profile)로 링크를 연다.
- release 폼의 runtime profile은 카탈로그(`GET /v1/profiles`)에서 고른다. 카드 모델과 다른 모델의 profile은 서버가 거절하므로 폼이 카드 모델에 맞는 profile을 먼저 고른다.

## Driving it with lib.sh

Preconditions: [web-login.md](./web-login.md)대로 owner를 `web-user.mjs`로 bootstrap·login했다. `orch hold browser --note "<what>"`를 잡았다. 화면은 이 run의 headless Chrome(`browser.mjs`, [web-console.md](./web-console.md))으로 몬다. 비밀번호와 초대 token은 명령에 쓰지 않는다: `web-user.mjs invite`가 token을 `users/<who>.invite`에, 초대받는 사람의 무작위 비밀번호를 `users/<who>`에 두고, 수락은 API(`web-user.mjs accept`)나 화면(`browser.mjs accept`)이 그 파일에서 읽는다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
U=.claude/skills/verify-agent-platform/scripts/web-user.mjs
B=.claude/skills/verify-agent-platform/scripts/browser.mjs
node $U <run id> invite owner member member   # 201 {invite_id, invite_token: (saved, N chars), expires_at}
node $B <run id> start                         # PID는 browser/pid에 남는다
node $B <run id> accept member                 # /invite/<token>에 비밀번호·이름을 넣어 수락 → "accept member -> /"
node $U <run id> login member                  # 같은 비밀번호로 API 로그인 → 200 role member, cookie.member
```

- API로만 수락하려면 `node $U <run id> accept member` → `200` `{user_id, workspace, role: "member"}`, cookie가 생긴다.
- 브라우저는 cookie를 하나만 가진다. 다른 사람으로 화면을 보려면 `node $B <run id> click 로그아웃` 뒤 `node $B <run id> login <who>`. 이미 로그인한 브라우저로 초대 링크를 열면 `invite-signed-in` 화면이 나온다.
- 초대 폼 자체(`invite-create`)는 화면으로 몬다: `node $B <run id> open /members`, 이메일·역할을 `type`/`select`, `click "초대 링크 만들기"`. 그 링크의 token은 출력하지 않는다(`eval`로 읽지 말고 스크린샷이나 목록의 "대기 중"으로 확인한다).

역할 변경·비활성은 owner 화면에서 `select`/`click` 뒤 DB로 다시 읽는다(읽기만).

```sh
ap_compose exec -T postgres psql -U postgres -d sessions -c "select u.email, m.role, m.disabled_at from memberships m join users u on u.id=m.user_id order by u.email" | tee "$EVIDENCE/members-db.txt"
```

비활성 뒤 초대받은 사람으로 `node $B <run id> open /`을 다시 열면 `/login?redirect=%2F`.

에이전트는 `/agents/new`에서 만든다. 폼 칸에 name이 없어 `@N`(main 안 N번째 칸, 0부터)으로 고른다. member로 로그인한 브라우저에서:

```sh
node $B <run id> open /agents/new
node $B <run id> type @0 "Member Helper"; node $B <run id> type @1 member-helper   # 이름, 주소 이름
node $B <run id> type @2 "verify helper"; node $B <run id> type @3 "Answer briefly."   # 역할, 지시 사항
node $B <run id> select @6 claude-sonnet-5     # 모델 select
node $B <run id> click "에이전트 만들기"        # → /agents/<id>?notice=created
node $B <run id> click "release 만들기"         # runtime profile select는 claude-coding-local · claude-sonnet-5
node $B <run id> click "활성화"
```

상세에서 지시를 고쳐 "저장"하면 새 version이다. 충돌은 같은 상세를 두 탭에 띄우고, 두 탭 모두 활성화 전 상태에서 A로 활성화한 뒤 B로 다른 release를 활성화한다(두 탭은 Orca 탭 둘로 연다. `browser.mjs`는 탭 하나만 쓴다).

```sh
ap_compose exec -T postgres psql -U postgres -d sessions -c "select a.slug, a.activation_revision, v.version_no as active_version, u.email as created_by from agents a left join agent_releases r on r.id=a.active_release_id left join agent_versions v on v.id=r.version_id left join users u on u.id=a.created_by" | tee "$EVIDENCE/agents-db.txt"
```

409 직후에는 revision과 version이 A가 활성화한 그대로여야 한다. B에서 "최신 상태 불러오기"를 누르면 보던·지금 활성 release와 카드 차이가 보이고, 그 뒤 활성화는 성공한다(revision +1).

- 2026-10-21 run `20261021-031642-23898`에서 member가 위 명령으로 `member-helper`를 만들고 활성화했다(`active_version 1`, `created_by member@example.test`). 같은 run에서 `invite` → `browser.mjs accept` → `web-user.mjs login`(200)도 확인했다.

끝나면 `node $B <run id> stop`(`down.sh`도 부른다). Orca 탭을 열었으면 `orca tab close --page <id>`, profile은 `orca tab profile delete --profile <id>`로 지운다.

## Gotchas

- `orca click`이 접힌 영역 아래 버튼(상세의 "저장")을 누르지 못할 때가 있다. 겹친 요소는 없었다. `orca eval --expression "[...document.querySelectorAll('button')].find(b=>b.textContent==='저장').click()"`로 누른다. `browser.mjs click`은 처음부터 이렇게 누른다.
- 비활성된 사람의 탭은 열린 채로는 `me`의 staleTime(30초)이 지나고 포커스가 돌아와야 로그인 화면으로 간다. 다시 열면 바로 간다.
- `GET /v1/members`가 owner·admin(`member.manage`) 전용이라 member는 구성원 목록을 못 본다. 권한 없음 화면이 맞는 결과다.
- 웹 카드 폼에는 `credential_refs`가 없어 웹에서 만든 에이전트는 바로 활성화된다. API로 `capabilities.credential_refs`를 넣은 카드는 연결 전 활성화가 `409 CREDENTIAL_UNBOUND`다. 자격 연결·Slack 앱 연결 화면은 아직 없고 API로만 한다([musterrolle.md](./musterrolle.md) f·g).
- 초대 token은 URL 경로에 있다. 텍스트 증거에는 링크를 남기지 않는다. 초대 링크 스크린샷의 token은 수락이나 회수 뒤 무효다.
- 같은 사람을 두 번 초대하지 않는다. `invite`는 그 사람의 `users/<who>`가 이미 있으면 새 비밀번호를 만들지 않고 그대로 쓴다.

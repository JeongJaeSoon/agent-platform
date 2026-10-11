# 웹 초대·구성원·에이전트

owner는 웹 콘솔 `/members`에서 초대 링크를 만들어 건네고, 받은 사람은 `/invite/{token}`에서 비밀번호를 정해 들어온다. owner는 같은 화면에서 역할을 바꾸고 비활성화·재활성화한다. `/agents`에서는 빈 카드로 에이전트를 만들고, `/agents/{id}`에서 카드를 고쳐 새 version을 저장하고, release를 만들어 활성화한다. 두 탭이 같은 활성화를 다투면 늦은 탭은 덮어쓰지 않고 409를 안내한다. 홈 checklist의 "팀원 초대"·"에이전트 만들기"는 이 상태를 그대로 보인다.

## Sub-features

- `invite-create` `/members`의 초대 폼(이메일, 역할은 contracts의 역할 값)을 내면 `<origin>/invite/<token>` 링크가 한 번만 보인다. 대기 중 초대 목록에 생기고 "회수"로 지운다.
- `invite-accept` 로그인하지 않은 브라우저로 링크를 열면 비밀번호·이름 폼. 내면 `/`에 그 사람 이름으로 로그인된다.
- `invite-signed-in` 이미 로그인한 브라우저로 링크를 열면 "이미 로그인돼 있습니다" 안내와 로그아웃 후 수락 버튼.
- `invite-used` / `invite-expired` 이미 쓴 링크는 409 "이미 사용된 초대", 회수했거나 없는 링크는 410 "만료됐거나 회수된 초대". 폼 대신 안내만 남는다.
- `member-forbidden` member로 `/members`를 열면 서버 403 문구와 함께 권한 없음 화면, 초대 버튼은 꺼진 채 이유가 붙는다.
- `role-change` 역할 select를 바꾸면 바로 PATCH, 마지막 owner를 내리면 409 LAST_OWNER 문구.
- `disable` "비활성"은 확인 대화상자를 거친다. 비활성된 사람은 다음 `me` 조회에서 로그인 화면으로 간다. "재활성"은 바로 된다.
- `agent-create` `/agents/new`는 빈 카드 폼. 만들면 상세로 가서 "에이전트를 만들었습니다(version 1). 아직 활성화되지 않았습니다".
- `agent-save` 카드를 고쳐 저장하면 "저장했습니다 — version N. 아직 활성화되지 않았습니다"와 두 version의 차이. 바뀐 것 없으면 새 version이 없다고 말한다. release 폼은 방금 저장한 version을 고른다.
- `release-activate` release를 만들고 "<version · profile> 활성화"를 누르면 "활성화됐습니다 — 이제 새 세션은 …(으)로 시작합니다". 저장·release·활성화 문구는 서로 다르다.
- `activate-conflict` 다른 탭이 먼저 활성화했으면 409 "다른 곳에서 먼저 활성화를 바꿨습니다 … 덮어쓰지 않고 멈췄습니다". "최신 상태 불러오기" 뒤 "보던 화면의 활성 release: …. 지금 활성 release: …."와 두 카드의 차이가 보이고, 그다음에야 다시 활성화된다.
- `checklist` 홈의 "팀원 초대"는 구성원이 둘 이상이거나 초대가 있으면, "에이전트 만들기"는 활성 release가 있는 에이전트가 있으면 완료. 조회가 실패하면 "확인할 수 없음".

## How to get to it (user POV)

- owner로 `$VERIFY_API/`에 로그인해 상단 nav의 "구성원"·"에이전트"로 간다.
- 초대받는 사람은 owner와 cookie를 나누지 않는 다른 브라우저 profile로 링크를 연다.
- runtime profile 목록 API가 없어 release 폼의 runtime profile은 직접 적는다. 로컬 스택은 `claude-coding-local`.

## Driving it with lib.sh

Preconditions: [web-console.md](./web-console.md)대로 owner(`owner@example.test` / `verify-owner-pass-1`)를 bootstrap하고 로그인했다. `orch hold browser --note "<what>"`를 잡았다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh "$RUN"
orca goto --url "$VERIFY_API/members"
orca snapshot                                   # 초대 폼, 구성원 표(owner 한 줄)
orca fill --element <"이메일" ref> --value mate@example.test
orca select --element <"역할" ref> --value member     # fill은 label을 보내 400이 난다
orca click --element <"초대 링크 만들기" ref>
orca eval --expression "document.querySelector('[data-testid=invite-link] input').value" --json \
  | jq -r '.result.value // .result.result // .result' > "$VERIFY_RUN/invite-url"   # evidence 밖에 둔다
```

초대받는 쪽은 격리 profile의 새 탭으로 연다.

```sh
orca profile create --label invitee --scope isolated --json     # owner와 cookie를 나누지 않는다
orca tab create --url "$(cat "$VERIFY_RUN/invite-url")" --profile <profile id> --json
orca fill --page <invitee page> --element <"비밀번호" ref> --value verify-mate-pass-1
orca click --page <invitee page> --element <"초대 수락" ref>
orca eval --page <invitee page> --expression "location.pathname"   # /
```

역할 변경·비활성은 owner 탭에서 `orca select`/`orca click` 뒤 DB로 다시 읽는다(읽기만).

```sh
ap_compose exec -T postgres psql -U postgres -d sessions -c "select u.email, m.role, m.disabled_at from memberships m join users u on u.id=m.user_id order by u.email" | tee "$EVIDENCE/members-db.txt"
```

비활성 뒤 초대받은 사람 탭을 `orca goto --url "$VERIFY_API/"`로 다시 열면 `/login?redirect=%2F`.

에이전트는 `/agents/new`에서 이름·주소 이름·역할·지시·모델을 채워 "에이전트 만들기", 상세에서 지시를 고쳐 "저장", runtime profile `claude-coding-local`로 "release 만들기", "… 활성화". 충돌은 같은 상세를 두 탭에 띄우고, 두 탭 모두 활성화 전 상태에서 A로 활성화한 뒤 B로 다른 release를 활성화한다.

```sh
ap_compose exec -T postgres psql -U postgres -d sessions -c "select a.slug, a.activation_revision, v.version_no as active_version from agents a left join agent_releases r on r.id=a.active_release_id left join agent_versions v on v.id=r.version_id" | tee "$EVIDENCE/agents-db.txt"
```

409 직후에는 revision과 version이 A가 활성화한 그대로여야 한다.

## Gotchas

- `orca click`이 접힌 영역 아래 버튼(상세의 "저장")을 누르지 못할 때가 있다. 겹친 요소는 없었다. `orca eval --expression "[...document.querySelectorAll('button')].find(b=>b.textContent==='저장').click()"`로 누른다.
- 비활성된 사람의 탭은 열린 채로는 `me`의 staleTime(30초)이 지나고 포커스가 돌아와야 로그인 화면으로 간다. 다시 열면 바로 간다.
- `GET /v1/members`가 owner 전용이라 member는 구성원 목록을 못 본다. 권한 없음 화면이 맞는 결과다.
- 초대 token은 URL 경로에 있다. 텍스트 증거에는 링크를 남기지 않는다. 초대 링크 스크린샷의 token은 수락이나 회수 뒤 무효다.

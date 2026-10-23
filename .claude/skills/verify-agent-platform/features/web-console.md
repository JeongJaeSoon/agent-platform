# 웹 콘솔

API가 `WEB_DIST_DIR`(control-host 이미지는 `/app/apps/web/dist`)의 웹 콘솔을 같은 origin에서 서빙한다. 사용자는 브라우저로 `/bootstrap`에서 첫 소유자(owner)를 만들고, `/login`에서 로그인해 `/`의 workspace shell과 시작하기 checklist를 보고, 로그아웃한다. `/v1`·`/internal` 밖의 경로는 모두 `index.html`이라 새로고침해도 화면이 열린다.

## Sub-features

- `serving` 페이지 경로는 `index.html`(`no-cache`, `script-src 'self'` CSP), `/assets/*`는 `immutable`, 없는 asset은 404.
- `api-404` `/v1/nope`는 fallback되지 않는다: 인증 없으면 JSON 401, 인증하면 JSON 404.
- `login-required` 로그인 없이 `/`를 열면 `/login?redirect=%2F`로 가고 "다시 로그인하세요"가 보인다.
- `bootstrap` `/bootstrap`은 제목 "첫 소유자 만들기"로 열리고, 제출하면 `/login?notice=created`.
- `bootstrap-done` 소유자가 이미 있으면 제출 결과가 409라 `/bootstrap`에 머문 채 폼 아래 오류 줄에 "이미 소유자가 있습니다. 로그인해 주세요. 로그인하기"(마지막 말이 `/login` 링크)가 보인다. `/login?notice=bootstrap_done` 안내는 그 주소로 직접 열 때만 나온다.
- `login` 로그인하면 `/`에 workspace 이름, "<이름>(<이메일>) 계정으로 로그인했습니다", checklist 넷(첫째만 완료).
- `logout` 로그아웃하면 `/login?notice=logged_out`, 다시 `/`를 열면 로그인 화면.
- `session-ended` 로그인한 채 다른 곳에서 세션이 끝나면(다른 탭 로그아웃), 다음 `me` 재조회가 401을 받아 `/login?redirect=…`로 간다.
- `locale` 오른쪽 아래 언어 선택(한국어·English).
- `google-callback` `/auth/google/callback`도 SPA 경로다. 로그인 화면의 Google 버튼은 `login-methods`에 `google`이 있을 때만 보인다([web-settings.md](./web-settings.md) `login-choice`).
- `states` 화면마다 로딩("로그인 상태를 확인하는 중입니다" 등)·오류("서버에 연결하지 못했습니다 — 네트워크 연결을 확인하세요.")·빈 상태가 있고, 390px 폭과 다크 모드(`prefers-color-scheme: dark`)에서도 가로로 넘치지 않는다.

## How to get to it (user POV)

- 브라우저로 `$VERIFY_API/`를 연다. 첫 설치면 로그인 화면의 "첫 소유자 만들기" 링크로 `/bootstrap`에 간다.
- 403(권한 없음) 화면은 cookie 세션이 `me`에서 403을 받아야 나오는데, 웹 사용자는 owner·member 모두 `sessions:read`를 가져 사용자 경로로는 만들 수 없다. 컴포넌트 테스트(`apps/web/src/app.test.tsx`)가 본다.

## Driving it with lib.sh

Preconditions: 새 `up.sh` 직후(bootstrap 전). `<run id>`는 `up.sh`가 출력한 값이다.

서빙은 curl로 본다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh <run id>
for p in / /login /bootstrap /sessions/deep/link; do curl -sS -o /dev/null -D - "$VERIFY_API$p" | grep -iE '^HTTP|cache-control|content-security'; done
curl -sS -w '\n%{http_code}\n' "$VERIFY_API/v1/nope"            # 401 JSON
curl -sS -o /dev/null -w '%{http_code}\n' "$VERIFY_API/assets/missing.js"   # 404
```

화면은 이 run의 headless Chrome으로 몬다: `scripts/browser.mjs`. run 디렉터리 안의 전용 user-data-dir(`browser/profile`)로 띄우고 PID를 `browser/pid`에 적으며, `stop`은 그 PID만(명령줄에 이 profile이 있을 때만) 끝내고 profile을 지운다. 사람의 Chrome 프로필이나 다른 Chrome 프로세스는 건드리지 않는다. 쓰기 전에 `orch hold browser --note "<what>"`, 끝나면 `stop` 뒤 `orch release browser`.

```sh
B=.claude/skills/verify-agent-platform/scripts/browser.mjs
node $B <run id> start                   # started headless Chrome pid N
node $B <run id> open /                  # /login?redirect=%2F | Agent Platform
node $B <run id> login owner             # web-user.mjs가 만든 users/owner로 /login 폼을 채운다 → "login owner -> /"
W=1280 THEME=light node $B <run id> shot home-1280-light   # evidence/home-1280-light.png, scrollWidth/innerWidth=1280/1280
W=390 THEME=dark node $B <run id> shot home-390-dark       # 390px, 다크. scrollWidth가 390이면 넘침 없음
node $B <run id> blockshot /sessions '*/v1/sessions*' sessions-error   # 그 요청을 실패시킨 오류 화면과 main 텍스트
node $B <run id> slowshot /sessions sessions-loading 3000              # 2.5초 지연 중 로딩 화면
node $B <run id> key Tab 3               # 포커스가 간 요소와 outline
node $B <run id> press "연결 해제"        # 그 버튼에 포커스를 두고 Enter → 경로와 그 뒤 포커스가 간 요소
node $B <run id> stop                    # stopped pid N; profile removed
```

- 간격·폭·정렬은 `measure`로 잰다. `W=1440 THEME=light node $B <run id> measure <set>-<화면>-1440-light`가 지금 화면의 `getBoundingClientRect` 값(사이드바 머리·topbar 경계선 y, 좌측 정렬선 x, 콘텐츠 폭, 머리→첫 섹션·섹션·블록 간격(상자와 글자 잉크 둘 다), 카드·목록 행 padding과 오른쪽 버튼 위치)을 `evidence/layout/<이름>.json`에 쓴다(`scripts/measure-layout.js`). 화면마다 1440·390 × light·dark로 잰 뒤 `node scripts/layout-report.mjs $EVIDENCE/layout <out dir> before after`가 v35 규칙(page-top 32·390은 16, page-head 24, section 32, block 16, 카드 안은 척도만, 필드 16, 카드 padding 16, 목록 행 12 16, topbar 52와 같은 선, 좌측선 하나)과 비교한 `before-vs-after.md`와 접두사별 csv를 쓰고, 화면끼리 다른 값(제목 y·섹션 간격)도 따로 모은다. 2026-10-23 run `20261023-152851-60390`에서 18화면을 이렇게 쟀다.
- 폭(`W`, 기본 1280)·높이(`H`, 900)·테마(`THEME`, `light`|`dark`)는 명령마다 `Emulation.setDeviceMetricsOverride`·`setEmulatedMedia`로 다시 건다. 600px 미만은 mobile로 그린다.
- 다른 명령: `click <버튼 글자|css>`, `press <버튼 글자|css> [Key]`, `type <css|@N> <text>`, `select <css|@N> <value>`, `eval <expr>`, `shot <name> full`(페이지 전체). `@N`은 main 안 N번째 입력 칸(0부터)이다.
- bootstrap 화면은 `node $B <run id> bootstrap <who>`로 몬다. `state.env`의 bootstrap token과 `users/<who>`(없으면 `web-user.mjs`와 같은 모양으로 만든다)로 폼 여섯 칸을 채워 제출하고, 값은 출력하지 않는다. 첫 제출은 `bootstrap owner -> /login?notice=created |`, 소유자가 이미 있으면(`web-user.mjs bootstrap owner` 뒤 등) `bootstrap owner -> /bootstrap | <오류 줄 글자>`다. token과 비밀번호를 `type`으로 명령에 쓰지 않는다.
- 포커스 회복(대화상자를 닫은 뒤, 보내기·삭제 뒤 포커스가 어디로 가는지)은 `press <버튼 글자|css> [Key]`로 본다. `click`은 `el.click()`이라 버튼에 포커스를 주지 않아, 키보드 사용자가 겪는 포커스 이동을 재현하지 못한다. `press`는 그 요소에 `focus()`를 한 뒤 CDP로 실제 키(기본 `Enter`)를 보내고, 끝난 뒤 `document.activeElement`(태그·이름·outline)를 출력한다. 찾지 못하면 `not found`, 찾았지만 포커스가 가지 않으면(disabled·숨김·포커스 불가 요소) `not focusable <태그> <글자>`만 출력하고 키를 보내지 않는다.
- 2026-10-22 run `20261022-073051-53892`에서 `bootstrap owner` 두 번으로 `/login?notice=created`와 `/bootstrap`의 409 오류 줄을 봤고, 그 `users/owner`로 `web-user.mjs login owner`가 `200`이었다. 연결 계정 한 줄을 둔 `/settings/linked-accounts`에서 `click "연결 해제"` 뒤 포커스는 `BODY`였고, 다시 연결한 뒤 `press "연결 해제"`는 `focus {"tag":"H2","name":"Slack","outline":"solid 2px"}`였다(해제 뒤 목록 제목).
- 2026-10-21 run `20261021-031642-23898`에서 member로 로그인해 `/sessions`를 1280·390 × light·dark로 찍었고(`scrollWidth/innerWidth` 1280/1280, 390/390), `blockshot`으로 "서버에 연결하지 못했습니다" 오류 화면, `slowshot`으로 로딩 화면을 찍었다.

Orca 브라우저(`orca tab`·`orca snapshot`)도 쓸 수 있다. 다른 스택이 같은 host에 로그인해 있으면 isolated profile(`orca tab profile create --scope isolated`)로 연다. 다만 Orca 탭이 hidden이면 `orca screenshot`이 "page did not draw a frame"으로 실패하고, 창 폭·color scheme·네트워크 실패를 바꾸지 못한다. 스크린샷·폭·상태 확인은 `browser.mjs`로 한다.

## Gotchas

- headless Chrome의 `--window-size=360,…`은 최소 창 폭(약 500px) 때문에 360px로 그려지지 않는다. `browser.mjs`는 창 크기 대신 device metrics를 바꿔서 390px도 그대로 그린다.
- `__Host-ap_session`은 `Secure`지만 Chromium은 `http://127.0.0.1`을 안전한 origin으로 보아 cookie를 저장한다. 브라우저 profile이 run마다 따로라 다른 스택의 cookie와 섞이지 않는다.
- `session-ended`를 몰려면 페이지에서 `fetch('/v1/auth/logout',{method:'POST',headers:{'x-requested-with':'agent-platform-web'}})`로 세션을 끝내고, 30초(`me`의 staleTime) 뒤 `window.dispatchEvent(new Event('visibilitychange'))`로 포커스 복귀를 흉내 낸다. `document`에 보내면 React Query가 듣지 않는다.
- bootstrap 완료 여부를 읽는 공개 GET이 없다. `/bootstrap`은 소유자가 있어도 같은 폼("첫 소유자 만들기")으로 열리고, 제출해야 409로 안다.
- `slowshot` 직후의 다음 명령은 페이지가 아직 불러오는 중일 수 있다. `open`으로 다시 연 뒤 이어 간다.

# 웹 콘솔

API가 `WEB_DIST_DIR`(control-host 이미지는 `/app/apps/web/dist`)의 웹 콘솔을 같은 origin에서 서빙한다. 사용자는 브라우저로 `/bootstrap`에서 첫 소유자(owner)를 만들고, `/login`에서 로그인해 `/`의 workspace shell과 시작하기 checklist를 보고, 로그아웃한다. `/v1`·`/internal` 밖의 경로는 모두 `index.html`이라 새로고침해도 화면이 열린다.

## Sub-features

- `serving` 페이지 경로는 `index.html`(`no-cache`, `script-src 'self'` CSP), `/assets/*`는 `immutable`, 없는 asset은 404.
- `api-404` `/v1/nope`는 fallback되지 않는다: 인증 없으면 JSON 401, 인증하면 JSON 404.
- `login-required` 로그인 없이 `/`를 열면 `/login?redirect=%2F`로 가고 "다시 로그인하세요"가 보인다.
- `bootstrap` `/bootstrap`은 제목 "첫 소유자 만들기"로 열리고, 제출하면 `/login?notice=created`.
- `bootstrap-done` 소유자가 이미 있으면 제출 결과가 409라 `/login?notice=bootstrap_done`.
- `login` 로그인하면 `/`에 workspace 이름, "<이름>(<이메일>)으로 로그인했습니다", checklist 넷(첫째만 완료).
- `logout` 로그아웃하면 `/login?notice=logged_out`, 다시 `/`를 열면 로그인 화면.
- `session-ended` 로그인한 채 다른 곳에서 세션이 끝나면(다른 탭 로그아웃), 다음 `me` 재조회가 401을 받아 `/login?redirect=…`로 간다.
- `locale` 오른쪽 아래 언어 선택(한국어·English).
- `google-callback` `/auth/google/callback`도 SPA 경로다. 로그인 화면의 Google 버튼은 `login-methods`에 `google`이 있을 때만 보인다([web-settings.md](./web-settings.md) `login-choice`).

## How to get to it (user POV)

- 브라우저로 `$VERIFY_API/`를 연다. 첫 설치면 로그인 화면의 "첫 소유자 만들기" 링크로 `/bootstrap`에 간다.
- 403(권한 없음) 화면은 cookie 세션이 `me`에서 403을 받아야 나오는데, 웹 사용자는 owner·member 모두 `sessions:read`를 가져 사용자 경로로는 만들 수 없다. 컴포넌트 테스트(`apps/web/src/app.test.tsx`)가 본다.

## Driving it with lib.sh

Preconditions: 새 `up.sh` 직후(bootstrap 전). `$RUN`은 `up.sh`가 출력한 run id다.

서빙은 curl로 본다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh "$RUN"
for p in / /login /bootstrap /sessions/deep/link; do curl -sS -o /dev/null -D - "$VERIFY_API$p" | grep -iE '^HTTP|cache-control|content-security'; done
curl -sS -w '\n%{http_code}\n' "$VERIFY_API/v1/nope"            # 401 JSON
curl -sS -o /dev/null -w '%{http_code}\n' "$VERIFY_API/assets/missing.js"   # 404
```

화면은 Orca 브라우저로 몬다. 쓰기 전에 `orch hold browser --note "<what>"`, 끝나면 `orch release browser`. ref는 화면이 바뀔 때마다 `orca snapshot`으로 다시 읽는다.

```sh
orca tab create --url "$VERIFY_API/"
orca snapshot                       # heading "로그인", heading "다시 로그인하세요"
orca click --element <"첫 소유자 만들기" ref>
orca fill --element <"Bootstrap 토큰" ref> --value "$VERIFY_BOOTSTRAP_TOKEN"   # 값은 출력하지 않는다
orca fill …  # 소유자 이메일 owner@example.test, 이름, 비밀번호 verify-owner-pass-1, 워크스페이스 이름 Verify, 워크스페이스 주소 이름 verify
orca click --element <"소유자 만들기" ref>
orca eval --expression "location.pathname+location.search"   # /login?notice=created
```

로그인·로그아웃도 같은 방식이다. 스크린샷은 `orca screenshot --format png --json`의 `result.data`(base64)를 `$EVIDENCE/*.png`로 풀어 남긴다.

폭별 가로 넘침은 브라우저 창 크기를 바꾸지 못하므로 페이지 안에 iframe을 띄워 잰다. 서빙된 페이지는 `frame-ancestors 'none'`이라 iframe을 막는다. 그래서 `bun run --cwd apps/web dev`(`VITE_API_TARGET=$VERIFY_API`, CSP 없음)에서 잰다. 360·768·1440에서 `documentElement.scrollWidth`가 iframe 폭과 같아야 한다.

## Gotchas

- headless Chrome의 `--window-size=360,…`은 최소 창 폭(약 500px) 때문에 360px로 그려지지 않는다. 그 스크린샷으로 넘침을 판정하지 않는다.
- `__Host-ap_session`은 `Secure`지만 Chromium은 `http://127.0.0.1`을 안전한 origin으로 보아 cookie를 저장한다.
- `session-ended`를 몰려면 페이지에서 `fetch('/v1/auth/logout',{method:'POST',headers:{'x-requested-with':'agent-platform-web'}})`로 세션을 끝내고, 30초(`me`의 staleTime) 뒤 `window.dispatchEvent(new Event('visibilitychange'))`로 포커스 복귀를 흉내 낸다. `document`에 보내면 React Query가 듣지 않는다.
- bootstrap 완료 여부를 읽는 공개 GET이 없다. `/bootstrap`은 소유자가 있어도 같은 폼("첫 소유자 만들기")으로 열리고, 제출해야 409로 안다.

# agent-platform 검증 map

이 디렉터리는 agent-platform의 사용자 표면을 확인하는 정본이다. 몰기 전에 이 index를 읽고, 해당 기능 파일을 절차로 쓴다.

## 기본 전제

- `scripts/up.sh`로 이 run만의 스택을 띄웠고, 출력된 run id를 기록했다(fake model, ephemeral 포트, 이 run의 bootstrap token).
- `scripts/doctor.sh <run id>`가 exit 0이고 checkout SHA가 확인하려는 커밋이다.
- 드라이브하는 Bash 호출마다 `. .claude/skills/verify-agent-platform/scripts/lib.sh <run id>`를 source한다. run id는 `up.sh`가 출력한 값이고 기본값은 없다.
- 이 run이 띄우지 않은 스택(기본 project `agent-platform`, 다른 `verify-ap-*`)은 몰지 않는다.

## 몰기 규칙

- 경로·헤더·JSON 키는 적힌 그대로 쓴다.
- 웹 사용자 행동은 `ap_web`, key 호출자는 `ap_get`·`ap_post`, 운영자 CLI는 `ap_key`·`ap_revoke`로 한다.
- 응답 마지막 줄이 HTTP 상태 코드다. 판정은 상태 코드와 본문의 `error.code`로 한다.
- bootstrap은 한 run에 한 번만 된다. 다른 상태에서 시작해야 하면 `down.sh <run id>` 뒤 `up.sh`.

## 증거와 생략 보고

- 출력은 `| tee "$EVIDENCE/<feature>.txt"`로 남긴다. 요청과 응답을 같이 남긴다.
- 상태를 바꾼 행동은 다른 읽기 경로로 다시 확인한다.
- key·cookie 값은 남기지 않는다.
- 몰 수 없던 진입점은 시도한 명령과 채워지지 않은 전제를 적는다. 다른 진입점으로 확인한 것을 그 진입점의 확인으로 보고하지 않는다.

## 기능 파일 형식

H1 제목과 사용자에게 보이는 동작 한 문단, 그다음 H2 넷을 이 순서로 둔다: `Sub-features`, `How to get to it (user POV)`, `Driving it with lib.sh`, `Gotchas`.

## 기능

- [웹 로그인](./web-login.md): 첫 owner bootstrap, 로그인, `me`, 로그아웃, CSRF·잘못된 비밀번호 거절.
- [웹 콘솔](./web-console.md): 브라우저로 `/bootstrap` → `/login` → `/`(workspace shell) → 로그아웃, SPA fallback과 `/v1` JSON 404.
- [API key](./api-keys.md): key CLI로 발급, scope 검사, 폐기 후 401.
- [세션](./sessions.md): fake model 대본으로 세션 생성·turn 완료·권한 요청·pause/resume (전체 경로는 `docs/quickstart.md` 3장).
- [운영 조회](./ops-endpoints.md): `/readyz`, `/docs`(API reference), `/v1/limits`, 세션 usage.
- [멤버·팀·권한 (Musterrolle)](./musterrolle.md): 시나리오 a–e. b(팀과 팀을 에이전트 관리자로), c(Slack 계정 연결), d(웹에서 권한별 key 발급), e의 판정 기록·보존 기간은 있고, 나머지는 구현 예정.

# 멤버·팀·권한 (Musterrolle)

**아직 없음(구현 예정).** workspace 멤버 초대·관리, 팀, Slack 계정 연동, 권한별 API key와 에이전트 서비스 key, 판정 기록(`authz_decisions`), 감사 열람·공유 범위를 사용자가 하는 순서대로 확인하는 자리다. 각 시나리오를 구현하는 티켓이 아래 자리를 실제 명령과 기대 결과로 채운다. 채우기 전까지 이 파일의 어떤 항목도 "확인됨"으로 보고하지 않는다.

## Sub-features

- `a-member-lifecycle` (아직 없음) owner 웹 로그인 → member 초대 → 수락·로그인 → 역할 변경 → 비활성화하면 웹과 key가 모두 막힌다.
- `b-teams` (아직 없음) 팀 생성 → 구성원 추가·제거(수락 없이, 알림만) → 팀을 에이전트 관리자로 지정 → 팀원은 그 에이전트를 관리할 수 있고 팀 밖 member는 못 한다.
- `c-slack-signin` (아직 없음) Sign in with Slack 연결·해제. 실제 Slack 동의는 사람이 하고, 자동 확인은 mock IdP로 한다.
- `d-scoped-keys` (아직 없음) member는 개인 key만, owner·admin·에이전트 관리자는 그 에이전트의 서비스 key를 발급한다. 권한이 없으면 403과 이유. 서비스 key는 그 에이전트 API만 부른다. 발급자를 비활성화하면 개인 key는 멈추고 서비스 key는 계속 동작한다.
- `e-authz-audit` (아직 없음) 위 행동이 `authz_decisions`에 남고, 감사 열람과 공유 범위가 설계대로다(감사 보존 기본 90일·하한 30일, DM 기본 "나만").

## How to get to it (user POV)

- (아직 없음) 웹 콘솔의 멤버·팀·연결·key 화면. 지금 있는 것은 [web-login.md](./web-login.md)의 bootstrap·login·me뿐이다. 초대 수락 계약(`acceptInviteRequestSchema`)은 `packages/contracts/src/musterrolle/auth.ts`에 있지만 route는 아직 없다.
- (아직 없음) 같은 동작의 HTTP API.

## Driving it with lib.sh

Preconditions:

- (구현 티켓이 채운다) 시나리오마다 필요한 사용자: owner는 [web-login.md](./web-login.md)의 bootstrap으로 만든다. member·admin은 초대 경로가 생기면 그 경로로 만든다. DB에 직접 넣지 않는다.

- **a.** (아직 없음) 초대 → 수락 → 로그인 → 역할 변경 → 비활성화 뒤 `ap_web GET /v1/auth/me`와 그 사용자의 key 호출이 모두 401/403인지.
- **b.** (아직 없음) 팀 관리자·팀원·팀 밖 member 세 cookie로 같은 에이전트 관리 요청을 보내 허용·거절을 비교.
- **c.** (아직 없음) mock IdP를 띄우는 방법과 연결·해제 뒤 `me`의 연결 표시.
- **d.** (아직 없음) 역할별 key 발급 요청과 403 이유, 서비스 key로 다른 에이전트 API 403, 발급자 비활성화 뒤 개인 key 401·서비스 key 200.
- **e.** (아직 없음) 위 행동 뒤 `authz_decisions` 열람 API(또는 감사 화면)에서 행동마다 한 줄씩 보이는지, 공유 범위 밖 사용자는 못 보는지. DB는 읽기 확인에만 쓴다.

## Gotchas

- (구현 티켓이 채운다)
- 실제 Slack 앱·OAuth 동의는 사람만 한다. 자동 확인은 mock IdP로만 하고 실제 Slack 연결은 "사람 확인 필요"로 보고한다.

# 결정(설계): 에이전트 담당 팀 필수와 에이전트·세션 액션 RBAC

- 상태: 설계. 오너 확인이 필요한 항목은 [(g) 오너 확인 필요](#g-오너-확인-필요)에 모았다. 각 항목에 추천과 답이 없을 때의 기본값을 적었고, 이 문서는 그 기본값으로 머지한다. 결정이 바뀌면 후속 PR로 고친다.
- 기준 커밋: `origin/main` `718c96c5c`. 아래 `파일:줄`은 이 커밋 기준이다.
- 오너 원문(2026-11-02): "에이전트는 무조건 담당 팀이 붙는게 좋을거 같아 / 관리팀으로 지정안되어잇으면 관리자의 설정에 따라 권한이 없다고 할수 잇는게 제한되거 / 에이전트 자체의 정보는 볼 수 잇더라도 설정에 따라서는 에이전트 내에서 세션의 상세내용을 모두 못보고 자기가 실행할수 잇는거지 / 음 관리팀인지 아닌지에 따라서 에이전트 정보를 열람하고 조회하고 사용할수 잇는지, 그리고 세션정보도 어덯게 열람하고 조회하거 사용할스 잇을지 등등의 액션에 대한 rbac 설계가 필요해보여"
- 오너 원문(같은 날, 앞선 결정에 대해): "나머지 d125 나 d126도 기본적 베이스가 되는 d124 설계따라 다를듯?"
- 앞선 설계: [agent-wizard-rework.md](agent-wizard-rework.md)(JeongJaeSoon/agent-platform#1067)의 항목 4와 U5a~U5c. 이 문서와 다르면 이 문서가 우선이다. 차이는 [(e)](#e-앞선-결정과의-차이)에 있다.
- "담당 팀"과 "관리 팀"은 같은 것(`agents.managing_team_id`)이다. 화면 문구는 '담당 팀'으로 통일한다.

## 요약

| 항목 | 결론 |
|---|---|
| 주체 | 워크스페이스 관리자(`owner`·`admin`), 에이전트 관리자(담당 팀 `lead`, 개인 관리자, 관리자 팀 구성원), 담당 팀 `member`, 담당 팀 밖 `member`. 앞의 셋을 이 에이전트의 **안쪽**, 마지막을 **바깥쪽**이라 부른다 |
| 안쪽 | 에이전트 정보·설정을 보고, 에이전트를 쓰고, 공유 범위 안의 세션을 지금처럼 본다. 설정을 고치는 것은 워크스페이스 관리자와 에이전트 관리자다 |
| 바깥쪽 | 기본값은 에이전트 정보(이름·설명·담당 팀)를 보고, 에이전트를 실행하고, 자기 세션과 이름이나 팀으로 공유받은 세션만 본다. 설정은 보지 못한다 |
| 워크스페이스 설정 두 축 | A. 바깥쪽의 에이전트 접근: `use`(보고 실행, 기본) / `view`(보기만) / `none`(숨김). B. `workspace` 공개 세션이 바깥쪽에 보이는지: `managing_team`(안 보임, 기본) / `workspace`(보임) |
| 담당 팀 필수 | 새 에이전트는 담당 팀이 있어야 한다. 기존 에이전트는 비어 있는 채로 두고 지금처럼 동작하게 한다. 관리 화면에서 담당 팀을 정하라고 안내한다. 담당 팀이 맡은 에이전트가 있으면 그 팀은 보관하지 못한다 |
| 앞선 결정 | d124(세션 공유 행의 기본값을 담당 팀으로)는 폐기하고 판정 시점의 열람 상한(축 B)으로 바꾼다. d125는 "자기가 속한 팀"으로 넓힌다. d126은 유지한다 |

## (a) 지금 구조 (실측)

### 판정이 이뤄지는 곳

- 라우트는 요청을 읽어 서비스를 부를 뿐이다. 권한 판정은 서비스가 `requirePermitted`·`requireAllowed`(`packages/platform/src/sessions/session-service.ts:268-299`)로 `policy.authorize`를 불러서 한다. 판정 본체는 `decide()`(`packages/platform/src/musterrolle/policy.ts:501-690`)다.
- action마다 필요한 것이 다르다.
  - 관리 action은 워크스페이스 역할 목록 `MANAGEMENT_ROLES`(`policy.ts:272-295`)로 판정한다. 역할이 모자라면 `AGENT_ADMIN_ACTIONS`(`policy.ts:309-317`)에 든 action만 그 에이전트의 관리자인지 다시 본다(`policy.ts:594-606`). 사람이 아니면(API key) 늘 거절이다(`policy.ts:595`).
  - 세션 action은 scope로 판정한다(`ACTION_SCOPES`, `policy.ts:254-261`). 사람의 scope는 역할에서 나온다. `owner`는 전부, `admin`·`member`는 `sessions:recover`를 뺀 전부다(`packages/contracts/src/musterrolle/authorization.ts:43-51`).
- 리소스가 워크스페이스면 에이전트 관리자 경로를 타지 못한다. `agentOf`가 워크스페이스 종류에 null을 돌려주기 때문이다(`packages/db/src/agent-authority.ts:81`).
- 에이전트 관리자 판정(`isAdmin`, `agent-authority.ts:101-127`)은 살아 있는 구성원인지 본 뒤 `administers()`(`packages/db/src/administers.ts:27-68`)를 부른다. 경로는 개인 관리자 행(`administers.ts:33-42`)과, 관리자 팀의 살아 있는 구성원(`administers.ts:43-66`) 둘이다. 쓰기 안의 재확인은 잠금을 거는 `lockedAdministers()`(`packages/db/src/agent-admins.ts:28`)다.
- 팀에는 구성원 역할이 없다(`packages/db/migrations/0145_member_teams.sql:10-18`). 팀을 만들고 구성원을 넣는 것은 `team.manage`(`owner`·`admin`, `policy.ts:278`)다. 에이전트에는 담당 팀 열이 없다(`packages/db/migrations/0139_agents.sql:48-62`).
- 워크스페이스 설정은 `workspaces.settings` jsonb의 키다. 지금 키는 Slack 게스트 허용 하나다(`packages/db/src/workspace-settings.ts:18`, 쓰기 `:26-50`). 바꾸는 사람은 `workspace.manage`(`apps/control-host/src/api/routes/workspaces.ts:84-93`)다.

### 에이전트 action

"관리자"는 워크스페이스 `owner`·`admin`, "에이전트 관리자"는 개인 관리자나 관리자 팀 구성원이다.

| action | 라우트 | 판정(서비스) | 지금 할 수 있는 사람 |
|---|---|---|---|
| 에이전트 목록·요약·개수 | `apps/control-host/src/api/routes/agents.ts:27`, `:36` | 워크스페이스에 `agent.manage`(`packages/platform/src/agents/agent-service.ts:276`, `:297`) | 관리자만. `member`는 에이전트 관리자여도 403이다. 화면은 "전체 에이전트 목록은 소유자와 관리자만 봅니다"(`apps/web/src/i18n/agents.ts:9-10`)를 보인다 |
| 내가 관리하는 에이전트 | `apps/control-host/src/api/routes/teams.ts:144` | 판정 없음. `administers()`로 거른 목록(`packages/db/src/agent-admins.ts:282-292`) | 로그인한 누구나. `member`가 받는 에이전트 목록은 이것뿐이다 |
| 에이전트 상세(카드·버전·릴리스) | `routes/agents.ts:51` | 에이전트에 `agent.manage`(`agent-service.ts:301-306`) | 관리자, 에이전트 관리자 |
| 에이전트 만들기 | `routes/agents.ts:43` | 워크스페이스에 `agent.create`(`agent-service.ts:313`) | `owner`·`admin`·`member`. 만든 사람이 개인 관리자가 된다(`packages/db/src/agents.ts:422-428`). 만드는 경로는 이것 하나다(`agents.ts:401`) |
| 이름·카드 고치기, 릴리스 만들기·켜기 | `routes/agents.ts:59`, `:68`, `:77` | `agent.manage`(`agent-service.ts:341`, `:372`, `:488`) | 관리자, 에이전트 관리자 |
| 관리자 목록·추가·삭제(사람·팀) | `routes/teams.ts:105`, `:113`, `:131` | `agent.admin.manage`(`packages/platform/src/musterrolle/agent-admin-service.ts:67-71`, `:80`) | 관리자, 에이전트 관리자. 관리자 팀은 보관되지 않은 어느 팀이든 추가한다(`agent-admins.ts:208-231`). 마지막 관리자를 지우는 것도 막지 않는다 |
| 자격 증명 연결 목록·연결·해제 | `apps/control-host/src/api/routes/credential-bindings.ts:22`, `:34`, `:50` | 목록까지 `credential.bind`(`packages/platform/src/musterrolle/credential-binding-service.ts:51-66`) | 관리자, 에이전트 관리자 |
| 에이전트 key 발급·폐기 | `apps/control-host/src/api/routes/api-keys.ts:22`, `:39` | 에이전트에 `api_key.manage`(`packages/platform/src/musterrolle/api-key-service.ts:79-89`) | 관리자, 에이전트 관리자 |
| GitHub 설정·저장소·활동 | `apps/control-host/src/api/routes/agent-github.ts:21`, `:30`, `:45` | `agent.manage`(`packages/platform/src/agents/agent-github-service.ts:157-161`) | 관리자, 에이전트 관리자 |
| Slack 연결·앱·채널 | `apps/control-host/src/api/routes/slack-bindings.ts:23`, `:31` 외 | `binding.manage`(`packages/platform/src/musterrolle/surface-binding-service.ts:100-104`) | 관리자, 에이전트 관리자 |
| 에이전트 사용량·성과 | `apps/control-host/src/api/routes/usage.ts:39` 외 | `usage.agent_read`(`packages/platform/src/usage/usage-service.ts:164-179`) | 관리자, 에이전트 관리자 |
| 보관·복원 | 없음 | `agent.restore`(`policy.ts:284`)는 정의만 있고 부르는 곳이 없다 | — |
| **에이전트로 세션 시작(웹·API)** | `apps/control-host/src/api/routes/sessions.ts:42` | `session.submit`, 리소스 `{session, id: null, agent_id, release_id}`(`session-service.ts:623-646`) | `sessions:write`를 가진 누구나. **그 에이전트와의 관계는 보지 않는다.** 에이전트 key는 자기 에이전트만(`policy.ts:609-616`). 자격 증명이 연결되지 않았으면 거절(`policy.ts:682-686`) |
| **Slack으로 세션 시작** | `packages/platform/src/musterrolle/slack-session-handler.ts:249-279` | `session.submit`, surface binding과 활성 릴리스 | 살아 있는 구성원과 연결된 Slack 사용자. 게스트는 설정이 켜졌을 때만, 외부 사용자는 안 된다(`policy.ts:529-537`). 앱이 그 에이전트의 것이어야 한다(`policy.ts:643-647`). 사람과 에이전트의 관계는 보지 않는다 |

- 에이전트를 읽는 action이 따로 없다. 읽기도 쓰기 action(`agent.manage`·`credential.bind`·`binding.manage`)으로 판정하므로, 에이전트를 보는 사람은 관리자와 에이전트 관리자뿐이다.

### 세션 action

| action | 라우트 | 판정 | 지금 할 수 있는 사람 |
|---|---|---|---|
| 목록·개수 | `routes/sessions.ts:54`, `:63` | `session.read`, `id: null`(`session-service.ts:1336-1339`, `:1368`). SQL이 공유 범위로 거른다(`packages/db/src/postgres-unit-of-work.ts:950-971`, `:958`) | 볼 수 있는 세션만. `relation`·`agent_id`·`q`는 좁히기만 한다 |
| 상세·turn·SSE·결과물·사용량·pending·receipt | `routes/sessions.ts:71`, `:176`; `routes/events.ts:112`; `routes/outputs.ts:14` 외 | `session.read`(`session-service.ts:1376`, `:1411`, `:1443`) | 볼 수 있는 사람. SSE는 페이지를 읽을 때마다 다시 판정하고, 404면 `not_visible`로 끊는다(`apps/control-host/src/api/routes/events.ts:338-344`). 결과물은 `artifact.read`가 아니라 `session.read`로 판정한다(`packages/platform/src/sessions/output-service.ts:26-28`) |
| 메시지 보내기 | `routes/sessions.ts:88` | `session.submit`(`session-service.ts:825-828`) | 볼 수 있는 사람 |
| interrupt·pause·close·terminate·resume·profile | `apps/control-host/src/api/routes/interrupt.ts:19`, `pause.ts:19`, `close.ts:19`, `sessions.ts:106`, `:124`, `:142` | `session.control`(`session-service.ts:954`, `:998`, `:907-913`, `:1267`, `:1047`) | 볼 수 있는 사람(`sessions:control`은 `member`도 가진다) |
| 승인·질문 답·push 결정 | `apps/control-host/src/api/routes/pending.ts:28` 외 | `session.approve`, 이어서 `mayAnswer`(`policy.ts:451-497`) | 볼 수 있는 사람 가운데 만든 사람, 관리자, 에이전트 관리자, 그 에이전트의 key. 세션을 시작한 key는 승인하지 못한다(`policy.ts:465-470`) |
| 이름 바꾸기 | `routes/sessions.ts:79` | `session.rename`, `mayAnswer`(`policy.ts:651-662`) | 승인과 같은 사람 |
| 공유 범위 바꾸기 | `apps/control-host/src/api/routes/session-shares.ts:39` | `session.share`, `mayShare`(`policy.ts:425-445`) | 사람이 만든 세션은 만든 사람만. key가 만든 세션은 관리자와 에이전트 관리자 |
| 감사 열람·관리자 목록·관리자 종료 | `routes/session-shares.ts:48`, `:57`, `:62` | `session.audit_read`·`session.admin_list`(`policy.ts:288-289`), 공유 밖은 사유가 있을 때만(`policy.ts:566-576`) | 관리자. 관리자 목록은 메타데이터만 준다 |
| 복구 결정 | `routes/sessions.ts:158` | `session.recover` | `owner`만 |

- 공유 범위 판정은 `sessionVisibleTo`(`packages/db/src/session-shares.ts:95-101`)다. 공유 행이 없거나 범위가 `workspace`면 누구나(`:97`), 아니면 만든 사람, 이름으로 지정된 사람, 지정된 팀의 지금 구성원이 본다. 팀은 보관되지 않았고 구성원 행이 지워지지 않은 것만 센다. 잠금 아래에서 다시 보는 구현이 따로 있다(`lockSessionReach`, `packages/db/src/requester-locks.ts:167`). 공유 규칙을 바꾸면 두 곳을 같이 고친다.
- 공유 범위 바깥이면 관리자도 보통 화면에서는 404다. 볼 수 있는 길은 사유를 남기는 감사 열람뿐이다(`policy.ts:566-576`). 에이전트 관리자에게는 공유 밖 세션을 보는 길이 없다. 운영자 문서에도 그렇게 적혀 있다(`docs/operator/api-server.md:629`).
- 세션을 만들 때 공유 행을 쓰는 것은 `shareScope`가 있을 때뿐이다(`postgres-unit-of-work.ts:310-320`). 웹·API 라우트는 이 값을 넘기지 않는다(`routes/sessions.ts:42-50`). 그래서 웹·API 세션은 공유 행 없이 `workspace`로 시작한다. 이 값을 넘기는 곳은 Slack DM의 `private`(`slack-session-handler.ts:415`)뿐이다.
- 에이전트별 사용량은 공유와 상관없이 그 에이전트의 모든 세션을 합한 수치다. 최근 항목의 세션 id·제목은 볼 수 있는 세션만 드러낸다(`packages/db/src/usage-reader.ts:101-105`, `:517-531`).

### 정리하면

- 에이전트는 관리자와 에이전트 관리자만 볼 수 있다. 그런데 실행에는 제한이 없어서, 에이전트를 볼 수 없는 `member`도 릴리스 id만 알면 그 에이전트로 세션을 시작한다.
- 세션을 볼 수 있는지는 세션마다 정하는 공유 범위 하나로 정한다. 그 세션이 어느 에이전트의 것인지는 판정에 들어가지 않는다.
- "관리 팀 안인지 밖인지"를 판정에 쓰는 곳이 아무 데도 없다.

## (b) RBAC 표

### 주체

| 주체 | 정의(판정 시점마다 다시 읽는다) |
|---|---|
| W. 워크스페이스 관리자 | 역할이 `owner`·`admin`인 사람 |
| L. 에이전트 관리자 | `administers()`가 참인 사람. 지금의 두 경로(개인 관리자, 관리자 팀 구성원)에 **담당 팀의 `lead`** 경로를 더한다 |
| T. 담당 팀 구성원 | 담당 팀(보관되지 않음)의 살아 있는 구성원 가운데 L이 아닌 사람. 팀 역할은 `member` |
| O. 바깥쪽 | 위 셋이 아닌 워크스페이스 `member` |

- W·L·T를 그 에이전트의 **안쪽**이라 한다. 판정 함수 하나(`insideAgent`)로 정의하고, 정책과 목록 SQL이 이 함수를 같이 쓴다.
- 담당 팀이 비어 있는 에이전트(이행 중)에는 T가 없다. 안쪽은 W·L뿐이다.
- 개인 key는 만든 사람으로 판정한다(지금과 같다, `policy.ts:338-354`). 에이전트 key는 멤버가 아니다. 자기 에이전트의 안쪽으로 본다. 그래도 자기 에이전트 밖으로 나갈 수 없다는 상한(`policy.ts:609-616`)은 그대로다. 에이전트 key의 다른 권한도 바꾸지 않는다.

### 대상과 액션의 기본값

✓ 할 수 있음, ✗ 못 함. "축 A"·"축 B"는 [(c)](#c-워크스페이스-설정-축)의 설정이다. 표의 값은 그 기본값(`use`, `managing_team`)일 때다.

| 대상 | 액션 | W | L | T | O |
|---|---|---|---|---|---|
| 에이전트 정보(이름·slug·설명·담당 팀·상태·활성 릴리스 id) | 목록에서 찾기, 열람 | ✓ | ✓ | ✓ | ✓ (축 A가 `none`이면 ✗, 404) |
| 에이전트 설정(카드·버전·릴리스·관리자 목록·자격 증명 연결 목록·GitHub·Slack 설정) | 열람 | ✓ | ✓ | ✓ | ✗ |
| 에이전트 설정 | 수정(카드·릴리스·GitHub·Slack·자격 증명) | ✓ | ✓ | ✗ | ✗ |
| 에이전트 관리자·담당 팀 | 수정 | ✓ | ✓ (아래 제한) | ✗ | ✗ |
| 에이전트 key | 발급·폐기 | ✓ | ✓ | ✗ | ✗ |
| 에이전트 사용량·성과 | 열람·성과 검토 | ✓ | ✓ | ✗ | ✗ |
| 에이전트 실행 | 세션 시작(웹·API·Slack) | ✓ | ✓ | ✓ | ✓ (축 A가 `use`일 때만) |
| 세션 목록 | 조회 | 볼 수 있는 세션 | 볼 수 있는 세션 | 볼 수 있는 세션 | 자기 세션과 이름·팀으로 공유받은 세션 |
| 세션 상세·로그·결과물 | 열람 | 공유 범위대로 | 공유 범위대로 | 공유 범위대로 | 자기 세션과 이름·팀으로 공유받은 세션(축 B) |
| 세션 | 메시지 보내기, interrupt·close 등 제어 | 볼 수 있으면 | 볼 수 있으면 | 볼 수 있으면 | 볼 수 있으면 |
| 세션 | 승인·이름 바꾸기 | ✓ (볼 수 있으면) | ✓ (볼 수 있으면) | 자기 세션만 | 자기 세션만 |
| 세션 | 공유 범위 바꾸기 | 지금처럼 | 지금처럼 | 지금처럼 | 지금처럼 |
| 세션 | 공유 밖 감사 열람·관리자 목록·관리자 종료 | ✓ (사유) | ✗ | ✗ | ✗ |

- **L과 T의 차이**: 둘 다 에이전트 정보와 설정을 보고, 에이전트를 쓰고, 안쪽 세션을 본다. 바꾸는 권한(설정·관리자·key)과 남의 세션에 답하는 권한(승인·이름 바꾸기)은 L만 있다. 앞선 설계(T는 관리 권한 없음)와 같고, 설정 열람과 세션 열람을 T에게 준다는 점이 새로 정해진 것이다.
- **O가 세션을 보는 범위**: 축 B가 `managing_team`이면 공유 범위가 `workspace`인 세션(공유 행이 없는 것 포함)이 O에게 닿지 않는다. 만든 사람이 일부러 고르는 `people`·`team` 범위는 지금처럼 O에게도 닿는다. 이 둘은 남에게 보이려고 고르는 것이고 receipt도 남는다(`docs/operator/api-server.md:631`). 오너가 말한 "자기가 실행한 것만"과는 이 예외만큼 다르다. 이 예외도 막을지는 [(g) G6](#g-오너-확인-필요)에 올렸다.
- **세션 목록의 메타데이터**: 목록은 상세와 같은 기준으로 거른다. 제목만 따로 보이는 등급은 두지 않는다. 제목에도 내용이 들어가기 때문이다. 관리자가 메타데이터만 보는 관리자 목록은 지금처럼 둔다.
- **세션 제어**: 볼 수 있는 사람이 남의 세션에 메시지를 보내는 것은 그대로 둔다. Slack 채널 스레드에서 여러 사람이 한 세션에 말을 거는 것이 이 경로다(`SLACK_SURFACE_ACTION_VALUES`, `packages/contracts/src/kollegium/surfaces.ts:98-103`). interrupt·close 같은 제어를 만든 사람과 L만으로 좁힐지는 [(g) G7](#g-오너-확인-필요)에 올렸다. 기본값은 지금 그대로다.
- **L의 제한**
  - W가 아닌 L은 담당 팀을 **자기가 속한 팀**(`lead`·`member`)으로만 바꾼다. 비우는 것(null)은 누구도 못 한다([(d)](#d-담당-팀-필수)).
  - 관리자 팀(`agent_admin_teams`)을 새로 추가할 때는 W가 아니면 **자기가 `lead`인 팀**만 고른다. 관리자 팀은 구성원 모두에게 관리 권한을 주므로, 담당 팀보다 좁게 막는다. 이미 있는 행은 그대로 둔다.
- **바꾸지 않는 것**: 공유 범위 바꾸기(`mayShare`), 승인 판정(`mayAnswer`)의 구조, W의 감사 열람, `owner`만 하는 복구는 그대로 둔다. L이 늘어나는 것은 `administers()`에 담당 팀 `lead` 경로가 더해지기 때문이다. `mayAnswer`·`mayShare` 코드는 고치지 않는다.

### 판정 구현

| 대상 | 바뀌는 것 |
|---|---|
| action | 읽기 action 둘을 새로 둔다. `agent.read`(에이전트 정보)와 `agent.settings_read`(설정 열람)이다. 지금 쓰기 action으로 판정하는 읽기를 이 둘로 옮긴다. 상세는 `agent-service.ts:301-306`, 자격 증명 연결 목록은 `credential-binding-service.ts:69-80`, GitHub 조회는 `agent-github-service.ts:164`, Slack 연결 목록은 `surface-binding-service.ts:167-178`, 관리자 목록은 `agent-admin-service.ts:116-124`다. 계약의 action 목록(`packages/contracts/src/musterrolle/authorization.ts:316-373`)과 리소스 표(`:387-424`)에 더한다 |
| `agent.read` | W는 통과. 그 밖에는 안쪽이거나 축 A가 `none`이 아니면 통과. 목록(`GET /v1/agents`)은 워크스페이스 단위 판정을 그만두고 행마다 같은 조건으로 거른다(SQL). O가 받는 항목은 에이전트 행(`agent`)뿐이다. 카드·버전·요약은 주지 않는다 |
| `agent.settings_read` | W이거나 안쪽 |
| `session.submit`(세션 시작) | 리소스에 `agent_id`가 있는 시작 판정에 축 A를 더한다. 바깥쪽이고 축 A가 `use`가 아니면 거절(`role`). 웹·API(`session-service.ts:623-646`)와 Slack(`slack-session-handler.ts:265-275`)이 같은 정책을 거치므로 한 곳(`policy.ts`의 `release_id` 분기 앞)에서 판정한다. 이미 있는 세션에 메시지를 보내는 것은 축 A를 보지 않는다 |
| 세션 열람 | `sessionVisibleTo`의 `workspace` 갈래(`session-shares.ts:97`)에 조건을 더한다. 세션의 에이전트에 담당 팀이 없거나, 축 B가 `workspace`이거나, 보는 사람이 안쪽이어야 한다. 잠금 쪽 재확인(`requester-locks.ts:167`)에도 같은 조건을 넣는다. 목록·개수·상세·SSE가 모두 이 판정을 지나므로 같이 바뀐다 |
| 안쪽 판정 | `insideAgent(db, workspaceId, userId, agentId)`를 SQL 하나로 만든다. W이거나 `administers()`이거나, 담당 팀이 보관되지 않았고 그 팀의 살아 있는 구성원이면 참이다. 팀 구성원은 판정 때마다 읽는다(`administers.ts:21-26`와 같은 원칙) |
| SSE | 설정이나 팀 구성원이 바뀌어도 바로 알리지 않는다. 다음 페이지를 읽을 때 다시 판정해 끊는다(`events.ts:338-344`). 지금 팀에서 빠질 때와 같다 |

## (c) 워크스페이스 설정 축

`workspaces.settings` jsonb에 키 둘을 더한다. 키가 없으면 기본값이다. Slack 게스트 설정과 같은 모양이다(`workspace-settings.ts:14-24`). 바꾸는 사람은 `workspace.manage`(W)이고, 바꿀 때 receipt를 남긴다.

| 축 | 키 | 값 | 기본값 | 적용 범위 |
|---|---|---|---|---|
| A. 바깥쪽의 에이전트 접근 | `agent_outsider_access` | `use`: 정보를 보고 실행한다 / `view`: 정보만 본다 / `none`: 목록에도 없고 실행도 못 한다 | `use` | 모든 에이전트. 담당 팀이 비어 있는 에이전트도 포함한다 |
| B. `workspace` 공개 세션이 바깥쪽에 보이는가 | `agent_outsider_session_visibility` | `managing_team`: 안쪽에만 보인다 / `workspace`: 모두에게 보인다(지금과 같다) | `managing_team` | 담당 팀이 있는 에이전트의 세션만 |

- 축 A 기본값 `use`: 오너 원문의 "자기가 실행할 수 있는 거지"를 따랐다. 지금도 바깥쪽은 실행할 수 있으므로 실행 쪽은 달라지는 것이 없다. 정보 열람은 지금 막혀 있던 것이 열린다.
- 축 B 기본값 `managing_team`: 오너 원문의 "세션의 상세 내용을 모두 못 보고"와 잠정 결정 d124(담당 팀 쪽)를 따랐다. 담당 팀이 없는 에이전트에는 적용하지 않으므로, 배포 직후에는 아무 세션의 공개 범위도 바뀌지 않는다. 에이전트에 담당 팀을 정하는 순간부터 그 에이전트의 `workspace` 공개 세션(이전 세션 포함)이 바깥쪽에서 사라진다. 담당 팀을 정하는 화면에서 이 결과를 알린다: "담당 팀을 정하면 팀 밖 사람은 이 에이전트의 세션 가운데 자기가 시작했거나 공유받은 것만 봅니다(워크스페이스 설정)".
- 축 B는 판정 시점의 상한이다. 설정을 바꾸면 기존 세션에도 다음 요청부터 적용되고, 되돌리면 그대로 돌아온다. 공유 행은 하나도 쓰지 않는다.
- 에이전트마다 따로 덮어쓰는 설정은 두지 않는다([(g) G5](#g-오너-확인-필요)).
- 화면: 워크스페이스 설정(`apps/web/src/routes/workspace-settings.tsx`)에 '에이전트 접근' 묶음을 두고, 두 축을 라디오로 보인다.

## (d) 담당 팀 필수

### 데이터 모델

| 대상 | 바뀌는 것 |
|---|---|
| `member_team_members` | `role text NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member'))` |
| `agents` | `managing_team_id uuid NULL`, FK `(workspace_id, managing_team_id)` → `member_teams(workspace_id, id)` |
| 감사 | `set_agent_managing_team`, `set_team_member_role`, `set_agent_access_settings` receipt |

- 열은 nullable로 둔다. "필수"는 API·화면에서 강제한다. 기존 에이전트를 채울 값이 정해지지 않았고, 롤백한 옛 이미지가 만드는 에이전트도 넣을 수 있어야 하기 때문이다. 담당 팀이 비어 있는 에이전트가 0개가 된 뒤에 `CHECK (managing_team_id IS NOT NULL) NOT VALID`를 걸지는 그때 정한다. 걸려면 롤백 하한이 그 이미지 이상이어야 한다.

### 생성 API와 마법사

- `POST /v1/agents`에 `managing_team_id`를 더한다. 두 단계로 켠다.
  1. 선택값으로 받는다. 화면이 보내기 시작한다.
  2. 화면이 배포된 뒤 필수로 바꾼다. 없으면 400이다. API를 직접 부르는 사용자(SDK)에게는 깨지는 변경이므로 사용자 문서와 변경 기록에 적는다.
- 지정 자격: W는 보관되지 않은 아무 팀이나 고른다. W가 아니면 **자기가 속한 팀**(`lead`·`member`)만 고른다. 다른 팀을 고르면 403 `team_not_allowed`다. 자격은 쓰는 트랜잭션 안에서 팀 행과 구성원 행을 잠근 채 다시 본다.
- 만든 사람은 지금처럼 개인 관리자가 된다(`agents.ts:422-428`). 그래서 `member`인 담당 팀 구성원이 에이전트를 만들어도 자기 에이전트를 관리한다. 그 팀의 `lead`도 관리자가 된다.
- 속한 팀이 없는 `member`는 에이전트를 만들 수 없다. 담당 팀이 필수라서 생기는 결과다. 마법사는 첫 단계에서 "속한 팀이 없어 에이전트를 만들 수 없습니다. 워크스페이스 관리자에게 팀에 넣어 달라고 요청하세요."를 보이고 진행하지 않는다. 이를 받아들일지는 [(g) G3](#g-오너-확인-필요)에 올렸다.
- 마법사가 쓸 팀 목록: W는 `GET /v1/teams`, 그 밖에는 `GET /v1/my-teams`(`packages/platform/src/musterrolle/team-service.ts:137`)를 쓴다. `my-teams` 응답에 팀마다 호출자의 `role`을 더한다. 마법사 1단계의 '담당 팀'은 필수 칸이다.

### 생성 뒤 변경

- `PUT /v1/agents/{id}/managing-team` `{team_id: string}`. action은 `agent.admin.manage`다. 지정 자격은 생성 때와 같다(W가 아니면 자기가 속한 팀). null은 받지 않는다. 담당 팀이 비어 있는 기존 에이전트를 채우는 것도 이 API다.
- 담당 팀을 바꾸면 옛 팀의 `lead`는 다음 요청부터 관리 권한을 잃고, 옛 팀 구성원은 안쪽에서 빠진다. 공유 행은 쓰지 않으므로 세션은 새 팀 기준으로 바로 다시 판정된다(앞선 설계의 "이미 만든 세션의 공유는 바꾸지 않는다"는 필요 없어진다).
- 상세 '관리자' 탭 맨 위에 '담당 팀' 묶음을 둔다. 내용은 팀 이름, 바꾸기, "이 팀의 팀 관리자는 이 에이전트를 관리하고, 구성원은 설정을 보고 사용합니다"다.

### 팀 보관·구성원 변경

- **보관**: 팀을 보관하는 쓰기(`packages/db/src/member-teams.ts:299-331`)는 지금 관리자 팀 행을 지우고 팀을 보관한다. 보관되지 않은 에이전트 가운데 그 팀이 담당 팀인 것이 있으면 409 `team_manages_agents`로 거절하고, 그 에이전트 id를 응답에 싣는다. 먼저 담당 팀을 옮겨야 한다. 담당 팀은 필수인데 비울 길을 만들지 않으려는 것이다. 잠금은 팀 행에 이미 걸리므로(`member-teams.ts:305`), 담당 팀 지정 쓰기도 같은 팀 행을 잠가 둘이 엇갈리지 않게 한다.
- **구성원 빼기·역할 바꾸기**: 막지 않는다. `lead`가 하나도 없는 담당 팀이 될 수 있다. 그 에이전트는 W와 개인 관리자가 관리한다. 관리자 탭은 "이 담당 팀에는 팀 관리자가 없습니다"를 보인다.
- 팀 역할을 정하는 사람은 지금처럼 `team.manage`(W)다. 팀 `lead`가 자기 팀 구성원을 관리하는 권한은 이번에 만들지 않는다.

### 기존 에이전트 이행

담당 팀을 무엇으로 채울지 세 안을 견줬다.

| 안 | 내용 | 판단 |
|---|---|---|
| **1. 비워 두고 지정을 안내한다(추천)** | 마이그레이션은 열만 더한다. 담당 팀이 비어 있는 에이전트는 지금처럼 동작한다(축 B 미적용, T 없음). 에이전트 목록과 관리자 탭에 '담당 팀 미지정' 표시를 두고, W와 L이 지정한다. 목록에 '담당 팀 미지정' 거르기를 둔다 | 권한이 사람 확인 없이 바뀌지 않는다. 되돌릴 것이 없다 |
| 2. 관리자 팀이 정확히 하나면 그 팀으로 채운다 | 일회성 이행 쿼리 | 그 팀의 구성원은 이미 관리자라 권한은 줄지 않는다. 하지만 축 B가 바로 켜져 바깥쪽에게서 세션이 사라진다. 사람이 고른 것이 아니다 |
| 3. 워크스페이스마다 '기본 팀'을 만들어 모든 에이전트에 채운다 | 구성원 전원을 넣은 팀 | 모든 `member`가 모든 에이전트의 안쪽이 된다. 설정 열람이 모두에게 열린다. 담당 팀의 뜻이 사라진다 |

- 1을 고른다. 2는 지정 화면에서 "관리자 팀 ○○을 담당 팀으로" 추천 버튼으로만 쓴다. 누르는 것은 사람이다.
- 되돌리기: 앱을 롤백해도 두 열은 남긴다. 옛 이미지는 열을 모르므로 담당 팀 `lead`·구성원 권한과 축 A·B만 사라진다. 나머지 권한은 지금과 같다. 설정 키도 남긴다. 열이나 키를 지우는 정리는 배포 뒤 지정한 값을 잃는 되돌릴 수 없는 작업이다. 하려면 내보내기·복구 절차와 오너 확인이 먼저다. 지금 계획에는 넣지 않는다.

## (e) 앞선 결정과의 차이

| 앞선 결정 | 내용 | 이 설계 | 이유 |
|---|---|---|---|
| 항목 4 A | `agents.managing_team_id` + `member_team_members.role` | **유지** | 오너 질문("각 팀의 관리자인지 구성원인지의 권한을 따라가는 거지")의 답이 그대로다 |
| 항목 4 관리 팀 선택 | 선택값. 마법사 1단계에서 고를 팀이 없으면 나중에 | **변경**: 새 에이전트는 필수. 기존 에이전트만 비어 있을 수 있다 | 오너 원문 "에이전트는 무조건 담당 팀이 붙는 게 좋을 것 같아" |
| 항목 4 관리 팀 `member` | 관리 권한 없음. 세션 기본값이 관리 팀이면 세션을 본다 | **변경**: 관리 권한은 여전히 없고, 설정 열람·사용·안쪽 세션 열람이 정해졌다 | (b) 표 |
| d124 | 세션 공개 범위 기본값. 관리 팀이 있으면 세션을 만들 때 `team` 공유 행을 넣고, 없으면 `workspace` | **폐기, 축 B로 대체**: 공유 행은 지금처럼 쓰지 않고, 판정 때 `workspace` 범위가 바깥쪽에 닿지 않게 한다. "없으면 workspace" 갈래는 담당 팀이 비어 있는 이행 중 에이전트에만 남는다 | 관리자가 설정을 바꾸면 기존 세션에도 바로 적용된다(오너의 "관리자의 설정에 따라"). 공유 행을 이행하지 않으므로 되돌리기가 설정 하나다. 담당 팀을 바꿀 때 옛 세션이 옛 팀에 묶이는 문제가 없다. `team` 공유 행은 팀이 보관되면 만든 사람만 보게 되는데(`api-server.md:620`), 이 문제도 생기지 않는다 |
| d125 | `member` 관리자는 자기가 `lead`인 팀만 관리 팀·관리자 팀으로 지정 | **둘로 나눔**: 담당 팀은 자기가 속한 팀(`lead`·`member`), 관리자 팀은 지금 결정대로 `lead`인 팀만 | 담당 팀이 필수인데 `lead`인 팀만 허용하면 `lead`가 아닌 `member`는 에이전트를 만들 수 없다. 속한 팀으로 묶으면 관계없는 팀에 권한을 떠넘기는 문제(앞선 설계가 막으려던 것)는 그대로 막힌다. 관리자 팀은 구성원 모두를 관리자로 만들어 더 넓으므로 좁게 둔다 |
| d126 | 카드의 도구 좁힘을 실행에 켠다 | **유지** | RBAC와 관계없다. U2a(JeongJaeSoon/agent-platform#1072)가 이미 바탕을 깔았다 |
| 항목 4 보관된 관리 팀 | 열 값을 남기고 "보관된 팀"으로 보인다 | **변경**: 담당 팀이 맡은 에이전트가 있으면 보관을 거절한다 | 필수인 값이 효력 없는 채로 남지 않게 한다 |
| 항목 4 세션 공개 범위 기본값(오너 확인 필요) | 1 워크스페이스 / 2 관리 팀이 있으면 관리 팀 / 3 항상 관리 팀 | **질문을 바꿈**: 축 B의 기본값([(g) G2](#g-오너-확인-필요)) | 위 d124와 같다 |
| 기존 팀 권한 모델 | 팀에 역할이 없고, 관리자 팀이면 구성원 모두가 관리자 | **유지**(기존 행), 새 추가만 제한 | 기존 권한을 줄이지 않는다. 관리자 팀을 없앨지는 [(g) G8](#g-오너-확인-필요) |
| U5a·U5b·U5c | 팀 역할·관리 팀 계약, 화면, 세션 기본값 | **대체**: [(f)](#f-구현-단위)의 R1~R5 | — |

## (f) 구현 단위

| 단위 | 내용 | 쓰기 경로 | start-after | land-after |
|---|---|---|---|---|
| R1 | 팀 역할과 담당 팀의 데이터·계약·판정. `role` 열, `managing_team_id` 열, `administers()`·`lockedAdministers()`의 담당 팀 `lead` 경로, `insideAgent`, `PUT /v1/agents/{id}/managing-team`, `POST /v1/agents`의 선택값 `managing_team_id`와 지정 자격, 관리자 팀 새 추가 제한, 팀 보관 거절, 팀 구성원 역할 API, `my-teams`의 `role`, receipt | `packages/db/migrations/<다음 번호>`, `packages/db/src/schema.ts`, `packages/db/src/administers.ts`, `packages/db/src/agent-admins.ts`, `packages/db/src/agents.ts`, `packages/db/src/member-teams.ts`, `packages/db/src/api-keys.ts`(시험만일 수 있음), `packages/platform/src/agents/agent-service.ts`, `packages/platform/src/musterrolle/agent-admin-service.ts`, `packages/platform/src/musterrolle/team-service.ts`, `packages/contracts/src/musterrolle/teams.ts`, `packages/contracts/src/kollegium/agents.ts`, `apps/control-host/src/api/routes/teams.ts`·`agents.ts`, `apps/control-host/src/api/openapi.ts`, `packages/client/src/schema.gen.ts`, `docs/openapi.json`, `docs/operator/api-server.md`, 시험 | U4a 착지 | U4a |
| R2 | 에이전트 읽기 action 분리(`agent.read`·`agent.settings_read`), 행마다 거르는 에이전트 목록, 바깥쪽에 에이전트 행만 주기, 읽기 경로를 새 action으로 옮기기 | `packages/contracts/src/musterrolle/authorization.ts`, `packages/platform/src/musterrolle/policy.ts`, `packages/db/src/agents.ts`(목록 SQL), `packages/db/src/agent-authority.ts`, `packages/platform/src/agents/agent-service.ts`, `agent-github-service.ts`, `packages/platform/src/musterrolle/credential-binding-service.ts`, `surface-binding-service.ts`, `agent-admin-service.ts`, `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`, `docs/operator/api-server.md`, 시험 | R1 착지 | R1 |
| R3 | 워크스페이스 설정 두 축. 설정 계약·API, 축 A를 세션 시작 판정에, 축 B를 `sessionVisibleTo`와 `lockSessionReach`에 넣기, 운영자·사용자 문서 | `packages/db/src/workspace-settings.ts`, `apps/control-host/src/api/routes/workspaces.ts`, 워크스페이스 설정 계약(`packages/contracts/src/musterrolle/`), `packages/platform/src/musterrolle/policy.ts`, `packages/db/src/session-shares.ts`, `packages/db/src/requester-locks.ts`, `packages/db/src/postgres-unit-of-work.ts`(필요하면), `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`, `docs/operator/api-server.md`(`:610-631`), `apps/docs/content/docs/sessions/start*.mdx`(`:71`), 시험 | R1 착지 | R2 |
| R4 | 화면. 마법사 1단계 '담당 팀'(필수), 관리자 탭의 '담당 팀', 팀 화면의 구성원 역할, `member`용 에이전트 목록(정보만), T가 보는 읽기 전용 설정 화면, 워크스페이스 설정의 두 축, '담당 팀 미지정' 표시와 거르기, 바뀐 문구의 사용자 문서 | `apps/web/src/components/new-agent-flow.tsx`, `apps/web/src/components/agent-admins.tsx`, `apps/web/src/routes/teams.tsx`, `apps/web/src/routes/agents.tsx`, `apps/web/src/routes/agent-detail*.tsx`, `apps/web/src/routes/workspace-settings.tsx`, `apps/web/src/i18n/agents.ts`·`teams.ts`와 설정 문구, `apps/storybook/src/screens/*`, `apps/docs/content/docs/agents/*` | R1(마법사·관리자 탭·팀 화면), R2(목록·읽기 전용 설정), R3(설정 화면) 착지 | U4c, R3 |
| R5 | 담당 팀 필수 켜기. `POST /v1/agents`에서 `managing_team_id`가 없으면 400, 사용자 문서와 변경 기록 | `packages/contracts/src/kollegium/agents.ts`, `packages/platform/src/agents/agent-service.ts`, `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`, `apps/docs/content/docs/agents/*`, 시험 | R4 배포 | R4 |

- 앞선 단위와의 관계: R1은 U5a를, R4는 U5b를 대체한다. U5c(세션 공유 행 기본값)는 없애고 R3로 대체한다. R2와 R5는 새로 생긴 단위다.
- 진행 중인 단위와 겹치는 경로
  - **U4a(94S-1247, `agents.description`)**: `packages/contracts/src/kollegium/agents.ts`, `packages/db/src/schema.ts`, 마이그레이션 번호, `packages/db/src/agents.ts`, `packages/platform/src/agents/agent-service.ts`, `openapi.ts`, `schema.gen.ts`, `docs/openapi.json`이 R1·R2·R5와 겹친다. 그래서 R1은 U4a가 착지한 뒤 시작한다. U4a의 계약은 바꾸지 않는다. 바깥쪽이 받는 에이전트 행(R2)에 `description`이 들어가는 것은 U4a 계약을 그대로 읽는 것이다.
  - **U2a(94S-1246, JeongJaeSoon/agent-platform#1072, 착지함)**: claim binding·`catalog.ts`·`worker-gateway.ts`는 이 설계와 겹치지 않는다.
  - **U4c·U1·U3**: `new-agent-flow.tsx`, `apps/web/src/i18n/agents.ts`가 R4와 겹친다. R4는 U4c 뒤에 착지한다(앞선 설계의 U5b와 같은 자리).
  - `policy.ts`·`openapi.ts`는 R2·R3가 같이 쓴다. R2 → R3 순서로 착지한다.
- 줄 세우기: 계약·DB 경로는 U4a → R1 → R2 → R3, 화면 경로는 U1 → U3 → U4c → R4, 마지막이 R5다. R2와 R3는 R1이 착지한 뒤 함께 시작할 수 있지만 착지는 R2가 먼저다.
- 배포 하한이 필요한 단위는 R5(R4 화면이 운영에 나간 뒤)다. R1~R4는 열·키를 더하고 판정을 넓히거나 좁힐 뿐이라, 롤백해도 데이터가 깨지지 않는다.
- 티켓은 R1+R2, R3, R4+R5 셋으로 묶기를 제안한다. 94S-1248(U5a·U5b·U5c)은 이 묶음으로 다시 쓴다(티켓은 리드가 고친다).
- 고칠 문서: `docs/operator/api-server.md:610-631`(공유 범위 기본값과 바깥쪽 상한, R3), `apps/docs/content/docs/sessions/start.mdx:71`·`start.en.mdx:71`(R3), 에이전트 만들기 사용자 문서(R4·R5). PRD는 이 리포에 없다(`git grep -n -i -w prd`의 결과는 앞선 설계 문서 한 줄뿐이다). PRD의 세션 공개 기본값 문장('워크스페이스')은 리드가 PRD가 있는 곳에서 축 B의 설명으로 바꾼다.

## (g) 오너 확인 필요

각 항목의 기본값으로 머지한다. 오너가 다른 답을 고르면 후속 PR로 고친다.

| # | 질문 | 선택지 | 추천 | 답이 없을 때 |
|---|---|---|---|---|
| G1 | 축 A(바깥쪽의 에이전트 접근) 기본값 | `use` 보고 실행 / `view` 보기만 / `none` 숨김 | `use` | `use` |
| G2 | 축 B(`workspace` 공개 세션이 바깥쪽에 보이는가) 기본값. 앞선 d124를 대신하는 질문이다 | `managing_team` 안쪽에만 / `workspace` 모두 | `managing_team` | `managing_team` |
| G3 | 속한 팀이 없는 `member`의 에이전트 만들기 | 못 만든다(담당 팀 필수의 결과) / 담당 팀 없이 만들게 둔다(그 에이전트는 이행 중과 같다) | 못 만든다 | 못 만든다 |
| G4 | W가 아닌 사람이 담당 팀으로 고를 수 있는 팀(d125를 대신한다) | 자기가 속한 팀 / 자기가 `lead`인 팀만 / 아무 팀 | 자기가 속한 팀 | 자기가 속한 팀 |
| G5 | 설정 축의 단위 | 워크스페이스 하나 / 에이전트마다 덮어쓰기 허용 | 워크스페이스 하나 | 워크스페이스 하나 |
| G6 | 축 B가 `managing_team`일 때, 이름·팀으로 공유받은 남의 세션을 바깥쪽이 보는가 | 본다(만든 사람이 고른 공유) / 못 본다(자기 세션만) | 본다 | 본다 |
| G7 | 볼 수 있는 남의 세션을 interrupt·close·resume하는 사람 | 지금처럼 볼 수 있는 사람 모두 / 만든 사람·L·W만 | 지금처럼 | 지금처럼 |
| G8 | 관리자 팀(`agent_admin_teams`, 구성원 모두가 관리자) | 유지하고 새 추가만 `lead`인 팀으로 제한 / 새 추가를 막고 담당 팀 `lead`로 옮기게 한다 | 유지·제한 | 유지·제한 |
| G9 | 기존 에이전트의 담당 팀 이행 | 비워 두고 지정 안내 / 관리자 팀이 하나면 자동 채움 / 기본 팀 | 비워 두고 안내 | 비워 두고 안내 |

- 되돌릴 수 없는 이행은 계획에 없다. 열과 설정 키를 지우는 정리를 하게 되면 그때 오너 확인을 받는다.
- 동작 변화(데이터 이행 아님)는 세 가지다. ① R2부터 `member`가 모든 에이전트의 정보를 본다(축 A `use`). ② R3부터 담당 팀이 정해진 에이전트의 `workspace` 공개 세션이 바깥쪽에서 사라진다(축 B `managing_team`). ③ R5부터 담당 팀 없는 `POST /v1/agents`는 400이다.

## 발견

| 발견 | 근거 | 제안 분류 |
|---|---|---|
| `member`는 에이전트를 볼 수 없는데 릴리스 id만 알면 그 에이전트로 세션을 시작한다 | `agent-service.ts:276`, `session-service.ts:623-646` | LATER(R2·R3가 정리한다. 다시 볼 때: R3 착지) |
| 마지막 에이전트 관리자를 지우는 것을 막지 않는다 | `agent-admins.ts:196-206`, `:233-243` | LATER(W는 늘 관리하므로 고아가 되지는 않는다. 다시 볼 때: 담당 팀 `lead`가 없는 에이전트가 생길 때) |
| 에이전트 수정·릴리스·켜기의 쓰기 재확인은 구성원인지만 본다. 역할·관리자인지는 보지 않는다 | `packages/db/src/agents.ts:396`, `:442`, `:505`, `:579` | LATER(판정 뒤 강등되는 경합에 한정된다. 다시 볼 때: R1이 `lockedAdministers`를 고칠 때 같이 볼지 정한다) |
| `artifact.read` action은 정의만 있고 쓰는 곳이 없다. 결과물은 `session.read`로 판정한다 | `authorization.ts:371`, `:422`, `output-service.ts:26-28` | DROP(동작은 맞다. 이 설계는 결과물을 세션 상세와 같이 다룬다) |
| 세션 공유 판정이 정책 SQL과 잠금 재확인 두 곳에 따로 있다 | `session-shares.ts:95-101`, `requester-locks.ts:167` | LATER(R3가 두 곳을 같이 고친다. 다시 볼 때: R3 리뷰) |
| PRD가 이 리포에 없다. 세션 공개 기본값이 문서마다 다르다 | `git grep -n -i -w prd` | NOW 아님. 리드가 PRD 위치에서 축 B 설명으로 고친다 |

## (h) Codex 반론

(리뷰 뒤 채운다.)

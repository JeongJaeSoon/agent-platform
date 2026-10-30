# 결정: 에이전트 GitHub 설정과 기능별 권한

- 상태: 설계. 구현 PR GA-1~GA-7과 GA-4b가 이 문서를 계약으로 쓴다([9절](#9-구현-pr-분할)).
- 기준 커밋: `origin/main` `cee8359b`. 아래 `파일:줄`은 [10절](#10-세션-성과물)을 빼고 모두 이 커밋 기준이다. 10절은 `3f4dd99d` 기준이다.
- 오너 원문(2026-10-30): "github apps 에서는 기능별로 권한을 가진다고 봐야할거 같아 그리고 기본적으로는 pr 을 작성하고 변경하기위한 권한 까지만을 기본값으로 가지고 그 외에 승인이나, 액션 실행 이나 관리 등등 그리고 액션을 실행하고자 할경우에 어떤 액션까지 허용할것인지에 대한 권한 관리는 agent 설정에서 관리가능하도록 하는게 좋을거 같아", "agent 상세화면에 slack 탭이 잇는것처럼 github 도 별도 탭으로 나눠서 일단 애초에 github 를 사용할것인가 아닌가 를 제어할수 있도록 하고 github 의 상세 옵션을 제어할수 있도록 메뉴를 확장하는게 좋을거 같네", "추천대로 진행해줘"(결정 0~10 전부).
- 리드 결정(2026-10-30, 이 설계 중 질문): GitHub 작업은 control-host의 서비스 한 곳에서 하고 입구는 둘이다. 세션 API와 세션 안의 내장 MCP 서버 `github`다. 내장 MCP는 구현 분할의 마지막 PR이다. 같은 에이전트가 연 PR의 리뷰 승인은 플랫폼이 막지 않는다([결정 1](#결정-1-리뷰-전용-app)).

## 지금 구조

- **연결.** 콘솔에서 등록한 GitHub App은 워크스페이스에 하나다. `github_apps`에는 `UNIQUE (workspace_id)`가 걸려 있다(`packages/db/migrations/0192_github_apps.sql:12`, `packages/db/src/schema.ts:512-537`). 키는 `secret_values`에 그 행 id를 owner로 해서 암호화해 둔다(`packages/db/src/github-apps.ts:25-29`). 등록할 때 `GET /app`으로 키를 확인한다(`packages/platform/src/musterrolle/github-app-service.ts:208-245`). 이때 App의 권한은 읽지 않는다.
- **어느 저장소가 그 App을 쓰나.** 카탈로그 저장소의 `auth`가 `{ kind: github_app }` 한 줄이면 콘솔 App을 쓴다(`packages/platform/src/sessions/catalog.ts:259-264`, `293`, `442-443`). `app_id`·`installation_id`·키 참조를 적은 저장소는 카탈로그의 App을 쓴다(`apps/control-host/src/api/forge-github.ts:707-759`). 콘솔 App의 forge는 `credentials()`의 첫 행으로 만든다(`forge-github.ts:612`). 이 query는 행을 거르지 않는다(`github-apps.ts:168-195`).
- **토큰 발급.** control-host만 키를 쥔다. 요청마다 **저장소 하나**(`repositoryNames: [repo.name]`, `forge-github.ts:445`)와 작업별 권한으로 installation token을 발급한다. clone은 `contents: read`, push는 `contents: write`(`forge-github.ts:265-266`), PR·코멘트는 `contents: read` + `pull_requests: write`(`forge-github.ts:207-210`)다. 토큰은 저장소·권한 조합별로 메모리에 캐시한다(`forge-github.ts:152-177`).
- **worker는 토큰을 받지 않는다.** clone은 egress proxy가 받아 gateway가 그때 발급한 자격 증명으로 보낸다(`packages/platform/src/workers/worker-gateway.ts:1241-1255`). proxy는 upload-pack만 받고 receive-pack(push)에는 경로가 없다(`apps/egress-proxy/src/credential.ts:160-175`). push는 API 프로세스가 한다. 쓰기 자격 증명을 받고(`packages/platform/src/sessions/push-executor.ts:108`) `deps.pusher.push`를 부른다(`push-executor.ts:138`).
- **누가 무엇을 부르나.** push 요청은 `session.submit` 호출자(사람이나 에이전트 key)가 만든다(`packages/platform/src/sessions/push-request-service.ts:127-134`). 승인, PR 열기, 코멘트는 `sessions:approve`를 가진 사람이나 API key만 한다(`push-request-service.ts:66-77`, `packages/platform/src/sessions/pull-request-service.ts:103`). 에이전트 key는 `sessions:approve`를 가질 수 없다(`packages/platform/src/musterrolle/policy.ts:283-285`). 웹과 Slack에는 push·PR 화면이 없다. **세션 안의 에이전트가 GitHub 작업을 부를 경로도 없다.**
- **에이전트 설정이 사는 곳.** 카드(`agent_versions.card`)는 불변 버전이다. 릴리스(`agent_releases`)는 카드·프로필·저장소·`policy_pins`를 해시한 id를 가진다(`schema.ts:2846-2888`, `packages/platform/src/agents/release-ids.ts:61-77`). 카드에 나중에 더한 칸은 optional로 두어 옛 카드의 해시를 지킨다(`packages/contracts/src/kollegium/agents.ts:101-105`). 릴리스 id 버전도 같은 이유로 올린다(`release-ids.ts:32-39`). 즉시 반영하는 스위치는 `agents` 행의 열로 둔다. 선례는 `slack_mention_only`다(`schema.ts:2408`, `packages/db/migrations/0188_slack_mention_only.sql:3`).
- **사람의 외부 계정.** `linked_accounts`는 provider를 일반화한 테이블이지만 값은 `slack` 하나다(`schema.ts:720-783`, CHECK는 `766-769`, `packages/contracts/src/musterrolle/linked-accounts.ts:14`). 화면은 `/settings/linked-accounts`다(`apps/web/src/router.tsx:240-243`).
- **세션을 시작한 사람.** turn 1의 `actor_id`가 시작자이고, 없으면 `sessions.created_by_user_id`다(`packages/db/src/session-shares.ts:68-71`). turn의 actor는 그 요청 principal 뒤의 사람이다(`packages/db/src/postgres-unit-of-work.ts:452`). 웹 cookie, 개인 API key(`api_keys.kind = 'personal'`, 만든 사람 필수 `schema.ts:2351-2357`), 연결된 Slack 사용자는 사람으로 풀린다. 에이전트 key와 operator key는 사람이 없다.
- **commit 작성자.** worker 이미지의 system git 설정이 `Werft <noreply@werft.invalid>`다(`apps/worker/Dockerfile:53-58`). Co-authored-by는 코드에 없다.
- **PR과 세션.** 브랜치 `agent/<session-id>`. PR 본문 꼬리는 "Opened by agent-platform from session …, commit …"이다(`pull-request-service.ts:204`). 이미 열린 PR을 다시 쓸 때는 꼬리를 고치지 않는다(`pull-request-service.ts:192-196`).
- **감사.** receipt operation 목록은 `packages/contracts/src/api/receipt.ts:25-111`이다. GitHub 쪽은 `request_push`·`decide_push`·`push`·`open_pull_request`·`comment_pull_request`·`set_github_app`·`delete_github_app`이 있다. receipt의 `agent_id`는 늘 null이다(`policy.ts:43-50`).

## 1. 실제 허용은 교집합이다

GitHub 토큰 하나가 가질 권한은 아래 다섯의 교집합이고, **발급할 때마다** 다시 계산한다(검토 문서 3절의 원칙).

1. **App 설치 권한**: GitHub가 강제한다. 등록할 때와 발급할 때 읽은 값이다([결정 2](#결정-2-app-최대-권한설치-상한)).
2. **워크스페이스 상한**: owner·admin이 정한다([결정 9](#결정-9-워크스페이스-상한--에이전트-좁히기)).
3. **에이전트 릴리스의 GitHub 설정**: 릴리스에 고정된다([결정 7](#결정-7-릴리스와의-관계)).
4. **에이전트 GitHub 스위치**: 즉시 반영된다.
5. **이번 작업**: clone, push, PR, dispatch, rerun, 리뷰.

이 계산을 하는 곳은 control-host의 **GitHub 게이트** 한 곳이다([3절](#3-토큰-발급-경로와-좁히기)). 세션 API, 내장 MCP, gateway의 clone, push 실행기는 모두 이 게이트를 지나야 토큰을 얻는다.

## 2. 결정별로 어떻게 지키나

### 결정 0. GitHub가 강제하는 것은 다시 책임지지 않는다

- 플랫폼은 브랜치 보호, 필수 리뷰, CODEOWNERS, ruleset, 필수 검사를 읽지도 흉내 내지도 않는다. GitHub가 거절하면 push·PR의 원문 사유는 지금처럼 로그에만 남긴다(`forge-github.ts:642-660`, `675-697`, #912). receipt에는 HTTP 상태와 플랫폼이 분류한 `reason_code`만 둔다. GitHub의 오류 문구는 요청에 넣은 값(예: dispatch `inputs`, 리뷰 본문)을 되비출 수 있기 때문이다. 같은 이유로 새 작업(dispatch·rerun·리뷰)의 오류는 **로그에도** 원문(`message`·`errors`)을 남기지 않는다. HTTP 상태, 플랫폼이 분류한 `reason_code`, GitHub의 `x-github-request-id`만 남긴다. 지금 오류 로거(`forge-github.ts:642-660`)를 이 작업에 그대로 쓰지 않는다. 그것으로 끝이다.
- 플랫폼이 여전히 막는 것은 **플랫폼이 만든 경계**뿐이다. push 대상 브랜치 고정과 기본 브랜치 거절(`push-executor.ts:93-99`), force push 금지, 토큰을 worker에 주지 않는 것, 그리고 이 문서가 더하는 기능별 권한·허용 목록·저장소 범위다.
- 에이전트 기본값은 PR 작성·수정까지다. 다시 말해 clone(`contents: read`), push(`contents: write`), PR 열기·코멘트(`pull_requests: write`)다. 그 밖의 권한은 모두 꺼진 채로 시작한다([4절 기본값 표](#에이전트-github-설정의-기본값)).

### 결정 1. 리뷰 전용 App

- **왜 두 번째 App인가.** GitHub는 PR 작성자의 승인 리뷰를 받지 않는다. 플랫폼이 연 PR의 작성자는 작성용 App bot이다. 같은 App의 토큰으로는 그 PR을 승인할 수 없다.
- **데이터.** `github_apps`에 `role`(`author`·`reviewer`)을 더하고, 유일 제약을 `(workspace_id, role)`로 바꾼다([4절](#4-데이터-모델)). 리뷰용 App은 별도 행이다. 키도 행 id로 따로 보관하므로 따로 교체하고 따로 지울 수 있다.
- **등록.** #922의 등록 흐름(App ID와 .pem, `GET /app`으로 확인)을 그대로 쓴다. 경로에 role만 더한다([6절](#6-api)). 두 행의 `app_id`가 같으면 `409` `reason_code: same_app`이다. 같은 App이면 작성자 규칙 때문에 승인이 늘 거절되기 때문이다.
- **사용.** 에이전트 GitHub 설정의 `review`가 켜져 있을 때만 리뷰 작업이 리뷰용 App 토큰을 받는다. 그 토큰은 `contents: read` + `pull_requests: write`, 저장소 하나다. 리뷰는 `POST /repos/{owner}/{repo}/pulls/{n}/reviews`에 `commit_id`를 반드시 넣어 부른다. 에이전트가 읽은 SHA가 아닌 것은 승인하지 않게 하려는 것이다(검토 문서 2절 Codex 경고). PR head가 그 사이 바뀌었으면 GitHub가 그 리뷰를 옛 commit에 단다.
- **리뷰용 App이 없을 때.** 에이전트 탭의 "리뷰 승인"은 비활성이고, "워크스페이스에 리뷰용 App이 없습니다" 안내와 GitHub 연결 설정 링크를 보인다. API는 `options`에서 `review.available: false, reason: no_reviewer_app`를 준다. 이미 `review`가 켜진 릴리스가 리뷰를 부르면 `409` `reason_code: no_reviewer_app`이다. 리뷰용 App이 그 저장소에 설치되지 않았으면 `503` `forge_failed`(지금 forge의 "not installed" 경로와 같다)다.
- **리뷰할 수 있는 PR.** 에이전트 저장소 범위([결정 8](#결정-8-에이전트별-저장소-범위)) 안의 저장소에 열린 PR이면 누가 열었든 리뷰할 수 있다. 사람이 연 PR도 포함한다. 오너가 말한 "agent-platform이 리뷰를 하는 경우"가 이것이다. 어떤 PR을 승인해도 되는지는 GitHub의 리뷰 규칙이 정한다(결정 0).
- **같은 에이전트의 작성과 승인(리드 결정, 플랫폼은 막지 않는다).** 같은 에이전트가 작성용 App으로 PR을 열고 리뷰용 App으로 승인하면, 필수 리뷰가 1명인 저장소에서는 그 승인으로 조건이 채워질 수 있다. 결정 0에 따라 이것은 GitHub 쪽 설정으로 다룬다. 운영 문서와 연결 화면에 대응을 적는다. 필수 리뷰어 수를 2 이상으로 두거나, CODEOWNERS로 사람 리뷰를 요구하거나, 리뷰용 App을 ruleset bypass 목록에 넣지 않는 것이다. "자기 PR 승인 거절" 옵션은 [LATER](#later)에 둔다. 리뷰 receipt에는 PR을 연 세션·에이전트와 리뷰한 세션·에이전트를 함께 남겨 사후에 찾을 수 있게 한다.

### 결정 2. App 최대 권한(설치 상한)

- **안내하는 권한.** 작성용 App: 기본은 Contents read & write, Pull requests read & write, Metadata read다. 선택은 Actions read & write, Checks read & write, Issues read & write, Workflows read & write다(Workflows는 [결정 3](#결정-3-workflows-권한)). Administration은 주지 않는다. 리뷰용 App: Contents read, Pull requests read & write, Metadata read다. 이 목록은 등록 화면의 안내, `apps/docs`의 GitHub 연동 문서, 운영 문서에 같은 값으로 들어간다.
- **실제 권한 읽기.** 권한은 두 가지다. App이 요청한 권한(`GET /app`의 `permissions`)과, 설치가 승인한 권한(`GET /repos/{o}/{r}/installation`의 `permissions`)이다. App 권한을 늘려도 설치 쪽에서 승인하기 전에는 installation token이 그 권한을 받지 못한다. `GitHubAppDirectory.describe`(`forge-github.ts:544-555`)는 App 권한을 함께 돌려준다. 저장소별 설치 조회(`installationFor`, `forge-github.ts:476-492`)는 설치 권한을 함께 돌려준다. App 권한은 등록과 `GET …/github-apps/{role}` 때마다 읽어 행의 `permissions`·`permissions_checked_at`에 둔다. 설치 권한은 같은 조회 때 저장소별로 읽어 응답에만 싣는다. 화면은 "App에 없음"과 "설치 승인 대기"를 나눠 보인다.
- **판정은 GitHub가 한다.** 게이트는 캐시된 권한으로 미리 거절하지 않는다. 필요한 권한으로 installation token을 그대로 요청한다. 설치가 그 권한을 갖지 않으면 GitHub가 발급을 거절(422)하고, 게이트는 이것을 `409` `reason_code: app_permission_missing`으로 바꾼다. 그래서 오너가 권한을 더하고 설치를 승인하면 재시작이나 캐시 만료를 기다리지 않고 다음 요청부터 돈다. 캐시된 권한은 화면 표시와 탭의 비활성 안내에만 쓴다.
- **상한보다 넓으면 경고.** 그 role의 안내 목록 밖의 권한, 또는 안내보다 높은 수준이 있으면 경고 목록을 낸다. 예: `administration`, 리뷰용 App의 `contents: write`. 저장은 막지 않는다. 오너가 의도해 넓힌 App일 수 있어서다. 경고는 등록 응답의 `warnings`와 receipt `set_github_app`의 result에 남는다.
- **App에 없는 권한.** 에이전트 탭에서 그 항목은 비활성이고 "App에 이 권한이 없습니다. GitHub App 설정에서 더한 뒤 설치를 다시 승인하세요"를 보인다. 설치 승인만 남았으면 "GitHub에서 설치의 권한 변경을 승인하세요"를 보인다. 이 안내는 캐시된 값이라 늦을 수 있고, 실제 판정은 위와 같이 발급 요청이 한다.

### 결정 3. workflows 권한

- 에이전트 GitHub 설정의 `workflows`(기본 false). 켜면 push 토큰이 `contents: write` + `workflows: write`가 된다. 끄면 `contents: write`뿐이다. `.github/workflows/` 아래를 바꾸는 push는 GitHub가 거절한다. 이것은 GitHub가 강제하는 규칙이고, werft-sandbox에서 실측으로 확인한다(GA-2 검증).
- 플랫폼은 push 전에 diff를 검사하지 않는다(결정 0). GitHub의 거절은 지금처럼 `push_failed`로 끝난다. 원문 사유는 로그에만 남긴다. 사유가 workflows 권한이면 `push_error.reason_code: workflows_permission_missing`으로 분류해 세션과 receipt에 보인다.
- **PAT 저장소는 이 제한을 지킬 수 없다.** PAT는 권한을 좁혀 발급할 수 없다(`forge-github.ts:130-132`). 그래서 PAT 저장소(`kind: basic`, github.com)는 에이전트 `github.repositories`에 고를 수 없다(`400` `reason_code: app_required`). `github` 설정이 없는 기존 릴리스는 PAT 저장소를 지금처럼 쓴다. 이것은 이 문서 전과 같은 동작이고, 운영 문서에 "기능별 권한을 쓰려면 App으로 옮긴다"를 적는다.
- `workflows`와 `actions`를 같이 켜면 에이전트는 허용 목록에 있는 워크플로 파일 자체를 자기 브랜치에서 고칠 수 있다. 그 브랜치는 dispatch 대상이 아니지만([결정 4](#결정-4-actions-허용-목록)), 사람이 머지하면 대상이 된다. 탭은 둘을 같이 켤 때 이 점을 경고한다.
- App에 `workflows` 권한이 없거나 워크스페이스 상한이 막으면 탭에서 선택할 수 없고 안내를 보인다([결정 2](#결정-2-app-최대-권한설치-상한)와 같은 문구 규칙).

### 결정 4. Actions 허용 목록

- **설정.** 릴리스의 `github.actions_allow`: `[{ workflow: "<파일 이름>", ref?: "<패턴>" }]`, 최대 32개다. 켜는 스위치는 `github.features.actions`다. `workflow`는 `.github/workflows/` 아래의 파일 이름(`deploy.yml`)이다. 경로 구분자는 받지 않는다. `ref`는 생략하면 그 저장소의 기본 브랜치만 뜻한다. 적으면 `*` 하나만 쓰는 glob이다(`release/*`). `*`는 `/`를 넘지 않는다. 목록이 비면 dispatch·rerun은 모두 거절한다. `actions`가 꺼져 있으면 목록을 저장할 수 없다(`400` `reason_code: actions_off`).
- **강제 지점.** 게이트가 토큰을 발급하기 **전에** 판정한다. 토큰은 control-host 밖으로 나가지 않으므로, 목록 밖 호출을 할 수 있는 토큰이 존재하지 않는다.
- **에이전트가 쓴 ref는 돌리지 않는다.** dispatch는 그 ref에 있는 워크플로 파일과 그 파일이 부르는 스크립트를 그대로 실행한다. 그래서 허용 목록 항목은 그 ref의 코드만큼만 안전하다. 에이전트는 `agent/<session-id>` 브랜치의 내용을 정할 수 있다. push 승인을 끈 릴리스면 사람 없이 정한다. 그러니 이 브랜치를 허용하면 목록 안의 `deploy.yml`이 에이전트가 고친 `scripts/deploy.sh`를 그 저장소의 비밀값으로 돌리게 된다. 그래서 게이트는 목록과 상관없이 플랫폼이 push하는 ref(`agent/` 접두사)에 대한 dispatch를 거절한다(`403` `reason_code: agent_ref_refused`). rerun은 아래처럼 플랫폼이 직접 허용한 ref로 dispatch한 run만 받으므로 이 브랜치의 run은 처음부터 대상이 아니다. 사람이 이 브랜치를 기본 브랜치나 허용한 ref로 머지한 뒤에만 그 코드가 dispatch 대상이 된다. 그 머지는 GitHub의 리뷰 규칙을 거친다(결정 0).
  - `workflow_dispatch`: 요청의 `workflow`·`ref`를 목록과 맞춘다. 맞지 않으면 `403` `reason_code: workflow_not_allowed`이고, GitHub에는 아무것도 보내지 않는다. 맞으면 `actions: write` 토큰으로 `POST /repos/{o}/{r}/actions/workflows/{workflow}/dispatches`를 부른다. `ref`는 브랜치만 뜻하고, GitHub에는 `refs/heads/<branch>`로 보내 같은 이름의 태그와 헷갈리지 않게 한다. `return_run_details: true`로 받은 run id를 [`github_workflow_dispatches`](#github_workflow_dispatches-새)에 기록한다.
  - rerun(`…/actions/runs/{run_id}/rerun`, `rerun-failed-jobs`): 호출자는 `run_id`만 넘긴다. rerun은 원래 run의 ref·SHA를 그대로 다시 쓴다. 그런데 GitHub의 run 응답(`event`, `head_branch`)만으로는 그 ref가 브랜치였는지 같은 이름의 태그였는지 증명할 수 없다. 그래서 **플랫폼이 이 저장소에서 브랜치로 dispatch해 run id를 기록한 run만** rerun한다. 기록이 없으면 `403` `reason_code: run_ref_unprovable`이다. 기록이 있으면 기록된 `workflow`·`ref`를 **지금 세션 릴리스의** 허용 목록과 다시 맞춘다. 목록이 그 사이 바뀌었으면 거절한다. push·PR로 시작된 run은 rerun하지 않는다. 그런 run의 재실행은 저장소 쪽의 일이다(결정 0).
- **입력값.** 허용 목록은 워크플로 파일과 ref만 좁힌다. `inputs`는 그대로 넘긴다. 허용 목록에 넣는 워크플로가 입력값으로 checkout ref나 실행할 스크립트를 고르게 되어 있으면, 에이전트가 `inputs`로 `agent/<session-id>`를 골라 위의 우회를 다시 열 수 있다. 그래서 운영 문서와 탭의 허용 목록 안내에 조건을 적는다: 허용 목록에 넣는 워크플로는 입력값으로 실행 코드나 checkout ref를 임의로 고르지 않아야 한다. 입력값별 제한은 이번에 만들지 않는다([LATER](#later)).
- **막지 않는 것.** `on: push`·`on: pull_request`로 도는 워크플로는 플랫폼이 건드리지 않는다. push와 PR이 그것을 부르는 것은 저장소 설정의 일이다.
- **세션 밖의 호출.** dispatch·rerun은 세션에 묶인 작업이다. 세션이 그 저장소를 쓰고 있어야 한다. 그 세션의 릴리스가 목록을 정한다.

### 결정 5. Co-authored-by

- **누가 들어가나.** 세션 시작자(위 [지금 구조](#지금-구조)의 시작자 규칙)가 활성 GitHub 연동 계정을 가졌으면 그 사람이다. 웹, 개인 API key, Slack 모두 같은 규칙으로 사람이 나온다. 에이전트 key, operator key, 그리고 앞으로 생길 스케줄·외부 시스템 트리거는 시작자가 없으므로 트레일러를 넣지 않는다. 그때 PR과 commit은 App 단독이다.
- **연결.** 설정 > 연동 계정에 GitHub를 더한다. GitHub OAuth로 본인을 확인한다. 사용자 이름을 직접 넣는 칸은 두지 않는다. OAuth 클라이언트는 작성용 App의 사용자 인증(App의 Client ID와 client secret)을 쓴다. 별도 OAuth App을 만들지 않으려는 것이다([오너 단계](#오너만-할-수-있는-단계)). 콜백은 `GET /user` 한 번만 부르고, 받은 user token은 저장하지 않고 버린다. 행에는 `external_user_id = <GitHub 숫자 id>`, `external_user_name = <login>`, `external_tenant = "github.com"`, `verified_via = 'github_oauth'`이 들어간다(응답의 `expires_at`은 null). 같은 GitHub 계정은 한 사람에게만 연결된다. 이것은 지금의 live 유일 인덱스(`schema.ts:756-758`)가 그대로 지킨다.
- **이메일.** `<id>+<login>@users.noreply.github.com`이다. 이메일은 연결할 때의 id와 login으로 만든다. 사람이 GitHub login을 바꾸면 다시 연결해야 이메일이 새 login을 따른다. login을 바꾼 뒤 옛 이메일이 여전히 그 계정에 귀속되는지는 확인하지 않았다. GA-4에서 werft-sandbox로 새 이메일의 귀속만 확인하고, 옛 이메일 귀속은 [LATER](#later)에 둔다.
- **넣는 곳과 때.** 트레일러는 **worker가 commit할 때** 넣는다. 승인 뒤에 넣으면 SHA가 바뀌어 사람이 승인한 commit과 달라지기 때문이다(검토 문서 4절 4번). claim 응답에 `git.co_author: { name, email } | null`과 `git.session_url`을 더한다. worker는 시작할 때 system git에 `core.hooksPath`를 플랫폼 hook 디렉터리로 둔다. 그 디렉터리의 `commit-msg` hook이 `git interpret-trailers --if-exists addIfDifferent`로 `Co-authored-by: <login> <email>`과 `Agent-Session: <session URL>`을 더한다. `name`은 연결할 때 GitHub가 준 login이고, 사람이 쓴 표시 이름은 쓰지 않는다. 서버는 login(`^[A-Za-z0-9-]{1,39}$`)과 숫자 id를 다시 검사한 뒤에만 claim에 싣는다. hook은 값을 shell 문자열에 끼우지 않고 argv(`--trailer`)로 넘기며, CR·LF·NUL이 든 값은 넣지 않고 건너뛴다. 값은 claim마다 새로 받는다. 그래서 세션 도중에 연결하면 다음 턴의 commit부터 들어간다.
  - 알려진 한계: 저장소가 자기 `core.hooksPath`(예: husky)를 쓰거나 세션이 `--no-verify`로 commit하면 트레일러가 빠진다. 트레일러는 귀속 표시이지 보안 경계가 아니므로 막지 않는다. 대신 PR 본문 꼬리가 같은 정보를 늘 싣는다(아래).
- **PR과 세션 연결(검토 문서 4절).** PR 본문 꼬리를 아래 줄들로 바꾼다. 세션 콘솔 URL, 에이전트 id·릴리스 id, push 요청 id, 트리거 종류(`web`·`slack`·`personal_key`·`agent_key`·`operator_key`), 시작자의 GitHub 연결 여부다. 시작자가 있고 연결돼 있으면 `Co-authored-by` 줄도 넣는다. PR을 다시 쓸 때도(`pull-request-service.ts:192-196`) 꼬리를 최신 승인 commit으로 고친다. 본문은 누구나 고칠 수 있으므로 증거가 아니라 찾아가는 수단이다. 기준 기록은 DB의 PR 행과 receipt다.
- **미연결 안내.** 시작자가 있지만 GitHub를 연결하지 않았으면, 세션 상세와 그 세션의 PR 정보 영역에 "GitHub 계정 미연결: 이 세션의 commit에는 공동 작성자가 들어가지 않습니다"와 연동 계정 링크를 보인다. 시작자가 없는 세션(에이전트 key 등)에는 안내를 띄우지 않고, 상세에 "App 단독"으로만 표시한다.

#### GA-4에서 정한 것

구현하면서 위 설명과 달라지거나 위에서 정하지 않은 것을 여기 둔다. 위 문단과 이 목록이 다르면 이 목록이 맞다.

- **Client ID.** OAuth에는 App의 Client ID가 필요한데 `github_apps` 행에 없었다. `client_id` 열(nullable, [4절](#github_apps-0192-열-추가))을 더하고, 등록과 `GET …/github-app` 때 읽는 `GET /app`의 `client_id`를 같이 둔다. 이 열이 없는 기존 행은 owner·admin이 GitHub 연결 화면을 한 번 열면 채워진다. 앞 이미지는 이 열을 읽지도 쓰지도 않는다. 앞 이미지가 App을 교체하면 열이 옛 값으로 남을 수 있지만, 다음 `GET …/github-app`이 고친다.
- **콘솔 주소.** 콜백 URL은 `<콘솔 origin>/settings/linked-accounts/github`, 세션 URL은 `<콘솔 origin>/sessions/<id>`다. 콘솔 origin은 새 환경 변수 `CONSOLE_ORIGIN`이고, 없으면 지금처럼 `SLACK_OIDC_REDIRECT_URI`의 origin이다. 둘 다 없으면 `oauth.callback_url`·`git.session_url`이 null이고, 연결 시작은 `github_oauth_unset`, commit에는 `Agent-Session` 트레일러가 들어가지 않으며 PR 꼬리는 세션 id만 싣는다.
- **오류 코드.** 작성용 App·Client ID·client secret·콘솔 origin 가운데 하나라도 없으면 연결 시작과 callback이 `409` `GITHUB_LINK_NOT_CONFIGURED`(`reason_code: github_oauth_unset`)다. Slack의 `SLACK_LINK_NOT_CONFIGURED`와 같은 자리다. 같은 GitHub 계정이 다른 사람에게 연결돼 있으면 `409 LINK_TAKEN`, 이미 GitHub를 연결했으면 `409 LINK_EXISTS`, state 만료·불일치·GitHub의 code 거절은 `400`이다(Slack과 같다).
- **state.** HttpOnly cookie `ap_github_link`(path `/v1/linked-accounts/github`, 10분)에 state, 시작한 사람, 만료 시각을 둔다. callback은 cookie를 늘 지우고, 만료 시각을 서버에서도 본다. 같은 code·state를 다시 보내면 cookie가 없어 `400`이다. GitHub의 code도 한 번만 쓰인다.
- **client secret 저장.** `PUT …/github-settings/oauth-client-secret`는 작성용 App이 없으면 `409` `GITHUB_LINK_NOT_CONFIGURED`(`reason_code: no_author_app`)다. 이 확인은 본문을 읽기 전에 한다(값을 받지 않고 거절한다). 저장소가 같은 확인을 잠금 안에서 한 번 더 한다. secret과 `oauth_client_secret_set`은 한 트랜잭션에서 쓰고 `set_github_app` receipt(`purpose: oauth_client_secret`, `last4`)를 남긴다. 응답은 `{ receipt_id, oauth }`이고 값은 어디에도 돌려주지 않는다. 지우는 경로는 따로 두지 않는다(작성용 App을 지우면 같이 지워진다).
- **user token.** callback은 code를 `POST <github.com>/login/oauth/access_token`으로 바꾸고 `GET /user` 한 번으로 `id`·`login`만 읽은 뒤 token을 버린다. 로그에도 receipt에도 token·code·client secret을 싣지 않는다. `login`은 `^[A-Za-z0-9-]{1,39}$`, `id`는 양의 정수가 아니면 연결하지 않는다(`400`).
- **hook 디렉터리.** `core.hooksPath`를 system에 두면 저장소의 `.git/hooks`가 돌지 않는다. 그래서 플랫폼 hook 디렉터리(`/usr/local/share/werft/git-hooks`)의 모든 client hook은 같은 스크립트 하나이고, 자기 일(`commit-msg`의 트레일러)을 한 뒤 저장소의 `.git/hooks/<이름>`이 실행 가능하면 그것을 그대로 부른다. `pre-commit install`처럼 `core.hooksPath`가 있으면 설치를 거절하는 도구는 그대로 거절한다(알려진 한계).
- **트레일러 값의 전달.** worker는 claim을 받으면 `$HOME/.werft/git-trailers`에 트레일러를 한 줄에 하나씩 쓴다(`Co-authored-by: …`, `Agent-Session: …`). 값이 없으면 그 줄이 없고, 둘 다 없으면 파일을 지운다. hook은 그 파일의 줄을 `--trailer` argv로만 넘기고, 이 두 키가 아니거나 CR이 든 줄은 건너뛴다. engine의 환경 변수는 바꾸지 않는다.
- **트리거 종류.** 세션 행의 `channel`과 만든 key로 정한다. `web`·`slack`은 그대로, `api`면 만든 key의 `kind`가 `personal`이면 `personal_key`, `agent`면 `agent_key`, key 행이 없으면 `operator_key`다. `channel`이 없는 옛 행은 만든 key가 있으면 그 key로, 만든 사람만 있으면 `web`이다.
- **PR 본문 꼬리.** 꼬리는 `<!-- agent-platform:pr-tail -->` 줄부터 `<!-- /agent-platform:pr-tail -->` 줄까지다. PR 열기가 GitHub에서 열린 PR을 찾아 답할 때 그 PR 본문에서 마지막 꼬리만 새 꼬리로 바꾸고(표시는 각자 한 줄에 들여쓰기 없이 홀로, 코드 블록 밖에 있을 때만 표시로 본다. 앞뒤의 사람 글과, 사람이 문장이나 코드 블록에 인용한 표시는 그대로 둔다. 그런 짝이 없는 PR은 아무것도 지우지 않고 끝에 붙인다), 이미 기록된 같은 push 요청을 다시 답할 때는 고치지 않는다. 꼬리를 고치지 못해도(GitHub 오류) PR 열기는 실패하지 않고 로그만 남긴다. GA-4b의 성과물 기록은 이 경로의 `savePullRequest` 그대로다.
- **세션 상세의 귀속 줄.** `GET /v1/sessions/{id}/github/attribution`(`session.read`)이 `{ trigger, attribution: "co_author" | "unlinked" | "app_only", login }`을 준다. 지금 연결 상태로 계산하므로 다음 claim의 commit부터의 귀속이다. 화면은 저장소가 있는 세션의 "결과물" 탭 위쪽에 한 줄로 보인다(GA-4b의 GitHub PR 영역이 같은 자리에 붙는다). 게이트 거절 이유는 GA-3의 범위다.

### 결정 6. push 전 사람 승인

- 릴리스의 `github.push_approval`(boolean)이다. 새 에이전트의 기본값은 true다. `policy_pins.github`가 없는 릴리스(이 기능 전의 모든 릴리스)는 true로 읽는다. 그래서 기존 에이전트는 데이터를 고치지 않고도 지금 동작 그대로다([5절](#5-기존-설치-이전)).
- **true:** 지금과 같다. 요청은 `requested`로 남고, `sessions:approve`를 가진 사람이 결정한다.
- **false:** push 요청을 만드는 같은 트랜잭션에서 `approved`로 둔다. `decided_by`는 `{ kind: "policy", agent_release_id }`이고 `decide_push` receipt를 남긴다. 결정 0의 "기본값은 PR 작성·수정까지"를 사람 승인 없이 쓰는 경우다.
- **PR 열기·코멘트(두 경우 공통).** push가 끝난(`pushed`) 요청에서는 `session.submit` 호출자(에이전트 key와 내장 MCP 포함)도 PR을 열고 코멘트를 달 수 있다. 사람이 승인했든 정책이 승인했든 같다. PR은 그 요청이 push한 브랜치와 commit으로만 열리므로, 사람 승인이 지키는 것(무엇이 push되나)은 PR을 누가 여느냐와 상관없이 그대로다. 지금은 `sessions:approve` scope와 `session.approve` 권한을 가진 호출자만 PR을 연다(`pull-request-service.ts:103-107`). GA-2가 이 규칙을 바꾼다. `sessions:approve` 호출자는 지금처럼 그대로 열 수 있다.
- 대상 브랜치 고정과 force push 금지는 승인 여부와 상관없이 그대로다.

### 결정 7. 릴리스와의 관계

- **릴리스에 넣는 값(보안 값):** 권한(`workflows`·`actions`·`checks`·`issues`·`review`), Actions 허용 목록, 저장소 범위, push 승인이다. 이 값은 카드가 아니라 **릴리스의 입력**이다. 지금 릴리스는 카드 버전·실행 프로필·저장소로 만든다(`packages/contracts/src/kollegium/agents.ts:477-486`). 여기에 `github`를 네 번째 입력으로 더하고 `policy_pins.github`에 넣는다. 그래서 GitHub 설정만 바꾸면 카드 버전은 그대로이고 새 릴리스만 생긴다(GA-MOCKUP 시안 A와 같다). `policy_pins`는 릴리스 id 해시에 들어가므로 값이 바뀌면 릴리스 id도 바뀐다. 릴리스 요청에 `github`가 없으면 지금 활성 릴리스의 `policy_pins.github`를 그대로 물려받는다. 카드를 고쳐 새 릴리스를 만들 때 GitHub 설정이 사라지지 않게 하려는 것이다. 활성 릴리스에 없으면 새 릴리스에도 없다. 이력은 릴리스 목록과 `create_agent_release`·`activate_agent` receipt로 남는다. `policy_pins.github`가 있는 릴리스만 id 버전을 4로 올린다. 없는 릴리스는 지금 버전 그대로 해시되어 기존 id가 검증된다(`release-ids.ts:32-39`의 방식).
- **즉시 반영하는 값:** GitHub 사용 스위치 `agents.github_enabled` 하나다. 끄면 게이트가 그 에이전트의 릴리스로 도는 모든 세션에 새 토큰을 내주지 않는다(`403` `reason_code: github_disabled`). 진행 중인 세션도 다음 토큰 요청부터 거절된다. 대상은 clone(gateway 재허가), push 실행, PR, dispatch, 리뷰다. 플랫폼이 이미 기록한 PR의 상태를 읽는 `outcome_refresh`만 대상이 아니다([10절](#pr-상태-갱신-조회로-한다)). 이미 발급해 캐시한 토큰이 control-host 안에 남아도 게이트가 먼저 거절하므로 쓰이지 않는다. 스위치를 바꾸면 `set_agent_github` receipt를 남긴다.
- 릴리스에 고정된 값도 발급할 때마다 그 시점의 워크스페이스 상한과 App 권한으로 다시 자른다. 상한을 낮추면 기존 릴리스의 그 기능은 다음 발급부터 거절된다(`409` `reason_code: over_workspace_ceiling`). 릴리스나 세션을 `CATALOG_MISMATCH`로 만들지는 않는다. 상한을 다시 올리면 같은 릴리스가 그대로 다시 돈다.

### 결정 8. 에이전트별 저장소 범위

- 릴리스의 `github.repositories`: 카탈로그 저장소 id 목록(1~32개)이다. 고를 수 있는 것은 GitHub App(콘솔 App이나 카탈로그 App)을 쓰는 저장소 가운데 릴리스 프로필이 허용하는 것(`allowedPair`)이다. 릴리스의 `repository_id`가 있으면 목록에 반드시 들어가야 한다(`400` `reason_code: release_repository_outside`).
- **강제.** 게이트는 세션의 저장소가 목록에 없으면 토큰을 내주지 않는다(`403` `reason_code: repository_not_allowed`). 토큰은 지금처럼 그 저장소 하나로 좁혀 발급한다(`repositoryNames`, `forge-github.ts:445`). 그래서 "에이전트 범위로 좁히기"는 GitHub 쪽으로 보면 여전히 저장소 하나짜리 토큰이다. 범위 검사는 발급 전에 한다. 세션을 만들 때도 같은 검사로 미리 거절한다(`409` `reason_code: repository_not_allowed`). clone 단계까지 가서야 실패하지 않게 하려는 것이다.
- `github` 설정이 없는 릴리스는 지금처럼 프로필이 허용하는 모든 저장소를 쓴다.

### 결정 9. 워크스페이스 상한 → 에이전트 좁히기

- 워크스페이스 GitHub 설정의 `ceiling`이다: `{ workflows, actions, checks, issues, review }` 각 boolean. 행이 없으면 모두 false다. 기본 권한(contents·pull_requests)은 상한에 두지 않는다. 그 권한을 막으려면 에이전트 스위치를 끈다.
- **누가.** owner·admin만 바꾼다. `workspace.manage`(`policy.ts:241`)이고 API key는 못 한다. 실행 프로필의 규칙과 같다. 저장할 때(`400` `reason_code: over_workspace_ceiling`)와 쓸 때(게이트의 교집합) 같은 정책 함수를 쓴다. 그 함수는 `packages/contracts`에 두어 서버와 콘솔이 같이 쓴다. 워크스페이스 프로필이 `WORKSPACE_PROFILE_POLICY`(`packages/contracts/src/api/profile-derivation.ts:153`)를 저장과 실행에서 같이 쓰는 것과 같다.
- 상한은 App 권한보다 넓게 저장할 수 있다. 실제 허용은 교집합이므로 해가 없다. 화면은 App에 없는 항목에 "App에 권한 없음"을 같이 보인다.
- 상한을 낮출 때 기존 릴리스 처리는 [결정 7](#결정-7-릴리스와의-관계) 마지막 항목과 같다. 상한 변경은 `set_github_ceiling` receipt(이전 값과 새 값)를 남긴다.

### 결정 10. 감사

| operation | 언제 | actor | result |
|---|---|---|---|
| `mint_github_token` (새) | 게이트가 GitHub에 **새로** 토큰을 발급받았을 때. 캐시에서 꺼낸 것은 남기지 않는다 | 그 작업의 actor. clone은 세션 시작자, push 실행기는 없음(null). 시작자가 없으면 null([GA-2에서 정한 것](#ga-2에서-정한-것)) | `session_id`, `agent_id`, `agent_release_id`, `repository_id`, `role`(`author`·`reviewer`), `app_id`, `permissions`, `purpose`(`clone`·`push`·`pull_request`·`actions_read`·`dispatch`·`rerun`·`review`·`outcome_refresh`), `expires_at` |
| 게이트의 거절 | 발급 전에 거절했을 때 | 같음 | 같은 칸 + `reason_code`. status `failed` |
| `set_github_app` (있음) | 등록·교체 | 사람 | `app_id`에 `role`, `permissions`, `warnings`를 더한다 |
| `delete_github_app` (있음) | 삭제 | 사람 | `app_id`, `role` |
| `set_github_ceiling` (새) | 상한 변경 | owner·admin | `before`, `after` |
| `set_agent_github` (새) | 스위치 변경 | 에이전트 관리자 | `agent_id`, `enabled` |
| `create_agent_release`·`activate_agent` (있음) | GitHub 보안 값 변경 | 그대로 | result에 `github`(릴리스의 `policy_pins.github`)를 더한다 |
| `review_pull_request` (새) | 리뷰 제출과 그 거절 | 세션 작업의 actor | `session_id`, `agent_id`, `repository_id`, `number`, `commit_id`, `event`(`APPROVE`·`REQUEST_CHANGES`·`COMMENT`), `review_id`, PR을 연 `opened_by_session_id`·`opened_by_agent_id`(플랫폼이 연 PR이면) |
| `dispatch_workflow`·`rerun_workflow` (새) | dispatch·rerun과 그 거절 | 같음 | `workflow`, `ref` 또는 `run_id`, `allowed_by`(맞은 목록 항목) |
| `link_account`·`unlink_account` (있음) | GitHub 연결·해제 | 본인 | `provider: "github"`, `external_user_id`, `login` |
| `decide_push` (있음) | push 승인을 끈 릴리스의 자동 승인 | null. `approved_by`의 policy decider가 누구인지 말한다 | `agent_release_id` |

- receipt는 토큰 값을 싣지 않는다. 지금 forge가 오류에 요청 헤더를 남기지 않는 규칙(`forge-github.ts:642-660`)을 그대로 따른다. GitHub 오류 원문, dispatch `inputs`의 값, 리뷰 본문도 싣지 않는다. 상태, 플랫폼의 `reason_code`, 위 표의 칸만 싣는다.
- **선행 수정.** 에이전트별 감사를 하려면 receipt의 `agent_id`가 채워져야 한다. 지금은 늘 null이다(`policy.ts:43-50`). GA-1에서 `receiptActorOf`가 caller의 에이전트 key의 `agent_id`를 싣게 고친다. **`actor.agent_id`는 호출자 key에서만 채운다**("누가 했나"). 사람이 부르면 null이고, 다른 에이전트의 key가 불렀으면 그 에이전트다. 위 표의 `result.agent_id`는 세션 릴리스에서 채운다("어느 에이전트의 세션인가"). 둘은 다를 수 있고, 게이트가 actor 쪽을 세션 릴리스로 덮어쓰지 않는다. 내장 MCP 호출의 actor는 GA-7이 정한다([9절](#9-구현-pr-분할)).
- **에이전트별 활동 조회(`…/github/activity`).** actor로 찾지 않는다. 사람이 릴리스를 만들면 actor에 에이전트가 없기 때문이다. 대상으로 찾는다. 둘을 합친다. (1) 에이전트 대상 receipt: `target_ref.resource`가 `{ kind: "agent", id }`인 것(`set_agent_github`, `create_agent_release`, `activate_agent`. 지금 에이전트 receipt가 이 모양이다, `packages/db/src/agents.ts:162-170`). (2) 세션 대상 receipt: `target_ref.session_id`가 있고 그 세션의 릴리스가 이 에이전트의 것인 것(`mint_github_token`, 게이트 거절, `review_pull_request`, `dispatch_workflow`, `rerun_workflow`). 게이트 receipt는 그래서 `target_ref`에 `session_id`를 싣는다. (2)는 호출자가 볼 수 있는 세션만 남긴다. 세션 목록과 같은 술어(`sessionVisibleTo`, `packages/db/src/session-shares.ts:95-100`)를 SQL에서 걸고 나서 최근 20개를 자른다. 에이전트 관리자라도 공유받지 않은 세션의 기록은 받지 못한다. 단건 receipt 조회가 세션의 `session.read`를 검사하는 것(`packages/platform/src/sessions/session-service.ts:1360-1368`)과 같은 경계다.
- 발급이 잦은 clone(gateway 재허가)도 캐시 덕분에 토큰 하나에 receipt 하나다. 토큰은 1시간 유효하고, 만료 10분 전에 다시 발급한다(`forge-github.ts:28`).

## 3. 토큰 발급 경로와 좁히기

### GitHub 게이트

`packages/platform`에 포트 하나를 더하고 control-host가 구현한다. 지금 호출자는 `ForgeResolver`(`packages/platform/src/ports/forge.ts:76`)에서 adapter를 받아 `gitCredential(repo, access)`를 부른다. 이 자리를 게이트로 바꾼다.

```ts
// packages/platform/src/ports/github-gate.ts (sketch)
export type GitHubPurpose =
  | "clone" | "push" | "pull_request"
  | "actions_read" | "dispatch" | "rerun" | "review"
  // GA-4b: the platform reading a PR it recorded (section 10).
  | "outcome_refresh";

export type GitHubWork = {
  // The repository is never passed: the gate reads it off the session row
  // and checks its catalog binding, as the clone path does today.
  sessionId: string;
  purpose: GitHubPurpose;
  /** dispatch only. */
  workflow?: { file: string; ref: string };
  /** rerun only. The gate finds its workflow and ref in github_workflow_dispatches. */
  runId?: number;
  actor: ReceiptActor;
};

// What a granted piece of work may call: bound to one repository, one App
// and one credential the gate issued. No method issues a credential itself.
export interface GitHubGrant {
  readonly role: "author" | "reviewer";
  readonly repo: RepoRef;
  readonly permissions: Readonly<Record<string, "read" | "write">>;
  /** For git over HTTP (clone, push). */
  readonly gitCredential: GitCredential;
  /** REST calls with that same credential (PR, comment, run, dispatch, review). */
  readonly api: GitHubApi;
}

export interface GitHubGate {
  /** Refuses with GitHubGateError(reason_code) before any GitHub call. */
  grant(work: GitHubWork): Promise<GitHubGrant>;
}
```

- `grant`가 하는 일, 이 순서로:
  1. 세션 → 릴리스 → 에이전트를 읽는다. 릴리스가 없는 세션은 "기본 설정"을 쓴다. 기본 설정은 GitHub 켜짐, push 승인 켜짐, 선택 권한 없음, 프로필이 허용하는 모든 저장소다. 지금 동작과 같다.
  2. `agents.github_enabled`이 false면 `github_disabled`다.
  - `outcome_refresh`만 예외다. 1단계, 3단계의 저장소 binding 검사, 6~8단계만 하고 2단계, 3단계의 릴리스 범위 검사, 4·5단계는 건너뛴다([10절](#pr-상태-갱신-조회로-한다)). 에이전트의 작업이 아니라 플랫폼이 이미 기록한 PR을 읽는 것이기 때문이다.
  3. 세션 행의 저장소와 그 binding을 읽는다(gateway의 지금 검사 `worker-gateway.ts:1226-1240`와 같다). 그 저장소가 릴리스 `github.repositories` 밖이면 `repository_not_allowed`다. 호출자는 저장소를 고를 수 없다.
  4. purpose별 필요 권한을 정한다([표](#작업별-권한)). 선택 권한이 필요한데 릴리스가 끈 것이면 `feature_off`, 상한이 막으면 `over_workspace_ceiling`이다. App·설치 권한은 여기서 보지 않고 6단계의 발급 요청이 판정한다.
  5. dispatch·rerun이면 허용 목록을 맞춘다(`workflow_not_allowed`).
  6. role에 맞는 연결 행의 발급 함수를 고르고(`review`만 `reviewer`), 저장소 하나와 권한으로 installation token을 요청한다. GitHub가 권한 부족으로 거절하면 `app_permission_missing`이다([결정 2](#결정-2-app-최대-권한설치-상한)).
  7. 새로 발급했으면 `mint_github_token` receipt를 남긴다. 거절했으면 거절 receipt를 남긴다.
  8. 그 자격 증명에 묶인 `GitHubGrant`를 돌려준다.
- **발급은 게이트 안에만 있다.** 지금 `ForgeAdapter`는 메서드마다 스스로 자격 증명을 얻는다(`call()`이 `credential()`을 부른다, `forge-github.ts:179-191`). PR 조회·생성, 저장소 조회, 코멘트가 모두 이 경로다. GA-2는 이 발급 함수(`issuer`, `forge-github.ts:407-460`)와 캐시(`forge-github.ts:152-177`)를 게이트 구현 안으로 옮긴다. REST 메서드는 `GitHubGrant.api`로 옮겨 받은 자격 증명만 쓰게 한다. 그래서 게이트를 거치지 않고 토큰을 얻는 코드 경로가 남지 않는다. 캐시는 지금처럼 **연결마다 따로** 둔다. 지금 캐시 키(`owner/name|permissions`, `forge-github.ts:156-159`)에는 GitHub 서버가 없고, 격리는 연결마다 forge를 따로 만드는 것(`forge-github.ts:722-736`)이 해 준다. 게이트도 연결(콘솔 행 id와 role, 또는 카탈로그 저장소의 `api_base`·`app_id`·`installation_id`)마다 발급기와 캐시 한 벌을 두고, 그 안의 키는 지금 그대로 쓴다. 콘솔 연결 행이 바뀌면 그 연결의 캐시를 통째로 버린다(지금 `createRegisteredGitHubForge`가 연결이 바뀌면 forge를 새로 만드는 것과 같다). GA-2 테스트: 서로 다른 `api_base`에서 같은 App id·같은 저장소 이름을 쓰는 두 연결이 서로의 토큰을 받지 않는다. 캐시에서 꺼낸 토큰을 줄 때도 1~5단계는 매번 다시 한다(`outcome_refresh`는 위 예외의 단계만).
- **카탈로그 App 저장소**(`app_id`를 적은 저장소)도 같은 게이트를 지난다. 그 저장소의 `author` 연결은 카탈로그의 App이고 `reviewer` 연결은 없다. 그래서 리뷰는 `no_reviewer_app`이다. App 권한은 그 App의 `GET /app`을 처음 발급할 때 한 번 읽어 메모리에 둔다. 카탈로그의 `api_base`가 github.com API가 아닌 저장소(GHES)는 **기본 작업**(`clone`·`push`·`pull_request`)과 `outcome_refresh`만 받는다. 그 밖의 purpose(`actions_read`·`dispatch`·`rerun`·`review`)는 게이트 4단계에서 `409` `reason_code: github_host_unsupported`로 거절한다. 탭은 그 저장소만 고른 에이전트에서 선택 권한을 같은 이유로 비활성으로 보인다. GA-2 테스트: GHES 카탈로그 저장소 세션의 clone·push·PR은 지금처럼 되고 dispatch는 `github_host_unsupported`다.
- **PAT 저장소**(`kind: basic`, github.com)는 권한을 좁힐 수 없다. `github` 설정이 없는 릴리스(와 릴리스 없는 세션)만 기본 작업(clone·push·PR)을 지금처럼 한다. 선택 권한 작업은 모두 `app_required`로 거절한다. `outcome_refresh`는 릴리스와 상관없이 PAT로 읽는다. 이때 자격 증명은 좁혀지지 않고, 플랫폼이 부르는 호출만 읽기(`GET …/pulls/{n}`)다. `github` 설정이 있는 릴리스는 PAT 저장소를 고를 수 없다([결정 3](#결정-3-workflows-권한)).

### GA-2에서 정한 것

구현하면서 위 설명과 달라지거나 위에서 정하지 않은 것을 여기 둔다. 위 문단과 이 목록이 다르면 이 목록이 맞다.

- **놓인 곳.** 게이트의 판정(`createGitHubGate`)은 `packages/platform/src/sessions/github-gate.ts`에 있고, 포트는 `packages/platform/src/ports/github-gate.ts`다. control-host는 연결만 준다. `forge-github.ts`의 `createGitHubConnection`이 연결 하나(발급기, 토큰 캐시, 그 자격 증명에 묶인 REST 호출)이고, `connectionsOf`가 저장소마다 연결을 고른다. `ForgeAdapter`·`ForgeResolver`는 없앴다. 그래서 control-host에도 게이트를 거치지 않고 토큰을 얻는 경로가 없다.
- **GitHub가 아닌 저장소.** 연결이 없고 `github_app` 인증도 아닌 저장소(Gitea, PAT의 GHES, bearer, 공개)는 1단계 다음에 바로 `null`을 돌려주고 호출자가 카탈로그의 자격 증명을 그대로 쓴다. 스위치·범위를 보지 않는다. GitHub 설정은 GitHub 저장소에만 뜻이 있고, 릴리스 검증이 GitHub App 저장소가 아닌 곳의 `github`를 `app_required`로 막기 때문이다.
- **receipt actor.** receipt의 principal 종류는 `api_key`·`user`·`installation`뿐이다(`receiptActorSchema`). 표의 `{ kind: "service" }` 대신, 사람이 없는 작업(push 실행기의 발급, 정책의 자동 승인)은 actor를 null로 둔다. 자동 승인은 `decided_by: { kind: "policy", agent_release_id }`와 receipt result의 `approved_by`로 알 수 있다. clone은 세션 시작자, 시작자가 없으면 null이다.
- **ref를 적지 않은 허용 목록 항목.** "기본 브랜치"는 GitHub에 묻지 않고 카탈로그 항목의 `branch`로 정한다. 게이트가 GitHub를 부르기 전에 판정해야 해서다.
- **상한 밖의 `workflows`.** 릴리스가 `workflows`를 켰어도 상한이 막으면 push 토큰에서 `workflows: write`만 빠지고 push 자체는 거절하지 않는다. 그 push가 워크플로 파일을 바꾸면 GitHub가 거절하고 `workflows_permission_missing`이 된다.
- **HTTP 상태.** `GITHUB_REFUSED`는 정책 거절(`github_disabled`, `repository_not_allowed`, `feature_off`, `workflow_not_allowed`, `agent_ref_refused`, `run_ref_unprovable`)이면 `403`, 나머지는 `409`다(`githubRefusalStatus`). 세션 생성의 저장소 범위 거절도 `403` `repository_not_allowed`이고 receipt는 없다(`receipt_id: null`).
- **저장소 binding.** 게이트는 모든 purpose에서 세션이 만들 때 고정한 저장소 URL·브랜치와 지금 카탈로그 항목을 비교한다. 다르면 거절 receipt 없이 `503`(저장소가 옮겨졌다)이다. gateway·push 실행기·PR 서비스의 binding 검사는 그대로 두고, Actions 작업도 같은 보호를 받게 한 것이다.
- **물려받은 `github`.** `github` 없이 만든 릴리스가 활성 릴리스의 설정을 물려받을 때도 보낸 설정과 같은 검증(저장소 범위·PAT·`actions_off`·상한)을 한다. 카드 편집이 릴리스를 다른 저장소로 옮기면 `release_repository_outside`로 막힌다.
- **승인 scope가 있는 호출자의 PR 열기.** `sessions:approve` scope가 있어도 share가 `session.approve`를 주지 않으면 `session.submit`으로 다시 보고, 되면 submit 호출자로 연다(`pushed` 요청만).
- **clone 거절이 보이는 곳.** proxy와 worker의 동작은 바꾸지 않는다(clone 재허가가 `GITHUB_REFUSED`로 실패한다). 이유는 게이트의 거절 receipt(`mint_github_token`, `target_ref.session_id`)로 세션 상세의 receipt 목록에서 보인다.
- **GA-2가 하지 않은 것.** `GET …/github-settings`의 OAuth 칸(GA-4), 저장소별 설치 권한을 응답에 싣는 것과 `…/github-apps/{role}` 경로(GA-5), 활성화·릴리스 생성 receipt의 `github` result(GA-3)다. App 권한은 지금 `…/github-app`(작성용)의 등록과 `GET` 때 읽어 행에 두고, 응답의 `github_app`에 `permissions`·`permissions_checked_at`·`warnings`를 싣는다.

### 작업별 권한

| purpose | 권한 | 연결 | 누가 부르나 |
|---|---|---|---|
| `clone` | `contents: read` | author | gateway 재허가(`worker-gateway.ts:1241-1255`) |
| `push` | `contents: write`, `workflows`가 켜졌으면 + `workflows: write` | author | push 실행기(`push-executor.ts:108`) |
| `pull_request` | `contents: read`, `pull_requests: write` | author | PR 열기·코멘트(`pull-request-service.ts`) |
| `actions_read` | `actions: read` | author | run 조회(rerun 판정은 GitHub가 아니라 `github_workflow_dispatches`로 한다) |
| `dispatch`, `rerun` | `actions: write` | author | 새 GitHub 작업 서비스 |
| `review` | `contents: read`, `pull_requests: write` | reviewer | 새 GitHub 작업 서비스 |
| `outcome_refresh` | `pull_requests: read` | author | 성과물 상태 조회(GA-4b, [10절](#pr-상태-갱신-조회로-한다)). 에이전트 스위치·범위·기능·상한을 보지 않는다 |

`checks: write`와 `issues: write`는 이번에 상한·릴리스 칸과 게이트의 판정만 만든다. 그 권한을 쓰는 작업(check run 쓰기, issue 쓰기)은 이 문서 범위에서 만들지 않는다. 칸이 먼저 있어야 오너가 App에 미리 권한을 주고 에이전트별로 켜 둘 수 있다. 작업은 필요할 때 이 표에 줄을 더해 만든다.

### GitHub 작업 서비스와 두 입구

- `packages/platform/src/sessions/github-work-service.ts`(새)가 dispatch·rerun·review를 한다. 기존 push 요청·PR 서비스와 같은 층이고 같은 게이트를 쓴다. 세션 share로 `session.submit`을 검사한다(`push-request-service.ts`의 `requireSession`과 같다).
- **입구 1: 세션 API**([6절](#6-api)). 에이전트 key, 개인 key, 웹이 부른다.
- **입구 2: 내장 MCP 서버 `github`**(GA-7). 세션의 에이전트가 자기 세션에 대해서만 부른다. worker는 여전히 토큰을 받지 않는다. MCP 호출은 egress proxy를 지나 control-host의 작업 서비스에 닿는다. proxy는 지금 `/mcp/<server>` 경로마다 control-host에 허가를 묻는다(`credential.ts:144-148`, `689`). 그 허가가 attempt 토큰으로 세션을 정하므로 다른 세션의 이름으로 부를 수 없다. 도구는 `request_push`, `open_pull_request`, `comment_pull_request`, `dispatch_workflow`, `rerun_workflow`, `submit_review`, `get_workflow_run`이다. 각 도구는 입구 1과 같은 서비스 함수를 부른다. push 승인을 켠 릴리스에서 `request_push`는 요청만 만들고 사람을 기다린다. 이 서버는 `github_enabled`이고 릴리스에 `github` 설정이 있는 세션에만 붙는다. 도구 목록은 릴리스가 켠 기능만 노출한다. upstream 주소, 허가 응답 모양, 도구 정책 핀(`policy_pins.tools`)과의 관계는 GA-7의 첫 커밋 전에 이 문서에 절을 더해 정한다.

## 4. 데이터 모델

### `github_apps` (0192, 열 추가)

| 열 | 타입 | 규칙 |
|---|---|---|
| `role` (새) | text NOT NULL DEFAULT `'author'` | `CHECK (role IN ('author', 'reviewer'))`. 기존 행은 `author` |
| `permissions` (새) | jsonb | 마지막으로 읽은 `GET /app`의 `permissions`. 읽기 전(기존 행)은 NULL이고 다음 `GET …/github-apps/author`나 첫 발급 때 채운다 |
| `permissions_checked_at` (새) | timestamptz | `permissions`와 짝 CHECK |
| `client_id` (GA-4, 새) | text | `GET /app`의 `client_id`. 사용자 연결(OAuth)의 client. 읽기 전(기존 행)은 NULL이고 다음 등록이나 `GET …/github-app` 때 채운다 |

- 제약: `github_apps_workspace_uniq`(`0192:12`)를 지우고 `UNIQUE (workspace_id, role)`을 건다.
- 키 슬롯은 행 id로 정해지므로(`github-apps.ts:25-29`) 바꾸지 않는다.
- `credentials()`(`github-apps.ts:168-195`)는 role을 받고 그 role만 돌려준다. 콘솔 App forge(`forge-github.ts:612`)는 `author`를 읽고, 리뷰용 forge를 같은 방식으로 하나 더 만든다.

### `github_workspace_settings` (새)

| 열 | 타입 | 규칙 |
|---|---|---|
| `workspace_id` | uuid PK FK workspaces | |
| `ceiling` | jsonb NOT NULL | `{ workflows, actions, checks, issues, review }` boolean. 스키마는 contracts의 `githubCeilingSchema` 하나 |
| `oauth_client_secret_set` | boolean NOT NULL DEFAULT false | 사용자 연결용 client secret이 `secret_values`(owner `{ kind: "github_app", id: <author 행 id> }`, purpose `github_oauth_client_secret`)에 있는지. 값은 다시 읽어 보여 주지 않는다. client secret은 App에 묶인 값이므로, 작성용 App을 지우거나 `app_id`가 다른 App으로 바꾸면 같은 트랜잭션에서 secret을 지우고 이 칸을 false로 둔다. 같은 App의 개인 키만 바꿀 때는 그대로 둔다(지금 교체는 같은 행을 고친다, `packages/db/src/github-apps.ts:111-120`. 삭제는 키 슬롯만 지운다, `153-158`). GA-4 테스트가 세 경우를 나눠 본다 |
| `revision` | integer NOT NULL DEFAULT 1 | 쓸 때마다 +1. PUT은 `revision`을 받아 다르면 `409 REVISION_CONFLICT`. revision은 상한의 CAS다. client secret 쓰기는 바꾸지 않는다 |
| `updated_by`, `updated_at` | uuid, timestamptz | |

행이 없으면 상한은 모두 false이고 client secret은 없다.

### `github_workflow_dispatches` (새)

| 열 | 타입 | 규칙 |
|---|---|---|
| `run_id` | bigint | GitHub run id. `UNIQUE (repository_id, run_id)` |
| `repository_id` | text NOT NULL | 카탈로그 저장소 id |
| `session_id` | uuid NOT NULL FK sessions | dispatch한 세션 |
| `agent_release_id` | text | 그때의 릴리스 |
| `workflow` | text NOT NULL | 파일 이름 |
| `ref` | text NOT NULL | 브랜치 이름(`refs/heads/` 없이) |
| `receipt_id` | uuid NOT NULL FK receipts | `dispatch_workflow` receipt |
| `created_at` | timestamptz NOT NULL | |

GitHub가 run id를 돌려주지 않은 dispatch는 행을 남기지 않는다. 그 run은 rerun할 수 없다. rerun은 이 행을 찾고, 세션 저장소와 `repository_id`가 같아야 한다.

### `agents.github_enabled` (새 열)

boolean NOT NULL DEFAULT true. 기존 에이전트는 true다. 지금 GitHub 저장소를 쓰는 에이전트가 멈추지 않게 하려는 것이다. 새 에이전트도 true다. 끄는 것은 GitHub 탭의 스위치다.

### 릴리스 `policy_pins.github`

```ts
// packages/contracts/src/kollegium/agents.ts (sketch)
export const agentGitHubSchema = z.object({
  repositories: z.array(z.string().min(1).max(128)).min(1).max(32),
  push_approval: z.boolean(),
  features: z.object({
    workflows: z.boolean(),
    actions: z.boolean(),
    checks: z.boolean(),
    issues: z.boolean(),
    review: z.boolean(),
  }).strict(),
  actions_allow: z.array(z.object({
    workflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/),
    ref: z.string().min(1).max(255).optional(),
  }).strict()).max(32),
}).strict();
// createAgentReleaseRequestSchema: github?: AgentGitHub (absent: inherit the active release's)
// policyPinsSchema: github?: AgentGitHub (absent on every release made before it)
```

- 릴리스를 만들 때 저장소 id가 카탈로그·프로필에 있는지, PAT 저장소가 아닌지, `actions_allow`가 `actions` 없이 쓰이지 않았는지, 워크스페이스 상한 안인지 검사하고 같은 값을 `policy_pins.github`에 넣는다. 상한 검사는 저장 시점의 안내이고, 실행 때 다시 자른다([결정 7](#결정-7-릴리스와의-관계)). 카드 스키마는 바꾸지 않는다.
- **저장소 없는 릴리스.** 프로필의 `repository_mode`가 `none`이면 릴리스에 `repository_id`가 없다(`packages/contracts/src/kollegium/agents.ts:483-484`). 이런 릴리스에는 `policy_pins.github`를 두지 않는다. 요청에 `github`를 넣으면 `400` `reason_code: repository_none`이고, 활성 릴리스의 `github`도 물려받지 않는다. 그래서 GitHub 설정이 있는 에이전트도 저장소 없는 프로필로 옮길 수 있다. 그 릴리스의 세션은 저장소가 없으니 GitHub 작업이 생기지 않는다. 다시 저장소 있는 프로필로 옮기면 활성 릴리스에 `github`가 없으므로 [기본값](#에이전트-github-설정의-기본값)으로 읽고, 탭에서 다시 저장해야 한다. GA-2 테스트: GitHub 설정이 있는 에이전트를 `repository_mode: none` 프로필로 옮기는 요청이 `github` 없이 성공하고 `github`를 넣으면 `repository_none`이다.
- 같은 내용의 릴리스를 다시 만들면 지금처럼 `created: false`로 그 릴리스를 돌려준다. 그래서 GitHub 설정을 바꿨다가 되돌리면 앞의 릴리스 id가 다시 나온다.

#### 에이전트 GitHub 설정의 기본값

| 칸 | 새 에이전트(GitHub 탭을 처음 저장할 때) | `github` 없는 릴리스(기존) |
|---|---|---|
| `repositories` | 릴리스 `repository_id` 하나(없으면 빈 목록이라 저장 전에 고르게 한다) | 프로필이 허용하는 모든 저장소 |
| `push_approval` | true | true |
| `features.*` | 모두 false | 모두 false |
| `actions_allow` | `[]` | `[]` |

### `linked_accounts` (CHECK 확장)

- 새 번호의 마이그레이션이 `linked_accounts_provider_check`(`schema.ts:766-769`)를 `IN ('slack', 'github')`로 바꾼다. `verified_via`에는 지금 DB CHECK가 없고 TypeScript 타입만 있다(`schema.ts:742`). 타입에 `github_oauth`를 더한다. contracts의 `LINKED_ACCOUNT_PROVIDER_VALUES`에도 더한다. 0141 파일은 고치지 않는다.
- `expires_at`은 열이 아니라 응답 필드다. 서비스가 null로 채운다(`packages/platform/src/musterrolle/linked-account-service.ts:31-32`). GitHub 행도 토큰을 두지 않으므로 같다.
- GitHub 행: `external_tenant = 'github.com'`, `external_user_id` = GitHub 숫자 id(문자열), `external_user_name` = login, `external_tenant_name = 'GitHub'`. 한 사람은 GitHub 계정 하나다(`linked_accounts_user_live_uniq`, `schema.ts:759-761`).
- `stale`은 쓰지 않는다. 토큰을 두지 않으므로 GitHub 계정이 사라진 것을 알 수 없다. 해제(`revoked`, `unlinked`)와 오프보딩만 있다.

### push 요청의 결정 주체

`push_requests.decided_by`(jsonb, `schema.ts:1766`)에 `{ kind: "policy", agent_release_id }` 모양을 더한다. contracts의 결정 주체 스키마와 웹·SDK 생성물을 같이 고친다.

## 5. 기존 설치 이전

마이그레이션은 확장 → 전환 → 정리로 한다. 규칙은 하나다. **N단계 이미지는 N+1단계가 남긴 DB를 읽고 멈추지 않는다.**

| 단계 | PR | DB | 앞 이미지가 멈추지 않는 이유 |
|---|---|---|---|
| 확장 | GA-1 | `github_apps.role`·`permissions`, `UNIQUE (workspace_id, role)`, `github_workspace_settings`, `agents.github_enabled DEFAULT true`, `linked_accounts` CHECK, receipt operation 값, `decided_by` 모양. store의 `find`·`put`·`delete`·`credentials`가 모두 role을 받고(지금은 모두 `workspace_id`만 본다, `github-apps.ts:85-89`, `111-114`, `153-158`, `168-195`), 기존 API와 콘솔 forge는 `author`에 묶는다. 그래서 이 이미지의 작성용 API는 뒤 단계가 만든 리뷰용 행을 읽거나 바꾸거나 지우지 않는다. **이 이미지는 `policy_pins.github`가 있는 릴리스의 세션에 GitHub 토큰을 주지 않는다**(clone·push·PR 모두 `409` `reason_code: github_settings_unsupported`). 좁히기를 모르는 이미지가 그 릴리스를 기본 설정으로 돌리는 일이 없게 하려는 것이다(fail closed). 릴리스 `policy_pins.github`를 **읽고**, 릴리스 요청에 `github`가 없을 때 활성 릴리스의 값을 물려받는 일까지 한다. 지금 `policyPinsSchema`는 `.strict()`라 이 칸이 든 릴리스를 거절한다(아래 실측). 그래서 쓰는 쪽(GA-2의 릴리스 요청 `github`)보다 읽고 물려받는 쪽이 먼저 모든 replica에 있어야 한다. 그래야 어느 replica가 카드 수정으로 릴리스를 만들어도 GitHub 설정이 사라지지 않고 같은 id가 나온다 | 0단계 이미지는 새 열과 테이블을 읽지 않는다. 이 단계에는 `reviewer` 행을 만드는 API가 없으므로, 0단계 이미지의 `credentials()` 첫 행은 여전히 작성용 App이다 |
| 전환 | GA-2~GA-7 | `github_workflow_dispatches`(GA-2, 새 테이블). 그 밖은 게이트, 릴리스 요청 `github`, 리뷰용 App 등록, OAuth, 상한 API | GA-1 이미지는 새 테이블을 읽지 않는다. GA-1 이미지는 `role`로 거르므로 리뷰용 행을 무시한다. `policy_pins.github`가 있는 릴리스는 GA-1 이미지에서 GitHub 토큰을 받지 못한다(fail closed). 섞인 기간에 그 세션이 GA-1 replica에 claim되면 clone이 거절될 수 있다. 그래서 GA-2를 모든 replica에 올린 뒤에 GitHub 탭(GA-3)을 연다. 탭 없이 릴리스 API로 `github`를 쓸 수는 있지만, 그 결과도 막히는 쪽으로만 틀린다 |
| 정리 | — | 없음 | 옛 경로 `/v1/workspaces/{id}/github-app`은 작성용 별칭으로 남긴다. 지울 이유가 생기면 그때 정한다 |

- **기존 연결 → 작성용 행.** `role` 열의 기본값이 `author`이므로 기존 행은 그대로 작성용이다. 데이터를 옮기지 않는다. `permissions`는 다음 조회나 첫 발급 때 채운다.
- **기존 에이전트 → push 승인 켜짐.** 기존 릴리스에는 `policy_pins.github`가 없으므로 [기본값 표](#에이전트-github-설정의-기본값)대로 `push_approval: true`로 읽는다. 릴리스 id도 바뀌지 않는다. 사람이 GitHub 탭에서 처음 저장할 때 새 릴리스가 생긴다(카드 버전은 그대로).
- **기존 에이전트 → GitHub 켜짐.** `github_enabled DEFAULT true`다.
- **실측(이 문서를 쓸 때, `cee8359b`).** 실제 contracts·release-ids 코드를 부르는 bun 테스트로 세 가지를 확인했다. `policyPinsSchema.safeParse({ tools, github })`는 실패한다. (카드 쪽 `agentCardSchema`도 모르는 칸이면 실패하므로, 설정을 카드에 두지 않는 이 설계에서는 카드 스키마를 건드리지 않는다.) 그리고 `deriveReleaseId`는 `policy_pins`에 키가 없을 때와 `github: undefined`일 때 같은 id(`sha256:6d06f0eb…`)를 낸다. `canonicalJsonOfJson`이 undefined 키를 버리기 때문이다. 반면 `canonicalJson`은 undefined에서 throw하므로, 해시에 들어가는 값은 지금처럼 `canonicalJsonOfJson`으로만 계산한다.
- **0단계로 되돌리기.** `policy_pins.github`가 든 릴리스가 생긴 뒤(GA-2 이후) 0단계 이미지로 되돌리면 그 에이전트의 릴리스를 읽지 못한다. GA-1 이전으로는 되돌리지 않는다.
- **알려진 한계.** 리뷰용 행을 만든 뒤(GA-5 이후) 0단계 이미지로 되돌리면 그 이미지의 `credentials()`가 행을 고르는 순서는 정해져 있지 않다. GA-1 이전으로는 되돌리지 않는다. 실행 프로필 전환(`profile-db.md` 5절)과 같은 규칙이다.

## 6. API

| 메서드·경로 | 누가 | 내용 |
|---|---|---|
| `GET`·`PUT`·`DELETE /v1/workspaces/{id}/github-apps/{role}` (새, `role` = `author`·`reviewer`) | owner·admin, cookie 세션만 | #922와 같은 본문과 응답(`openapi.ts:1167`, `1219`, `1260`)이다. 응답의 `github_app`에 `role`, `permissions`, `permissions_checked_at`, `warnings`(상한보다 넓은 권한 목록)를 더한다. `PUT reviewer`는 작성용 행이 없으면 `409` `reason_code: no_author_app`, 같은 App이면 `409` `same_app`이다 |
| `/v1/workspaces/{id}/github-app` (있음) | 그대로 | `…/github-apps/author`의 별칭. 응답 모양은 그대로이고, 새 칸은 optional로 더한다 |
| `GET /v1/workspaces/{id}/github-settings` (새) | 구성원 | `ceiling`, `revision`, `agents_using`(기능별로, `github_enabled`가 true이고 활성 릴리스의 `policy_pins.github`에서 그 기능을 켠 에이전트 수. 시안 C). 이 수는 "활성 릴리스에서 켠 에이전트"이지 실제 영향 전부가 아니다. 앞 릴리스로 아직 도는 세션도 상한을 낮추면 다음 발급부터 거절된다. 화면 문구는 "활성 릴리스에서 켠 에이전트 N개"로 하고, 낮출 때 확인 대화 상자에 "앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다"를 적는다,  `oauth: { client_id, client_secret_set, callback_url }`, `apps: { author: { permissions } \| null, reviewer: … }` |
| `PUT /v1/workspaces/{id}/github-settings` (새) | owner·admin, cookie 세션만 | 본문 `{ ceiling, revision }`. `set_github_ceiling` receipt |
| `PUT /v1/workspaces/{id}/github-settings/oauth-client-secret` (새) | owner·admin, cookie 세션만 | 본문 `{ client_secret }`. `set_github_app` receipt(`purpose: oauth_client_secret`, 끝 네 글자만). 값은 다시 읽히지 않는다 |
| `GET /v1/agents/{id}/github` (새) | 에이전트를 볼 수 있는 사람 | `enabled`, 활성 릴리스의 `github`(없으면 `null`과 `legacy_defaults`), `options`: 고를 수 있는 저장소, 각 기능의 `available`과 `reason`(`app_permission_missing`·`over_workspace_ceiling`·`no_reviewer_app`·`app_required`·`github_host_unsupported`) |
| `PUT /v1/agents/{id}/github/enabled` (새) | 에이전트 관리자(`agent.manage`), cookie 세션만 | 본문 `{ enabled }`. 즉시 반영. `set_agent_github` receipt. Slack의 `…/slack/app/settings`(`openapi.ts:3102-3119`)와 같은 자리 |
| `POST /v1/agents/{id}/releases` (있음, 본문 확장) | 그대로 | 본문에 optional `github`(위 스키마)를 더한다. 없으면 활성 릴리스의 값을 물려받는다. 검증 실패는 `400`의 `details.field`(`github.…`)와 `details.reason_code`(`repository_not_allowed`·`app_required`·`actions_off`·`over_workspace_ceiling`·`release_repository_outside`). 활성화는 지금의 흐름 그대로 |
| `GET /v1/agents/{id}/github/activity` (새) | 에이전트를 볼 수 있는 사람 | 그 에이전트의 GitHub receipt 최근 20개(`mint_github_token`, 게이트 거절, `set_agent_github`, `review_pull_request`, `dispatch_workflow`, `rerun_workflow`, GitHub 설정이 바뀐 `create_agent_release`·`activate_agent`). 대상으로 찾고 세션 기록은 호출자가 볼 수 있는 세션만 준다([결정 10](#결정-10-감사)의 조회 규칙, 시안 A "최근 기록") |
| `POST /v1/linked-accounts/github/start`, `POST …/github/callback` (새) | 본인(`account.link`) | Slack의 `…/slack/start`·`…/slack/callback`(`openapi.ts:2722`, `2743`)과 같은 모양과 state 규칙. 작성용 App이나 client secret이 없으면 `409` `reason_code: github_oauth_unset`([GA-4에서 정한 것](#ga-4에서-정한-것)) |
| `GET /v1/sessions/{id}/github/attribution` (GA-4, 새) | `session.read` | `{ trigger, attribution, login }`. 세션 상세의 귀속 줄([GA-4에서 정한 것](#ga-4에서-정한-것)) |
| `POST /v1/sessions/{id}/github/workflow-dispatches` (새) | `session.submit` | 본문 `{ workflow, ref, inputs? }`. GitHub에 `return_run_details: true`로 보내고, 응답은 `{ receipt_id, run: { id, html_url } \| null }`이다. GitHub가 run 정보를 주지 않으면 `run`은 null이다. `inputs`는 receipt에도 로그에도 남기지 않는다(키 이름만 남긴다). GitHub 오류 응답의 원문도 남기지 않는다([결정 0](#결정-0-github가-강제하는-것은-다시-책임지지-않는다)) |
| `GET /v1/sessions/{id}/github/workflow-runs/{run_id}` (새) | `session.read` | `actions_read`. `{ id, path, head_branch, status, conclusion, html_url }` |
| `POST /v1/sessions/{id}/github/workflow-runs/{run_id}/rerun` (새) | `session.submit` | 본문 `{ failed_only?: boolean }` |
| `POST /v1/sessions/{id}/github/pull-requests/{number}/reviews` (새) | `session.submit` | 본문 `{ event, commit_id, body? }`. `commit_id`는 40자 hex 필수 |
| `POST …/push-requests/{id}/pull-request`, `…/comments` (있음) | 바뀜 | `pushed` 요청이면 사람이 승인했든 정책이 승인했든 `session.submit`도 된다([결정 6](#결정-6-push-전-사람-승인)). `sessions:approve`는 그대로 된다 |

- 게이트 거절의 공통 형식: HTTP `403`(정책) 또는 `409`(설정이 없음·상한), `error.code` `GITHUB_REFUSED`, `details.reason_code`, `details.receipt_id`. `reason_code` 값은 contracts의 `GITHUB_REFUSAL_VALUES` 하나에 모은다: `github_disabled`, `repository_not_allowed`, `feature_off`, `over_workspace_ceiling`, `app_permission_missing`, `no_reviewer_app`, `app_required`, `workflow_not_allowed`, `agent_ref_refused`, `run_ref_unprovable`, `actions_off`, `github_settings_unsupported`, `github_host_unsupported`, `repository_none`.
- 새 경로는 `apps/control-host/src/api/openapi.ts`, `route-error-coverage.ts`, `packages/core`의 응답 표, `packages/client` 생성물, `docs/openapi.json`에 같이 들어간다.

## 7. 화면

시안은 GA-MOCKUP이 만든 오너 확인용 사본이다(repo 밖 `~/share/owner-checks/github-agent-20261030/mockups/`, 목차 `index.html`, 결정별 대응표 `decisions.md`). 화면 이름은 그 파일 이름이다. A는 에이전트 GitHub 탭(`a-default`, `a-nogh`, `a-noreview`, `a-ceiling`), B는 연동 계정(`b-unlinked`, `b-linked`), C는 GitHub 연결 설정(`c-default`, `c-noreview`, `c-member`)이다. 화면 PR(GA-3·GA-4·GA-6)은 이 절과 시안을 같이 기준으로 삼는다. 둘이 다르면 이 문서를 먼저 고친다. 시안과 이 문서가 다른 곳은 하나다. 시안 A는 저장소 후보를 "작성용 App을 쓰는 설치된 저장소"로 그렸다. 이 문서는 거기에 릴리스 프로필이 허용하는 것(`allowedPair`)이라는 조건을 더하고 PAT 저장소를 뺀다([결정 8](#결정-8-에이전트별-저장소-범위)). 탭은 프로필이 허용하지 않는 저장소를 이유와 함께 비활성으로 보인다.

### 에이전트 상세 GitHub 탭

`AGENT_TABS`(`apps/web/src/routes/agent-detail.tsx:70-76`)의 `slack` 뒤에 `github`를 더한다. 구성은 Slack 탭과 같다. 위에 사용 스위치, 아래에 상세 옵션이다.

1. **GitHub 사용**: 스위치. 즉시 반영되고, 끌 때 "진행 중인 세션도 다음 GitHub 요청부터 거절됩니다" 확인 대화 상자를 띄운다. 꺼져 있으면 아래 영역은 읽기 전용으로 흐리게 보인다.
2. **저장소**: 고를 수 있는 저장소 목록(체크박스). 설치 안 된 저장소는 "App 미설치" 배지.
3. **권한**: 기본 권한 줄(읽기 전용, "PR 작성·수정: contents·pull requests")과 선택 권한 다섯 줄(workflows 수정, Actions 실행, Checks 쓰기, Issues 쓰기, 리뷰 승인). 줄마다 비활성일 때 이유 한 줄과 해결할 곳 링크(GitHub 연결 설정)를 단다.
4. **Actions 허용 목록**: Actions 실행을 켰을 때만 보인다. 행마다 워크플로 파일 이름과 선택 ref 패턴. 비었으면 "목록에 없는 워크플로는 실행하지 않습니다".
5. **push 전 사람 승인**: 스위치. 끌 때 "승인 없이 `agent/<세션>` 브랜치로 push하고 PR을 엽니다" 경고.
6. **저장**: 2~5는 "새 릴리스로 저장"이다. 저장하지 않은 변경이 있으면 위쪽에 "릴리스에 넣지 않은 변경 N건" 상자(새 릴리스로 저장 / 되돌리기)를 보인다. 저장하면 같은 카드 버전·같은 실행 프로필에 새 GitHub 설정으로 릴리스를 만들고, 지금의 활성화 단계로 이어진다.
7. **최근 기록**: `…/github/activity`의 receipt 몇 줄과 운영 기록 링크.

### 설정 > 연동 계정

`/settings/linked-accounts`의 서비스 목록에 GitHub 행을 더한다. 미연결이면 "GitHub 계정 연결" 버튼이 GitHub 동의 화면으로 간다. 연결되면 login과 "공동 작성자 이메일 `<id>+<login>@users.noreply.github.com`" 한 줄, "해제" 버튼을 보인다. 작성용 App이나 client secret이 없으면 버튼은 비활성이고 "owner·admin이 GitHub 연결 설정에서 사용자 연결을 켜야 합니다"를 보인다.

### 설정 > 워크스페이스 > GitHub 연결

`/settings/workspace/github`(`router.tsx:318`)를 세 영역으로 나눈다.

1. **작성용 App**: 지금 화면 그대로에 "App 권한" 표를 더한다. 표는 권한 이름, App 값, 안내 값, 상태(맞음·없음·넓음 경고)다.
2. **리뷰용 App(선택)**: 같은 등록 양식. 비어 있으면 "PR 승인 리뷰를 하려면 PR을 만드는 App과 다른 App이 필요합니다" 안내와 권장 권한 목록. 같은 에이전트 승인 위험과 GitHub 쪽 대응([결정 1](#결정-1-리뷰-전용-app))도 한 단락으로 적는다.
3. **에이전트 권한 상한**: 선택 권한 다섯 개의 스위치(owner·admin만 바꾼다. 다른 사람에게는 읽기 전용). App에 없는 항목은 "App에 권한 없음" 표시.
4. **사용자 계정 연결**: Client ID(App에서 읽은 값), 콜백 URL(복사 버튼), client secret 입력.

### 세션 상세

PR 정보 영역(세션 출력)에 commit 귀속 한 줄: "공동 작성자: <login>" / "GitHub 계정 미연결" 안내와 연동 계정 링크 / "App 단독(시작자 없음)". 그리고 게이트 거절이 있으면 이유를 보인다.

i18n ko·en·ja를 같이 고친다.

## 8. 검증 기준(werft-sandbox)

실 GitHub 검증은 `JeongJaeSoon/werft-sandbox`와 작성용 App `werft-sandbox-agent`(App ID 5513262)로 한다. 리뷰용 App은 오너가 새로 만든다. 각 구현 PR의 실측 항목은 [9절](#9-구현-pr-분할)에 있다. 공통 규칙은 셋이다. 자기 verify 스택 하나를 쓰고 끝나면 바로 `--keep-volumes`로 내린다. 키 파일은 경로만 넘기고 읽지 않는다. 거절을 확인할 때는 플랫폼 거절(게이트 `reason_code`)과 GitHub 거절(403·422)을 나눠 적는다.

## 9. 구현 PR 분할

| PR | 범위 | 수락 기준 | werft-sandbox 실측 |
|---|---|---|---|
| GA-1 데이터 모델·이전(확장) | 마이그레이션: `github_apps.role`·`permissions`·`permissions_checked_at`과 `UNIQUE (workspace_id, role)`, `github_workspace_settings`, `agents.github_enabled DEFAULT true`, `linked_accounts` provider CHECK 확장·`verified_via` TypeScript 타입 확장. contracts: `agentGitHubSchema`(`policy_pins.github`의 optional 칸), 릴리스를 만들 때 활성 릴리스의 `github` 물려받기, `githubCeilingSchema`, `GITHUB_REFUSAL_VALUES`, receipt operation 값, `decided_by` policy 모양. store의 role 인자(`find`·`put`·`delete`·`credentials`)와 기존 API·forge의 `author` 고정. `policy_pins.github` 릴리스 세션의 GitHub 토큰 fail closed(`github_settings_unsupported`). `receiptActorOf`의 `agent_id` 채우기. 릴리스 id 버전 4(`github`이 있을 때만) | 실 postgres 통합 테스트: 기존 `github_apps` 행이 `author`로 읽힌다. `(workspace, role)` 유일. `reviewer` 행을 직접 넣어도 콘솔 forge가 작성용 App을 쓰고, 기존 `GET`·`PUT`·`DELETE …/github-app`이 그 행과 키를 건드리지 않는다. `policy_pins.github`가 있는 릴리스의 세션은 clone·push·PR이 `github_settings_unsupported`. 기존 릴리스 id가 그대로 검증된다(fixture). GitHub 설정만 바꾸면 카드 버전·카드 해시는 그대로이고 `policy_pins.github`와 릴리스 id만 바뀐다. 에이전트 key의 `request_push` receipt에 `agent_id`가 있다. `bun run typecheck`, `bun test`, migration snapshot 테스트(`packages/db/src/schema.test.ts`) | 기존 등록 App으로 clone·push·PR이 #922 결과와 같다(PR 하나, 작성자 `app/werft-sandbox-agent`). receipt `request_push`에 `agent_id` |
| GA-2 토큰 발급 좁히기·허용 목록 | 릴리스 요청 `github`와 그 검증(저장소·PAT·상한·`actions_off`). `GitHubGate` 포트와 control-host 구현. gateway·push 실행기·PR 서비스를 게이트로 옮긴다. `credential(repo, permissions)`. App 권한 읽기(`describe`의 `permissions`)와 경고. 작업 서비스의 dispatch·run 조회·rerun과 세션 API, `github_workflow_dispatches` 마이그레이션(새 테이블이라 앞 이미지와 섞여도 안전하다). 새 작업의 오류 로그는 원문 없이 남긴다. `push_approval` false의 자동 승인과 `pushed` 요청의 `session.submit` PR 열기. `mint_github_token`·거절·`dispatch_workflow`·`rerun_workflow`·`decide_push`(policy) receipt. `github_enabled` 즉시 거절. 상한 정책 함수(contracts, 저장·실행 공용)와 `github-settings` GET·PUT API, `set_github_ceiling` receipt(GA-3의 Actions 실측이 상한을 켜야 하므로 화면보다 먼저 둔다) | 게이트 단위 테스트: [작업별 권한 표](#작업별-권한)의 각 줄과 각 `reason_code`. 꺼진 스위치가 진행 중 세션의 다음 clone 재허가·push·PR을 거절한다. 허용 목록의 ref glob(`*`가 `/`를 넘지 않음, `ref` 생략은 기본 브랜치만). `agent/` ref dispatch는 목록과 상관없이 `agent_ref_refused`. rerun은 `github_workflow_dispatches`에 기록된 run만 받고, 기록 없는 run(push로 시작된 run, 같은 이름의 브랜치·태그가 있는 저장소의 태그 run 포함)은 `run_ref_unprovable`. 기록된 run도 지금 릴리스 목록에서 빠졌으면 `workflow_not_allowed`. 입력값을 되비추는 fake GitHub 오류로 dispatch를 실패시켜 로그·receipt에 입력값이 없음을 확인한다. `pushed` 요청의 PR 열기가 `session.submit`(에이전트 key)으로 된다. 캐시된 토큰이 있어도 꺼진 뒤에는 쓰이지 않는다. fake GitHub(`packages/testkit/src/fake-github.ts`)로 route 테스트. 상한 서비스 테스트: owner·admin만(member·API key `403`), `revision` 충돌, 상한을 낮추면 기존 릴리스의 그 기능이 다음 발급부터 `over_workspace_ceiling`이고 올리면 다시 돈다 | 먼저 `PUT …/github-settings`로 상한의 workflows·actions를 켠다. 기본 권한으로 PR 생성. `workflows` 꺼진 릴리스로 `.github/workflows/` 변경 push → GitHub 거절과 `workflows_permission_missing`. 켠 릴리스(App에 권한 추가 뒤)로 같은 push 성공. 허용 목록 안 dispatch 성공, 목록 밖 dispatch는 플랫폼 `workflow_not_allowed`(GitHub 호출 없음, receipt). 목록 안 워크플로라도 `agent/<SID>` ref면 `agent_ref_refused`. 플랫폼이 dispatch한 run의 rerun 성공, `main` push로 시작된 run의 rerun은 `run_ref_unprovable`. 저장소 범위 밖 세션 생성 거절. `contents: read` 토큰 push 거절(검토 문서 6절 1번). 스위치를 끄면 진행 중 세션의 다음 push 요청이 `github_disabled`. 상한에서 Actions를 끄면 dispatch가 `over_workspace_ceiling`이고, 다시 켜면 성공 |
| GA-3 에이전트 GitHub 탭 | `GET /v1/agents/{id}/github`, `PUT …/github/enabled`, `GET …/github/activity`, 탭 화면·i18n·stories | activity route 테스트: 사람이 만든 릴리스·활성화·스위치 변경이 목록에 나온다. 공유받지 않은 비공개 세션의 게이트 receipt는 에이전트 관리자에게도 나오지 않는다. 걸러 낸 뒤에 20개를 자르므로, 볼 수 있는 기록이 20개 넘게 있으면 비공개 기록이 최근에 몰려 있어도 20개가 다 찬다. web 테스트(비활성 이유 여섯 가지, 저장 → 같은 카드 버전의 새 릴리스, 저장 안 한 변경 상자), 1440·390 전후 캡처, ui-review | 탭에서 저장소 하나·Actions·허용 목록 하나를 켜고 릴리스 → 그 릴리스로 dispatch 성공·목록 밖 거절. 스위치 끄기 → 세션 상세에 거절 이유 |
| GA-4 사용자 GitHub OAuth·Co-authored-by | `…/github-settings/oauth-client-secret`과 GitHub 연결 화면의 사용자 계정 연결 영역(리드 결정, API와 같은 PR), `github_apps.client_id` 마이그레이션, `linked-accounts/github/start·callback`, 연동 계정 화면, claim의 `git.co_author`·`session_url`, worker `commit-msg` hook, PR 본문 꼬리 확장과 재사용 PR 꼬리 갱신, 세션 상세의 귀속 줄 | callback 테스트(state 만료·재사용, 같은 GitHub 계정 두 사람 `409`). hook 단위 테스트(트레일러 한 번만, 기존 트레일러 보존, `co_author` null이면 `Agent-Session`만). 시작자 규칙: 웹·개인 key·Slack 연결 사용자 → 사람, 에이전트 key → null | 오너 계정 연결 → 웹에서 시작한 세션의 commit에 `Co-authored-by: <login> <id+login@users.noreply.github.com>`, GitHub PR 화면에 공동 작성자로 보인다. 에이전트 key 세션은 트레일러 없음·"App 단독". PR 본문 꼬리에 세션 URL. 같은 세션 두 번째 push 뒤 꼬리의 commit이 최신 |
| GA-4b 세션 성과물(GitHub PR) | [10절](#10-세션-성과물) 전부. 마이그레이션 `session_outcomes`·`outcome_refresh_quotas`(새 테이블). forge `createPullRequest` 결과의 `created`(422로 남의 PR을 돌려줬으면 false). contracts `SESSION_OUTCOME_TYPE_VALUES`·성과물 스키마. `savePullRequest` 트랜잭션의 성과물 기록. forge 포트 `getPullRequest`와 `ForgePullRequest`의 `merged_at`·`closed_at`. 게이트 purpose `outcome_refresh`. API replica마다 도는 `outcome-refresher`(상태 조회와 성과물 없는 `pull_requests` 행 채우기). `GET /v1/sessions/{id}/outcomes`, `GET /v1/usage/outcomes`. 세션 상세 "결과물" 탭의 GitHub PR 영역과 세션 토큰·비용 줄, i18n ko·en·ja | 실 postgres 통합 테스트: PR 열기가 성과물 행 하나(`open`, `receipt_id` = `open_pull_request` receipt)를 같은 트랜잭션에서 만든다. 같은 세션의 두 번째 PR 열기(같은 URL)는 행을 늘리지 않는다. GitHub에 이미 열린 PR을 답한 경우와, 찾을 때는 없었는데 생성이 422로 사람의 PR을 돌려준 경우(fake GitHub) 모두 `metadata.adopted: true`. 성과물 행을 쓰지 못하면 `pull_requests` 행과 receipt도 남지 않는다(한 트랜잭션). 성과물 없는 `pull_requests` 행(push 요청 있음)을 refresher가 채우고 그 행의 `receipt_id`를 쓴다. push 요청이 없는 옛 행은 건너뛴다. refresher 두 개가 같은 행을 집지 않고, GitHub 호출 동안 DB 잠금을 쥐지 않는다(느린 fake GitHub 응답 중에 다른 refresher가 다른 행을 처리한다). 집기만 하고 답을 못 받은 행의 `state_checked_at`은 그대로다. lease가 만료돼 다시 집힌 행에 늦게 온 앞 결과(`open`)는 새 결과(`merged`)를 덮지 않는다. 같은 `quota_key`를 refresher 두 개가 동시에 집어도 한 창의 `used`가 예산을 넘지 않는다(남은 몫 50에 두 refresher가 동시에 집으면 합이 50). 최근 PR 몇 개를 한 시간 동안 5분마다 다시 읽으면 요청마다 `used`가 늘어 예산에서 멈춘다. 같은 사용자의 서로 다른 PAT 두 개가 같은 `quota_key`를 쓰고, 저장소의 PAT를 다른 사용자의 것으로 바꾸면 다음 pass부터 새 키로 센다(fake `GET /user`). 조회가 500을 받아도 같은 pass에서 다시 보내지 않는다(fake GitHub 요청 수). `GET /user`가 실패한 PAT는 1시간 동안 다시 부르지 않고 그 저장소의 행도 집지 않는다. `x-ratelimit-remaining`이 limit의 20% 아래이거나 429면 그 단위가 reset까지 멈추고 다른 replica도 집지 않는다. 간격 표대로 읽을 행을 고른다(`merged`는 읽지 않음, 닫힌 지 30일 지난 `closed`는 읽지 않음). fake GitHub로 `open → merged`, `open → closed → open`, 404 → `check_error: not_found`이고 state는 그대로. 에이전트 스위치를 끄고 범위를 좁혀도 `outcome_refresh`는 발급된다. `GET /v1/usage/outcomes`: PR 둘인 세션의 비용이 한 번만 더해진다, 성과물 없는 세션의 비용이 `cost_usd`에 들어간다, scope별 읽기 권한이 summary와 같다(member의 `installation` 403, API key의 `agent` 403), 합계 행의 `session_count`·`cost_usd`가 같은 기간의 summary와 같다. web 테스트(PR 영역의 세 state 배지, `check_error` 줄, 탭 수 = PR + 파일, 둘 다 없을 때 빈 안내), 1440·390 전후 캡처, ui-review | 플랫폼으로 PR을 연다 → `GET …/outcomes`에 `open` 행. GitHub에서 그 PR(만든 지 1일 안, 예산·멈춤에 걸리지 않은 설치)을 머지 → 7분 안에(간격 5분 + 1분 tick + 조회 시간) `merged`와 `merged_at`, 세션 상세 배지가 "머지됨". 다른 세션의 PR을 GitHub에서 닫음 → `closed`. 다시 열기 → 1일 간격 안에서 `open`(실측은 `state_checked_at`을 앞당겨 다음 pass를 기다린다). `GET /v1/usage/outcomes?scope=agent`가 그 에이전트의 `pr_count` 2, `merged_pr_count` 1과 두 세션의 비용 합을 보인다. 에이전트 GitHub 스위치를 끈 뒤에도 남은 열린 PR의 머지가 반영된다 |
| GA-5 리뷰용 App·리뷰 승인 | `github-apps/{role}` 경로와 화면의 리뷰용 App 영역, 리뷰용 forge, 작업 서비스의 리뷰와 세션 API, `review_pull_request` receipt, `no_reviewer_app` | route 테스트: `same_app`, `no_author_app`, 리뷰용 App 없을 때 `options.review.available: false`. 리뷰가 `commit_id`를 보낸다. 리뷰 토큰이 reviewer forge에서 나온다 | 리뷰용 App 등록(키는 경로만) → 작성용 App이 연 PR을 리뷰 승인 → GitHub에 `app/<리뷰용 App>` 승인. 리뷰 꺼진 릴리스는 `feature_off`. 리뷰용 App을 지운 뒤 `no_reviewer_app`. 필수 리뷰 1 브랜치 보호에서 승인이 조건을 채우는지 기록(결정 1의 위험 실측) |
| GA-6 워크스페이스 상한 화면 | 연결 화면의 App 권한 표·상한(API는 GA-2에 있다). 사용자 연결 영역은 GA-4가 만든다 | web 테스트(owner·admin만 바꾸고 member는 읽기 전용, `revision` 충돌 안내, 낮출 때 확인 대화 상자), 1440·390 캡처, ui-review | 화면에서 상한의 Actions를 끄면 GA-3에서 켠 에이전트의 dispatch가 거절되고, 다시 켜면 성공 |
| GA-7 내장 MCP `github` | 세션에 붙는 내장 MCP 서버, 도구 일곱 개, egress 허가 경로, 릴리스 기능에 따른 도구 노출. 첫 커밋 전에 이 문서 [3절](#github-작업-서비스와-두-입구)에 upstream·허가·도구 정책 절을 더한다 | 도구가 다른 세션 id를 받지 않는다(attempt 토큰으로 정함). 꺼진 기능의 도구는 목록에 없다. 입구 1과 같은 receipt. worker 환경에 GitHub 토큰이 없다(env·파일 검사) | Slack에서 시작한 세션의 에이전트가 도구로 push 요청 → 사람 승인 → 에이전트가 도구로 PR 열기. push 승인 꺼진 릴리스는 승인 없이 PR. 허용 목록 안 dispatch |

순서: GA-1 → GA-2 → (GA-3, GA-4, GA-6 병렬 가능) → GA-4b(GA-4 바로 뒤, 세션 상세의 PR 정보 영역을 같이 쓴다) → GA-5(GA-3 뒤, 탭의 리뷰 항목) → GA-7. GA-4b는 GA-2의 게이트에 purpose를 더하므로 GA-2 뒤여야 하고, GA-5·GA-7과는 겹치지 않는다. GA-3은 GA-2가 모든 replica에 올라간 뒤에 연다([5절](#5-기존-설치-이전)). 각 PR의 첫 커밋 전에 이 문서의 해당 절을 다시 읽고, 계약과 다르게 가야 하면 이 문서를 먼저 고친다.

### 오너만 할 수 있는 단계

1. **작성용 App 권한 추가**: GitHub > Settings > Developer settings > GitHub Apps > `werft-sandbox-agent` > Permissions & events. Repository permissions의 Actions·Checks·Issues·Workflows를 Read and write로 바꾸고 저장한다. 그 뒤 Install App > JeongJaeSoon > 바뀐 권한을 승인한다. GA-2 실측 전에 한다. Administration은 주지 않는다.
2. **리뷰용 App 만들기**: 같은 화면 > New GitHub App. 이름 예 `werft-sandbox-reviewer`, Webhook 끔, Repository permissions는 Contents Read-only, Pull requests Read and write, Metadata Read-only다. "Only on this account"로 만든다. Install App으로 `werft-sandbox` 하나에 설치하고 Generate a private key로 .pem을 받는다. 키 파일 경로만 카드에 알린다. GA-5 실측 전에 한다.
3. **사용자 연결용 OAuth 설정**: `werft-sandbox-agent` App 설정 > General. Callback URL에 verify 스택의 `<콘솔 주소>/settings/linked-accounts/github`를 더하고, "Expire user authorization tokens"는 그대로 둔다. Client secrets > Generate a new client secret으로 값을 만들어 콘솔의 사용자 계정 연결 칸에 직접 넣는다. GA-4 실측 전에 한다.
4. **werft-sandbox 준비**: `main`에 `.github/workflows/sandbox-dispatch.yml`과 `.github/workflows/sandbox-other.yml`을 둔다. 둘 다 `on: workflow_dispatch`이고 `echo` 한 줄짜리다. 하나는 허용 목록 안, 하나는 밖을 시험하는 데 쓴다. 브랜치 보호 `main`에 "Require a pull request before merging, Required approvals 1"을 켠다(GA-5의 위험 실측). GA-2 실측 전에 한다.

## 10. 세션 성과물

- 오너 원문(2026-10-30): "roi 측정관점에서 세션별 성과(결과물? 이라고 되어잇는거 같네)를 기록을 명확히 하도록 하고싶어 그 type 으로써 github 혹은 github_pullrequest? 같은거로 해서 링크가되엇든 이 세션에서는 이렇게 동작, 토큰을 사용해서 성과물로써 github 의 pr 이라는 카테고리를 놓아서 roi 를 파악할수 잇는 재로를 쓰도록 하는거지 다른 결과물 타입이 어떤게 잇을지는 아직 잘모르겟네".
- 목적: 세션 하나가 만든 것(성과물)을 type과 함께 DB에 남기고, 그 세션의 토큰·비용과 이어 "이 세션은 토큰 N, 비용 $X를 써서 PR 하나를 만들었고 그 PR이 머지됐다"를 셀 수 있게 한다. 이번에 채우는 type은 GitHub PR(`github_pull_request`) 하나다.
- 이 절의 `파일:줄`은 `origin/main` `3f4dd99d` 기준이다.

### 지금 있는 것

- **"결과물" 탭은 파일이다.** 세션 상세의 탭 하나가 "결과물"이다(`apps/web/src/routes/sessions.tsx:425-431`, 문구 `apps/web/src/i18n/outputs.ts:2`). 내용은 작업 공간 `out/` 폴더의 파일뿐이다(`outputs.ts:7`). API는 `GET /v1/sessions/{id}/outputs`(`apps/control-host/src/api/openapi.ts:1734-1739`)이고, 목록은 마지막으로 커밋된 checkpoint의 manifest에서 읽는다(`packages/platform/src/sessions/output-service.ts:42-44`, `packages/platform/src/checkpoints/checkpoint-service.ts:1278-1282`). `checkpoint_outputs`(`packages/db/src/schema.ts:1915-1934`)는 그 파일 객체의 크기 기록이다. type도 외부 링크도 없다. 일본어 문구는 이미 "成果物"다(`outputs.ts:11`).
- **PR은 행으로 남지만 읽는 곳이 없다.** `pull_requests`는 세션·URL을 키로 저장소 id, 번호, head, base, `open_pull_request` receipt를 가진다(`schema.ts:1213-1233`). PR을 열 때(`packages/platform/src/sessions/pull-request-service.ts:141-226`) 같은 트랜잭션에서 receipt와 함께 쓴다(`packages/db/src/pull-requests.ts:160-221`). 열린 PR을 GitHub에서 찾아 답한 경우도 행을 남긴다(`pull-request-service.ts:192-196`, `212-221`). push 요청을 잇기 전의 옛 행은 번호·push 요청이 비어 있고 공개 모양으로 읽지 못한다(`pull-requests.ts:18-30`).
- **PR의 상태는 모른다.** 행에 상태 칸이 없다. forge 포트의 PR은 `open`·`closed`만 알고 머지 여부가 없다(`packages/platform/src/ports/forge.ts:29-35`). 읽는 메서드는 열린 PR을 브랜치로 찾는 것 하나다(`forge.ts:50-54`, GitHub 구현 `apps/control-host/src/api/forge-github.ts:248-251`의 `state: "open"`). API에도 PR을 여는 `POST`와 코멘트뿐이고(`openapi.ts:2151`, `2189`) 세션의 PR 목록을 읽는 경로가 없다. 웹에도 PR을 보이는 화면이 없다.
- **세션의 토큰·비용은 세션 행에 있다.** `sessions.cost_usd`(추정 비용, `schema.ts:1013-1019`)와 `sessions.provider_tokens`(모든 토큰, `schema.ts:1021-1027`)다. 둘 다 egress proxy가 잰 호출마다 `provider_usage`(`schema.ts:2013`)에 쌓으면서 더한다. 모델별 합은 `session_model_usage`(`schema.ts:2083-2121`)이고, 그 trigger가 세션의 에이전트를 릴리스에서 복사한다(`packages/db/migrations/0169_usage_breakdown_rollup.sql:35-38`). 세션의 에이전트는 `sessions.agent_release_id`(`schema.ts:1009-1011`) → `agent_releases.agent_id`(`schema.ts:2851`)다. 세션 하나는 `GET /v1/sessions/{id}/usage`(`openapi.ts:1697-1700`), 기간 합은 `GET /v1/usage/summary`·`…/breakdown`(`openapi.ts:3886-3891`, `3971-3976`)이 읽는다. 에이전트별 묶음 query는 `packages/db/src/usage-reader.ts:136-146`이다.
- **GitHub 웹훅을 받는 곳이 없다.** control-host에 GitHub 이벤트를 받는 경로나 서명 검사가 없다. 오너가 만든 App도 Webhook을 끈 채다([오너 단계](#오너만-할-수-있는-단계) 2와 같은 설정).
- **주기 작업의 선례.** push 실행기는 API replica마다 하나씩 돌고 `FOR UPDATE SKIP LOCKED`로 서로의 행을 피한다(`packages/platform/src/sessions/push-executor.ts:197-218`, `packages/db/src/push-requests.ts:404-416`, 연결 `apps/control-host/src/api/server.ts:706`, `963`).

### 이름

화면의 "결과물"은 지금처럼 `out/` 파일이다. 새 개념은 **성과물**(영어 `outcome`, 일본어 "成果")이라 부른다. 데이터는 따로 두고, 화면은 같은 "결과물" 탭 안에 영역을 하나 더한다([아래](#세션-상세의-성과물)). 오너가 말한 "결과물"과 같은 자리에서 보이게 하려는 것이다.

### 데이터 모델: `session_outcomes` (새)

| 열 | 타입 | 규칙 |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | text NOT NULL | 세션의 owner |
| `session_id` | uuid NOT NULL FK sessions | 성과물을 만든 세션 |
| `agent_release_id` | text | 그 세션의 `agent_release_id`. 릴리스 없는 세션은 null |
| `agent_id` | uuid | 그 릴리스의 `agent_id`. 쓸 때 복사한다(`session_model_usage`와 같은 이유: 세션의 릴리스는 바뀌지 않고, 집계가 릴리스 표를 매번 잇지 않게 한다) |
| `type` | text NOT NULL | `CHECK (type IN ('github_pull_request'))`. 값은 contracts의 `SESSION_OUTCOME_TYPE_VALUES` 하나에 모은다 |
| `url` | text NOT NULL | 외부 링크. PR이면 `html_url` |
| `repository_id` | text | 카탈로그 저장소 id. 저장소와 상관없는 type은 null |
| `external_id` | text | 그 type 안의 식별자. PR이면 번호(문자열) |
| `state` | text NOT NULL | type별 값. PR은 `open`·`merged`·`closed`. `CHECK (type <> 'github_pull_request' OR state IN ('open', 'merged', 'closed'))` |
| `state_changed_at` | timestamptz NOT NULL | 마지막으로 state가 바뀐 때. 처음에는 `created_at` |
| `merged_at`, `closed_at` | timestamptz | GitHub가 준 값 그대로 |
| `state_checked_at` | timestamptz | 마지막으로 GitHub에 물어 답(성공이든 `check_error`든)을 받은 때. 아직 안 받았으면 null. 집을 때는 고치지 않는다 |
| `lease_token`, `lease_expires_at` | uuid, timestamptz | refresher가 이 행을 집었다는 표시. 결과를 쓸 때 지운다 |
| `check_error` | text | 마지막 조회가 실패한 `reason_code`(`not_found`·`forge_failed`·`github_refused`). 성공하면 null |
| `metadata` | jsonb NOT NULL DEFAULT `'{}'` | type별 모양. PR은 `{ head, base, adopted, merge_commit_sha, additions, deletions, changed_files, commits }`. 제목·본문·리뷰 내용은 넣지 않는다 |
| `receipt_id` | uuid FK receipts | 만든 작업의 receipt. PR은 `open_pull_request` receipt |
| `created_at` | timestamptz NOT NULL | |

- 제약: `UNIQUE (session_id, type, url)`. 상태 조회용 부분 인덱스 `(state_checked_at) WHERE type = 'github_pull_request' AND state <> 'merged'`.
- **type은 등록된 목록이다.** 열린 문자열로 두지 않는다. 집계가 type마다 state의 뜻(무엇이 "성공"인가)을 알아야 하기 때문이다. type을 더할 때는 마이그레이션 하나가 CHECK를 넓히고 contracts 값과 state 규칙을 더한다. `linked_accounts`의 provider CHECK(`schema.ts:766-769`)와 같은 방식이다.
- **`pull_requests`는 그대로 둔다.** 그 표는 push 요청과 PR을 잇는 기록이고 키가 `(session_id, url)`이다. 성과물 행은 같은 `(session_id, url)`과 같은 `receipt_id`를 가진다. 외래 키는 걸지 않는다. 성과물 표는 type이 여럿이 될 표라서다.
- **만드는 것은 서버뿐이다.** 성과물을 쓰는 API는 두지 않는다. 사람이나 에이전트가 성과물을 직접 적게 하면 ROI 재료가 자기 보고가 된다.
- 새 표이므로 앞 이미지와 섞여도 안전하다. 앞 이미지는 이 표를 읽지도 쓰지도 않는다([5절](#5-기존-설치-이전)의 규칙).

### PR을 열 때 자동으로 남긴다

- **경로.** `pull_requests` 행을 쓰는 `savePullRequest`(`pull-requests.ts:160-221`)의 같은 트랜잭션에서 성과물 행을 `ON CONFLICT (session_id, type, url) DO NOTHING`으로 넣는다. 넣는 것은 그 트랜잭션이 `pull_requests` 행을 처음 쓸 때(새 행이나 옛 행 채우기, `pull-requests.ts:205-218`)뿐이다. state `open`, `metadata`의 head·base·`adopted`, `receipt_id`는 그 행에 쓰는 `open_pull_request` receipt다. 이미 기록된 PR을 다시 답하는 호출은 새 receipt를 만들지만(`pull-requests.ts:176-192`, 서비스에서는 `pull-request-service.ts:161-180`이 먼저 답한다) 성과물은 건드리지 않는다. GA-2 뒤에 PR 열기는 GitHub 게이트를 지나는 PR 서비스(`pull-request-service.ts`) 하나이고, 세션 API와 내장 MCP의 `open_pull_request`(GA-7)가 모두 그 함수를 부른다([3절](#github-작업-서비스와-두-입구)). 그래서 입구가 늘어도 기록 지점은 하나다.
- **같은 PR을 다시 답할 때.** 세션의 push 요청은 브랜치 `agent/<session-id>` 하나를 같이 쓴다. 두 번째 push 요청의 PR 열기는 같은 URL을 돌려주므로 성과물은 하나로 남는다. 앞 PR이 닫힌 뒤 다시 열면 GitHub가 새 PR을 만들고(`pull-request-service.ts:192-205`) URL이 다르므로 성과물이 하나 더 생긴다.
- **기존 행과 섞인 기간.** 이 기능 전에 연 PR, 그리고 배포가 섞인 동안 앞 이미지가 연 PR은 성과물 행이 없다. 아래 상태 조회가 돌 때마다 `pull_requests`에서 `push_request_id`가 있는데 성과물이 없는 행을 찾아 같은 모양으로 만든다(state `open`, `receipt_id`는 그 `pull_requests` 행의 receipt, `metadata.adopted`는 알 수 없으므로 null, `state_checked_at` null이라 바로 읽힌다). 마이그레이션에서 한 번 채우는 방식은 섞인 기간의 행을 놓치므로 쓰지 않는다. push 요청이 없는 옛 행(번호 없음)은 만들지 않는다.
- **무엇이 성과물인가: 플랫폼의 PR 열기가 기록한 PR.** 성과물은 `pull_requests`에 남은 PR이다. 플랫폼이 만든 PR과, PR 열기가 GitHub에서 찾아 답한 열린 PR(`pull-request-service.ts:192-196`)이 둘 다 들어간다. 뒤의 것은 사람이 `agent/<session-id>` 브랜치로 먼저 연 PR일 수 있다. 그 브랜치의 commit은 이 세션이 만든 것이므로 성과물로 센다. 다만 구분할 수 있게 `metadata.adopted`에 둔다. 이 값은 `savePullRequest`의 `created`로 정하지 않는다. 서비스는 열린 PR을 찾지 못하면 `created: true`로 두는데(`pull-request-service.ts:192-196`), 그 사이 사람이 PR을 열었으면 forge의 생성 요청이 422를 받고 그 사람의 PR을 돌려주기 때문이다(`forge-github.ts:300-305`). 그래서 GA-4b는 `createPullRequest`가 실제로 만들었는지(`created`)를 forge 결과에 싣고, `adopted`는 "찾은 열린 PR을 답했거나 forge가 만들지 않았다"이다. 상태 조회가 채우는 행([위](#pr을-열-때-자동으로-남긴다))은 알 수 없으므로 null이다. PR 열기를 한 번도 부르지 않은 PR은 성과물이 아니다([LATER](#later)).

### PR 상태 갱신: 조회로 한다

**추천과 기본값: 주기 조회(polling).** 웹훅은 이번에 쓰지 않는다.

- **웹훅을 쓰려면 필요한 것.** 오너가 App 설정에서 Webhook을 켜고 URL과 webhook secret을 넣어야 한다(밖에 보이는 설정 변경, 오너만 할 수 있다). control-host에 GitHub가 닿는 공개 경로, 서명(`X-Hub-Signature-256`) 검사, secret 보관, 놓친 이벤트를 다시 맞추는 조회가 새로 필요하다. verify 스택은 로컬이라 GitHub가 닿지 않으므로 werft-sandbox 실측에 터널도 필요하다. 웹훅을 켜도 놓친 이벤트 때문에 조회는 남는다. 그래서 조회만으로 시작하고, 웹훅은 조회의 비용이나 지연이 문제가 될 때 더한다([LATER](#later)).
- **Webhook을 끈 지금의 뜻.** GitHub는 플랫폼에 아무것도 알려 주지 않는다. 머지·닫힘은 플랫폼이 다음에 물어볼 때까지 보이지 않는다. 그래서 성과물 state는 늘 "`state_checked_at` 시점의 값"이고, API와 화면은 그 시각을 같이 보인다.
- **도는 곳.** API replica마다 하나씩 도는 `outcome-refresher`. push 실행기와 같은 모양(`push-executor.ts:197-218`)이고 1분마다 돈다. 집는 방식도 push 실행기의 claim(`push-requests.ts:404-416`)처럼 DB 잠금을 GitHub 호출 동안 쥐지 않는다. 한 문장의 `UPDATE … SET lease_token = <새 uuid>, lease_expires_at = now() + interval '2 minutes' WHERE id IN (SELECT … WHERE <읽을 때가 됨> AND (lease_expires_at IS NULL OR lease_expires_at < now()) ORDER BY state_checked_at NULLS FIRST LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING …`로 행을 집는다. `state_checked_at`은 집을 때 고치지 않으므로 화면의 "상태 확인" 시각은 실제로 답을 받은 때다. GitHub 호출은 트랜잭션 밖에서 하고, 결과는 `WHERE id = $1 AND lease_token = $2`로 행마다 따로 쓰며 같은 문장에서 lease를 지운다. lease가 만료돼 다른 refresher가 다시 집은 행에 늦게 온 앞 결과는 0행으로 끝나고 버린다. push 실행기가 `push_attempts`로 늦은 결과를 막는 것(`push-requests.ts:434-443`)과 같다. replica가 죽으면 그 행은 lease 만료(2분) 뒤 다시 집힌다.
- **누구를 언제 읽나.** `state_checked_at`이 null이거나 아래 간격보다 오래된 행만 읽는다.

| state | 다시 읽는 간격 | 그만 읽는 때 |
|---|---|---|
| `open` | 만든 지 1일 안이면 5분, 30일 안이면 1시간, 그 뒤는 1일 | 없음(열려 있는 동안) |
| `closed` | 1일(다시 열릴 수 있다) | `closed_at` 뒤 30일 |
| `merged` | 읽지 않는다 | 머지는 끝 상태다 |

- **무엇을 부르나.** `GET /repos/{o}/{r}/pulls/{number}` 하나다. `merged_at`이 있으면 `merged`, `state: closed`이면 `closed`, 아니면 `open`이다. forge 포트에 `getPullRequest(repo, number)`를 더하고 `ForgePullRequest`에 `merged_at`·`closed_at`과 metadata 칸을 더한다. 값이 바뀌었을 때만 state와 `state_changed_at`을 고친다.
- **토큰.** 게이트에 purpose `outcome_refresh`를 더한다. 권한은 `pull_requests: read` 하나, 연결은 author다([작업별 권한](#작업별-권한)). 이것은 에이전트의 작업이 아니라 플랫폼이 이미 연 PR의 상태를 읽는 것이다. 그래서 게이트 1단계(세션·릴리스 읽기)와 저장소 binding 검사, 6~8단계만 하고, 에이전트 스위치(2단계), 릴리스의 저장소 범위(3단계의 범위 검사), 기능·상한(4단계), 허용 목록(5단계)은 보지 않는다. 에이전트의 GitHub를 끄거나 범위를 좁혀도 그 에이전트가 앞서 연 PR의 머지는 ROI 기록에 남아야 하기 때문이다. App 토큰은 control-host 밖으로 나가지 않고 읽기 권한뿐이며 플랫폼이 고른 PR 하나만 읽으므로, [결정 7](#결정-7-릴리스와의-관계)의 "끄면 에이전트의 작업은 멈춘다"는 그대로다. GHES 카탈로그 App 저장소도 읽는다([3절](#github-게이트)). PAT 저장소는 PAT로 읽는다. PAT는 좁힐 수 없으므로 자격 증명은 그대로이고, 읽기로 제한되는 것은 플랫폼이 부르는 호출(`GET …/pulls/{n}`)뿐이다. receipt의 actor는 `principal: { kind: "service", id: "outcome-refresher" }`다. `mint_github_token`은 새로 발급했을 때만 남는다. 캐시(`forge-github.ts:152-177`)는 replica의 메모리에 연결·저장소·권한 조합별로 있고 토큰은 만료 10분 전에 다시 받으므로(`forge-github.ts:28`), receipt는 replica·저장소마다 대략 50분에 하나다.
- **실패.** 404(PR·저장소가 사라졌거나 App 설치가 빠짐)는 `not_found`, 그 밖의 GitHub 오류는 `forge_failed`, 게이트 거절은 `github_refused`로 `check_error`에 두고 state는 그대로 둔다. `state_checked_at`은 고쳐서 같은 간격으로 다시 읽는다. 오류 원문은 [결정 0](#결정-0-github가-강제하는-것은-다시-책임지지-않는다)대로 남기지 않는다.
- **요청량.** 위 간격이면 PR 하나가 시간당 쓰는 요청은 만든 지 1일 안이 12회, 1~30일이 1회, 30일 넘은 `open`과 `closed`가 1/24회다. 그래서 간격대로 다 읽으면 시간당 요청은 대략 12 × (최근 1일에 연 열린 PR) + (1~30일 된 열린 PR) + (나머지 읽을 행) / 24다. 하루 300개를 열고 대부분 하루 안에 머지하면 시간당 3600회 남짓이다. 하루 300개가 30일씩 열려 있으면 12 × 300 + 29 × 300 = 12300회로, 간격대로는 읽을 수 없다. 그래서 아래 예산이 간격보다 앞선다.
- **예산과 멈춤.** GitHub REST 한도는 한도의 주인마다 따로다. App 설치 토큰은 설치마다(설치 규모에 따라 시간당 5000부터 늘어난다), PAT는 그 PAT의 사용자 전체가 같이 쓴다. GraphQL 한도와는 따로다. refresher는 한도 단위를 `quota_key`로 묶고, 그 단위에서 자기가 쓰는 양만 제한한다.
  - `quota_key`는 성과물 행에 두지 않는다. 자격 증명은 바뀔 수 있기 때문이다(콘솔 App 교체, 카탈로그의 PAT 교체). refresher는 pass마다, 읽을 때가 된 행의 `repository_id`별로 **이번 요청에 실제로 쓸 자격 증명**에서 키를 정한다. App이면 `app:<api_base>:<installation_id>`, PAT면 `pat:<api_base>:<그 PAT로 부른 GET /user의 숫자 id>`다. `GET /user` 결과는 그 자격 증명 값의 해시를 키로 메모리에 두므로 PAT를 바꾸면 다시 부른다. 이 요청은 키를 알기 전에 보내므로 **예산 밖**이다. 대신 replica마다 자격 증명 하나에 1시간에 한 번까지만 보낸다(성공은 PAT가 바뀔 때까지 두고, 실패하면 1시간 동안 그 PAT 저장소의 행을 집지 않는다). 그래서 예산 밖 요청은 replica 수 × PAT 수 / 시간을 넘지 않는다. 같은 설치나 같은 사용자의 PAT를 쓰는 저장소·연결·replica는 같은 키를 쓴다.
  - 예산과 멈춤은 replica가 같이 보는 표 `outcome_refresh_quotas`에 단위마다 한 행으로 둔다: `quota_key` PK, `rate_limit`(마지막으로 본 `x-ratelimit-limit`, 처음 보기 전에는 null), `window_start`, `used`, `paused_until`.
  - 시간당 예산은 `rate_limit`의 20%(null이면 1000)다. 행 하나를 집는 것이 요청 하나다. 그래서 refresher의 조회는 지금 forge client의 자동 재시도·throttle 대기(`forge-github.ts:104-118`)를 끄고 한 번만 보낸다. 실패는 아래 "실패"대로 다음 간격에 다시 읽는다. 집기는 단위별로 한 트랜잭션에서 한다. 그 단위의 `outcome_refresh_quotas` 행을 `FOR UPDATE`로 잠그고(없으면 만든다), `window_start`가 1시간보다 오래됐으면 `window_start = now()`, `used = 0`으로 되돌린다. `paused_until`이 지나지 않았으면 집지 않는다. 남은 몫(예산 − `used`)과 50 가운데 작은 수만큼, 이 pass에서 그 키로 정해진 저장소들의 성과물 행을 집고, 집은 수를 `used`에 더한 뒤 커밋한다. 단위의 행 잠금이 확인과 차감을 직렬로 만들므로 replica가 여럿이어도 한 창에서 예산을 넘겨 집지 않는다. 같은 행을 5분마다 다시 읽어도 읽을 때마다 `used`가 는다. 예산을 넘는 행은 `state_checked_at` 오래된 순으로 밀려 늦게 읽힌다. 창은 고정 1시간이라 창 경계 앞뒤를 합치면 1시간 안에 예산의 두 배까지 쓸 수 있다.
  - 응답의 `x-ratelimit-remaining`이 limit의 20% 아래이거나 rate limit 응답(403·429)을 받으면, 그 단위의 `paused_until`을 `x-ratelimit-reset`(또는 `retry-after`)으로 둔다. 이미 집어 나간 요청은 막지 못한다. 그 수는 replica마다 한 pass의 최대 50이므로 단위 전체로는 replica 수 × 50까지다(이것도 이미 `used`에 들어 있어 예산은 넘지 않는다).
  - 보장 범위: PAT 사용자를 확인하는 `GET /user`(위의 상한)를 빼면, refresher가 한 단위에서 시간당 쓰는 요청은 예산을 넘지 않고, 그 단위가 바닥나 가면 멈춘다. 다른 작업(에이전트의 clone·push·PR, PAT 사용자의 다른 호출)의 몫을 따로 떼어 두지는 않는다. 그 작업들이 한도를 다 쓰면 refresher도 멈춘다.
  - 밀리거나 멈춘 행은 state와 `check_error`를 바꾸지 않고 늦게 읽힐 뿐이다. 화면은 `state_checked_at`으로 그 늦음을 보인다.

### ROI 재료: 집계 query

화면(대시보드)은 이번에 만들지 않는다. 같은 기간·범위 규칙으로 읽는 API 하나와 그 query 모양만 정한다.

- **세션 단위로 먼저 접는다.** 세션 하나에 성과물이 여럿일 수 있으므로, 성과물을 세션별로 센 뒤 세션에 잇는다. 그래야 세션 비용이 두 번 더해지지 않는다.

```sql
-- sketch: one row per agent plus the total, over the sessions
-- GET /v1/usage/summary would count for the same scope and period
WITH s AS (
  SELECT s.id, ar.agent_id, s.cost_usd, s.provider_tokens
  FROM sessions s
  LEFT JOIN agent_releases ar ON ar.id = s.agent_release_id
  WHERE <summary period on s.created_at> AND <summary scope predicate>
), o AS (
  SELECT session_id,
         count(*) AS prs,
         count(*) FILTER (WHERE state = 'merged') AS merged,
         count(*) FILTER (WHERE state = 'closed') AS closed
  FROM session_outcomes
  WHERE type = 'github_pull_request' AND session_id IN (SELECT id FROM s)
  GROUP BY session_id
)
SELECT s.agent_id,
       grouping(s.agent_id) = 1 AS total,
       count(*) AS session_count,
       coalesce(sum(s.cost_usd), 0) AS cost_usd,
       coalesce(sum(s.provider_tokens), 0) AS token_count,
       count(*) FILTER (WHERE o.prs > 0) AS sessions_with_pr,
       count(*) FILTER (WHERE o.merged > 0) AS sessions_with_merged_pr,
       coalesce(sum(o.prs), 0) AS pr_count,
       coalesce(sum(o.merged), 0) AS merged_pr_count,
       coalesce(sum(o.closed), 0) AS closed_pr_count,
       coalesce(sum(s.cost_usd) FILTER (WHERE o.merged > 0), 0)
         AS cost_of_merged_sessions_usd
FROM s LEFT JOIN o ON o.session_id = s.id
GROUP BY GROUPING SETS ((s.agent_id), ());
```

- 세션이 하나도 없는 기간도 `()` 묶음이 합계 행 하나를 내고, 합은 모두 0이다(summary가 빈 기간에 0을 주는 것과 같다).

- **API.** `GET /v1/usage/outcomes`. `scope`·`since`·`until`·`agent_id`와 누가 어느 범위를 읽는지는 `GET /v1/usage/summary`와 똑같다(`openapi.ts:3886-3891`). `group_by=agent`면 에이전트별 행을 더한다. 응답은 위 칸에 `cost_per_merged_pr_usd`(`cost_usd / merged_pr_count`, 0이면 null)와 `cost_complete`(summary와 같은 뜻), `refreshed_at`을 더한다. `cost_per_merged_pr_usd`의 분자는 **기간의 모든 세션** 비용이다. 성과물이 없는 세션의 비용도 그 PR들을 얻는 데 든 비용이기 때문이다. 머지된 세션만의 비용은 `cost_of_merged_sessions_usd`로 따로 준다. 아무것도 바꾸지 않는다.
- **읽는 법.** 기간은 세션을 만든 때로 자른다(summary와 같다). 그래서 기간 뒤에 머지된 PR도 그 세션의 기간에 들어가고, 같은 기간을 나중에 다시 읽으면 `merged_pr_count`가 늘 수 있다. state는 각 행의 `state_checked_at` 시점 값이다. `unmetered` 세션은 비용이 0이므로 토큰 수를 같이 본다.

### 세션 상세의 성과물

- "결과물" 탭(`sessions.tsx:425-431`) 위쪽에 "GitHub PR" 영역을 더한다. [7절](#세션-상세)의 "PR 정보 영역"이 이 자리다. 행마다 `<저장소>#<번호>` 링크, state 배지(열림·머지됨·닫힘), 머지·닫힌 시각, "상태 확인 <상대 시각>"(`state_checked_at`), `check_error`가 있으면 그 이유 한 줄을 보인다. 영역 아래에 이 세션의 토큰 수와 추정 비용 한 줄을 `GET /v1/sessions/{id}/usage`의 값으로 보인다. 그 아래가 지금의 `out/` 파일 목록이다.
- 탭의 수는 PR 수와 파일 수의 합이다. 둘 다 없으면 지금의 빈 안내를 쓴다. 빈 안내 문구(`outputs.ts:7`)는 "PR과 out/ 폴더의 파일"을 세는 것으로 고친다.
- API는 `GET /v1/sessions/{id}/outcomes`(`session.read`)다. `{ items: [{ id, type, url, repository_id, external_id, state, state_changed_at, merged_at, closed_at, state_checked_at, check_error, metadata, created_at }] }`, 만든 순서. 아무것도 바꾸지 않는다.
- i18n ko·en·ja를 같이 고친다. 일본어 "成果物"는 지금 파일 탭의 이름이므로 PR 영역 제목은 "GitHub PR"로 둔다.

## 대안

설계는 두 후보를 놓고 골랐다. 이 카드의 모델 호출 제한으로 후보는 카드가 직접 썼다(architect의 단일 시스템 예외).

- **B: 가변 설정 테이블 + 프록시 강제.** `agent_github_settings`를 가변 행으로 두고 변경 이력을 별도 테이블에 쌓는다. worker가 GitHub REST를 egress proxy로 직접 부르고, proxy가 경로·메서드로 허용 목록을 거른 뒤 토큰을 붙인다. 고르지 않은 이유는 셋이다. (1) 결정 7의 "보안 값은 릴리스에 넣어 이력"을 따로 만든 이력 테이블로 다시 구현하게 된다. (2) proxy가 GitHub REST 경로 문법을 알아야 한다. rerun처럼 대상 워크플로를 GitHub에 물어봐야 판정할 수 있는 요청도 있다. (3) worker 쪽에 GitHub API 전체로 가는 통로가 생긴다. 지금의 "토큰은 control-host 밖으로 나가지 않는다"(검토 문서 1절)가 깨진다.
- **A(고름): 릴리스 핀 + control-host 게이트.** 보안 값은 릴리스의 입력으로 받아 `policy_pins`에 고정하고, 즉시 값은 Slack의 `slack_mention_only`처럼 행의 열로 둔다. 모든 발급이 게이트 하나를 지나므로 새 작업을 더할 때 "이 파일만 보고 맞게 고치면 전체가 맞는" 지점이 하나다.
- **상한을 실행 프로필에 두기.** 검토 문서 3절은 권한 등급을 설치 상한 프로필에 두자고 제안했다. 오너는 결정 9에서 워크스페이스 GitHub 연결 설정에 두기로 정했다. 프로필은 모델·도구·권한 모드를 다루고, GitHub 연결은 워크스페이스에 하나뿐이라 그쪽이 사람에게 찾기 쉽다.
- **사용자 연결에 별도 OAuth App.** client를 작성용 App과 떼어 둘 수 있지만, 오너가 App을 하나 더 만들고 관리해야 한다. GitHub App의 사용자 인증으로 `GET /user` 하나면 충분하므로 고르지 않았다. 작성용 App을 교체하면 콜백 URL과 client secret을 다시 넣는다.

## LATER

- **자기 PR 승인 거절 옵션**(리드 결정으로 이번에 넣지 않음). 다시 볼 조건: 결정 1의 위험이 실제 저장소에서 필수 리뷰를 우회한 사례가 나오거나, 오너가 GitHub 쪽 설정만으로 부족하다고 판단할 때. 모양은 리뷰 요청의 PR이 같은 에이전트의 세션에서 열렸으면 `409` `reason_code: own_pull_request`다.
- **dispatch 입력값별 제한**([결정 4](#결정-4-actions-허용-목록)). 허용 목록 항목에 입력 이름별 허용 값이나 패턴을 더하는 것이다. 다시 볼 조건: 입력값으로 ref나 스크립트를 고르는 워크플로를 허용 목록에 넣어야 할 때.
- **push·PR로 시작된 run의 rerun.** 지금은 플랫폼이 dispatch한 run만 rerun한다. 다시 볼 조건: GitHub run 응답이 원래 ref의 전체 이름(`refs/heads/…`)을 주게 되거나, 에이전트가 PR 검사의 재실행을 해야 하는 요청이 나올 때.
- **checks·issues 작업.** 칸과 판정만 만든다([작업별 권한](#작업별-권한)). 다시 볼 조건: 에이전트가 check run이나 issue를 써야 하는 요청이 나올 때.
- **login 변경 뒤 옛 noreply 이메일의 귀속.** 다시 볼 조건: 연결한 사람이 GitHub login을 바꾼 뒤 그 전 commit의 공동 작성자 표시가 사라졌다는 보고가 나올 때.
- **rate limit 사용량 화면.** 브리프의 범위 밖이다. 다시 볼 조건: 에이전트 여럿이 App 하나를 함께 쓸 때.
- **merge 권한.** 범위 밖이다. "플랫폼 머지 요청 기능"으로 따로 검토한다.
- **성과물의 다른 type**([10절](#10-세션-성과물)). 후보는 Slack 답변(세션이 스레드에 남긴 답과 그 반응), 파일·문서(`out/`의 파일이나 외부 문서 링크), GitHub issue(GA의 `issues` 작업이 생기면), 그리고 리뷰(`review_pull_request`), dispatch한 run이다. 다시 볼 조건: 오너가 PR 밖에서 세고 싶은 결과를 정할 때. 더할 때는 type마다 state와 "성공"의 뜻을 먼저 정한다.
- **GitHub 웹훅으로 PR 상태 받기**([10절](#pr-상태-갱신-조회로-한다)). 오너가 App의 Webhook을 켜고 URL·secret을 넣어야 한다. 다시 볼 조건: 열린 PR이 많아 조회가 설치의 REST 한도를 눈에 띄게 쓰거나, 머지 반영이 5분보다 빨라야 한다는 요청이 나올 때.
- **PR 열기를 부르지 않은 PR을 성과물로.** 사람이 `agent/<session-id>` 브랜치로 직접 열고 플랫폼의 PR 열기가 한 번도 답하지 않은 PR이다. 다시 볼 조건: 그런 PR이 실제로 생겨 ROI에서 빠진다는 보고가 나올 때.
- **성과물 대시보드.** API(`GET /v1/usage/outcomes`)만 만든다. 다시 볼 조건: 오너가 사용량 화면에서 ROI를 보고 싶어 할 때.
- **GHES.** 범위 밖이다. 콘솔 App은 github.com만 쓴다(#922). 카탈로그 App의 GHES 저장소는 게이트의 기본 작업(`clone`·`push`·`pull_request`)과 `outcome_refresh`만 받고 나머지는 `github_host_unsupported`다([3절](#3-토큰-발급-경로와-좁히기)).

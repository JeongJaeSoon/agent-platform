<!--
Every ```bash block below runs, in order, in one shell, in CI (the
`quickstart` job, tests/e2e/quickstart.sh) on a fresh clone. Keep it that
way: a block a reader should not run as-is is ```sh or ```text.
-->

# Quickstart — 로컬 스택과 curl로 세션 한 바퀴

저장소를 clone한 머신에서 명령 두 개로 API를 띄우고, curl만으로 세션의 전체 경로를 한 번 돈다: 생성 → 이벤트 관찰 → 권한 요청 응답 → 후속 메시지 → interrupt → pause → resume(복원) → terminate → 복구 결정 → resume.

모델 계정은 필요 없다. 예시 카탈로그(`config/`)는 compose의 `fake-messages` 서비스를 Messages API로 쓴다. 각 워커 안에서는 **진짜 Claude Code**(Agent SDK 0.3.270에 번들된 실행 파일)가 돌고, fake는 프롬프트에 적힌 스크립트대로 답한다(§ [스크립트된 프롬프트](#스크립트된-프롬프트)).

같은 시나리오를 `tests/e2e/alpha-path.e2e.ts`가 CI(`e2e` job)에서 자동으로 돌고, 이 문서의 `bash` 블록도 CI(`quickstart` job)가 새 clone에서 순서대로 실행한다.

## 대상: 신뢰된 내부 인원 한정

private alpha는 **신뢰된 내부 인원만** 쓴다. 워커 안에서 실행되는 코드(에이전트의 tool 실행, prompt injection으로 들어온 명령 포함)는 다음에 접근할 수 있고, 이것은 알려진 제약이다.

- 공유 provider key와 저장소 credential ([94S-252](https://linear.app/94soon/issue/94S-252))
- object store bucket 전체에 미치는 credential ([94S-251](https://linear.app/94soon/issue/94S-251))
- 카탈로그가 바뀐 뒤의 재claim ([94S-253](https://linear.app/94soon/issue/94S-253))

외부 사용자·멀티 테넌트·공유 환경에 열기 전에 위 세 티켓을 닫아야 한다.

## 요구 사항

| 항목 | 버전 | 확인 |
|---|---|---|
| Docker Engine | **28 이상** — 워커 네트워크의 `gateway_mode_ipv4=isolated`가 28에서 생겼고, scheduler는 그보다 낮은 daemon에서 기동을 거부한다([94S-274](https://linear.app/94soon/issue/94S-274)) | `docker version --format '{{.Server.Version}}'` |
| Docker Compose | v2 (`include` 지원, 2.20 이상) | `docker compose version` |
| Bun | 1.3.10 이상. `bun run keys` 한 곳에만 쓴다(`bun install` 불필요) | `bun --version` |
| curl, jq, uuidgen | 아무 버전 | |

Docker Desktop은 Settings → Software updates에서 엔진 버전을 확인한다. 로컬 스택은 루프백에만 포트를 연다: `127.0.0.1`의 3000(API), 5432(Postgres), 4566(LocalStack S3), 4567(LocalStack Secrets Manager), 3001·2222(Gitea). 이미 쓰는 포트가 있으면 기동이 실패한다.

```bash
set -euo pipefail
docker version --format 'Docker Engine {{.Server.Version}}'
docker compose version
```

## 1. 기동 — 명령 두 개

저장소 루트에서:

```text
git clone https://github.com/JeongJaeSoon/agent-platform.git
cd agent-platform
```

```bash
docker compose --profile apps up -d --build
KEY=$(bun run keys create quickstart \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)
```

첫 명령은 api·scheduler·worker 이미지를 이 checkout에서 빌드하고(처음엔 몇 분 걸린다) 다음을 띄운다. `up`은 API가 healthy가 되고 scheduler가 시작된 뒤에 끝난다.

- postgres(+ 한 번 도는 `migrate`), localstack(S3), secrets(API 전용 Secrets Manager), gitea(+ 샘플 저장소 `agent/sample-app`을 만드는 `gitea-init`), fake-messages, egress-proxy
- `api`(`127.0.0.1:3000`)와 `scheduler`(5초마다 한 pass로 세션마다 worker 컨테이너를 띄운다)
- `worker`는 상주하지 않는다. 이미지 빌드와 `claude --version` 확인만 하고 끝난다. 실제 워커는 scheduler가 세션마다 띄운다

Gitea(`http://127.0.0.1:3001`)의 `agent/sample-app`은 누구나 읽을 수 있는 공개 저장소다. 워커도 egress proxy를 거쳐 Gitea에 닿으므로 소유 계정 `agent`의 비밀번호는 알려진 기본값 없이 무작위로 만들어진다. 브라우저로 로그인하거나 push하려면 `docker compose exec -u git gitea gitea admin user change-password -u agent -p <비밀번호>`로 직접 정한다.

두 번째 명령은 API 컨테이너 안에서 key CLI(`apps/api/src/keys.ts`)를 돌려 key를 한 번만 출력한다. `quickstart`는 key의 owner id다. 웹 콘솔 사용자와 세션을 공유하려면 그 사용자의 workspace id를 쓴다. `--scopes`는 필수이며 위 목록이 전부다. 복구 결정(`sessions:recover`)을 빼면 9단계의 recovery 호출이 403이다. Bun이 없으면 `docker compose --profile apps exec -T api bun run apps/api/src/keys.ts create ...`가 같은 일을 한다.

코드를 새로 받은 뒤에는 같은 `up -d --build`를 다시 실행한다. `--build` 없이 올리면 예전에 빌드한 이미지가 그대로 쓰인다.

## 2. curl 준비

```bash
API=http://127.0.0.1:3000
AUTH=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')

# 세션 생성·메시지 본문. message는 스크립트된 프롬프트다(아래 절).
body() { jq -nc --arg m "$1" '{profile_id:"claude-coding-local", repository_id:"sample-app", message:$m}'; }
say() { jq -nc --arg m "$1" '{message:$m}'; }
post() { curl -sS "$API$1" "${AUTH[@]}" -H "Idempotency-Key: $(uuidgen)" -d "$2"; }
get() { curl -sS "$API$1" "${AUTH[@]}"; }
# 응답 JSON에서 jq 식 $2의 값이 $3이 될 때까지 GET $1을 되풀이한다.
wait_for() {
  for _ in $(seq 1 180); do
    [ "$(get "$1" | jq -r "$2")" = "$3" ] && return 0
    sleep 1
  done
  echo "timed out: $1 $2 != $3" >&2; get "$1" >&2; return 1
}
revision() { get "/v1/sessions/$SID" | jq .revision; }

get /v1 | jq .
```

모든 POST는 `Idempotency-Key`가 필수다. 같은 key와 같은 본문으로 다시 보내면 처음 응답이 그대로 오고(재시도 안전), 같은 key에 다른 본문이면 409 `IDEMPOTENCY_CONFLICT`다.

## 3. 세션 한 바퀴

### ① 생성

```bash
created=$(post /v1/sessions "$(body 'GATE-SPEC {"id":"q1","steps":[{"tool":"Bash","input":{"command":"echo alpha > hello.txt","description":"write hello.txt"}}],"final":"wrote hello.txt"}')")
echo "$created" | jq .
SID=$(echo "$created" | jq -r .session_id)
```

```text
{ "session_id": "…", "turn_id": "1", "receipt_id": "…", "receipt_status": "accepted", "status": "queued" }
```

201이다. scheduler가 다음 pass에서 worker를 띄우고, worker가 저장소를 clone한 뒤 turn 1을 시작한다.

### ② 이벤트 관찰

turn 1은 `echo alpha > hello.txt`를 실행하려다 권한을 묻고 멈춘다. worker가 뜨고 저장소를 clone하는 데 몇 초에서 수십 초가 걸리므로, 세션이 그 상태(`needs_input`)가 될 때까지 기다린 뒤 스트림을 처음부터 읽는다.

```bash
wait_for "/v1/sessions/$SID" .status needs_input
# 5초 동안 읽고 끊는다(curl은 시간 초과로 끝나므로 `|| true`).
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/quickstart-events.txt || true
grep -A1 '^event: question' /tmp/quickstart-events.txt
```

SSE 스트림이다(`id`·`event`·`data` 한 묶음씩, 15초마다 keepalive). 처음부터 다시 읽고, 끊긴 곳부터 이어 읽으려면 마지막 `id`를 `Last-Event-ID` 헤더로 보낸다. 사람이 볼 때는 `--max-time` 없이 열어 두고 Ctrl-C로 닫는다. 이벤트 이름은 `system`·`assistant`·`tool_use`·`tool_result`·`question`·`result`·`status`·`error`다. `result` 이벤트의 `data.session_id`는 플랫폼 세션 id가 아니라 **engine(Claude Code) 세션 id**다.

turn이 끝났는지는 이벤트가 아니라 turn 조회(`GET /v1/sessions/{id}/turns/{turn_id}`의 `status`)로 판정한다.

### ③ 대기 중인 요청

예시 profile은 `permission_mode: default`다. Claude Code는 읽기 전용 명령(`cat`, `ls` 등)은 묻지 않고 실행하므로, 권한 흐름은 파일을 바꾸는 명령으로 보여 준다.

```bash
get "/v1/sessions/$SID/pending-requests" | jq .
REQ=$(get "/v1/sessions/$SID/pending-requests" | jq -r '.items[0].request_id')
```

```text
{ "items": [ { "request_id": "req_…", "turn_id": "1", "kind": "permission", "tool": "Bash", "input": { "command": "echo alpha > hello.txt", … }, "expires_at": "…" } ] }
```

요청은 30분(`PENDING_REQUEST_TTL_SEC`) 안에 답하지 않으면 거절로 끝난다.

### ④ 응답

```bash
answer=$(post "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", decision:"allow"}')")
echo "$answer" | jq .
wait_for "/v1/sessions/$SID/turns/1" .status completed
get "/v1/receipts/$(echo "$answer" | jq -r .receipt_id)" | jq '{operation, status}'
```

거절은 `{"decision":"deny","reason":"…"}`(reason 필수)이다. `AskUserQuestion`에서 오는 `kind: "question"` 요청은 `answers: [{question_id, selected_option_ids}]`로 답한다.

### ⑤ 후속 메시지

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q2","steps":[],"final":"second turn"}')" | jq .
wait_for "/v1/sessions/$SID/turns/2" .status completed
```

202와 함께 `turn_id: "2"`가 온다. 같은 worker의 같은 Claude Code 세션에서 이어진다. 세션 하나에 쌓을 수 있는 대기 입력은 `QUEUED_INPUT_LIMIT_PER_SESSION`(기본 20)개이고, 넘으면 429다.

### ⑥ interrupt

turn 3은 모델 응답이 5분 늦게 오도록 스크립트했다. 실행 중인 turn을 지정해서 멈춘다. 여기서는 turn이 `running`이 된 것만 기다린다 — 모델 호출이 실제로 진행 중일 때 멈추는지는 `tests/e2e`가 fake의 호출 기록을 보고 확인한다.

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q3","steps":[],"final":"too late","finalDelayMs":300000}')" | jq .
wait_for "/v1/sessions/$SID" .current_turn_id 3
wait_for "/v1/sessions/$SID" .status running
interrupt=$(post "/v1/sessions/$SID/interrupt" '{"target_turn_id":"3"}')
echo "$interrupt" | jq .
wait_for "/v1/sessions/$SID/turns/3" .status interrupted
get "/v1/receipts/$(echo "$interrupt" | jq -r .receipt_id)" | jq '{status, result}'
```

아직 시작하지 않은 turn은 409 `TURN_NOT_STARTED`, 이미 끝난 turn은 `no_op: true`인 성공 receipt다. 멈춘 turn은 `interrupted`, 세션은 `status: stopped`가 된다. worker는 남아 있어 다음 메시지를 그대로 받는다.

### ⑦ pause

pause·terminate·resume·recovery는 세션의 현재 `revision`을 `expected_revision`으로 보낸다(다르면 409 `REVISION_CONFLICT`).

```bash
wait_for "/v1/sessions/$SID" .status stopped
post "/v1/sessions/$SID/pause" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"quickstart"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state paused
get "/v1/sessions/$SID" | jq '{status, admission_state, checkpoint_revision}'
code=$(curl -sS -o /tmp/quickstart-paused.json -w '%{http_code}' "$API/v1/sessions/$SID/messages" \
  "${AUTH[@]}" -H "Idempotency-Key: $(uuidgen)" -d "$(say 'while paused')")
test "$code $(jq -r .error.code /tmp/quickstart-paused.json)" = "409 SESSION_PAUSED"
```

worker가 진행 중인 일을 마무리하고 checkpoint(workspace git bundle + transcript)를 커밋한 뒤 사라진다. 그동안은 `pausing`이고, 끝나면 `paused`다. paused 동안 메시지는 409 `SESSION_PAUSED`다. 60초 안에 drain되지 않으면 세션 상세의 `attention`에 `PAUSE_BLOCKED`가 뜬다.

### ⑧ resume — 새 worker에서 복원

```bash
post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q4","steps":[{"tool":"Bash","input":{"command":"cat hello.txt","description":"read hello.txt"}}],"final":"restored"}')" | jq .
wait_for "/v1/sessions/$SID/turns/4" .status completed
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/quickstart-events.txt || true
grep '^data:' /tmp/quickstart-events.txt | grep '"turn_id":"4"' | grep -m1 alpha
```

새 worker는 빈 HOME·workspace에서 마지막 checkpoint만으로 저장소와 Claude Code 세션을 복원한다. turn 4의 `cat hello.txt`가 turn 1에서 쓴 `alpha`를 돌려주면 workspace가 복원된 것이다.

### ⑨ terminate → 복구 결정 → resume

turn 5를 느리게 걸어 두고 실행 중에 terminate한다(⑥처럼 `running`까지만 기다린다). 결과를 알 수 없는 turn이 남으므로 세션은 복구 결정을 기다린다.

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q5","steps":[],"final":"never","finalDelayMs":300000}')" | jq .
wait_for "/v1/sessions/$SID" .current_turn_id 5
wait_for "/v1/sessions/$SID" .status running
post "/v1/sessions/$SID/terminate" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"quickstart"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state recovery_required
get "/v1/sessions/$SID/turns/5" | jq '{id, status}'

decision=$(post "/v1/sessions/$SID/recovery-decisions" "$(jq -nc --argjson r "$(revision)" \
  '{decision:"abandon", expected_revision:$r, reason:"slow call had no effect", target_turn_id:"5"}')")
echo "$decision" | jq .
wait_for "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" .status succeeded
get "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" | jq .result

post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q6","steps":[{"tool":"Bash","input":{"command":"cat hello.txt","description":"read hello.txt"}}],"final":"still here"}')" | jq .
wait_for "/v1/sessions/$SID/turns/6" .status completed
```

- terminate는 대기 중인 입력을 취소하고 열린 권한 요청을 닫는다. 실행 중이던 turn은 `outcome_unknown`이 되고 세션은 `status: failed`, `admission_state: recovery_required`다. 도구가 이미 바깥에 한 일은 되돌리지 않는다(`external_effects_reverted: false`).
- 복구 결정은 `abandon`(turn을 `cancelled`로), `confirm_completed`(checkpoint가 그 turn까지 덮을 때, `evidence_ref` 필수), `close`(세션을 끝냄, 되돌릴 수 없음) 중 하나다. receipt `result.resumable`이 `true`면 resume할 수 있다.
- idle 상태에서 terminate하면 복구 결정 없이 바로 `stopped`이고, 그대로 resume할 수 있다.

## 4. 정리

```bash
docker compose --profile apps down
```

세션·checkpoint·Gitea 데이터는 volume에 남는다. 전부 지우려면 `down -v`를 쓴다. scheduler가 만든 worker 컨테이너·네트워크·workspace volume은 compose 소유가 아니므로 label로 지운다.

```sh
docker compose --profile apps down -v
docker ps -aq --filter label=agent-platform.installation=local | xargs -r docker rm -f
docker network ls -q --filter label=agent-platform.installation=local | xargs -r docker network rm
docker volume ls -q --filter label=agent-platform.installation=local | xargs -r docker volume rm
```

## 스크립트된 프롬프트

fake Messages API(`packages/testkit/src/scripted-messages.ts`)는 user 메시지 안의 `GATE-SPEC {…}`를 대본으로 읽는다.

```text
GATE-SPEC {"id":"<이름>","steps":[{"tool":"<도구>","input":{…},"delayMs":<선택>}],"final":"<마지막 답>","finalDelayMs":<선택>}
```

- `steps`의 도구 호출을 하나씩 순서대로 보내고, 도구 결과를 다 받으면 `final` 텍스트로 turn을 끝낸다. 몇 번째 단계인지는 대본 뒤에 쌓인 도구 결과 수로 정하므로 서버는 상태를 갖지 않는다.
- `delayMs`·`finalDelayMs`는 그 응답을 늦춘다. 긴 turn(interrupt·terminate 시연)을 만들 때 쓴다.
- 대본이 없는 메시지에는 `Hello from the local fake Messages API.`로 답한다.
- 도구는 profile의 `tools`(예시: Read, Edit, Write, Glob, Grep, Bash) 안에 있어야 한다. 밖의 도구는 권한 요청 없이 거절된다.

실제 모델로 바꾸려면 `config/profiles.yaml`의 profile에서 `provider.endpoint`를 지우고(기본 `https://api.anthropic.com`) `auth`를 실제 key를 가리키게 바꾼 뒤, egress proxy의 `EGRESS_ALLOWLIST`(기본 `api.anthropic.com:443`)를 확인한다. 유료 호출이므로 이 문서의 절차에는 넣지 않는다.

## 로그

```sh
docker compose logs -f api scheduler
```

worker 컨테이너는 끝나면 scheduler가 바로 지우므로 `docker logs`로 나중에 볼 수 없다. 남기려면 스택을 띄운 동안 시작되는 worker마다 로그를 따라가는 루프를 하나 걸어 둔다(`tests/e2e/run.sh`가 같은 방법을 쓴다).

```sh
mkdir -p worker-logs
docker events --filter label=agent-platform.installation=local --filter type=container \
  --filter event=start --format '{{.Actor.ID}} {{index .Actor.Attributes "name"}}' |
  while read -r id name; do docker logs -f --timestamps "$id" >"worker-logs/$name.log" 2>&1 & done
```

## 막혔을 때

| 증상 | 원인과 조치 |
|---|---|
| `up`이 scheduler에서 멈추거나 scheduler가 재시작을 반복하고 로그에 `GatewayModeUnsupportedError` | Docker Engine이 28 미만이다. 엔진을 올린다 |
| `bind: address already in use` | 위 포트 중 하나를 다른 프로세스·다른 스택이 쓰고 있다 |
| 세션이 `queued`에서 움직이지 않는다 | `docker compose logs scheduler`와 worker 로그(위 루프)를 본다. `EXECUTION_SLOT_LIMIT`(기본 10)만큼 세션이 이미 실행 중일 수도 있다 |
| POST가 401 | `Authorization: Bearer <key>`가 빠졌거나 key가 다른 스택의 DB에서 발급됐다 |
| POST가 403 | key에 그 scope가 없다(`--scopes`) |
| pause가 오래 `pausing`이고 `attention.code`가 `PAUSE_BLOCKED` | worker가 60초 안에 drain하지 못했다. 진행 중인 turn을 interrupt하거나 기다린다 |

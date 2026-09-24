<!--
Every ```bash block below runs, in order, in one `bash -euo pipefail`, in CI
(the `quickstart` job, tests/e2e/quickstart.sh) on a fresh clone, so each
`jq -e` line is an assertion there. Keep it that way: a block a reader should
not run as-is is ```sh or ```text.
-->

# Quickstart — 로컬 스택과 curl로 세션 한 바퀴

저장소를 clone한 머신에서 `scripts/local.sh`로 스택을 띄우고, curl만으로 세션의 전체 경로를 한 번 돈다: 생성 → 이벤트 관찰 → 권한 요청 응답 → 후속 메시지 → interrupt → pause → resume(복원) → terminate → 복구 결정 → resume.

모델 계정은 필요 없다. 예시 카탈로그(`config/`)는 compose의 `fake-messages` 서비스를 Messages API로 쓴다. 각 워커 안에서는 **진짜 Claude Code**(Agent SDK 0.3.270에 번들된 실행 파일)가 돌고, fake는 프롬프트에 적힌 대본대로 답한다(§ [스크립트된 프롬프트](#스크립트된-프롬프트)). 실제 Claude로 확인하는 방법은 [5장](#5-실제-claude로-확인하기-선택-유료)에 있다.

이 문서의 `bash` 블록은 CI(`quickstart` job)가 새 clone에서 순서대로 실행한다. `jq -e`로 시작하는 줄은 `true`를 출력해야 한다. `false`가 나오면 그 단계가 기대와 다르게 끝난 것이고, CI에서는 그 자리에서 실패한다. 같은 시나리오를 `tests/e2e/alpha-path.e2e.ts`가 CI(`e2e` job)에서 자동으로 돈다.

## 대상: 신뢰된 내부 인원 한정

private alpha는 **신뢰된 내부 인원만** 쓴다. 워커 안에서 실행되는 코드(에이전트의 tool 실행, prompt injection으로 들어온 명령 포함)는 다음에 접근할 수 있고, 이것은 알려진 제약이다.

- 카탈로그가 바뀐 뒤의 재claim ([94S-253](https://linear.app/94soon/issue/94S-253))

provider key, 저장소 credential, object store credential 값은 worker에 가지 않는다([94S-252](https://linear.app/94soon/issue/94S-252), [94S-251](https://linear.app/94soon/issue/94S-251)). 다만 attempt가 살아 있는 동안은 그 attempt의 egress token으로 proxy를 거쳐 provider와 저장소, 그리고 자기 세션 prefix 안의 object를 부를 수 있다.

외부 사용자·멀티 테넌트·공유 환경에 열기 전에 위 티켓을 닫아야 한다.

## 0. 준비물

macOS나 Linux를 기준으로 한다. 셸은 bash나 zsh를 쓴다.

| 항목 | 버전 | 왜 |
|---|---|---|
| Docker Engine | **28 이상** | 워커 네트워크가 `gateway_mode_ipv4=isolated`를 쓴다. 28보다 낮은 daemon에서는 scheduler가 기동을 거부한다([94S-274](https://linear.app/94soon/issue/94S-274)) |
| Docker Compose | v2, 2.24 이상 | compose의 `include`와 `env_file`의 `required`를 쓴다. 6장의 백업·복원까지 해 보려면 2.24.6 이상(`include`로 합친 스택 위에 overlay를 겹친다) |
| curl, jq, uuidgen | 아무 버전 | 3장의 수동 확인 |
| lsof | 아무 버전 | 0장의 포트 점검. 없으면 점검 블록이 아무것도 출력하지 않는다(`local.sh up`이 다시 확인한다) |
| git | 아무 버전 | clone |
| Bun | 1.3.10 이상 | 4장의 자동 검증과 6장의 key 폐기·백업에만 쓴다. 1–3장에는 필요 없다 |

로컬 스택은 루프백(`127.0.0.1`)에만 포트를 연다. 다음 포트가 비어 있어야 한다: **3000**(API), **5432**(Postgres), **4566**(LocalStack S3), **4567**(LocalStack Secrets Manager), **3001**(Gitea 웹·HTTP clone). 로컬에 Postgres가 떠 있으면 5432가 겹치는 경우가 많다. Docker Desktop은 Settings → Software updates에서 엔진 버전을 확인한다.

```bash
docker version --format 'Docker Engine {{.Server.Version}}'
docker compose version
for p in 3000 5432 4566 4567 3001; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then echo "사용 중: $p"; fi
done
docker system df
```

`사용 중:` 줄이 없어야 한다. 마지막 줄은 이미지 빌드에 쓸 디스크 여유를 보여 준다. `scripts/local.sh up`도 기동 전에 엔진·compose 버전과 포트를 다시 확인하고, 맞지 않으면 아무것도 띄우지 않고 이유를 출력한다.

## 1. clone과 기동

저장소는 public이라 인증 없이 받을 수 있다.

```text
git clone https://github.com/JeongJaeSoon/agent-platform.git
cd agent-platform
```

```bash
scripts/local.sh up
KEY=$(scripts/local.sh key quickstart \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)
echo "${KEY:0:12}…"
scripts/local.sh status
```

`up`은 compose project `agent-platform`을 띄운다. 첫 실행은 api·scheduler·worker 이미지를 이 checkout에서 빌드하므로 몇 분에서 10분쯤 걸린다. `/readyz`가 `{"status":"ready","checks":{"database":"ok","schema":"ok","config":"ok"}}`를 돌려줄 때까지 기다렸다가 그 응답을 출력하고 끝난다. 뜨는 서비스는 다음과 같다.

- postgres(+ 한 번 도는 `migrate`), localstack(S3), secrets(API 전용 Secrets Manager), gitea(+ 샘플 저장소 `agent/sample-app`을 만드는 `gitea-init`), fake-messages, egress-proxy
- `api`(`127.0.0.1:3000`)와 `scheduler`(5초마다 한 pass로 세션마다 worker 컨테이너를 띄운다)
- `reconciler`(pass가 끝날 때마다 10초 쉬고 다음 pass를 돈다. lease가 만료된 세션과 orphan 세션을 다시 queue에 넣거나 복구 대상으로 표시하고, 기한을 넘긴 interrupt·terminate receipt를 `unknown`으로 마감한다)
- `worker`는 상주하지 않는다. 이미지 빌드와 `claude --version` 확인만 하고 끝난다. 실제 워커는 scheduler가 세션마다 띄운다

`key`는 API 컨테이너 안에서 key CLI(`apps/control-host/src/api/keys.ts`)를 돌린다. key는 stdout에 **한 번만** 출력되고, 폐기할 때 쓰는 key id는 stderr의 `key_id …` 줄에 나온다. 위 `echo`는 발급됐는지만 앞 12자로 확인한다. `quickstart`는 key의 owner id다. 웹 콘솔 사용자와 세션을 공유하려면 그 사용자의 workspace id를 쓴다. `--scopes`는 필수이며 위 목록이 전부다. 복구 결정(`sessions:recover`)을 빼면 ⑨의 recovery 호출이 403이다.

`status`는 컨테이너 목록과 `/readyz` 응답을 보여 준다. api·scheduler·reconciler가 running이면 다음 장으로 넘어간다.

코드를 새로 pull했으면 `scripts/local.sh up`을 다시 실행한다. 매번 이미지를 이 checkout에서 다시 빌드한다.

**로컬 설치는 휘발성이다.** LocalStack은 S3를 메모리에만 두므로 `docker compose down`이나 Docker 재시작 한 번에 checkpoint 객체가 모두 사라진다. postgres는 volume에 남아 그 객체를 가리키는 행을 그대로 갖고 있으므로, GC가 아직 거두지 않은 checkpoint가 하나라도 남아 있으면 그 상태로 다시 띄울 때 API가 기동을 거부한다([8장](#8-막혔을-때)). 스택을 내릴 때는 `scripts/local.sh down`(데이터까지 삭제)을, 처음부터 다시 할 때는 `scripts/local.sh reset`을 쓴다(7장).

Gitea(`http://127.0.0.1:3001`)의 `agent/sample-app`은 누구나 읽을 수 있는 공개 저장소다. 워커도 egress proxy를 거쳐 Gitea에 닿으므로 소유 계정 `agent`의 비밀번호는 알려진 기본값 없이 무작위로 만들어진다(6장).

## 2. curl 준비

아래 블록을 **같은 터미널**에 한 번 붙여 넣는다. 3장의 명령이 모두 이 함수와 `KEY`를 쓴다. 셸을 새로 열었으면 1장의 `KEY=…` 줄부터 다시 한다.

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

`get /v1`이 `owner_id`가 든 JSON을 돌려주면 준비가 끝났다. 401이면 `KEY`가 비었거나 다른 스택에서 발급한 key다.

모든 POST는 `Idempotency-Key`가 필수다. `post`가 요청마다 새 값을 붙인다. 같은 key와 같은 본문으로 다시 보내면 처음 응답이 그대로 오고(재시도 안전), 같은 key에 다른 본문이면 409 `IDEMPOTENCY_CONFLICT`다.

## 3. 세션 한 바퀴

### ① 생성

```bash
created=$(post /v1/sessions "$(body 'GATE-SPEC {"id":"q1","steps":[{"tool":"Bash","input":{"command":"echo alpha > hello.txt","description":"write hello.txt"}}],"final":"wrote hello.txt"}')")
echo "$created" | jq .
echo "$created" | jq -e '.status == "queued" and .turn_id == "1"'
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
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/quickstart-events.txt || true
grep -A1 '^event: question' /tmp/quickstart-events.txt
```

`curl: (28) Operation timed out after 5… milliseconds`는 정상이다. 이벤트 스트림은 서버가 닫지 않으므로 `--max-time 5`가 5초 뒤에 끊은 것이고, `|| true`가 있어 다음 줄은 그대로 실행된다. ⑧에서도 같은 메시지가 나온다.

SSE 스트림이다(`id`·`event`·`data` 한 묶음씩, 15초마다 keepalive). 사람이 볼 때는 `--max-time` 없이 열어 두고 Ctrl-C로 닫는다. 끊긴 곳부터 이어 읽으려면 마지막 `id`를 `Last-Event-ID` 헤더로 보낸다. 이벤트 이름은 `system`·`assistant`·`tool_use`·`tool_result`·`question`·`result`·`status`·`error`다. `result` 이벤트의 `data.session_id`는 플랫폼 세션 id가 아니라 **engine(Claude Code) 세션 id**다.

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

요청은 30분(`PENDING_REQUEST_TTL_SEC`, 정수 초) 안에 답하지 않으면 거절로 끝난다. 값을 바꾸면 worker도 그만큼 기다린다. 다만 turn 상한 `MAX_TURN_SECONDS`를 넘길 수는 없다.

### ④ 응답

```bash
answer=$(post "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", decision:"allow"}')")
echo "$answer" | jq .
wait_for "/v1/sessions/$SID/turns/1" .status completed
get "/v1/sessions/$SID/turns/1" | jq -e '.status == "completed"'
get "/v1/receipts/$(echo "$answer" | jq -r .receipt_id)" | jq '{operation, status}'
```

거절은 `{"decision":"deny","reason":"…"}`(reason 필수)이다. `AskUserQuestion`에서 오는 `kind: "question"` 요청은 `answers: [{question_id, selected_option_ids}]`로 답한다.

### ⑤ 후속 메시지

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q2","steps":[],"final":"second turn"}')" | jq .
wait_for "/v1/sessions/$SID/turns/2" .status completed
get "/v1/sessions/$SID/turns/2" | jq -e '.status == "completed"'
```

202와 함께 `turn_id: "2"`가 온다. 같은 worker의 같은 Claude Code 세션에서 이어진다. 세션 하나에 쌓을 수 있는 대기 입력은 `QUEUED_INPUT_LIMIT_PER_SESSION`(기본 20)개이고, 넘으면 429다.

### ⑥ interrupt

turn 3은 모델 응답이 5분 늦게 오도록 대본을 짰다. 실행 중인 turn을 지정해서 멈춘다. 여기서는 turn이 `running`이 된 것만 기다린다 — 모델 호출이 실제로 진행 중일 때 멈추는지는 `tests/e2e`가 fake의 호출 기록을 보고 확인한다.

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q3","steps":[],"final":"too late","finalDelayMs":300000}')" | jq .
wait_for "/v1/sessions/$SID" .current_turn_id 3
wait_for "/v1/sessions/$SID" .status running
interrupt=$(post "/v1/sessions/$SID/interrupt" '{"target_turn_id":"3"}')
echo "$interrupt" | jq .
wait_for "/v1/sessions/$SID/turns/3" .status interrupted
get "/v1/sessions/$SID/turns/3" | jq -e '.status == "interrupted"'
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
get "/v1/sessions/$SID" | jq -e '.admission_state == "paused" and .checkpoint_revision != null'
code=$(curl -sS -o /tmp/quickstart-paused.json -w '%{http_code}' "$API/v1/sessions/$SID/messages" \
  "${AUTH[@]}" -H "Idempotency-Key: $(uuidgen)" -d "$(say 'while paused')")
jq -e --arg code "$code" '$code == "409" and .error.code == "SESSION_PAUSED"' /tmp/quickstart-paused.json
```

worker가 진행 중인 일을 마무리하고 checkpoint(workspace git bundle + transcript)를 커밋한 뒤 사라진다. 그동안은 `pausing`이고, 끝나면 `paused`다. paused 동안 보낸 메시지는 409 `SESSION_PAUSED`다(마지막 줄). 60초 안에 drain되지 않으면 세션 상세의 `attention`에 `PAUSE_BLOCKED`가 뜬다.

### ⑧ resume — 새 worker에서 복원

```bash
post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q4","steps":[{"tool":"Bash","input":{"command":"cat hello.txt","description":"read hello.txt"}}],"final":"restored"}')" | jq .
wait_for "/v1/sessions/$SID/turns/4" .status completed
get "/v1/sessions/$SID/turns/4" | jq -e '.status == "completed"'
curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" \
  >/tmp/quickstart-events.txt || true
sed -n 's/^data: *//p' /tmp/quickstart-events.txt |
  jq -se 'any(.[]; .turn_id == "4" and (tojson | contains("alpha")))'
```

새 worker는 빈 HOME·workspace에서 마지막 checkpoint만으로 저장소와 Claude Code 세션을 복원한다. 마지막 줄은 turn 4의 이벤트에 turn 1이 쓴 `alpha`가 있는지 본다. turn 4의 `cat hello.txt`가 `alpha`를 돌려주면 workspace가 복원된 것이다.

### ⑨ terminate → 복구 결정 → resume

turn 5를 느리게 걸어 두고 실행 중에 terminate한다(⑥처럼 `running`까지만 기다린다). 결과를 알 수 없는 turn이 남으므로 세션은 복구 결정을 기다린다.

```bash
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q5","steps":[],"final":"never","finalDelayMs":300000}')" | jq .
wait_for "/v1/sessions/$SID" .current_turn_id 5
wait_for "/v1/sessions/$SID" .status running
post "/v1/sessions/$SID/terminate" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"quickstart"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state recovery_required
get "/v1/sessions/$SID/turns/5" | jq -e '.status == "outcome_unknown"'

decision=$(post "/v1/sessions/$SID/recovery-decisions" "$(jq -nc --argjson r "$(revision)" \
  '{decision:"abandon", expected_revision:$r, reason:"slow call had no effect", target_turn_id:"5"}')")
echo "$decision" | jq .
wait_for "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" .status succeeded
get "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" | jq .result
get "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" | jq -e '.result.resumable == true'

post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say 'GATE-SPEC {"id":"q6","steps":[{"tool":"Bash","input":{"command":"cat hello.txt","description":"read hello.txt"}}],"final":"still here"}')" | jq .
wait_for "/v1/sessions/$SID/turns/6" .status completed
get "/v1/sessions/$SID/turns/6" | jq -e '.status == "completed"'
```

- terminate는 대기 중인 입력을 취소하고 열린 권한 요청을 닫는다. 실행 중이던 turn은 `outcome_unknown`이 되고 세션은 `status: failed`, `admission_state: recovery_required`다. 도구가 이미 바깥에 한 일은 되돌리지 않는다(`external_effects_reverted: false`).
- 복구 결정은 `abandon`(turn을 `cancelled`로), `confirm_completed`(checkpoint가 그 turn까지 덮을 때, `evidence_ref` 필수), `close`(세션을 끝냄, 되돌릴 수 없음) 중 하나다. receipt `result.resumable`이 `true`면 resume할 수 있다.
- idle 상태에서 terminate하면 복구 결정 없이 바로 `stopped`이고, 그대로 resume할 수 있다.

### 로그 보기

```sh
docker compose logs -f api scheduler
```

worker 컨테이너는 끝나면 scheduler가 바로 지우므로 `docker logs`로 나중에 볼 수 없다. 남기려면 스택을 띄운 동안 다른 터미널에서 시작되는 worker마다 로그를 따라가는 루프를 하나 걸어 둔다(`tests/e2e/run.sh`가 같은 방법을 쓴다).

```sh
mkdir -p worker-logs
docker events --filter label=agent-platform.installation=local --filter type=container \
  --filter event=start --format '{{.Actor.ID}} {{index .Actor.Attributes "name"}}' |
  while read -r id name; do docker logs -f --timestamps "$id" >"worker-logs/$name.log" 2>&1 & done
```

## 4. 명령 하나로 자동 검증

3장을 손으로 도는 대신 스크립트로 확인한다. 처음 한 번 테스트 의존성을 설치한다.

```sh
bun install
```

| 명령 | 확인하는 것 | 성공 표시 |
|---|---|---|
| `tests/e2e/run.sh` | 알파 경로 전체(3장과 같은 흐름 + pause 경계 케이스). CI `e2e` job과 같다 | `tests: pass=6 skip=0 fail=0` |
| `tests/e2e/quickstart.sh` | 이 문서의 `bash` 블록을 순서대로 한 `bash -euo pipefail`에서 실행한다. `jq -e` 줄 하나라도 `false`면 실패다. CI `quickstart` job과 같다. 1장 스택이 없을 때만 돌린다(아래 경고) | `== quickstart: every block ran` |
| `tests/e2e/restore-resume.sh` | 세션 두 turn → pause → 백업 → 원본 전부 삭제 → 새 project에 복원·검증 → resume해서 같은 Claude 세션으로 이어지는지 | exit 0. 비교표는 `RR_OUT/record.txt` |

`run.sh`와 `restore-resume.sh`는 **자기 compose project와 임시 포트**로 따로 뜨고, 끝나면 자기가 만든 것을 모두 지운다. 1장 스택과 겹치지 않는다. 다만 이미지를 새로 빌드하므로 무겁다. 하나씩 돌린다.

> **`quickstart.sh`는 1장 스택과 그 데이터를 지운다.** 문서 그대로 기본 project(`agent-platform`)와 기본 포트(3000 등)를 쓴다. 1장 스택이 떠 있으면 그 스택을 이어 받아 세션과 API key를 하나씩 더 만들고, 마지막 블록의 `scripts/local.sh down`으로 스택과 volume을 모두 지운다. 1장 스택을 7장처럼 내린 뒤에 돌리거나 새로 clone한 머신에서만 돌린다.

실행 기록은 `E2E_OUT`(기본값은 새 임시 디렉터리이고 끝날 때 경로를 출력한다)에 남는다. `record.txt`(tested SHA, 이미지 id, SDK·Claude Code 버전), `test.log`, compose 로그, worker 로그가 들어 있다. 스택을 남겨 두고 테스트만 반복하려면 `E2E_UP_ONLY=1 tests/e2e/run.sh`로 띄우고, `source <E2E_OUT>/vars.sh` 뒤에 `bun test ./tests/e2e/alpha-path.e2e.ts`를 돌린다.

## 5. 실제 Claude로 확인하기 (선택, 유료)

Anthropic API key 하나로 같은 흐름을 실제 Claude에 붙여 돈다. 절차와 비용, key 취급은 [실제 모델로 돌리기](#실제-모델로-돌리기)에 있다.

## 6. 운영 기능 둘러보기

2장의 함수와 3장의 `SID`를 그대로 쓴다.

```bash
get /v1/limits | jq .
get "/v1/sessions/$SID/usage" | jq .
```

| 기능 | 명령 |
|---|---|
| 설치 상한 조회 | `get /v1/limits \| jq .` |
| 세션 사용량(비용·토큰) | `get /v1/sessions/$SID/usage \| jq .` |
| turn 조회 | `get /v1/sessions/$SID/turns/1 \| jq .` |
| receipt 조회 | `get /v1/receipts/<receipt_id> \| jq .` |
| API key 추가 발급 | `scripts/local.sh key <owner> --scopes …`. key id는 stderr의 `key_id …` 줄에 있다 |
| API key 폐기 | `bun run keys revoke <key id>`. 폐기한 key로 호출하면 401이다 |
| Idempotency 확인 | 같은 `Idempotency-Key`로 같은 본문을 다시 보내면 첫 응답이 그대로 온다. 같은 key에 다른 본문을 보내면 409 `IDEMPOTENCY_CONFLICT`다 |
| Gitea에서 커밋 보기 | `http://127.0.0.1:3001`의 `agent/sample-app`. 읽기는 공개다. 로그인하거나 push하려면 비밀번호를 직접 정한다: `docker compose exec -u git gitea gitea admin user change-password -u agent -p <비밀번호>` |

에이전트가 워커 안에서 만든 커밋의 작성자는 워커 이미지의 기본값 `agent-platform <noreply@agent-platform.invalid>`다([94S-423](https://linear.app/94soon/issue/94S-423)). 그래서 Claude가 커밋 전에 이름과 이메일을 묻지 않는다. 세션 안에서 `git config`로 정한 값이 있으면 그 값이 먼저다.

### 백업 → 복원 → 검증 (수동)

compose 2.24 이상과 `bun install`이 필요하다. 원본 설치의 volume은 건드리지 않고, 복원은 새 project로 한다. 세션을 하나 이상 만들어 idle이 된 뒤에 뜬다.

```sh
dir=$(scripts/backup.sh --project agent-platform)
scripts/restore.sh "$dir" --into ap-restore-1 --port-base 25432
scripts/verify-restore.sh --project ap-restore-1   # 마지막 줄: checkpoints=N passed=N failed=0
```

자세한 내용은 [backup-restore.md](backup-restore.md)에 있다. 복원본은 `docker compose -p ap-restore-1 -f infra/docker-compose.yml down -v`로 정리한다.

## 7. 정리

```bash
scripts/local.sh down
```

`down`은 스택과 **모든 데이터**(세션, checkpoint, API key, Gitea 저장소)를 지운다. scheduler가 만든 worker 컨테이너·네트워크·workspace volume은 compose 소유가 아니므로 `agent-platform.installation=local` label로 찾아 함께 지운다. 처음부터 다시 하려면 `scripts/local.sh reset`(= `down` 뒤 `up`)을 쓴다. 새 스택에서는 1장의 `KEY=…`부터 다시 한다.

데이터를 남긴 채 내리는 방법은 없다. LocalStack이 S3를 메모리에만 두기 때문에 `docker compose down`으로 내리면 postgres에는 세션이 남지만 그 checkpoint 객체는 사라진다. GC가 아직 거두지 않은 checkpoint가 하나라도 남아 있으면 다시 올릴 때 API가 기동을 거부한다([8장](#8-막혔을-때)).

## 8. 막혔을 때

| 증상 | 원인과 조치 |
|---|---|
| `local.sh up`이 `Docker Engine … is too old`로 끝나거나, scheduler가 재시작을 반복하고 로그에 `GatewayModeUnsupportedError`가 있다 | Docker Engine이 28 미만이다. 엔진을 올린다 |
| `local.sh up`이 `127.0.0.1 port(s) … already in use`로 끝나거나 `bind: address already in use`가 나온다 | 0장의 포트 중 하나를 다른 프로세스나 다른 스택이 쓰고 있다. 0장의 `lsof` 루프로 찾는다 |
| API가 기동하지 않고 로그에 `Checkpoint bucket … holds no object version, but the database still has checkpoints that restores read`가 있다 | `docker compose down`이나 Docker 재시작으로 LocalStack의 S3 객체만 사라지고 postgres의 checkpoint 행은 남았다. `scripts/local.sh reset`으로 모두 지우고 새로 띄운다(세션도 지워진다) |
| scheduler가 재시작을 반복하고 로그에 `SCHEDULER_PASS_TIMEOUT_SEC must be greater than EXECUTION_DOCKER_STOP_TIMEOUT_SEC + EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC` | 예전에 만든 `.env`에 옛 기본값(`SCHEDULER_PASS_TIMEOUT_SEC=120`)이 남아 있다. pass는 worker 정지 하나를 끝까지 기다릴 수 있어서 timeout이 그보다 길어야 한다([94S-385](https://linear.app/94soon/issue/94S-385)). 두 줄을 지우거나 `.env.example`처럼 `SCHEDULER_PASS_TIMEOUT_SEC=180`·`SCHEDULER_HEALTH_STALE_SEC=200`으로 고친다. 새로 clone한 머신에는 `.env`가 없다 |
| zsh에서 `readyz`나 다른 URL이 `NOT_FOUND`이고 `Could not resolve host: echo`가 함께 뜬다 | oh-my-zsh의 `url-quote-magic`이 URL 뒤에 붙여 넣은 `;` 앞에 `\`를 넣었다. 명령을 보면 `readyz\;`로 되어 있고, 요청은 `/readyz;`로 가며 `echo`는 curl의 호스트 이름이 된다. URL을 따옴표로 감싸도 막히지 않는다. 스택 문제가 아니다. 이 문서의 명령처럼 줄바꿈은 `curl -sS -w '\n' http://127.0.0.1:3000/readyz`로 붙인다. 이 동작을 아예 끄려면 `~/.zshrc`에서 `DISABLE_MAGIC_FUNCTIONS="true"`의 주석을 풀고 새 셸을 연다 |
| `readyz`가 503 `NOT_READY`다 | DB나 migration이 아직 준비되지 않았다. `docker compose --profile apps ps -a`에서 `migrate`가 `Exited (0)`인지 보고 `docker compose logs api migrate`를 확인한다 |
| `scripts/backup.sh`가 `checkpoint objects could not be backed up at the versions their checkpoints pin`으로 끝난다 | LocalStack의 S3 객체가 사라졌다(위 bucket 행과 같은 원인). `scripts/local.sh reset` 뒤 세션을 새로 만들고 idle이 된 다음 backup한다 |
| 세션이 `queued`에서 움직이지 않는다 | `docker compose logs scheduler`와 worker 로그(3장 끝의 루프)를 본다. `EXECUTION_SLOT_LIMIT`(기본 10)만큼 세션이 이미 실행 중일 수도 있다 |
| POST가 401이다 | `Authorization` 헤더가 빠졌거나, key가 다른 스택의 DB에서 발급됐다. `reset`이나 `down` 뒤라면 key도 지워졌다. 1장의 `KEY=…`와 2장의 함수를 다시 설정한다 |
| POST가 403이다 | key에 그 scope가 없다. `--scopes`를 1장과 같게 발급한다 |
| ④의 allow가 409 `REQUEST_EXPIRED`다 | 권한 요청이 30분 안에 답을 받지 못해 거절로 끝났고 turn 1도 이미 끝났다([94S-425](https://linear.app/94soon/issue/94S-425)). `hello.txt`가 만들어지지 않았으니 ⑧에서 `alpha`가 나오지 않는다. ①부터 새 세션으로 다시 하고 ②–④를 30분 안에 진행한다 |
| 409 `REVISION_CONFLICT` | 그 사이 세션이 바뀌었다. `$(revision)`으로 다시 읽어 보낸다 |
| pause가 오래 `pausing`이고 `attention.code`가 `PAUSE_BLOCKED`다 | worker가 60초 안에 drain하지 못했다. 진행 중인 turn을 interrupt하거나 기다린다 |
| pull한 코드가 반영되지 않은 것 같다 | `scripts/local.sh up`을 다시 실행한다. 이미지를 이 checkout에서 다시 빌드한다 |
| 빌드 중 디스크가 부족하다 | `docker system df`로 확인하고, 필요 없는 이미지와 빌드 캐시를 지운다(예: `docker builder prune`) |
| `--real-model`이 바로 exit 2로 끝난다 | `ANTHROPIC_API_KEY`가 export되지 않았다. [실제 모델로 돌리기](#실제-모델로-돌리기)의 순서대로 입력한다 |

## 스크립트된 프롬프트

fake Messages API(`packages/testkit/src/scripted-messages.ts`)는 user 메시지 안의 `GATE-SPEC {…}`를 대본으로 읽는다.

```text
GATE-SPEC {"id":"<이름>","steps":[{"tool":"<도구>","input":{…},"delayMs":<선택>}],"final":"<마지막 답>","finalDelayMs":<선택>}
```

- `steps`의 도구 호출을 하나씩 순서대로 보내고, 도구 결과를 다 받으면 `final` 텍스트로 turn을 끝낸다. 몇 번째 단계인지는 대본 뒤에 쌓인 도구 결과 수로 정하므로 서버는 상태를 갖지 않는다.
- `delayMs`·`finalDelayMs`는 그 응답을 늦춘다. 긴 turn(interrupt·terminate 시연)을 만들 때 쓴다.
- 대본이 없는 메시지에는 `Hello from the local fake Messages API.`로 답한다.
- 도구는 profile의 `tools`(예시: Read, Edit, Write, Glob, Grep, Bash) 안에 있어야 한다. 밖의 도구는 권한 요청 없이 거절된다.

실제 모델로 돌리는 방법은 다음 절에 있다.

## 실제 모델로 돌리기

Anthropic API key 하나로 같은 로컬 스택을 실제 Claude에 붙여 e2e를 돈다. AWS 계정은 필요 없다(S3·Secrets Manager는 그대로 LocalStack이다). 유료 호출이므로 위 절차와 CI(`e2e`·`quickstart` job)에는 들어가지 않는다. 실 AWS S3까지 쓰는 확인은 [94S-303](https://linear.app/94soon/issue/94S-303)이다.

key가 셸 history에 남지 않도록 입력받아 넘기고, 끝나면 지운다.

```sh
printf 'Anthropic API key: '
read -rs ANTHROPIC_API_KEY
echo
export ANTHROPIC_API_KEY
tests/e2e/run.sh --real-model
unset ANTHROPIC_API_KEY
```

`ANTHROPIC_API_KEY`가 없거나 비어 있으면 Docker를 건드리기 전에 exit 2로 끝난다. fake로 대신 돌지 않는다.

**무엇이 바뀌나.** `tests/e2e/run.sh`가 평소 e2e와 같은 스택(격리된 compose project, 루프백 임시 포트)을 띄우되 `tests/e2e/compose.real-model.yml`을 하나 더 얹는다.

- 카탈로그가 `tests/e2e/real-model/`로 바뀐다. profile은 `claude-coding-real` 하나이고, `claude-sonnet-5`로 `https://api.anthropic.com`을 부른다. key는 `value_env: ANTHROPIC_API_KEY`로 API 프로세스 환경에서 읽는다. 이 카탈로그에는 fake를 가리키는 profile이 없다.
- key는 API 컨테이너에만 이름으로 전달된다. compose 파일과 명령 인자 어디에도 값이 없다. worker는 attempt 범위의 egress token만 받고, egress proxy가 `api.anthropic.com:443`(기본 `EGRESS_CREDENTIAL_ALLOWLIST`)으로 나가는 요청에 key를 붙인다([94S-252](https://linear.app/94soon/issue/94S-252)).
- `SESSION_COST_LIMIT_USD=1`, `MAX_TURN_SECONDS=600`으로 한 번의 실행에 상한을 건다.
- 스크립트된 스위트 대신 `tests/e2e/real-model.e2e.ts`를 돈다.

**무엇을 확인하나.** 모델의 문장은 보지 않는다. 도구 결과(저장소 상태)와 플랫폼 기록을 본다.

1. turn 1: 샘플 저장소에 파일을 만들고 커밋한다. 권한 요청은 테스트가 허용한다.
2. turn 2: 같은 worker에서 `git log`와 `cat`으로 그 커밋을 읽는다.
3. pause: checkpoint가 turn 2까지 덮는다.
4. resume 후 turn 3: 새 worker(turn 1과 겹치는 attempt 없음)에서 같은 커밋 hash와 파일 내용이 나오고, Claude Code 세션 id가 turn 1과 같다.
5. `GET /v1/sessions/{id}/usage`: 세 turn 모두 비용을 보고했고(`complete: true`) 금액이 0보다 크며 상한을 넘지 않았다. `cost_limit_usd`는 `GET /v1/limits`와 같다.

run record(`E2E_OUT`, 끝에 경로를 출력한다)의 `record.txt`에는 tested SHA, 이미지 id, SDK·Claude Code 버전과 함께 `model`, `provider_endpoint`, `session_cost_limit_usd`가 남는다. `test.log`에는 세션 id, 커밋, attempt, 실제 비용을 담은 `real_model` JSON 한 줄이 남는다.

**비용.** Sonnet 5 기준(100만 토큰당 입력 2달러, 출력 10달러, 캐시 쓰기 2.5달러, 캐시 읽기 0.2달러) 추정치다. Claude Code 요청 하나는 system prompt와 도구 정의로 약 2만5천 토큰이다. turn 세 개에 모델 호출은 10번 안팎이다.

- 캐시가 맞으면 한 번 실행에 약 0.2달러다.
- 캐시가 전혀 맞지 않아도 0.6달러를 넘지 않을 것으로 본다.
- 상한은 세션당 1달러다. SDK가 호출이 끝날 때마다 누적 비용을 확인하므로 마지막 호출 하나만큼은 넘을 수 있다. 넘으면 turn이 `budget_exceeded`로 실패하고 실행도 실패한다.

실제로 든 비용은 `test.log`의 `cost_usd`에 있다. 이 값은 SDK의 추정치이고, 청구액은 Console에서 확인한다. 이미지 빌드까지 합쳐 처음에는 10분 남짓 걸린다.

**key가 남는 곳과 폐기.**

- `run.sh`는 끝날 때 `E2E_OUT` 전체(compose 로그, 모든 worker 로그, run record, 테스트 출력)에서 key 값을 찾는다. 하나라도 나오면 파일 이름만 출력하고 실행을 실패시킨다. key 값은 어떤 로그에도 출력되지 않는다.
- 스택이 떠 있는 동안에는 API 컨테이너 설정(`docker inspect`)에 key가 있다. `run.sh`는 끝날 때 스택을 지운다. `E2E_KEEP=1`이나 `E2E_UP_ONLY=1`로 남겼다면 `docker compose -p <project> down -v`로 직접 내린다.
- 이 용도로는 전용 key를 만들고 Console에서 workspace 지출 한도를 걸어 두기를 권한다. 다 쓴 key는 Console의 API Keys에서 비활성화하거나 삭제한다. 셸에서는 `unset ANTHROPIC_API_KEY`로 지운다.

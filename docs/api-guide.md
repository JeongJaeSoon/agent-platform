<!--
Every ```bash block below runs, in order, in one `bash -euo pipefail`, in CI
(the `quickstart` job, tests/e2e/quickstart.sh) on a fresh clone. Keep commands
that are illustrative rather than executable in `sh`, `json`, or `text` blocks.
-->

# API 유즈케이스 가이드

이 문서는 API 사용자가 "어떤 endpoint를 어떤 순서로 호출하는가"를 빠르게 찾는 실행 가이드다. 요청·응답 스키마의 정본은 `docs/openapi.json`이며, 배포 서버의 인증 없는 `GET /docs`가 읽기 전용 참조를 같은 origin의 `/docs/scalar.js`와 함께 제공한다. 저장소에서 보는 생성물은 [`docs/api/index.html`](api/index.html)이다. 여기서는 스키마를 복제하지 않고 operation 이름으로 연결한다. 아래 `bash` 블록은 CI가 compose의 fake Messages API로 그대로 실행하므로 Anthropic 계정이나 실제 호출 비용이 들지 않는다.

예시는 로컬 기본 주소 `http://127.0.0.1:3000`을 쓴다. 배포 환경에서는 `API`만 바꾼다.

## 1. API key로 인증하고 scope 확인하기

OpenAPI: [`getApiRoot`](api/index.html)

**목적.** Bearer API key를 발급하고, 이후 유즈케이스에 필요한 최소 scope를 한 번에 확인한다. 읽기·세션 입력·승인·제어·복구는 각각 `sessions:read`, `sessions:write`, `sessions:approve`, `sessions:control`, `sessions:recover`로 나뉜다.

**순서.** 로컬 fake-provider 스택을 띄우고 key를 발급한 뒤, `GET /v1`으로 key가 유효한지 확인한다. 운영에서는 플랫폼 관리자가 발급한 key를 `KEY`에 넣고 `scripts/local.sh` 두 줄은 생략한다.

```bash
scripts/local.sh up
KEY=$(scripts/local.sh key api-guide \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)
API=http://127.0.0.1:3000
AUTH=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')

DOCS_STATUS=$(curl -sS -o /tmp/agent-platform-api-docs.html -w '%{http_code}' "$API/docs")
SCALAR_STATUS=$(curl -sS -o /tmp/agent-platform-scalar.js -w '%{http_code}' "$API/docs/scalar.js")
printf 'GET /docs %s, GET /docs/scalar.js %s\n' "$DOCS_STATUS" "$SCALAR_STATUS"
test "$DOCS_STATUS" = 200
test "$SCALAR_STATUS" = 200
grep -q 'src="/docs/scalar.js"' /tmp/agent-platform-api-docs.html
test -s /tmp/agent-platform-scalar.js

wait_for() {
  for _ in $(seq 1 180); do
    [ "$(curl -sS "$API$1" "${AUTH[@]}" | jq -r "$2")" = "$3" ] && return 0
    sleep 1
  done
  echo "timed out: $1 $2 != $3" >&2
  curl -sS "$API$1" "${AUTH[@]}" >&2
  return 1
}
wait_for_pending() {
  for _ in $(seq 1 180); do
    pending=$(curl -sS "$API/v1/sessions/$SID/pending-requests" "${AUTH[@]}")
    [ "$(echo "$pending" | jq -r '.items[0].kind // empty')" = "$1" ] && return 0
    sleep 1
  done
  echo "timed out: pending request kind != $1" >&2
  echo "$pending" >&2
  return 1
}
revision() {
  curl -sS "$API/v1/sessions/$SID" "${AUTH[@]}" | jq .revision
}

curl -sS "$API/v1" "${AUTH[@]}" | jq -e '.owner_id != null'
```

**기대 응답.** `GET /v1`은 인증된 `owner_id`를 포함한 200 JSON을 돌려준다.

**흔한 오류.** 401 `UNAUTHORIZED`면 key가 비었거나 다른 설치에서 발급됐다. 403 `FORBIDDEN`이면 호출할 operation의 scope가 빠졌다. key를 로그나 문서에 붙이지 말고 환경 변수나 secret manager로 전달한다.

## 2. 세션 만들기: profile·repository 선택

OpenAPI: [`createSession`](api/index.html), [`getSession`](api/index.html)

**목적.** 실행 profile과 repository를 명시해 세션과 첫 turn을 내구적으로 접수한다.

**순서.** `profile_id`, `repository_id`, 첫 `message`를 보내고, 응답의 `session_id`와 `turn_id`를 저장한다. 이 예시는 다음 절에서 승인 요청을 보여 주기 위해 파일 쓰기 도구를 호출하는 fake 대본을 쓴다.

```bash
CREATE_BODY=$(jq -nc --arg message 'GATE-SPEC {"id":"guide-permission","steps":[{"tool":"Bash","input":{"command":"echo guide > api-guide.txt","description":"write api-guide.txt"}}],"final":"wrote api-guide.txt"}' \
  '{profile_id:"claude-coding-local", repository_id:"sample-app", message:$message}')
CREATE_KEY=$(uuidgen)
created=$(curl -sS "$API/v1/sessions" "${AUTH[@]}" \
  -H "Idempotency-Key: $CREATE_KEY" --data "$CREATE_BODY")
echo "$created" | jq .
echo "$created" | jq -e '.status == "queued" and .turn_id == "1"'
SID=$(echo "$created" | jq -r .session_id)
```

**기대 응답.** 201과 함께 `session_id`, `turn_id: "1"`, `receipt_id`, `receipt_status: "accepted"`, `status: "queued"`가 온다. 실제 완료 결과는 생성 receipt의 옛 acceptance body가 아니라 turn 조회로 판정한다.

**흔한 오류.** 422는 profile 또는 repository 선택이 유효하지 않다는 뜻이다. `createSession`은 계약상 429 `RATE_LIMITED`를 반환할 수 있으므로 나중에 재시도한다. 입력 queue 상한은 메시지 추가에 적용된다(4절). 저장소 상한은 413 `STORAGE_LIMIT_EXCEEDED`로 나타나며 `/v1/limits`를 본다. 실행 slot이 모자라면 세션은 거절되지 않고 `queued`로 기다린다. 세션 비용 상한은 요청을 거절하지 않고, 넘은 뒤 세션 `attention`의 `BUDGET_EXCEEDED`와 `/usage`의 `budget_exceeded: true`로 나타난다(8절). 409 `IDEMPOTENCY_CONFLICT`면 같은 key에 다른 본문을 보냈다.

## 3. pending-requests의 승인·질문에 답하기

OpenAPI: [`listPendingRequests`](api/index.html), [`answerPendingRequest`](api/index.html), [`getReceipt`](api/index.html)

**목적.** worker가 기다리는 도구 승인과 `AskUserQuestion`을 같은 pending-requests 흐름으로 처리한다.

**순서.** 원하는 종류의 pending request가 목록에 나타날 때까지 기다리고 `request_id`를 읽는다. 권한 요청은 `decision`, 질문 요청은 각 `question_id`의 `selected_option_ids` 또는 `free_text`로 답한다. 응답은 202 receipt이므로 receipt와 turn을 다시 조회한다.

```bash
wait_for_pending permission
echo "$pending" | jq -e '.items[0].kind == "permission"'
PERMISSION_REQUEST_ID=$(echo "$pending" | jq -r '.items[0].request_id')

permission_answer=$(curl -sS "$API/v1/sessions/$SID/answers" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --arg request_id "$PERMISSION_REQUEST_ID" \
    '{request_id:$request_id, kind:"permission", decision:"allow"}')")
echo "$permission_answer" | jq -e '.receipt_status == "accepted"'
wait_for "/v1/sessions/$SID/turns/1" .status completed
wait_for "/v1/receipts/$(echo "$permission_answer" | jq -r .receipt_id)" .status succeeded
curl -sS "$API/v1/receipts/$(echo "$permission_answer" | jq -r .receipt_id)" \
  "${AUTH[@]}" | jq -e '.operation == "answer" and .status == "succeeded"'

question_message=$(jq -nc --arg message 'GATE-SPEC {"id":"guide-question","steps":[{"tool":"AskUserQuestion","input":{"questions":[{"question":"Which environment?","header":"Environment","options":[{"label":"staging","description":"safe"},{"label":"production","description":"live"}],"multiSelect":false}]}}],"final":"selected"}' \
  '{message:$message}')
curl -sS "$API/v1/sessions/$SID/messages" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" --data "$question_message" | jq -e '.turn_id == "2"'
wait_for_pending question
echo "$pending" | jq -e '.items[0].kind == "question"'
QUESTION_REQUEST_ID=$(echo "$pending" | jq -r '.items[0].request_id')
QUESTION_ID=$(echo "$pending" | jq -r '.items[0].questions[0].question_id')
OPTION_ID=$(echo "$pending" | jq -r '.items[0].questions[0].options[0].option_id')

question_answer=$(curl -sS "$API/v1/sessions/$SID/answers" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --arg request_id "$QUESTION_REQUEST_ID" --arg question_id "$QUESTION_ID" --arg option_id "$OPTION_ID" \
    '{request_id:$request_id, kind:"question", answers:[{question_id:$question_id, selected_option_ids:[$option_id]}]}')")
echo "$question_answer" | jq -e '.receipt_status == "accepted"'
wait_for "/v1/sessions/$SID/turns/2" .status completed
wait_for "/v1/receipts/$(echo "$question_answer" | jq -r .receipt_id)" .status succeeded
```

**기대 응답.** 목록의 `items`에는 `kind: "permission"` 또는 `kind: "question"`과 만료 시각이 있다. 답변은 `receipt_status: "accepted"`로 접수되고, worker가 답을 소비하면 receipt가 `succeeded`, turn이 `completed`가 된다. worker는 답 소비를 다음 poll에 보고하므로 turn이 먼저 `completed`가 될 수 있다. receipt는 한 번 조회하지 말고 `succeeded`까지 기다린다.

**흔한 오류.** 409 `REQUEST_EXPIRED`면 만료되거나 worker가 이미 포기한 요청이므로 새 세션/turn에서 다시 요청한다. 404 `NOT_FOUND`면 현재 principal이 보지 못하는 세션·요청이거나 이미 닫혔다. 승인 scope가 없으면 403 `FORBIDDEN`이다.

## 4. 메시지 보내기와 turn 상태 보기

OpenAPI: [`appendSessionMessage`](api/index.html), [`getSessionTurn`](api/index.html)

**목적.** 기존 세션의 같은 engine 대화에 입력을 추가하고, 결과가 terminal인지 확인한다.

**순서.** 메시지 POST의 `turn_id`를 저장하고 그 turn을 조회한다. 세션의 요약 `status`나 SSE 연결 종료 여부 대신 turn의 `status`가 `completed`, `failed`, `interrupted`, `cancelled`, `outcome_unknown` 중 하나인지로 종료를 판정한다.

```bash
message=$(curl -sS "$API/v1/sessions/$SID/messages" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --arg message 'GATE-SPEC {"id":"guide-message","steps":[],"final":"continued"}' '{message:$message}')")
TURN_ID=$(echo "$message" | jq -r .turn_id)
echo "$message" | jq -e '.receipt_status == "accepted" and .turn_id == "3"'
wait_for "/v1/sessions/$SID/turns/$TURN_ID" .status completed
curl -sS "$API/v1/sessions/$SID/turns/$TURN_ID" "${AUTH[@]}" \
  | jq -e '.status == "completed"'
```

**기대 응답.** 메시지는 202와 새 `turn_id`를 돌려주고, turn 조회는 최종 상태와 커밋된 결과를 돌려준다.

`completed`는 engine이 turn을 오류 없이 끝냈다는 뜻이지, 요청한 일을 다 했다는 뜻이 아니다. 모델이 "먼저 파일 목록을 보겠다"며 도구 하나만 부르고 답을 끝내도 turn은 `completed`가 된다. 플랫폼은 모델의 답을 해석해 과제 완료를 판정하지 않는다. 일이 끝났는지는 클라이언트가 [5절](#5-sse로-진행-보기와-last-event-id-재연결)의 `assistant`·`tool_use`·`tool_result` 이벤트로 확인하고, 덜 끝났으면 같은 세션에 다음 메시지를 보낸다.

**흔한 오류.** 409 `SESSION_PAUSED`나 `RECOVERY_REQUIRED`면 입력을 더 보내지 말고 각각 resume 또는 복구 결정을 먼저 한다. 429면 세션별 queued input 상한을 확인한다.

## 5. SSE로 진행 보기와 Last-Event-ID 재연결

OpenAPI: [`streamSessionEvents`](api/index.html)

**목적.** 이미 저장된 이벤트를 재생한 뒤 live 진행을 받고, 연결이 끊기면 마지막 cursor 다음부터 이어 본다.

**순서.** 첫 연결에서 마지막 `id`를 저장하고, 재연결 요청의 `Last-Event-ID` 헤더로 보낸다. 스트림은 15초 keepalive 때문에 정상 상태에서도 닫히지 않으므로 예시만 `--max-time`으로 끊는다.

```bash
FIRST_CODE=$(curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" \
  -H "Authorization: Bearer $KEY" -o /tmp/api-guide-events.txt -w '%{http_code}' || true)
test "$FIRST_CODE" = 200
LAST_EVENT_ID=$(awk '/^id: / { id=$2 } END { sub(/\r$/, "", id); print id }' /tmp/api-guide-events.txt)
test -n "$LAST_EVENT_ID"

RECONNECT_CODE=$(curl -sSN --max-time 2 "$API/v1/sessions/$SID/events" \
  -H "Authorization: Bearer $KEY" -H "Last-Event-ID: $LAST_EVENT_ID" \
  -o /tmp/api-guide-reconnected-events.txt -w '%{http_code}' || true)
test "$RECONNECT_CODE" = 200
```

**기대 응답.** 200 `text/event-stream`이며 각 frame은 `id`, `event`, `data`를 가진다. 재연결은 지정한 cursor 이후의 저장 이벤트를 재생하고 live stream으로 이어진다.

**흔한 오류.** 410 `CURSOR_EXPIRED`면 보존 범위 밖 cursor이므로 세션/turn 현재 상태를 HTTP로 다시 읽고 새 stream을 시작한다. 429면 동시 stream 수를 줄인다. alpha는 이벤트를 trim하지 않아 410을 현재 만들지는 않지만 클라이언트는 처리해야 한다.

## 6. interrupt, pause/resume, terminate와 receipt 확인

OpenAPI: [`interruptSession`](api/index.html), [`pauseSession`](api/index.html), [`resumeSession`](api/index.html), [`terminateSession`](api/index.html), [`getReceipt`](api/index.html)

**목적.** turn 하나만 멈추거나, checkpoint를 남겨 worker를 내렸다 복원하거나, 실행을 강제로 종료한다. 모든 비동기 제어는 202 receipt의 최종 상태까지 확인한다.

**순서.** interrupt는 실행 중인 `target_turn_id`를 보낸다. pause·resume·terminate는 직전에 읽은 `revision`을 `expected_revision`으로 보내 경쟁 변경을 막는다. terminate는 외부 효과를 되돌리지 않는다.

```bash
slow=$(curl -sS "$API/v1/sessions/$SID/messages" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --arg message 'GATE-SPEC {"id":"guide-interrupt","steps":[],"final":"too late","finalDelayMs":300000}' '{message:$message}')")
SLOW_TURN=$(echo "$slow" | jq -r .turn_id)
wait_for "/v1/sessions/$SID/turns/$SLOW_TURN" .status running
interrupt=$(curl -sS "$API/v1/sessions/$SID/interrupt" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" --data "$(jq -nc --arg turn "$SLOW_TURN" '{target_turn_id:$turn}')")
wait_for "/v1/sessions/$SID/turns/$SLOW_TURN" .status interrupted
wait_for "/v1/receipts/$(echo "$interrupt" | jq -r .receipt_id)" .status succeeded
curl -sS "$API/v1/receipts/$(echo "$interrupt" | jq -r .receipt_id)" "${AUTH[@]}" \
  | jq -e '.result.terminal == "interrupted" and .result.no_op == false'

pause=$(curl -sS "$API/v1/sessions/$SID/pause" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --argjson revision "$(revision)" '{expected_revision:$revision, reason:"api guide"}')")
wait_for "/v1/receipts/$(echo "$pause" | jq -r .receipt_id)" .status succeeded
wait_for "/v1/sessions/$SID" .admission_state paused

resume=$(curl -sS "$API/v1/sessions/$SID/resume" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --argjson revision "$(revision)" '{expected_revision:$revision}')")
wait_for "/v1/receipts/$(echo "$resume" | jq -r .receipt_id)" .status succeeded
wait_for "/v1/sessions/$SID" .admission_state active

doomed=$(curl -sS "$API/v1/sessions/$SID/messages" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --arg message 'GATE-SPEC {"id":"guide-terminate","steps":[],"final":"never","finalDelayMs":300000}' '{message:$message}')")
DOOMED_TURN=$(echo "$doomed" | jq -r .turn_id)
wait_for "/v1/sessions/$SID/turns/$DOOMED_TURN" .status running
terminate=$(curl -sS "$API/v1/sessions/$SID/terminate" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --argjson revision "$(revision)" '{expected_revision:$revision, reason:"api guide"}')")
echo "$terminate" | jq -e '.receipt_status == "accepted" and .external_effects_reverted == false'
wait_for "/v1/receipts/$(echo "$terminate" | jq -r .receipt_id)" .status succeeded
```

**기대 응답.** 각 POST는 `receipt_id`를 돌려준다. interrupt receipt의 `result`는 실제 terminal과 `no_op`을, pause/resume receipt는 resulting state와 checkpoint revision을, terminate receipt는 실행 제거 결과와 `external_effects_reverted: false`를 기록한다.

**흔한 오류.** 409 `TURN_NOT_STARTED`면 interrupt 대상이 아직 queued다. 409 `REVISION_CONFLICT`면 세션을 다시 읽고 사용자의 의도가 여전히 유효한지 판단한 뒤 새 revision으로 재시도한다. 409 `RECOVERY_REQUIRED`면 다음 절의 결정을 먼저 한다.

## 7. outcome_unknown·RECOVERY_REQUIRED 복구 결정

OpenAPI: [`decideSessionRecovery`](api/index.html), [`resumeSession`](api/index.html), [`getSessionTurn`](api/index.html)

**목적.** terminate나 worker 상실 뒤 외부 효과를 확정할 수 없는 turn을 운영자가 명시적으로 판정한다. `outcome_unknown`을 성공이나 실패로 추측하지 않는다.

**순서.** 세션의 `admission_state: recovery_required`와 대상 turn의 `outcome_unknown`을 확인한다. 증거에 맞춰 `abandon`, `confirm_completed`, `close`, `start_fresh`, `retry_restore` 중 하나를 선택한다. 여기서는 외부 효과가 없다는 fake 시나리오이므로 `abandon` 뒤 resume한다.

```bash
wait_for "/v1/sessions/$SID" .admission_state recovery_required
curl -sS "$API/v1/sessions/$SID/turns/$DOOMED_TURN" "${AUTH[@]}" \
  | jq -e '.status == "outcome_unknown"'

decision=$(curl -sS "$API/v1/sessions/$SID/recovery-decisions" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --arg turn "$DOOMED_TURN" --argjson revision "$(revision)" \
    '{decision:"abandon", expected_revision:$revision, reason:"fake call had no external effect", target_turn_id:$turn}')")
wait_for "/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" .status succeeded
curl -sS "$API/v1/receipts/$(echo "$decision" | jq -r .receipt_id)" "${AUTH[@]}" \
  | jq -e '.result.resumable == true'

recovery_resume=$(curl -sS "$API/v1/sessions/$SID/resume" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq -nc --argjson revision "$(revision)" '{expected_revision:$revision}')")
wait_for "/v1/receipts/$(echo "$recovery_resume" | jq -r .receipt_id)" .status succeeded
wait_for "/v1/sessions/$SID" .admission_state active
```

**기대 응답.** 복구 receipt의 `result.resumable`이 `true`면 마지막 checkpoint에서 resume할 수 있다. `abandon`은 대상 turn을 `cancelled`로 바꾸지만 이미 발생한 외부 효과를 되돌리지는 않는다.

**흔한 오류.** 409 `RECOVERY_REQUIRED`는 아직 필요한 결정이 남았다는 뜻이다. `confirm_completed`에는 검증 가능한 `evidence_ref`가 필요하다. checkpoint가 없으면 resume이 `CHECKPOINT_UNAVAILABLE`로 거절될 수 있으므로 receipt의 `resumable`을 먼저 본다.

## 8. 사용량·비용·한도 조회

OpenAPI: [`getSessionUsage`](api/index.html), [`getInstallationLimits`](api/index.html)

**목적.** 세션의 추정 provider 비용과 입력 queue 상태, 설치 전체의 실행 slot·저장소·turn 상한을 읽는다.

**순서.** 세션별 `/usage`와 설치별 `/v1/limits`를 각각 읽는다. 비용은 청구액이 아니라 platform 가격표로 계산한 추정치이며, `cost.complete`가 false면 아직 열린 turn이 있거나 보고가 빠져 실제 합계를 알 수 없다.

```bash
usage=$(curl -sS "$API/v1/sessions/$SID/usage" "${AUTH[@]}")
echo "$usage" | jq .
echo "$usage" | jq -e '.period == "session_lifetime" and .cost.kind == "estimated"'

limits=$(curl -sS "$API/v1/limits" "${AUTH[@]}")
echo "$limits" | jq .
echo "$limits" | jq -e '.scope == "installation" and .limits.execution_slot_limit >= 0 and .usage.execution_slots_used >= 0'
```

**기대 응답.** 세션 응답은 `cost.amount_usd`, `complete`, 보고/미보고/open turn 수, 비용 상한과 queued input 수를 준다. 설치 응답은 설정된 상한과 현재 execution slot·queued input·저장소 사용량을 준다.

**흔한 오류.** 404 `NOT_FOUND`면 세션이 없거나 현재 owner에게 보이지 않는다. `complete: false`를 0원으로 해석하지 않는다. 503이면 DB나 사용량 집계를 포함한 설치 상태를 확인한다.

## 9. Idempotency-Key로 안전하게 재시도하기

OpenAPI: [`appendSessionMessage`](api/index.html), [`getReceipt`](api/index.html)

**목적.** 응답 유실이나 timeout 뒤 같은 명령을 중복 실행하지 않고 원래 접수 결과를 다시 받는다.

**순서.** mutation 하나에 UUID key를 만들고, 재시도할 때 key와 body를 둘 다 그대로 보낸다. 새 사용자의 새 의도에는 새 key를 쓴다.

```bash
RETRY_KEY=$(uuidgen)
RETRY_BODY=$(jq -nc --arg message 'GATE-SPEC {"id":"guide-idempotency","steps":[],"final":"once"}' '{message:$message}')
first=$(curl -sS "$API/v1/sessions/$SID/messages" "${AUTH[@]}" \
  -H "Idempotency-Key: $RETRY_KEY" --data "$RETRY_BODY")
second=$(curl -sS "$API/v1/sessions/$SID/messages" "${AUTH[@]}" \
  -H "Idempotency-Key: $RETRY_KEY" --data "$RETRY_BODY")
test "$first" = "$second"
RETRY_TURN=$(echo "$first" | jq -r .turn_id)
wait_for "/v1/sessions/$SID/turns/$RETRY_TURN" .status completed
```

**기대 응답.** 두 호출은 같은 status와 acceptance body를 돌려주며 turn은 한 번만 만들어진다. receipt의 `result`는 최초 acceptance body를 보존하고, 현재 성공/실패는 receipt의 최상위 `status`와 turn 조회로 읽는다.

**흔한 오류.** 같은 key에 다른 body를 보내면 409 `IDEMPOTENCY_CONFLICT`다. timeout 뒤 결과가 불분명하다고 새 key로 다시 보내면 중복 실행될 수 있으므로 먼저 같은 key로 재시도한다.

## 10. 로컬 예시 정리

**목적.** 이 문서가 만든 로컬 데이터와 worker 자원을 제거한다.

**순서.** 기본 compose project를 데이터 volume과 함께 내린다. 운영 배포에는 실행하지 않는다.

```bash
scripts/local.sh down
```

**기대 응답.** `local.sh: deleted`가 출력되고 로컬 세션·checkpoint·key·샘플 Gitea 저장소가 삭제된다.

**흔한 오류.** 다른 project나 installation을 수동 Docker 명령으로 지우지 않는다. 기본 포트를 다른 스택이 쓰고 있다면 이 예시를 시작하지 말고 [quickstart의 포트 점검](quickstart.md#0-준비물)을 먼저 따른다.

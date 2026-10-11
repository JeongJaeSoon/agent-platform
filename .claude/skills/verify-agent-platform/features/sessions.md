# 세션

호출자는 profile과 저장소를 골라 세션을 만들고 메시지를 보낸다. scheduler가 세션마다 worker 컨테이너를 띄워 진짜 Claude Code를 돌리고, 호출자는 turn 상태·이벤트 스트림·권한 요청으로 진행을 보고 답한다. fake model에서는 프롬프트의 GATE-SPEC 대본대로 답한다.

## Sub-features

- `session-create` `POST /v1/sessions` → 201 `queued`, turn 1.
- `turn-complete` turn이 `completed`가 된다.
- `events` `GET /v1/sessions/{id}/events` SSE.
- `permission` 파일을 바꾸는 도구는 `needs_input`과 pending request를 만들고 `POST …/answers`로 허용·거절한다.
- `follow-up` `POST …/messages`로 turn 2.
- `interrupt`·`pause`·`resume`·`terminate`·`recovery` 세션 제어(`docs/quickstart.md` 3장 ⑥–⑨).

## How to get to it (user POV)

- HTTP API(`docs/api-guide.md`). 세션 POST는 모두 `Idempotency-Key`가 필요하다.
- 같은 흐름을 사람이 손으로 도는 문서: `docs/quickstart.md` 3장. 자동판: `tests/e2e/alpha-path.e2e.ts`.

## Driving it with lib.sh

Preconditions:

- `KEY`가 `sessions:read,sessions:write`(권한 응답에는 `sessions:approve`, 제어에는 `sessions:control`, 복구에는 `sessions:recover`)를 가진다. [api-keys.md](./api-keys.md)로 발급한다.

```sh
. .claude/skills/verify-agent-platform/scripts/lib.sh
KEY=$(ap_key verify --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover 2>/dev/null)
body() { jq -nc --arg m "$1" '{profile_id:"claude-coding-local", repository_id:"sample-app", message:$m}'; }
```

- **생성.** `created=$(ap_post /v1/sessions "$(body 'GATE-SPEC {"id":"v1","steps":[],"final":"hello from verify"}')"); SID=$(echo "$created" | head -1 | jq -r .session_id)` → `201`, `status: "queued"`, `turn_id: "1"`.
- **완료.** `for i in $(seq 1 90); do [ "$(ap_get "/v1/sessions/$SID/turns/1" | head -1 | jq -r .status)" = completed ] && break; sleep 2; done; ap_get "/v1/sessions/$SID/turns/1"` → `200`, `status: "completed"`, `result.subtype: "success"`. 첫 turn은 worker 기동·clone 때문에 수 초–수십 초.
- **권한 요청.** 대본 `GATE-SPEC {"id":"q1","steps":[{"tool":"Bash","input":{"command":"echo alpha > hello.txt","description":"write hello.txt"}}],"final":"wrote hello.txt"}`로 만들면 세션이 `needs_input`이 되고 `ap_get "/v1/sessions/$SID/pending-requests"`에 `kind: "permission"`이 하나 있다. `ap_post "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", decision:"allow"}')"` 뒤 turn 1이 `completed`.
- **이벤트.** `curl -sSN --max-time 5 "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY" > "$EVIDENCE/events.txt" || true` → `event: result` 블록이 있다. timeout 메시지(28)는 정상.
- **제어.** pause·resume·terminate·recovery는 `docs/quickstart.md` 3장 ⑥–⑨의 명령을 `get`/`post` 대신 `ap_get`/`ap_post`로 바꿔 그대로 쓴다(응답 마지막 줄의 상태 코드를 jq에 넘기지 않도록 `| head -1`).
- **증거.** `| tee "$EVIDENCE/sessions.txt"`.

## Gotchas

- 응답 마지막 줄이 상태 코드다. jq에 넘길 때는 `| head -1`.
- worker 컨테이너는 끝나면 scheduler가 지운다. 로그가 필요하면 `docs/quickstart.md`의 "로그 보기" 루프에서 label을 `agent-platform.installation=$EXECUTION_INSTALLATION_ID`로 바꿔 건다.
- `finalDelayMs`로 느린 turn을 만들 수 있다(interrupt·terminate 시험용).
- 세션을 에이전트·팀 권한과 묶는 것은 아직 없다([musterrolle.md](./musterrolle.md) b, d).

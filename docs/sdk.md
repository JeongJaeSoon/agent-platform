# TypeScript SDK (`@werft-ai/sdk`)

서버와 스크립트에서 API key로 세션을 다루는 TypeScript SDK다. 위치는 `packages/sdk`이고, 이 저장소의 workspace 패키지로만 쓴다. npm에는 올리지 않는다(`private`, 버전 0.x). Node 20 이상과 Bun에서 돈다.

HTTP API 자체의 규칙(scope, Idempotency-Key, 오류 코드, 이벤트 스트림)은 [API 유즈케이스 가이드](api-guide.md)가 정본이다. 이 문서는 SDK가 그 규칙을 어떻게 감싸는지만 적는다.

## 1. 만들기

```ts
import { Werft } from "@werft-ai/sdk";

// WERFT_BASE_URL, WERFT_API_KEY 환경변수를 읽는다.
const werft = new Werft();
// 또는 직접 넘긴다.
const other = new Werft({ baseUrl: "https://agents.example.com", apiKey: key });
```

- `apiKey`는 `Authorization: Bearer <key>`로만 보낸다. 오류 메시지, `inspect`, JSON 어디에도 나오지 않는다.
- 생성이 실패하는 경우:
  - `window`가 있는 곳(브라우저). 페이지에 key를 두면 새기 때문이다. `dangerouslyAllowBrowser: true`로만 푼다.
  - loopback(`localhost`, `127.0.0.1`, `[::1]`)이 아닌 곳으로 가는 `http://`. key가 평문으로 지나가기 때문이다. `allowInsecureHttp: true`로만 푼다.
- 그 밖의 옵션: `maxRetries`(기본 2), `maxRetryDelayMs`(기본 60초), `timeoutMs`(시도 한 번당, 기본 60초), `defaultHeaders`, `fetch`.
- 승인 key를 따로 쓰려면 `werft.withOptions({ apiKey: approveKey })`로 두 번째 client를 만든다.

## 2. 무엇을 부를 수 있나

API key scope가 `sessions:*`인 operation을 모두 감싼다. 요청·응답 본문의 필드 이름은 API와 같은 snake_case다.

| 메서드 | API |
| --- | --- |
| `sessions.create` · `get` · `list` · `usage` · `share` | `POST/GET /v1/sessions`, `GET /v1/sessions/{id}`, `…/usage`, `…/share` |
| `sessions.messages.send` | `POST …/messages` |
| `sessions.turns.get` · `list` | `GET …/turns/{turn_id}`, `GET …/turns` |
| `sessions.events.stream` | `GET …/events` (SSE) |
| `sessions.requests.list` · `answer` | `GET …/pending-requests`, `POST …/answers` |
| `sessions.interrupt` · `pause` · `resume` · `terminate` · `close` · `changeProfile` | `POST …/interrupt`, `…/pause`, `…/resume`, `…/terminate`, `…/close`, `…/profile` |
| `sessions.recoveryDecisions.create` | `POST …/recovery-decisions` |
| `sessions.pushRequests.create` · `list` · `get` · `decide` · `openPullRequest` · `commentPullRequest` | `…/push-requests/**` |
| `receipts.get`, `auth.me`, `limits.get`, `profiles.list`, `root.get` | `GET /v1/receipts/{id}`, `/v1/auth/me`, `/v1/limits`, `/v1/profiles`, `/v1` |

- 타입은 OpenAPI에서 생성한 타입에서 이름만 붙여 가져온다. 응답 타입의 enum은 열린 union이라, 서버가 새 값(새 상태, 새 오류 코드)을 보내도 타입과 코드가 깨지지 않는다. 요청 타입은 닫혀 있다.
- `sessions.list`와 `turns.list`는 `await`하면 첫 페이지, `for await`하면 모든 항목을 준다. `page.nextPage()`는 마지막 페이지에서 `null`이다.
- pause·resume·terminate·close의 `expected_revision`은 호출자가 넘긴다. SDK가 대신 읽어 채우지 않고, `REVISION_CONFLICT`도 자동으로 다시 보내지 않는다.

## 3. 재시도와 Idempotency-Key

- 재시도하는 경우: 응답 본문의 `retryable: true`, API 오류 본문이 아닌 502·504(프록시 응답), 응답을 읽지 못한 연결 실패와 시도 timeout.
  - 연결 실패·timeout은 GET과 Idempotency-Key가 있는 명령만 다시 보낸다. key가 없는 `openPullRequest`·`commentPullRequest`는 응답을 잃으면 다시 보내지 않는다.
- 재시도하지 않는 경우: 409 전부, 500, 그 밖의 4xx.
- 기다리는 시간: `Retry-After`가 있으면 그 값을 쓴다. 60초(`maxRetryDelayMs`)를 넘으면 기다리지 않고 바로 실패하고, 오류의 `retryAfterMs`에 그 값을 싣는다. 없으면 `min(0.5초·2^n, 8초)` 안에서 무작위로 기다린다.
- key가 필요한 명령은 호출마다 key를 하나 만들고, 그 호출의 모든 재시도에 같은 key를 보낸다. 같은 key로 다시 보내면 서버가 명령을 한 번만 실행한다.
- `sessions.requests.answer`의 기본 key는 `answer:<request_id>`다. 요청 하나에는 답이 하나뿐이다.
- 프로세스를 다시 띄운 뒤 이어서 재시도하려면 오류의 `idempotencyKey`를 저장해 두었다가 `{ idempotencyKey }`로 넘긴다.

## 4. 오류

오류 클래스는 실패 방식마다 하나다. 서버 오류는 `code`로 가른다.

| 클래스 | 언제 | 주요 필드 |
| --- | --- | --- |
| `APIError` | 서버가 오류로 답했다 | `status`, `code`(서버 `error.code` 그대로), `retryable`, `requestId`, `details`, `retryAfterMs` |
| `ConnectionError` | 응답을 읽지 못했다. 명령이 실행됐는지 모른다 | `code: "NETWORK_ERROR"` |
| `TimeoutError` | 시도가 `timeoutMs`를 넘었다 | `code: "TIMEOUT"` |
| `AbortedError` | 호출자의 `signal`이 abort했다 | `name: "AbortError"`, `cause`는 signal의 reason |
| `TurnBlockedError` | `waitForTurn`에서만. 세션이 `paused`·`stopped`·`recovery_required`·`closed`라 turn이 스스로 끝나지 않는다 | `details.admission_state` |

모두 `WerftError`를 잇고 `attempts`를 싣는다. key가 있는 명령의 오류는 abort까지 모두 `idempotencyKey`를 싣는다.

```ts
import { isApiError } from "@werft-ai/sdk";

try {
  await werft.sessions.pause(id, { expected_revision: revision });
} catch (error) {
  if (isApiError(error, "REVISION_CONFLICT")) {
    // 다른 사람이 세션을 바꿨다. 다시 읽고 판단한다.
  }
  throw error;
}
```

## 5. 이벤트 스트림

```ts
const stream = werft.sessions.events.stream(sessionId, { lastEventId, signal });
for await (const event of stream) {
  console.log(event.kind, event.turn_id, event.payload);
}
// stream.lastEventId를 저장해 두면 다른 프로세스에서 그 뒤부터 받는다.
```

- 끊기면 `Last-Event-ID`로 다시 연결해 그 이벤트 바로 뒤부터 받는다.
- turn이나 세션이 끝나도 스스로 닫히지 않는다. `signal`이나 `stream.close()`로 끝낸다.
- 400·401·403·404·410은 반복을 멈추고 `APIError`를 던진다.
- `lastEventId` 없이 열면 세션 전체를 처음부터 다시 받는다. owner마다 열 수 있는 스트림 수에 한도가 있다(넘으면 429).

## 6. turn 대기와 권한 요청 응답

`waitForTurn`은 turn이 끝날 때까지 REST로 2초마다 확인한다. 같은 루프에서 세션의 대기 중인 요청을 handler에 넘긴다.

```ts
import { type PendingRequestHandlers, waitForTurn } from "@werft-ai/sdk";

const approvals: PendingRequestHandlers = {
  permission(request) {
    const command = (request.input as { command?: unknown } | null)?.command;
    if (request.tool === "Bash" && command === "git status") return { decision: "allow" };
    return { decision: "deny", reason: "This script only allows: git status" };
  },
};

const turn = await waitForTurn(werft, sessionId, turnId, {
  signal: AbortSignal.timeout(30 * 60_000),
  onRequest: approvals,
  onAnswer: (outcome) => console.log(outcome.request_id, outcome.outcome),
  events: { onEvent: (event) => console.log(event.kind) }, // 선택: 이벤트가 오면 바로 깨어난다
});
console.log(turn.status); // "failed"도 오류가 아니라 값이다
```

- 끝났다는 판단은 `GET …/turns/{turn_id}`의 `status`가 terminal(`completed`·`failed`·`interrupted`·`cancelled`·`outcome_unknown`)이거나 `ended_at`이 있을 때다. `result` 이벤트는 완료 판정이 아니다.
- handler는 보안 경계다. 정확히 일치하는 입력만 허락하고 나머지는 거절한다. 거절에는 타입상 `reason`이 필요하다.
- handler가 `undefined`를 돌려주거나 그 kind의 handler가 없으면 요청을 열어 두고 콘솔이나 Slack의 사람에게 맡긴다.
- 답의 결과(`AnswerOutcome`): `accepted`(저장됨, receipt가 나중에 failed가 될 수 있다), `left_open`, `too_late`(`REQUEST_EXPIRED`·`REQUEST_STALE`), `conflict`(다른 답이 먼저 저장됨).
- 답하려면 key에 `sessions:approve`가 있어야 한다. 없으면 403으로 대기가 실패한다.
- 시한은 `signal` 하나다. 질문을 열어 둔 채 기다리면 사람이 답할 때까지 기다린다.
- `events`를 켜면 스트림 하나를 더 쓴다. 스트림이 실패해도 polling으로 계속한다.

한 번만 처리하려면 `answerPending(werft, sessionId, approvals)`를 쓴다.

## 7. 세션 닫기 (close)

할 일을 마친 세션을 끝낸다. terminate와 달리 아무것도 죽이지 않는다. 돌던 turn이 끝나고 checkpoint가 커밋된 뒤 세션이 `closed`가 된다. scope는 `sessions:control`이다.

```ts
import { closeBlocked, closeResult, waitForReceipt } from "@werft-ai/sdk";

const { revision } = await werft.sessions.get(sessionId);
const accepted = await werft.sessions.close(sessionId, {
  expected_revision: revision,
  reason: "script finished",
});
const receipt = await waitForReceipt(werft, accepted.receipt_id, {
  signal: AbortSignal.timeout(10 * 60_000),
});
console.log(receipt.status, closeResult(receipt));
// { resulting_admission_state: "closed", checkpoint_revision: 3, cancelled_turn_count: 0 }
```

- 닫는 동안 세션은 `closing`이다(`isClosing(session)`). 이때 보낸 메시지·제어는 409 `SESSION_CLOSING`이다.
- drain이 60초를 넘으면 세션 `attention`이 `CLOSE_BLOCKED`가 된다(`closeBlocked(session)`이 그 reason을 준다). 열린 질문이나 승인 요청이 있으면 답하거나 turn을 interrupt할 때까지 close가 기다린다. 그래서 `waitForReceipt`에는 `signal`로 시한을 준다.
- 대기 중이던 입력은 close가 커밋될 때 취소된다(`cancelled_turn_count`). 닫힌 뒤의 메시지·제어는 409 `SESSION_CLOSED`다.
- 자기 turn 안에서 자기 세션을 닫는 에이전트는 receipt를 기다리지 않는다. drain이 그 turn이 끝나기를 기다리기 때문이다.
- close에 관한 코드는 `packages/sdk/src/resources/close.ts` 한 파일에 있다.

## 8. push 승인

```ts
import { waitForPushRequest } from "@werft-ai/sdk";

const push = await werft.sessions.pushRequests.create(sessionId);
// push.git_commit을 검토한 뒤, 승인 key로:
await approver.sessions.pushRequests.decide(sessionId, push.id, {
  decision: "approve",
  git_commit: push.git_commit,
});
const done = await waitForPushRequest(werft, sessionId, push.id, { signal });
if (done.state === "pushed")
  await approver.sessions.pushRequests.openPullRequest(sessionId, push.id);
```

`CHECKPOINT_MOVED`를 받아도 SDK가 다시 읽어 다시 승인하지 않는다. 검토한 commit만 승인한다.

## 9. 예제 실행 (로컬 스택, fake model)

[`packages/sdk/examples/session-close.ts`](../packages/sdk/examples/session-close.ts)는 세션 생성 → 메시지 → 이벤트 스트림으로 turn 대기 → 권한 요청 허락 → close → 닫힌 상태 확인을 한 번에 돈다. 메시지는 fake model이 재생하는 `GATE-SPEC` 대본이다([Quickstart](quickstart.md)).

1. [Quickstart](quickstart.md)대로 `scripts/local.sh up --fake-model`로 스택을 띄운다.
2. `sessions:read,sessions:write,sessions:approve,sessions:control` scope의 key를 한 owner로 발급한다(`scripts/local.sh key <owner> --scopes …`).
3. key를 환경변수에만 넣고 실행한다.

```sh
export WERFT_BASE_URL=http://127.0.0.1:3000
read -rs WERFT_API_KEY && export WERFT_API_KEY
bun packages/sdk/examples/session-close.ts
```

`WERFT_PROFILE_ID`(기본 `claude-coding-local`)와 `WERFT_REPOSITORY_ID`(기본 `sample-app`)로 profile과 저장소를 바꾼다. 출력 예:

```text
session 91863849-4a1d-4fda-97e5-22fa4099b5f3: created, turn 1 queued
  event status (turn 1)
  event system (turn 1)
  …
  event result (turn 1)
  event status (turn 1)
turn 1: completed
  event system
  event status (turn 2)
  …
  event tool_use (turn 2)
  event question (turn 2)
  event status (turn 2)
permission req_fcc8a8c9-5264-4bcf-852b-466c31b3c624: allow Bash "echo alpha > hello.txt"
answer req_fcc8a8c9-5264-4bcf-852b-466c31b3c624: accepted
  event status (turn 2)
  event tool_result (turn 2)
  event assistant (turn 2)
  event result (turn 2)
  event status (turn 2)
turn 2: completed
close: receipt accepted
close: receipt succeeded {
  checkpoint_revision: 1,
  cancelled_turn_count: 0,
  resulting_admission_state: "closed",
}
session 91863849-4a1d-4fda-97e5-22fa4099b5f3: admission closed, status stopped
message after close: 409 SESSION_CLOSED
```

닫힌 세션의 `admission_state`는 `closed`, 실행 상태 `status`는 `stopped`다. 닫힌 뒤의 메시지는 409 `SESSION_CLOSED`로 거부된다.

## 10. 버전

- SDK 버전(`SDK_VERSION`)은 패키지 자신의 semver다. API가 alpha인 동안 0.x이고, 공개 표면을 깨는 변경은 minor, 덧붙이는 변경은 patch다.
- `API_SPEC_VERSION`은 타입을 생성한 스펙의 `info.version`이다. 런타임에 서버 버전과 맞춰 보지는 않는다.
- SSE envelope은 `schema_version` 1만 읽는다(`SUPPORTED_SSE_SCHEMA_VERSIONS`).

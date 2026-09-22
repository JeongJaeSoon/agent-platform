# I2 상세 설계: Dispatch & Routing

> **저장 상태:** 현재 실행 환경은 읽기 전용이고 권한 요청도 비활성화되어 있어 지정된 `dd-dispatch.md` 파일을 생성하지 못했다. 아래는 해당 파일에 저장할 Markdown 원문이다. 저장소 파일은 수정하지 않았다.
>
> **검토 기준:** 2026-09-22, agent-platform 체크아웃 `b2c5f187138f758110e6ca5b45f47bc9a0b48ac7`. 지정된 `context.md`를 먼저 읽고 아래 근거 파일을 확인했다. 코드 읽기 기반 설계이며 테스트·실제 모델 평가·런타임 검증 결과를 의미하지 않는다.

## 1. 결론과 구현 경계

I2는 Relay의 **입력 분류, 후보 검색, 확인, 라우팅 정책**을 흡수한다. 실행은 agent-platform의 session/turn, receipt, admission state, epoch fencing, checkpoint 계약을 사용한다.

핵심 결정은 다음과 같다.

1. `POST /v1/dispatches`는 분류 작업을 내구성 있게 수락하고 `202`와 dispatch receipt를 반환한다.
2. 분류 전 수락과 분류 후 적용은 별도 트랜잭션이다. LLM 호출 중 DB 트랜잭션을 유지하지 않는다.
3. 적용 트랜잭션은 session/turn, 실행 입력 receipt, queue, dispatch 결과를 함께 커밋한다.
4. `split`의 all-or-nothing은 **모든 입력의 DB 수락**에 적용한다. 여러 실행의 시작·성공까지 원자적으로 보장하지 않는다.
5. 명시적 `target.session_id`는 classifier를 건너뛰고 원문을 새 turn으로 전달한다. 권한·admission·workspace 정책 검사는 생략하지 않는다.
6. low confidence, 후보 동률, close, split은 `needs_confirm`을 거친다.
7. 상태 조회 fast path는 읽기만 수행한다. 파괴적 자연어를 regex만으로 interrupt/pause/terminate로 실행하지 않는다.
8. resume의 queue-head override는 **세션 간 슬롯 배정 우선순위**다. 세션 내부 turn sequence는 변경하지 않는다.

### 1.1 현재 코드와의 차이

| 항목 | 현재 확인한 코드 | I2에 필요한 보완 |
|---|---|---|
| 세션 생성 | `Idempotency-Key` 필수, `201`; session·첫 turn·queue·receipt·key를 한 트랜잭션으로 저장한다. [A1][A2] | 기존 HTTP API를 재호출하지 않고, 트랜잭션 핸들을 공유하는 acceptance primitive로 추출한다. |
| receipt | operation에 `dispatch`가 없고 `target_ref.session_id`가 필수다. [A3] | session이 아직 없는 dispatch와 직접 응답을 표현하는 receipt 분기를 추가한다. |
| turn append | Zod/OpenAPI 계약은 존재한다. 현재 production server는 session 생성·목록·상세 라우트만 등록한다. [A4][A5][A6] | append acceptance 및 조회·receipt API의 실제 구현을 선행 조건으로 둔다. |
| control | interrupt/pause/terminate/resume/recovery 계약은 존재한다. 현재 라우트 등록만으로 실행 구현을 확인할 수 없다. [A5][A7] | control acceptance, worker 전달, 완료 판정이 구현되어야 정책을 활성화한다. |
| dispatch 확인 | 기존 pending request는 `turn_id`, `attempt_id`가 필수이며 permission/question만 표현한다. [A8] | 실행 전 확인은 dispatch에 저장한다. 가짜 turn/attempt를 만들지 않는다. |
| admission | DB enum과 session 필드는 존재한다. [A9] | 실제 scheduler/queue claim에서 admission 검사가 필요하다. |
| FIFO | `(session_id, sequence)` unique 제약은 있다. queue consumer는 visible row를 ID 순으로 `SKIP LOCKED` 조회한다. [A9][A10] | sequence 할당 직렬화와 세션별 단일 실행 보장을 추가한다. unique 제약만으로 FIFO 실행이 증명되지는 않는다. |
| workspace/agent | 현재 session 테이블에는 workspace·agent·immutable release 연결이 없다. [A9] | I0의 권한·workspace·Agent release 연결을 전제로 한다. |
| API scope | 현재 authorization은 owner 일치와 read/write만 구현한다. [A11] | 94S-132 scope 및 I0 Grant를 적용해야 한다. |
| close | `recovery-decisions.close`는 존재하지만 일반 session close endpoint는 없다. [A7] | 정상 session의 논리적 close 계약을 추가한다. recovery API를 일반 종료에 전용하지 않는다. |
| quota | sessions route는 94S-131 전까지 quota가 구현되지 않았음을 명시한다. [A1] | slot과 입력 backlog quota 구현을 실제로 확인한 뒤 연결한다. |

**출시 차단 조건:** append/control 실행 경로, admission-aware claim, I0 권한 연결, dispatch receipt 확장 없이 자동 라우팅을 활성화하지 않는다.

## 2. API 계약과 receipt 의미

### 2.1 `POST /v1/dispatches`

요청의 `input`은 기존 `messageTextSchema`를 재사용한다. 현재 제한은 UTF-8 32 KiB, 전체 요청은 64 KiB다. 문자열 문자 수 제한으로 대체하지 않는다. [A12]

`workspace_id`는 I0의 제품 범위이며 별도 조직 tenancy를 새로 만드는 필드가 아니다. 권한은 인증된 actor, workspace membership/Grant, API key scope에서 결정한다.

```ts
import { z } from "zod";
import {
  idempotencyKeySchema,
  messageTextSchema,
  receiptIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
} from "@agent-platform/contracts";

const opaqueIdSchema = z.string().min(1).max(128);
const dispatchIdSchema = z.uuid();

const explicitTargetSchema = z.union([
  z.object({ session_id: sessionIdSchema }).strict(),
  z.object({ agent_id: opaqueIdSchema }).strict(),
]);

const sourceContextSchema = z.object({
  instance_id: opaqueIdSchema,
  thread_id: opaqueIdSchema.optional(),
  event_id: opaqueIdSchema.optional(),
}).strict();

export const createDispatchRequestSchema = z.object({
  workspace_id: z.uuid(),
  input: messageTextSchema.refine(
    (value) => value.trim().length > 0,
    "Input must not be blank",
  ),
  target: explicitTargetSchema.optional(),
  repository_id: opaqueIdSchema.optional(),
  source: z.enum(["web", "slack", "api"]),
  source_context: sourceContextSchema.optional(),
}).strict();

export const createDispatchHeadersSchema = z.object({
  "idempotency-key": idempotencyKeySchema,
});

export const createDispatchResponseSchema = z.object({
  dispatch_id: dispatchIdSchema,
  receipt_id: receiptIdSchema,
  receipt_status: z.literal("accepted"),
  state: z.literal("received"),
  status_url: z.string().min(1),
}).strict();
```

추가 검증 규칙:

- `target.session_id`와 `target.agent_id`는 동시에 지정할 수 없다.
- `target.session_id` 지정 시 `repository_id`는 허용하지 않는다. 기존 session의 repository를 요청 본문으로 변경하지 않는다.
- `target.agent_id`는 후보 agent를 제한한다. 해당 agent의 기존 session과 신규 session 중 선택은 계속 필요하다.
- 신규 session의 `profile_id`는 사용자가 입력하지 않는다. I0 Agent의 immutable release와 94S-132 runtime profile 연결에서 해석한다.
- 신규 session에는 기존 생성 API가 요구하는 repository가 반드시 필요하다. 요청 또는 Agent 기본 repository에서 결정할 수 없으면 확인 단계로 보낸다.
- adapter가 전달한 Slack source/thread/event 식별자는 adapter 인증과 workspace 연결을 검증한다. 임의의 `source: "slack"` 선언만으로 신뢰하지 않는다.
- thread가 이미 session에 결합되어 있으면 다른 session으로 조용히 재결합하지 않는다. I0의 “다중 사용자 thread 하나 = Session 하나”를 유지한다.

응답 예:

```json
{
  "dispatch_id": "00000000-0000-4000-8000-000000000101",
  "receipt_id": "00000000-0000-4000-8000-000000000102",
  "receipt_status": "accepted",
  "state": "received",
  "status_url": "/v1/dispatches/00000000-0000-4000-8000-000000000101"
}
```

`202`는 dispatch 처리의 수락이다. session 생성, turn 실행 시작, 모델 답변 완료를 의미하지 않는다. 결과는 `GET /v1/dispatches/{id}`에서 조회한다. I2의 직접 응답은 session/worker 없이 생성하는 응답이며, POST가 반드시 답변 본문까지 동기 반환한다는 뜻은 아니다.

### 2.2 멱등성

기존 `idempotency_keys`의 복합 키 구조를 재사용한다. 현재 구조는 `(principal, operation, resource, key)`다. [A9]

| 요청 | operation | resource |
|---|---|---|
| dispatch 생성 | `dispatch` | `workspaces/{workspace_id}/dispatches` |
| dispatch 확인 | `confirm_dispatch` | `dispatches/{dispatch_id}` |

- 같은 scope/key와 같은 정규화 payload hash: 최초 수락 응답을 재생한다.
- 같은 scope/key와 다른 payload: `409 IDEMPOTENCY_CONFLICT`.
- payload hash는 검증된 요청을 canonical JSON으로 정렬해 계산한다. 기존 `payloadHash()` 방식과 일치시킨다. [A13]
- 원문 whitespace를 임의로 정규화하지 않는다. 빈 문자열 여부 확인과 입력 변경은 다르다.
- replay 시 인증·조회 권한은 다시 확인하지만 모델 호출·session 생성·turn 추가는 반복하지 않는다.
- 최초 수락 응답은 `dispatches.acceptance_response`에 불변 snapshot으로 저장한다. 현재 결과는 GET으로 조회한다.
- 신뢰된 adapter event는 `(workspace_id, source, instance_id, event_id)`로 추가 중복 방지한다. 다른 HTTP key로 재전달되어도 같은 dispatch에 연결한다.
- 같은 event ID에 다른 입력이 도착하면 충돌이다. 원문을 덮어쓰지 않는다.
- 초기 I2에서는 idempotency key를 독립적으로 만료시키지 않는다. dispatch 삭제 후에도 늦은 재전달을 막을 tombstone 정책을 함께 정의해야 한다.

현재 생성 구현은 `receipts.result`에서 최초 응답을 재생한다. dispatch는 비동기 결과가 변하므로 같은 필드를 최초 응답 저장소와 현재 결과 저장소로 겸용하지 않는다. [A2]

### 2.3 receipt 확장

기존 `answer` operation은 pending permission/question에 답하는 명령이다. `answer_directly`에 사용하지 않는다. [A3][A6]

기존 session receipt 응답 형태는 유지하고 operation별 union을 확장한다.

```ts
const dispatchReceiptOperationSchema = z.enum([
  "dispatch",
  "confirm_dispatch",
]);

const dispatchReceiptTargetSchema = z.object({
  dispatch_id: dispatchIdSchema,
}).strict();

const dispatchReceiptSchema = z.object({
  id: receiptIdSchema,
  operation: dispatchReceiptOperationSchema,
  target_ref: dispatchReceiptTargetSchema,
  status: z.enum(["accepted", "succeeded", "failed", "unknown"]),
  result: z.unknown().nullable(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();
```

위 `error.code`는 설명용이며 구현에서는 확장된 `apiErrorCodeSchema`를 사용한다. 기존 receipt schema와 이 분기를 union으로 결합하고, OpenAPI·클라이언트 parser를 함께 변경한다.

| dispatch 상태 | root receipt | 의미 |
|---|---|---|
| `received`, `deciding`, `needs_confirm` | `accepted` | 아직 적용되지 않았다. |
| `applied` | `succeeded` | 입력 또는 control 의도가 내구성 있게 수락되었거나 직접 응답이 저장되었다. |
| `rejected` | `failed` | 사용자가 거절했거나 확인이 만료되었다. |
| `failed` | `failed` | 복구 가능한 재시도 범위를 소진했고 적용되지 않았다. |

사용자 거절에는 새 오류 코드 `DISPATCH_REJECTED`, 만료에는 기존 `REQUEST_EXPIRED`를 사용한다.

신규 session/turn을 만드는 경우 root dispatch receipt 외에 기존 `create_session` 또는 `append_message` receipt를 생성한다.

- root receipt의 성공: 라우팅 적용 완료.
- child receipt의 `accepted`: 실행 입력 수락.
- turn terminal 상태: 실행 결과.
- checkpoint와 execution 관찰: 내구성·실행 종료 증거.

이를 하나의 “성공”으로 합치지 않는다. DB commit 응답이 끊겼다는 이유만으로 `unknown`으로 확정하지 않고 같은 key/dispatch ID로 DB 상태를 다시 확인한다.

## 3. 분류 결정과 확인 흐름

### 3.1 결정 스키마

Relay의 다섯 action과 high/low confidence를 유지하되 Task를 Session으로 치환한다. Relay는 action별 필수 필드를 `superRefine`으로 검증하고 split에 별도 guard를 적용한다. [R1]

I2에서는 strict union으로 불필요한 필드와 잘못된 조합도 거절한다.

```ts
const utf8 = new TextEncoder();

const boundedText = (maxBytes: number) =>
  z.string().min(1).refine(
    (value) => utf8.encode(value).length <= maxBytes,
    "Text exceeds the UTF-8 byte limit",
  );

const decisionMeta = {
  confidence: z.enum(["high", "low"]),
  rationale: boundedText(512),
};

const newSessionDecisionSchema = z.object({
  decision: z.literal("new_session"),
  agent_id: opaqueIdSchema,
  repository_id: opaqueIdSchema,
  title: boundedText(240),
  ...decisionMeta,
}).strict();

const routeDecisionSchema = z.object({
  decision: z.literal("route_to_session"),
  target_session_id: sessionIdSchema,
  ...decisionMeta,
}).strict();

const directAnswerDecisionSchema = z.object({
  decision: z.literal("answer_directly"),
  answer: boundedText(4096),
  ...decisionMeta,
}).strict();

const closeDecisionSchema = z.object({
  decision: z.literal("close_session"),
  target_session_id: sessionIdSchema,
  ...decisionMeta,
}).strict();

const scalarDecisionSchema = z.discriminatedUnion("decision", [
  newSessionDecisionSchema,
  routeDecisionSchema,
  directAnswerDecisionSchema,
  closeDecisionSchema,
]);

const splitItemSchema = z.discriminatedUnion("decision", [
  newSessionDecisionSchema.extend({ input: messageTextSchema }),
  routeDecisionSchema.extend({ input: messageTextSchema }),
]);

export function buildDispatchDecisionSchema(maxSplit: number) {
  if (!Number.isInteger(maxSplit) || maxSplit < 1 || maxSplit > 8) {
    throw new Error("Invalid max_split");
  }

  if (maxSplit === 1) return scalarDecisionSchema;

  const splitDecisionSchema = z.object({
    decision: z.literal("split"),
    items: z.array(splitItemSchema).min(2).max(maxSplit),
    ...decisionMeta,
  }).strict();

  return z.union([scalarDecisionSchema, splitDecisionSchema]);
}
```

운영 기본값은 `max_split=3`, hard maximum은 8로 제안한다. `max_split=1`이면 prompt와 JSON schema 모두에서 split을 제거한다. 이는 현재 운영값이 아니라 I2 정책 제안이다.

스키마 통과 후 서버 검증:

- session/agent/repository ID는 허용된 후보 또는 catalog에 존재해야 한다.
- 명시한 `target.agent_id`와 다른 agent를 선택할 수 없다.
- 일반 new/route에는 요청 원문을 그대로 전달한다. classifier가 작업 본문을 조용히 다시 쓰지 않는다.
- split만 항목별 입력을 작성할 수 있으며, 확인 카드에 원문과 항목별 입력을 함께 제시한다.
- split 항목의 입력 합계는 UTF-8 32 KiB 이하로 제한한다.
- 같은 기존 session을 두 번 지정한 split은 거절하고 하나의 입력으로 재작성하도록 한다.
- split 내부에 close, direct answer, nested split을 허용하지 않는다.
- `rationale`은 후보 선택 이유의 짧은 설명이다. 내부 추론 전체를 저장하도록 요구하지 않는다.
- 모델의 `confidence: high`는 확률 보정값이 아니다. deterministic gate와 평가 결과를 대체하지 않는다.

### 3.2 확인 후보

classifier의 다섯 결정 유형에는 interrupt/pause/terminate가 없다. 이 동작을 `route_to_session`으로 위장하지 않는다.

자연어 control 요청은 별도 확인 후보로 표현하며, 확인 후 기존 control acceptance에 전달한다.

```ts
const controlPlanSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("interrupt"),
    session_id: sessionIdSchema,
    target_turn_id: turnIdSchema,
  }).strict(),
  z.object({
    operation: z.enum(["pause", "terminate"]),
    session_id: sessionIdSchema,
    expected_revision: revisionSchema,
    reason: boundedText(512),
  }).strict(),
]);

const candidateBase = {
  candidate_id: z.uuid(),
  label: boundedText(240),
  expected_sessions: z.array(z.object({
    session_id: sessionIdSchema,
    revision: revisionSchema,
  }).strict()).max(8),
};

const routingCandidateSchema = z.object({
  ...candidateBase,
  kind: z.literal("routing"),
  plan: buildDispatchDecisionSchema(8),
}).strict();

const controlCandidateSchema = z.object({
  ...candidateBase,
  kind: z.literal("control"),
  plan: controlPlanSchema,
}).strict();

export const dispatchCandidateSchema = z.discriminatedUnion("kind", [
  routingCandidateSchema,
  controlCandidateSchema,
]);

export const confirmDispatchRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("choose"),
    candidate_id: z.uuid(),
    expected_revision: revisionSchema,
  }).strict(),
  z.object({
    action: z.literal("reject"),
    expected_revision: revisionSchema,
    reason: boundedText(512).optional(),
  }).strict(),
]);
```

클라이언트는 임의의 decision JSON을 confirm에 넣을 수 없다. 서버가 저장한 candidate를 선택한다. 다른 대상을 찾는 UI는 서버에 후보 snapshot 갱신을 요청하고, 새 revision/candidate ID를 받아야 한다.

candidate snapshot에는 코드 예시 외에도 resolved agent release, profile, repository, 정책 버전, 권한 검증에 필요한 참조를 저장한다. 모델이 작성한 release ID를 신뢰하지 않는다.

### 3.3 상태 전이

```text
received → deciding → applied
                    → needs_confirm → applied
                                    → rejected
                                    → failed
                    → failed

needs_confirm → deciding → needs_confirm
                후보 갱신 시에만 허용
```

- 모든 변경은 dispatch row lock과 revision CAS를 사용한다.
- `received → deciding`에서 claim token과 lease 만료 시각을 저장한다.
- lease가 만료되면 새 작업자가 소유권을 획득한다. 이전 작업자의 늦은 결과는 token 불일치로 폐기한다.
- 후보 갱신은 revision을 올리고 이전 후보를 무효화한다.
- `applied`, `rejected`, `failed`는 terminal이다. 이미 적용한 dispatch를 redispatch하여 새 session을 만들지 않는다.
- 종료된 요청을 다시 수행하려면 새 key로 새 dispatch를 생성하고 이전 dispatch를 감사 참조로 연결한다.

Relay 역시 이미 dispatch된 메시지의 redispatch를 막는다. 이 보호를 HTTP 멱등성·DB 제약까지 확장한다. [R3]

### 3.4 `POST /v1/dispatches/{id}/confirm`

`Idempotency-Key`는 필수다.

처리 순서:

1. actor와 dispatch 접근 권한 확인.
2. confirm key를 조회하여 기존 수락이면 동일 응답 반환.
3. dispatch를 잠그고 `needs_confirm`, revision, expiry 검증.
4. 선택한 candidate가 해당 revision에 속하는지 확인.
5. 대상 권한·admission·release·repository·quota·workspace kill switch 재검증.
6. 적용 또는 거절과 confirm receipt를 같은 트랜잭션으로 저장.

확인 명령은 별도 `confirm_dispatch` receipt를 반환한다. root receipt ID도 함께 반환하여 원래 작업의 결과를 추적한다.

```ts
export const confirmDispatchResponseSchema = z.object({
  dispatch_id: dispatchIdSchema,
  receipt_id: receiptIdSchema,
  receipt_status: z.literal("succeeded"),
  dispatch_receipt_id: receiptIdSchema,
  state: z.enum(["applied", "rejected"]),
}).strict();
```

확인 기본 유효기간은 후보 발행 후 15분이다.

- 만료 시 `rejected`, root receipt `failed/REQUEST_EXPIRED`.
- expired confirm은 `410 REQUEST_EXPIRED`.
- 낡은 revision은 `409 REVISION_CONFLICT`.
- 후보 대상이 바뀌었으면 `409 REQUEST_STALE`; 조용히 다른 session에 적용하지 않는다.
- 서로 다른 key의 동시 confirm도 dispatch row lock으로 하나만 적용된다.
- 이미 적용된 dispatch에 다른 선택을 제출하면 `409 REQUEST_STALE`.
- 동일한 confirm key 재시도는 expiry보다 먼저 replay를 확인한다.

기존 pending request는 runtime attempt에 귀속되는 permission/question이다. dispatch 확인 카드는 별도 데이터지만 I1/I3 UI에서 같은 “사용자 응답 필요” 목록에 표시할 수 있다. API와 수명주기는 합치지 않는다. [A8]

## 4. DB 설계

아래는 추가할 Drizzle 형태의 핵심 테이블이다. `workspaces`, `agents`, actor/Grant 관계는 I0 선행 스키마에 연결한다. 현재 체크아웃에 이미 존재한다는 의미가 아니다.

JSONB는 `$type`만으로 검증되지 않는다. 모든 write/read boundary에서 Zod 검증을 수행하고, byte limit과 핵심 상태 제약은 migration에도 둔다.

```ts
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const dispatchState = pgEnum("dispatch_state", [
  "received",
  "deciding",
  "needs_confirm",
  "applied",
  "rejected",
  "failed",
]);

export const dispatches = pgTable("dispatches", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  actorId: text("actor_id").notNull(),
  receiptId: uuid("receipt_id").notNull().references(() => receipts.id),
  inputText: text("input_text").notNull(),
  requestJson: jsonb("request_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  source: text().notNull(),
  sourceInstanceId: text("source_instance_id"),
  sourceThreadId: text("source_thread_id"),
  sourceEventId: text("source_event_id"),
  state: dispatchState().notNull().default("received"),
  revision: integer().notNull().default(0),
  policyVersion: integer("policy_version").notNull(),
  candidates: jsonb().notNull().default(sql`'[]'::jsonb`),
  selectedCandidateId: uuid("selected_candidate_id"),
  acceptanceResponse: jsonb("acceptance_response").notNull(),
  result: jsonb(),
  error: jsonb(),
  claimToken: uuid("claim_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull().defaultNow(),
}, (t) => [
  uniqueIndex("dispatches_receipt_uniq").on(t.receiptId),
  uniqueIndex("dispatches_source_event_uniq")
    .on(t.workspaceId, t.source, t.sourceInstanceId, t.sourceEventId)
    .where(sql`${t.sourceEventId} IS NOT NULL`),
  index("dispatches_work_idx").on(t.state, t.leaseUntil, t.createdAt),
  index("dispatches_workspace_created_idx")
    .on(t.workspaceId, t.createdAt),
  check("dispatches_input_size",
    sql`octet_length(${t.inputText}) BETWEEN 1 AND 32768`),
  check("dispatches_revision_nonnegative", sql`${t.revision} >= 0`),
  check("dispatches_confirmation_expiry",
    sql`${t.state} <> 'needs_confirm' OR ${t.expiresAt} IS NOT NULL`),
  check("dispatches_source_event_instance",
    sql`${t.sourceEventId} IS NULL OR ${t.sourceInstanceId} IS NOT NULL`),
]);

export const dispatchItems = pgTable("dispatch_items", {
  dispatchId: uuid("dispatch_id").notNull().references(() => dispatches.id),
  ordinal: integer().notNull(),
  operation: text().notNull(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  turnRowId: bigint("turn_row_id", { mode: "number" })
    .references(() => turns.id),
  receiptId: uuid("receipt_id").notNull().references(() => receipts.id),
  inputHash: text("input_hash"),
}, (t) => [
  primaryKey({ columns: [t.dispatchId, t.ordinal] }),
  uniqueIndex("dispatch_items_receipt_uniq").on(t.receiptId),
  check("dispatch_items_ordinal", sql`${t.ordinal} BETWEEN 0 AND 7`),
]);

export const sessionDigests = pgTable("session_digests", {
  sessionId: uuid("session_id").primaryKey().references(() => sessions.id),
  workspaceId: uuid("workspace_id").notNull(),
  title: text().notNull(),
  agentId: text("agent_id"),
  state: admissionState().notNull(),
  status: sessionStatus().notNull(),
  lastTurnSummary: text("last_turn_summary").notNull().default(""),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
    .notNull(),
  revision: integer().notNull().default(0),
  sourceSessionRevision: integer("source_session_revision").notNull(),
  summarizedTurnSequence: integer("summarized_turn_sequence"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull().defaultNow(),
}, (t) => [
  index("session_digests_candidates_idx")
    .on(t.workspaceId, t.agentId, t.state, t.lastActivityAt),
  check("session_digests_title_size",
    sql`octet_length(${t.title}) <= 240`),
  check("session_digests_summary_size",
    sql`octet_length(${t.lastTurnSummary}) <= 2048`),
]);

export const dispatchDecisions = pgTable("dispatch_decisions", {
  id: uuid().primaryKey(),
  dispatchId: uuid("dispatch_id").notNull().references(() => dispatches.id),
  ordinal: integer().notNull(),
  kind: text().notNull(),
  basedOnDecisionId: uuid("based_on_decision_id"),
  model: text(),
  promptVersion: text("prompt_version"),
  policyVersion: integer("policy_version").notNull(),
  candidateSnapshot: jsonb("candidate_snapshot").notNull(),
  decision: jsonb(),
  userOverride: jsonb("user_override"),
  outcome: text().notNull(),
  latencyMs: integer("latency_ms").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  reservedCostMicros: bigint("reserved_cost_micros", { mode: "bigint" }),
  actualCostMicros: bigint("actual_cost_micros", { mode: "bigint" }),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull().defaultNow(),
}, (t) => [
  uniqueIndex("dispatch_decisions_ordinal_uniq")
    .on(t.dispatchId, t.ordinal),
  check("dispatch_decisions_latency", sql`${t.latencyMs} >= 0`),
]);

export const workspaceDispatchPolicies = pgTable(
  "workspace_dispatch_policies",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    revision: integer().notNull().default(0),
    paused: boolean().notNull().default(false),
    idlePauseMinutes: integer("idle_pause_minutes").notNull().default(30),
    proposeCloseHours: integer("propose_close_hours").notNull().default(72),
    maxSplit: integer("max_split").notNull().default(3),
    classifierProfileId: text("classifier_profile_id").notNull(),
    modelBudget: jsonb("model_budget").notNull(),
  },
  (t) => [
    check("workspace_dispatch_max_split",
      sql`${t.maxSplit} BETWEEN 1 AND 8`),
    check("workspace_dispatch_idle_positive",
      sql`${t.idlePauseMinutes} > 0`),
  ],
);
```

관계와 저장 규칙:

- `dispatch_items`는 적용된 실행 입력/control만 기록한다. 직접 응답은 `dispatches.result`에 저장하며 가짜 session을 만들지 않는다.
- 혼합 split은 신규 session과 기존 session append를 같은 membership 테이블로 표현한다.
- `turn_row_id`는 내부 bigint FK다. 외부 `turn_id`는 해당 session의 sequence 문자열이다. 현재 DB 코드가 이 차이를 명시한다. [A9]
- `operation`별 turn 필요 여부와 session 일치는 DB CHECK/FK 또는 acceptance 검증으로 강제한다.
- `dispatch_decisions.kind`는 `classification`, `heuristic`, `selection`, `override`, `failure` 중 하나다.
- override는 기존 classification row를 덮어쓰지 않고 새 row로 추가한다. `based_on_decision_id`에는 self-FK를 둔다.
- candidate snapshot은 최대 10개, 전체 64 KiB 이하로 제한한다.
- I0 workspace/agent FK와 actor 연결을 실제 migration에서 추가한다.
- 기존 session·turn·receipt 테이블이나 `pod_id`를 제거하지 않는다.

추가로 필요한 내구성 데이터:

| 데이터 | 키와 용도 |
|---|---|
| source thread binding | `(workspace_id, source, instance_id, thread_id)` unique → canonical session. I3와 공유하며 중복 구현하지 않는다. |
| digest job | `session_id` unique, 원하는 최신 finalized sequence, claim token, retry 시각. finalize와 함께 upsert한다. |
| workspace pause batch/member | pause 명령 receipt와 대상 session/control receipt를 연결한다. 부분 완료를 숨기지 않는다. |
| model budget bucket/reservation | workspace·기간·모델별 예산과 실제 호출별 예약을 원자적으로 관리한다. |
| resume priority | alpha scheduler의 세션 배정 요청에 일회성 우선순위와 원인 receipt를 추가한다. 별도 permit pool을 만들지 않는다. |

## 5. 원자적 적용과 FIFO

### 5.1 트랜잭션 경계

```text
T0: Accept
  idempotency lock
  → root receipt
  → dispatch(received)
  → idempotency key
  → commit
  → HTTP 202

T1: Claim
  dispatch claim token
  → deciding
  → commit

Outside transaction
  fast path or candidate retrieval
  → classifier call
  → schema and policy validation

T2a: Require confirmation
  claim token + revision check
  → candidates + expires_at
  → needs_confirm
  → audit rows
  → commit

T2b: Apply
  workspace policy + dispatch + target sessions lock
  → revalidate
  → all session/turn/control rows + child receipts + queue intents
  → dispatch_items
  → dispatch(applied) + root receipt(succeeded)
  → commit
```

T0 이후 프로세스가 죽어도 `received` row를 다시 처리한다. 알림 전송은 작업 발견의 최적화이며, DB polling으로 복구할 수 있어야 한다.

일관된 lock 순서를 사용한다.

1. API 멱등 advisory lock.
2. workspace policy/budget row.
3. dispatch row.
4. 대상 sessions를 ID 정렬 순으로 잠금.
5. 관련 turn/queue/control row.

동일 기능의 API·정책 job·reconciler가 같은 순서를 따른다. LLM·외부 실행 backend·Slack 전송 중에는 이 잠금을 유지하지 않는다.

### 5.2 결정별 적용

| 결정 | T2b에서 원자적으로 저장할 내용 |
|---|---|
| `new_session` | I0 agent/release 연결, session, sequence `1` turn, `create_session` receipt, queue/signal, dispatch item |
| `route_to_session` | session lock 아래 다음 sequence turn, `append_message` receipt, queue/signal, dispatch item |
| `answer_directly` | 답변과 근거 snapshot, dispatch 결과, root receipt 성공. session/turn 없음 |
| `close_session` | 정상 close 선행 조건 확인, close receipt, admission `closed`, dispatch item |
| `split` | 모든 항목의 위 입력 저장을 하나의 트랜잭션으로 수행 |
| 확인된 control | 기존 interrupt/pause/terminate acceptance와 child receipt, dispatch item |

기존 `acceptInputAtomic()`은 스스로 transaction을 연다. 이를 여러 번 호출하면 split 전체 원자성이 성립하지 않는다. `acceptSessionWithin(tx, ...)`, `appendTurnWithin(tx, ...)`, `acceptControlWithin(tx, ...)`처럼 같은 transaction을 받는 내부 primitive를 추출한다. 기존 public API는 그 위에서 현재 응답을 유지한다. [A2][A14]

split 적용 전 모든 항목의 권한, release, repository, admission, backlog quota를 검증한다. 하나라도 실패하면 session/turn/child receipt가 하나도 남지 않는다.

slot이 부족하다는 이유로 일부 항목만 수락하지 않는다. backlog quota가 허용하면 모두 queued로 수락하고 alpha scheduler가 실행 slot을 배정한다. backlog quota가 부족하면 전체 적용을 거절한다.

### 5.3 FIFO의 정확한 의미

현재 sequence unique 제약은 중복 번호만 막는다. 다음 번호 계산의 경쟁, 여러 consumer의 동시 SDK 전달까지 해결하지 않는다. [A9][A10]

필수 규칙:

- append마다 session row를 먼저 잠그고 `max(sequence)+1`을 할당한다.
- turn insert, queue insert, child receipt insert를 같은 transaction에서 수행한다.
- public `turn_id`는 `String(sequence)`다.
- 일반 실행은 가장 작은 미처리 sequence부터 수행한다.
- 현재 turn이 running/needs_input/outcome_unknown이면 다음 일반 turn을 SDK에 전달하지 않는다.
- claim/worker polling은 admission, execution generation, lease epoch를 함께 검증한다.
- control과 기존 pending answer는 일반 turn FIFO와 다른 lane이다. 필요한 승인 답변이 queued turn 뒤에 막히면 안 된다.
- 오래된 worker의 ACK/finalize는 fence 검증으로 거절한다.

서로 다른 dispatch가 같은 session으로 향할 때 FIFO 순서는 **turn 수락 transaction의 직렬화 순서**다. classifier 완료 전 POST 도착 순서까지 보장하지 않는다. 이를 보장하려면 별도 per-thread ingress sequencing이 필요하다.

split의 원자적 수락 이후 한 실행이 실패해도 이미 수락된 다른 실행을 자동 취소하지 않는다. 실행 결과는 각 turn/receipt에서 보고한다.

## 6. Fast path

Relay fast path는 40자 이하의 상태 질문에서 ACTION, DESTRUCTIVE, NEGATION을 제외하며, task-scoped reply도 제외한다. [R2] 이 보수적인 원칙을 유지한다.

| 규칙 | 예시 | I2 처리 | LLM |
|---|---|---|---|
| INTENT만 있음 | `현재 상태?`, `what's running?` | 권한이 있는 status read model을 조회해 직접 응답 | 0 |
| INTENT + ACTION | `큐 상태 확인하고 고쳐줘` | 일반 분류. 상태 답변으로 작업을 삼키지 않음 | 필요 시 |
| DESTRUCTIVE | `stop`, `kill`, `취소해`, `초기화` | fast path 금지. control 확인 또는 일반 작업 분류 | 0회 강제 조건 없음 |
| NEGATION | `멈추지 마`, `not running`, `안 끝났어?` | fast path 금지. 문맥 해석 또는 확인 | 필요 시 |
| 명시적 session target | 특정 session에 `상태 알려줘` 전달 | classifier 없이 해당 session에 원문 enqueue | classifier 0 |
| quoted/code/mixed intent | `` `kill` 사용법 설명하고 수정해줘 `` | 단순 regex control 실행 금지 | 필요 시 |
| `target.agent_id`만 지정 | 특정 agent의 현황 질문 | 범위가 명확한 읽기만 허용. 전체 workspace 상태로 바꾸지 않음 | 0 또는 일반 분류 |

**DESTRUCTIVE는 절대로 regex 실행 fast path를 통과하지 않는다.** 이는 classifier를 반드시 호출한다는 뜻이 아니라, regex 결과만으로 부작용을 실행하지 않는다는 뜻이다.

control 의도 대응:

| 확인한 사용자 의도 | 실제 명령 |
|---|---|
| 현재 turn만 중단 | `POST /v1/sessions/{id}/interrupt`, 정확한 `target_turn_id` |
| 현재 작업을 안전하게 마친 뒤 일시정지 | `POST /v1/sessions/{id}/pause`, `expected_revision` |
| 실행을 강제로 내리고 새 dispatch 차단 | `POST /v1/sessions/{id}/terminate`, `expected_revision` |
| session을 논리적으로 종료 | 신규 `POST /v1/sessions/{id}/close`, 별도 확인 |
| 모호한 `멈춰` | interrupt/pause/terminate 차이를 설명하는 확인 카드 |

typed control 버튼은 사용자가 동작을 명시한 기존 control API 경로다. 자연어 regex fast path와 구별한다.

`target.session_id`의 원문 enqueue는 주소 지정이지 control 해석이 아니다. 예를 들어 target과 함께 제출된 `stop`을 임의로 terminate endpoint로 전환하지 않는다. UI의 제어 버튼은 명시적 control API를 사용해야 한다.

status 응답은 실제 session status, admission, queued turn 수, pending request 수, 관찰 시각을 표시한다. 알 수 없는 execution 상태를 “실행 없음”으로 표현하지 않는다. 현재 reader의 `attention` 및 일부 durability 필드는 고정 `null`이므로 이를 확정적인 정상 상태로 해석하지 않는다. [A15]

Relay regex는 한국어·영어 일부 표현만 다룬다. 한국어 부정의 붙여쓰기, 일본어, 인용문, Unicode 정규화는 별도 fixture로 검증한다. [R2]

## 7. Session digest와 후보 검색

### 7.1 읽기 모델

필수 필드:

```ts
export const sessionDigestSchema = z.object({
  session_id: sessionIdSchema,
  title: boundedText(240),
  agent_id: opaqueIdSchema.nullable(),
  state: z.enum([
    "active",
    "pausing",
    "paused",
    "resuming",
    "stopping",
    "stopped",
    "recovery_required",
    "closed",
  ]),
  status: z.enum([
    "queued", "running", "needs_input", "idle", "failed", "stopped",
  ]),
  last_turn_summary: z.string().refine(
    (value) => utf8.encode(value).length <= 2048,
    "Summary exceeds the UTF-8 byte limit",
  ),
  last_activity_at: timestampSchema,
  revision: revisionSchema,
  source_session_revision: revisionSchema,
  summarized_turn_sequence: z.number().int().positive().nullable(),
}).strict();
```

- `state`는 admission state다. 실행 관찰용 `status`와 혼용하지 않는다.
- `revision`은 digest 자체의 버전이다.
- `source_session_revision`은 이 digest가 반영한 session 버전이다.
- `summarized_turn_sequence`는 마지막으로 요약한 finalized turn이다.
- legacy session의 agent를 추정하지 않는다. `agent_id=null`로 backfill하고 명시적 agent routing 후보에서는 제외한다.
- 직렬화된 digest 한 개는 4 KiB 이하, title 240 bytes, summary 2 KiB 이하를 보장한다.

### 7.2 갱신 책임

| 이벤트 | 갱신자 | 처리 |
|---|---|---|
| session 생성 | acceptance transaction | 제목·agent·state·활동 시각 초기화 |
| turn 수락 | acceptance transaction | 활동 시각 갱신 |
| control/admission 변경 | control state machine | state와 source revision 동기 갱신 |
| turn finalize | finalize transaction | terminal 상태 반영, digest job upsert |
| 요약 완료 | summarizer job | 해당 finalized sequence의 요약을 CAS 갱신 |
| 제목·agent metadata 변경 | I0 projection handler | 필요한 필드와 digest revision 갱신 |

기존 worker protocol에는 `finalize_key`, terminal status/result/usage, checkpoint 계약이 있다. 다만 이것이 현재 체크아웃의 완성된 finalize handler를 증명하지는 않는다. digest job 연결은 실제 finalize transaction 구현에 추가해야 한다. [A16]

요약기는 다음을 지킨다.

- finalize transaction 안에서 모델을 호출하지 않는다.
- `(session_id, finalized sequence)` 기준으로 중복 작업을 합친다.
- 늦게 끝난 이전 요약이 최신 요약을 덮어쓰지 않는다.
- 요약 작업이 state·agent·activity를 오래된 값으로 되돌리지 않는다.
- 실패하면 이전 요약과 `summarized_turn_sequence`를 유지한다.
- `failed`, `interrupted`, `outcome_unknown`을 성공 완료로 요약하지 않는다.
- heartbeat, 상태 조회, 요약 작업 자체는 사용자 활동으로 계산하지 않는다.
- 원본 event/transcript에서 재생성할 수 있어야 한다.

### 7.3 후보 검색과 ranking

1. 인증된 actor가 읽고 사용할 수 있는 workspace/session만 검색한다.
2. target agent, repository 제약과 source thread binding을 적용한다.
3. closed는 일반 route 후보에서 제외한다.
4. paused/resuming/recovery-required는 자동 enqueue 후보로 사용하지 않고 상태를 설명하는 확인 후보로만 노출한다.
5. 최대 50개를 검색하고 최대 10개만 classifier context에 넣는다.

초기 ranking 제안:

```text
score =
  0.50 × same_source_thread
+ 0.30 × same_agent
+ 0.20 × exp(-age_hours / 24)
```

- source thread 일치는 source와 instance까지 같은 경우다.
- same agent는 명시적 agent 또는 I0 thread의 agent에서 계산한다.
- 점수가 같으면 `last_activity_at DESC, session_id ASC`로 결정적으로 정렬한다.
- 1·2위 점수 차이가 0.05 미만인 모호한 후보군은 확인 대상으로 표시한다.
- recency 점수는 주제 일치의 증거가 아니다. 최근 session이라는 이유만으로 자동 route하지 않는다.
- canonical thread binding이 있으면 해당 session이 우선이다. 분류 결과만으로 binding을 교체하지 않는다.

### 7.4 classifier prompt

prompt는 다음 구조로 고정하고 버전을 관리한다.

```text
System
  Allowed decisions and immutable safety rules
  Read-only classifier role
  Output JSON schema
  Confirmation rules

Workspace policy
  Allowed agents and repositories
  max_split and policy version

Candidate data
  Candidate ID
  Session ID, agent, title
  Admission state and execution status
  Last-turn summary
  Last activity and digest revision
  Ranking features

Untrusted user input
  Original input text
```

후보 summary와 사용자 입력은 명령이 아닌 데이터로 구획한다. classifier에는 shell, runtime control, DB mutation 도구를 제공하지 않는다.

최대 입력 8,000 tokens, 출력 1,000 tokens를 초기 상한으로 제안한다. 실제 tokenizer로 계산한다.

- 낮은 순위 후보부터 줄일 수 있지만 사용자 원문을 조용히 잘라 분류하지 않는다.
- 원문만으로 예산을 초과하면 heuristic 후보를 제시하며 `needs_confirm`으로 전환한다.
- 모델이 후보에 없는 session ID를 출력하면 schema 성공 여부와 관계없이 거절한다.
- 모델/가격/endpoint는 operator가 허용한 classifier profile에서 선택한다.

### 7.5 I4 memory 재사용

I4는 digest를 session 검색과 memory 수집의 입력으로 재사용한다.

- 참조 키: session ID, digest revision, summarized turn sequence.
- digest는 재생성 가능한 요약이며 원본 transcript·checkpoint·사용자 승인 기록을 대체하지 않는다.
- 장기 memory 승격 시 provenance와 visibility를 유지한다.
- summary에 없는 사실을 memory가 추정해서 채우지 않는다.
- I4 검색 결과도 workspace/Grant 검증 후 classifier에 전달한다.
- I2 출시를 vector store 또는 장기 memory 구현에 의존시키지 않는다.

## 8. 수명주기 정책

### 8.1 idle → pause

기본 제안은 30분이며 workspace 설정 `idle_pause_minutes=N`으로 조정한다.

대상 조건:

- admission `active`.
- 현재 running/needs_input turn 없음.
- queued turn 없음.
- 미해결 pending request 없음.
- 마지막 의미 있는 활동으로부터 N분 경과.
- 최근 activity와 revision을 session lock 아래 재확인.

조건을 만족하면 기존 pause acceptance를 호출한다.

```text
active → pausing → paused
```

pause는 현재 turn drain, checkpoint, execution 종료를 의미한다. checkpoint 실패·불확실한 execution 상태를 숨기고 paused로 표시하지 않는다. 현재 OpenAPI도 이 의미를 기술한다. [A6]

정책 tick은 `(session_id, observed revision, policy version)` 기반 idempotency key를 사용한다. 반복 tick이나 다중 정책 worker가 중복 pause를 만들지 않는다.

Relay는 `waiting_input` 등에도 idle stop을 enqueue하지만 I2는 이를 그대로 옮기지 않는다. unresolved permission callback을 잃는 위험 때문에 기본 idle pause 대상에서 제외한다. [R4]

### 8.2 long idle → close 제안

기본 제안은 72시간이다.

- 정상적으로 paused/stopped이고 진행 중·미해결·outcome_unknown 작업이 없는 session에만 close 후보를 만든다.
- `needs_confirm` dispatch로 기록한다.
- 사용자가 확인하지 않으면 닫지 않는다.
- 같은 activity revision에 반복 제안하지 않는다.
- 거절 후 새 활동 또는 정책상 재제안 시점까지 억제한다.

### 8.3 정상 close 계약

현재 일반 close endpoint는 없다. `recovery-decisions.close`는 unknown outcome에 대한 operator 결정이므로 재사용하지 않는다. [A7]

신규 계약:

```ts
export const closeSessionRequestSchema = z.object({
  expected_revision: revisionSchema,
  reason: boundedText(512),
}).strict();
```

`POST /v1/sessions/{id}/close`는 다음 조건에서만 수행한다.

- admission이 `paused` 또는 `stopped`.
- authoritative lifecycle 상태상 execution이 종료되었고 새 실행이 배정될 수 없음.
- running/queued/needs_input/outcome_unknown turn 없음.
- unresolved pending request 없음.
- expected revision 일치.

조건을 만족하면 close receipt와 `admission_state=closed`를 원자적으로 저장한다. `receiptOperationSchema`에 `close_session`을 추가한다.

active session을 닫으려면 먼저 pause 또는 terminate를 명시적으로 수행하고, 결과를 확인한 후 close한다. I2는 분류 한 번으로 강제 종료·복구 결정·close를 숨겨 실행하지 않는다.

여기서 close는 **논리적 입력 차단과 보관 상태**다. worktree·artifact·checkpoint 삭제는 포함하지 않는다.

### 8.4 admission 상태별 처리

| 상태 | 자동 route/append | 제어와 정책 |
|---|---|---|
| `active` | 허용 | interrupt는 특정 turn만 중단. pause/terminate는 revision 검증 |
| `pausing` | 거절, `SESSION_PAUSED` | 다음 turn dispatch 차단. resume의 pause 취소 가능 여부는 alpha control 상태에 따름 |
| `paused` | 거절, `SESSION_PAUSED` | 명시적 resume 필요. idle close 제안 가능 |
| `resuming` | 거절, `SESSION_RESUMING` | 복원 완료 전 입력을 새 worker에 전달하지 않음 |
| `stopping` | 거절, `SESSION_NOT_ACTIVE` | terminate 결과 관찰. 자동 resume 금지 |
| `stopped` | 거절, `SESSION_NOT_ACTIVE` | alpha가 복구 가능성을 확인한 경우에만 명시적 resume |
| `recovery_required` | 거절, `RECOVERY_REQUIRED` | `/recovery-decisions`; classifier가 복구 결정을 대신하지 않음 |
| `closed` | 거절, `SESSION_CLOSED` | reopen 없음. 새 dispatch/session 필요 |

`SESSION_NOT_ACTIVE`는 추가할 오류 코드다. `status=stopped`와 `admission_state=stopped`는 다른 축이다. interrupt 후 관찰 status가 stopped여도 admission이 active이면 다음 정상 입력이 가능하다.

### 8.5 workspace kill switch: pause all

신규 workspace control은 다음 두 단계로 처리한다.

1. workspace policy의 `paused=true`를 원자적으로 커밋하여 신규 실행 배정을 즉시 차단한다.
2. 현재 session들에 pause control을 멱등적으로 fan-out한다.

차단 플래그는 dispatch 적용뿐 아니라 직접 sessions/messages API, scheduler claim, resume에도 적용한다. dispatch endpoint만 막으면 우회할 수 있다.

- 읽기와 status answer는 계속 허용한다.
- 아직 적용되지 않은 작업은 `needs_confirm`에 workspace paused 사유를 표시하고 자동 실행하지 않는다.
- 이미 queued인 turn은 보존하되 실행하지 않는다.
- 현재 running turn은 pause 계약대로 drain한다.
- 모든 실행이 즉시 종료되었다고 응답하지 않는다.
- batch 결과는 session별 `pausing`, `paused`, `PAUSE_BLOCKED`, 실패를 표시한다.
- unresolved permission 등으로 pause가 막히면 사용자에게 해당 상태를 노출한다.
- 강제 종료는 별도 terminate 명령이며 kill switch의 숨은 fallback이 아니다.

resume-all은 workspace gate 해제와 명시적으로 선택한 session resume을 수행한다. 이 kill switch 이전부터 수동 paused였던 session까지 자동으로 재개하지 않는다.

### 8.6 resume queue-head override

Relay의 `qhead`는 task scheduler에서 `qhead DESC, queued_at ASC`로 정렬하며 slot 획득 후 해제한다. turn 내부 순서를 바꾸는 기능이 아니다. [R5]

이를 alpha 94S-131의 session slot 배정 우선순위로 옮긴다.

```ts
export const resumeSessionRequestV2Schema = z.object({
  expected_revision: revisionSchema,
  queue_head: z.boolean().default(false),
  reason: boundedText(512).optional(),
}).strict();
```

- `queue_head=true`는 해당 session의 다음 slot 배정을 한 번 우선한다.
- session 내부 turn sequence와 입력 본문을 변경하지 않는다.
- 실행 중인 다른 session을 강제로 선점하지 않는다.
- 수락 receipt와 우선순위 요청을 같은 transaction에 저장한다.
- slot claim 시 우선순위를 내구성 있게 소비한다.
- 반복 resume replay는 우선순위를 다시 발급하지 않는다.
- starvation 방지를 위해 연속 우선 배정 수와 aging 규칙을 alpha scheduler에 둔다.

현재 resume schema는 `expected_revision`만 받는 strict object이므로 `queue_head`를 보내면 거절된다. 계약·OpenAPI·scheduler의 명시적 확장이 필요하다. [A7]

## 9. Override 로그와 replay 평가

### 9.1 감사 데이터

각 결정에 다음을 남긴다.

- dispatch ID와 candidate/digest revision snapshot.
- model identifier, prompt version/hash, policy version.
- validation을 통과한 decision 또는 실패 코드.
- confidence와 짧은 rationale.
- 모델 호출 latency와 전체 dispatch latency를 분리한 측정값.
- 입력·출력 token, 예약 비용, 확정 비용 또는 비용 불명 상태.
- 자동 적용/확인 요구/거절 결과.
- 사용자가 선택한 candidate와 원래 추천 candidate.
- override actor와 시각.
- timeout·5xx·invalid JSON·candidate mismatch·budget exceeded 구분.

명시적 target과 fast path도 `model=null`인 deterministic decision으로 남긴다. LLM이 선택한 것처럼 통계에 섞지 않는다.

applied 이후 수정은 기존 turn을 수정하는 override가 아니다. 별도 dispatch 또는 control을 생성하고 이전 dispatch를 참조한다.

원문·후보 내용은 평가에 필요한 최소 범위로 보관한다. 일반 애플리케이션 로그에는 원문을 복제하지 않는다. 사용자 피드백을 정답으로 자동 승격하지 않고 검토된 label과 구별한다.

### 9.2 fixture 형식

JSONL 한 줄에 독립 사례 하나를 둔다.

```json
{
  "id": "route-korean-existing-thread-001",
  "suite": "routing",
  "input": {
    "text": "아까 로그인 오류 수정 이어서 해줘",
    "source": "web",
    "target": null
  },
  "policy": {
    "max_split": 3,
    "workspace_paused": false
  },
  "candidates": [
    {
      "session_id": "00000000-0000-4000-8000-000000000201",
      "agent_id": "coding-agent",
      "state": "active",
      "title": "Login failure",
      "last_turn_summary": "Identified a failing authentication test.",
      "same_source_thread": true,
      "revision": 7
    }
  ],
  "expected": {
    "decision": "route_to_session",
    "allowed_session_ids": [
      "00000000-0000-4000-8000-000000000201"
    ],
    "needs_confirm": false,
    "forbidden_effects": [
      "new_session",
      "terminate",
      "close_session"
    ]
  }
}
```

별도 fixture 유형:

- new/route/direct/close/split 각 유형.
- 한국어·영어·일본어, 부정·인용·복합 의도.
- 후보 없음, 동률, stale digest, 잘못된 agent/repository.
- close/split low-confidence item.
- closed race, permission 대기, workspace kill switch.
- timeout/5xx/예산 부족.
- 후보 summary 안의 prompt injection.
- split의 누락·중복 작업, 같은 repository의 충돌 가능성.

train/dev/holdout을 thread와 작업 계열 단위로 분리한다. 동일 대화의 유사 문장이 양쪽에 들어가는 누출을 막는다.

### 9.3 지표와 출시 기준

두 단계를 별도로 평가한다.

1. **classifier 평가:** 다섯 decision별 precision/recall, target 정확도, split 항목 적합성.
2. **정책 적용 평가:** 실제 자동 실행 선택의 precision, 확인 필요 사례의 recall, 금지된 부작용 수.

초기 prompt 변경 출하 기준 제안:

| 지표 | 기준 |
|---|---|
| 자동 적용 new/route/direct precision | 유형별 ≥ 99%; 95% 신뢰구간 하한 ≥ 98% |
| new/route recall | 유형별 ≥ 90% |
| direct-answer recall | ≥ 85% |
| close/split 의도 recognition recall | 유형별 ≥ 95% |
| close/split 확인 누락 | 0건 |
| 파괴적 요청의 regex 실행 fast path | 0건 |
| 잘못된 workspace/session 적용 | 0건 |
| schema·candidate validation 실패의 자동 적용 | 0건 |
| 이전 prompt 대비 유형별 recall | 2%p 초과 하락 없음 |
| 비용·latency | 정책 상한 준수; p95가 승인된 baseline 대비 10% 초과 악화하지 않음 |

- 표본 수와 confusion matrix를 반드시 함께 출력한다.
- 표본이 적어 신뢰구간 기준을 충족하지 못하면 “정확도 100%”만으로 자동 적용을 허용하지 않는다.
- recognition recall은 확인으로 보낸 올바른 close/split 제안을 포함한다. confirm으로 모두 보내 자동 실행 precision만 높이는 편법은 별도 coverage 지표로 드러낸다.
- 실서비스 shadow → 제한된 workspace canary → 확대 순으로 배포한다.
- prompt version을 즉시 이전 버전으로 되돌릴 수 있어야 한다.
- 위 수치는 설계상 gate이며 현재 측정 결과가 아니다.

## 10. 실패 처리와 비용 상한

| 실패 | 처리와 불변 조건 |
|---|---|
| classifier timeout | 추가 호출을 무한 반복하지 않는다. 허용된 heuristic 후보와 신규 session 선택지를 만들어 `needs_confirm` |
| classifier 5xx | 전체 시간·호출 예산 안에서 최대 1회 재시도. 소진 시 `needs_confirm` |
| invalid JSON/schema | 모델 응답을 부분 적용하지 않는다. 허용된 재시도 후 heuristic 확인 |
| 후보 검색 실패 | 빈 후보라고 해석하지 않는다. 저장소 장애로 재시도하거나 failed. 신규 session 자동 생성 금지 |
| 중복 HTTP 제출 | 동일 root receipt와 최초 응답 재생. LLM 비용 재발생 금지 |
| adapter event 중복 | source event unique key로 동일 dispatch 연결 |
| 결정 후 대상 closed | 적용 transaction에서 재검사. 자동 경로는 후보를 갱신해 확인; stale confirm은 409 |
| 대상 권한 회수 | 적용 금지. 접근 불가 대상의 세부 정보를 추가 노출하지 않음 |
| 동시 append | session lock으로 sequence 할당 직렬화; queue/receipt와 함께 commit |
| split 중 한 항목 실패 | 전체 transaction rollback. 부분 child receipt/session/turn 없음 |
| 적용 commit 직후 응답 유실 | 같은 key로 DB 결과 재조회. 재분류·재적용 금지 |
| classifier worker crash | lease/token 기반 인계. 오래된 결과 폐기 |
| 적용 후 runtime 시작 실패 | dispatch는 applied 유지. child receipt/turn/execution 실패로 보고 |
| digest job 실패 | 이전 summary 유지, freshness 표시. 실행 상태를 과거로 되돌리지 않음 |
| 만료 confirm | `410 REQUEST_EXPIRED`; 입력 실행 없음 |
| 모델 예산 부족 | LLM 호출 없이 heuristic `needs_confirm`; 자동으로 비싼 모델로 승격하지 않음 |

비용 정책:

- 기본은 operator가 허용한 소형 저지연 모델이다.
- dispatch당 최대 2회 실제 모델 호출.
- 초기 총 classifier deadline은 5초로 제안한다. timeout 후 동일 요청의 무조건 재호출은 하지 않는다.
- 호출 전에 최대 입력·출력 비용을 workspace budget에서 예약한다.
- minute request/token limit과 daily monetary cap을 함께 적용한다.
- 각 실제 provider 시도와 summarizer 호출을 각각 계상한다.
- retry도 별도 예약을 사용한다.
- 호출 결과가 불명확하면 비용 예약을 즉시 0으로 반환하지 않는다.
- 확정 usage가 오면 실제 비용으로 정산한다.
- budget row update와 reservation insert는 같은 transaction에서 수행한다.
- classifier token budget, summarizer budget, 실행 slot은 다른 자원이다. 94S-131 slot 확보가 LLM 비용 상한을 대신하지 않는다.

## 11. Relay에서 의도적으로 제거하는 개념

| Relay 개념 | I2 결정 | 이유와 대체 |
|---|---|---|
| attach lease | 제거 | Relay는 terminal attach와 daemon 제어 충돌을 막기 위해 lease와 CLI 명령을 제공한다. [R6] I2는 API 기반 다중 사용자 session이며 Grant, revision, worker fence로 제어한다. 브라우저 연결을 execution 소유권으로 취급하지 않는다. |
| 별도 permit pool | alpha 94S-131 slot으로 통합 | Relay pool은 동기 SQLite count+insert와 daemon scheduler에 의존한다. [R7] 분산 API/worker 환경에서 독립 pool을 추가하면 quota가 이중 계상된다. |
| SQLite event log/projection | 제거 | Relay의 event/projection/ws frame transaction 원칙은 유지하지만 PostgreSQL acceptance·events·receipts를 사용한다. [R8] SQLite dual write를 도입하지 않는다. |
| Relay의 runtime spawn/CLI 제어 | 제거 | agent-platform Runtime Adapter와 Execution Backend가 실행을 소유한다. |
| 자동 idle disposal | close 제안으로 변경 | Relay는 stop/rm 및 worktree 보존 실패를 다룬다. [R4][R6] I2의 close는 사용자 확인 후 논리적 종료이며 파일 삭제를 포함하지 않는다. |
| task-scoped 자연어 permission answer | 제거 | Relay는 waiting permission에 route된 텍스트를 answer로 처리할 수 있다. [R9] I2는 pending `request_id`, attempt, expiry에 결합된 typed answers만 허용한다. |
| 메시지 순서로 답변 연결 | 제거 | dispatch ID와 receipt ID로 직접 연결한다. |
| 무제한 redispatch | 금지 | 이미 적용된 입력의 중복 실행을 막는다. Relay의 terminal 재분류 제한도 유지한다. [R3] |

Relay의 durable transaction은 worker 시작까지 원자적으로 만들지 않는다. I2도 이 구분을 유지한다.

## 12. 테스트 및 검증 계획

### 12.1 Unit

- INTENT/ACTION/DESTRUCTIVE/NEGATION 조합.
- 40자 경계, UTF-8 byte 경계, whitespace-only 입력.
- 한국어 붙여쓰기 부정, 일본어, 인용문, 코드 block.
- target session 우회와 agent-only 후보 제한.
- decision strict union과 cross-field validation.
- `max_split=1`, 2개 최소, 최대 초과, 항목별 low confidence.
- split 중복 session, nested split, 총 입력 byte 초과.
- candidate ID 위조, stale revision, expiry 경계.
- 비용 예약·재시도·늦은 모델 결과 token 불일치.
- digest 최신 sequence CAS와 state 보존.

### 12.2 PostgreSQL integration

기존 테스트에는 생성의 atomic rows와 동일 key 10개 동시 요청 사례가 있다. 테스트 파일 존재는 이번 실행의 통과 증거가 아니다. [A17]

추가 검증:

| 시나리오 | DB에서 확인할 결과 |
|---|---|
| new dispatch | root receipt 1, session 1, turn 1, child receipt 1, queue 1 |
| route dispatch | 기존 session 유지, 다음 sequence turn 1, child receipt 1 |
| direct answer | root 성공과 답변만 존재; session/turn/queue 증가 없음 |
| mixed split | 모든 item과 receipt가 함께 존재 |
| split 중간 insert 실패 | 모든 child write rollback |
| 동일 key 20개 동시 요청 | dispatch/root receipt/model reservation 각각 1회 |
| 다른 key로 동일 source event | 동일 dispatch 재사용 |
| 동일 key 다른 payload | 409, 추가 write 없음 |
| 동시 서로 다른 confirm | 하나만 적용 |
| expiry와 confirm 경쟁 | commit 기준으로 한 결과만 존재 |
| decide/apply 사이 close | 새 turn 없음 |
| 같은 session에 동시 append | unique sequence, 입력과 receipt 대응, 실행 FIFO |
| head turn claim 중 두 번째 consumer | 다음 turn의 조기 실행 없음 |
| pause/kill switch와 claim 경쟁 | gate 이후 새로운 실행 claim 없음 |
| DB commit 응답 유실 | replay로 복구, 추가 부작용 없음 |
| stale worker finalize | epoch/token 검증 실패 |
| digest worker 역순 완료 | 최신 summary 유지 |

실제 PostgreSQL을 사용한다. SQLite/PGlite만으로 advisory lock, row lock, 다중 connection race를 검증했다고 보고하지 않는다.

### 12.3 Lifecycle 및 runtime

- idle 직전 새 입력이 들어오면 잘못 pause하지 않는지 확인.
- pending permission이 idle reaper 대상에서 제외되는지 확인.
- checkpoint 실패 시 paused 성공을 표시하지 않는지 확인.
- workspace pause-all의 부분 실패·재시도·membership 추적.
- resume priority 1회 소비와 일반 queue starvation 방지.
- close 이후 직접 messages API로 우회할 수 없는지 확인.
- 실제 SDK/worker에서 turn 순서, interrupt 대상, pause/resume 복원을 확인.

### 12.4 평가 실행

다음 경로와 명령은 **구현할 harness 인터페이스 제안**이다. 현재 존재하거나 실행한 것으로 간주하지 않는다.

```sh
bun run scripts/eval-dispatch.ts \
  --fixtures tests/fixtures/dispatch/holdout.jsonl \
  --prompt-version dispatch-v1 \
  --mode replay
```

replay는 저장된 모델 출력으로 schema·policy·apply 계획을 검증한다. 새 prompt의 품질은 별도의 live classifier run으로 측정한다.

```sh
bun run scripts/eval-dispatch.ts \
  --fixtures tests/fixtures/dispatch/holdout.jsonl \
  --prompt-version dispatch-v2 \
  --baseline dispatch-v1 \
  --mode live \
  --budget-profile dispatch-eval
```

실제 실행 결과에는 command, 모델 식별자, prompt/fixture hash, 사례 수, skip 수, 유형별 precision/recall, latency, 비용을 포함한다.

`bun run check`는 현재 root script로 존재하지만 이번 설계 작업에서는 실행하지 않았다. 현재 integration suite도 DB 설정이 없으면 skip되므로 exit code만으로 DB 검증 완료를 판단하지 않는다. [A17]

## 13. I2 티켓 분할 제안

각 티켓은 한 PR로 완료한다. 아래는 티켓 생성이나 현재 Linear 완료 상태의 주장 없이 제안하는 분할이다.

| 순서 | 티켓 | 주요 변경과 완료 기준 | 의존 |
|---|---|---|---|
| 1 | **Dispatch 계약·receipt 확장·저장 기반** | Zod/OpenAPI, dispatch receipt union, core tables, T0 수락·GET·멱등 replay. session 없는 receipt contract test | I0 workspace/actor/Agent 연결, 94S-132 권한 계약 |
| 2 | **공유 acceptance와 원자적 dispatch 적용** | tx 기반 new/append primitive, root/child receipt, split 전체 rollback, sequence 직렬화. 실제 PostgreSQL race test | 1, alpha append 및 admission-aware 실행 경로 |
| 3 | **Session digest와 후보 검색** | 초기화/backfill, finalize job, CAS summarizer, source-thread 연결 인터페이스, ranking·size limit | 1, I0 session-agent 연결, alpha finalize |
| 4 | **Classifier·fast path·비용 제한·기본 eval harness** | 모델 adapter, prompt version, deterministic guard, timeout fallback, 호출별 예산 예약, replay/live harness | 1, 3 |
| 5 | **확인·후보 선택·override 감사** | confirm API, expiry/CAS, candidate refresh, close/split confirmation gate, append-only feedback | 2, 4 |
| 6 | **Idle·workspace pause·resume 우선순위·정상 close** | policy job, pause batch, scheduler gate, queue-head extension, 정상 close 계약 및 검증 | 2, 5, alpha control/checkpoint, 94S-131 |
| 7 | **통합 실패 검증과 prompt 출하 gate** | 전 경로 PostgreSQL/runtime QA, 장애 주입, holdout 기준, shadow/canary 및 rollback 절차 | 2–6 |

의존 순서:

```text
I0 / alpha prerequisites
          │
          ▼
          1
        ┌─┴─┐
        ▼   ▼
        2   3
        │   ▼
        │   4
        └─┬─┘
          ▼
          5
          ▼
          6
          ▼
          7
```

2와 3은 공통 계약이 고정된 뒤 병행할 수 있다. I3 Slack 완료는 core dispatch 출시의 필수 조건이 아니지만, source/thread/event 계약은 I3와 공유한다. I4는 digest를 소비하며 I2가 I4 memory 구현을 기다리지는 않는다.

## 14. 실제 확인한 코드 근거

`A`는 agent-platform, `R`은 Relay다. 링크는 실제 읽은 파일의 시작 행을 가리킨다.

| 근거 | 파일·행 | 확인 내용 |
|---|---|---|
| A1 | [apps/api/src/routes/sessions.ts:70–100][A1] | quota 미구현 주석, key 필수, `201` |
| A2 | [packages/db/src/postgres-unit-of-work.ts:38–124][A2] | advisory lock, replay, session/turn/queue/receipt/key transaction |
| A3 | [packages/contracts/src/api/receipt.ts:13–56][A3] | receipt operation/status, session 필수 target |
| A4 | [packages/contracts/src/api/turn.ts:21–31][A4] | append enqueue 계약 |
| A5 | [apps/api/src/server.ts:26–36][A5] | production 라우트 등록 |
| A6 | [packages/contracts/src/openapi.ts:147–262][A6] | messages, pending, answers, control, receipt 선언 |
| A7 | [packages/contracts/src/api/control.ts:7–54][A7] | control body, strict resume, recovery close |
| A8 | [packages/contracts/src/api/pending.ts:23–44][A8] | turn/attempt 필수 pending 계약 |
| A9 | [packages/db/src/schema.ts:34–237][A9] | sessions, sequence, queue, receipts, idempotency, pending |
| A10 | [packages/queue/src/postgres.ts:84–127][A10] | visible queue row claim, ID 정렬, SKIP LOCKED |
| A11 | [packages/platform/src/authorization/policy.ts:1–16][A11] | owner 기반 read/write, scopes 선행 조건 |
| A12 | [packages/contracts/src/api/session.ts:136–163][A12] | 입력 byte 제한과 생성 계약 |
| A13 | [packages/platform/src/sessions/session-service.ts:30–53][A13] | canonical payload hash |
| A14 | [packages/db/src/enqueue.ts:26–59][A14] | caller transaction queue 저장·signal |
| A15 | [packages/db/src/postgres-unit-of-work.ts:299–319][A15] | detail projection의 미구현/null 값 |
| A16 | [packages/contracts/src/worker-protocol/index.ts:131–148][A16] | finalize 계약 |
| A17 | [apps/api/src/sessions.integration.test.ts:30–32,136–203][A17] | DB 없을 때 skip, atomic create·동시 key 테스트 정의 |
| R1 | [src/dispatcher/schema.ts:4–65][R1] | decision, split guard, max_split schema |
| R2 | [src/core/fastpath.ts:6–28][R2] | intent/action/destructive/negation, status 응답 |
| R3 | [src/gateway/routes.ts:40–77][R3] | 메시지 수락, explicit reply, 중복·redispatch 제한 |
| R4 | [src/lifecycle/idle.ts:10–34][R4] | idle stop, 자동 close/disposal |
| R5 | [src/core/queue.ts:12–36][R5] | qhead 정렬, slot 획득·소비 |
| R6 | [src/core/tasks.ts:197–239][R6] | close, attach lease, pause/resume |
| R7 | [src/core/permits.ts:8–36][R7] | SQLite permit과 permission 대기 예외 |
| R8 | [src/core/events.ts:17–44][R8] | event/projection/frame transaction |
| R9 | [src/core/tasks.ts:47–67][R9] | decision 적용, permission answer, close 확인 |
| R10 | [src/dispatcher/dispatcher.ts:61–98][R10] | fast path, classifier retry, needs_confirm 분기 |

[A1]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/apps/api/src/routes/sessions.ts:70
[A2]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/db/src/postgres-unit-of-work.ts:38
[A3]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/api/receipt.ts:13
[A4]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/api/turn.ts:21
[A5]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/apps/api/src/server.ts:26
[A6]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/openapi.ts:147
[A7]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/api/control.ts:7
[A8]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/api/pending.ts:23
[A9]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/db/src/schema.ts:34
[A10]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/queue/src/postgres.ts:84
[A11]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/platform/src/authorization/policy.ts:1
[A12]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/api/session.ts:136
[A13]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/platform/src/sessions/session-service.ts:30
[A14]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/db/src/enqueue.ts:26
[A15]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/db/src/postgres-unit-of-work.ts:299
[A16]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/packages/contracts/src/worker-protocol/index.ts:131
[A17]: /Users/dev-soon/orca/workspaces/agent-platform/whiting/apps/api/src/sessions.integration.test.ts:136
[R1]: /Users/dev-soon/workspace/project/relay/src/dispatcher/schema.ts:4
[R2]: /Users/dev-soon/workspace/project/relay/src/core/fastpath.ts:6
[R3]: /Users/dev-soon/workspace/project/relay/src/gateway/routes.ts:40
[R4]: /Users/dev-soon/workspace/project/relay/src/lifecycle/idle.ts:10
[R5]: /Users/dev-soon/workspace/project/relay/src/core/queue.ts:12
[R6]: /Users/dev-soon/workspace/project/relay/src/core/tasks.ts:197
[R7]: /Users/dev-soon/workspace/project/relay/src/core/permits.ts:8
[R8]: /Users/dev-soon/workspace/project/relay/src/core/events.ts:17
[R9]: /Users/dev-soon/workspace/project/relay/src/core/tasks.ts:47
[R10]: /Users/dev-soon/workspace/project/relay/src/dispatcher/dispatcher.ts:61



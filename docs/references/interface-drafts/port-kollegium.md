# Kollegium 흡수 코드 포팅 매핑 — I0 핵심 규칙 / I3 Slack

작성일: 2026-09-22. **실행 기반은 agent-platform을 유지하고, Kollegium의 권한·불변 release·공개 범위 규칙과 Slack 어댑터를 선별 이식한다.** 기존 core 패키지 전체를 의존성으로 추가하지 않는다.

## 1. 조사 기준과 현재 구현

먼저 읽은 정본은 요청한 scratchpad의 `context.md`다. hybrid 방향, phase 순서, Telegram 제외, alpha 단일 조직 전제는 변경하지 않는다.

| 구분 | 조사한 로컬 상태 |
|---|---|
| K: 원본 | `/Users/dev-soon/workspace/project/kollegium`, HEAD `d71170603c5254f69f1a72da19c28d054559ee0b`, working tree clean |
| A: 대상 | `/Users/dev-soon/orca/workspaces/agent-platform/whiting`, HEAD `b2c5f187138f758110e6ca5b45f47bc9a0b48ac7`; 시작 시 `?? docs/references/` 존재 |
| 경로·줄 수 | 아래 K/A 상대 경로는 위 루트 기준. 줄 수는 조사 시 `wc -l` 기준 |
| 검증 수준 | 실제 코드·테스트 본문·package manifest·lockfile·공식 문서를 읽은 설계 조사. 테스트 실행, PostgreSQL migration, 실제 Slack OAuth/송수신, CI·merge·release·deployment 검증은 수행하지 않음 |
| 94S-132 | 제공된 context의 operator runtime profile/scoped API key 계약을 의존 조건으로 사용. 이 체크아웃에서 구현 완료로 취급하지 않음 |

A의 현재 배치:

| 파일 | 줄 | 확인 내용과 연결 지점 |
|---|---:|---|
| `apps/api/src/app.ts` | 205 | Hono `/v1` 전체에 bearer 인증, key hash→owner 조회. `AUTH_MODE=none`에서만 `X-Owner-Id`. Slack ingress는 별도 signature-authenticated router 필요 |
| `apps/api/src/keys.ts` | 86 | `ApiKeyStore.findOwner()`는 owner 문자열만 반환. scope/actor/workspace 정보 없음 |
| `apps/api/src/routes/sessions.ts` | 129 | 실제 route는 session create/list/detail. create에는 `Idempotency-Key` 필수. 다른 contract가 있다고 해당 route 구현이 존재하는 것은 아님 |
| `packages/platform/src/authorization/policy.ts` | 17 | `Principal={ownerId}`; read/write 모두 owner 일치 검사. scope는 주석에서도 94S-132의 후속 작업 |
| `packages/platform/src/sessions/catalog.ts` | 28 | config profile/repository 카탈로그. 94S-132부터 `config/profiles.yaml`·`repositories.yaml`(참조만, 값 없음), profile fingerprint·catalog revision 제공 |
| `packages/platform/src/sessions/session-service.ts` | 148 | policy 주입, profile/repository 확인, 기존 입력 접수 port 호출 |
| `packages/db/src/postgres-unit-of-work.ts` | 324 | session·첫 turn·queue·receipt·idempotency를 단일 transaction에 저장. Slack도 이 원자성에 합류해야 함 |
| `packages/db/src/schema.ts` | 302 | UUID session, text owner/profile, turns/events/queue/receipts/idempotency/pending/checkpoints/executions/api_keys. Slack 테이블 없음 |
| `packages/contracts/src/api/session.ts` | 189 | Zod public session 계약. 기존 `profile_id`/`repository_id`와 runtime vocabulary 유지 |
| `packages/contracts/src/worker-protocol/index.ts` | 176 | worker protocol은 실행의 정본. Kollegium Run/engine protocol로 대체하지 않음 |

`api_keys`의 현재 컬럼은 `id,key_hash,owner_id,created_at,revoked_at`이다(A `schema.ts:294–302`). `sessions.profile_id` 컬럼은 이미 있지만 profile 등록·scope enforcement 완료 증거가 아니다. I3의 후속 turn·approval·control 연결은 해당 alpha service가 실제 구현된 뒤 진행한다.

## 2. 파일별 이식 재고

“그대로 이식”은 동작·알고리즘 기준이며 formatter/파일 위치 변경은 허용한다. “제외”는 새 제품 production 코드에서 제외한다는 뜻이다. 테스트의 유효한 규칙은 표에서 별도 이관한다.

### 2.1 `@kollegium/slack`

모든 경로는 K 기준이다.

| 소스 파일 | 줄 | 판정 | 대상 및 변경 |
|---|---:|---|---|
| `packages/slack/src/index.ts` | 5 | 변경 이식 | `chat-slack/src/index.ts`; 새 계약만 export, SQLite subpath 제거 |
| `packages/slack/src/signature.ts` | 96 | 변경 이식 | `chat-slack/src/signature.ts`; HMAC/constant-time/±300초 보존, Hono raw bytes와 연결하고 byte-preserving 입력 계약 명확화 |
| `packages/slack/src/events.ts` | 226 | 변경 이식 | `chat-slack/src/events.ts`; app/team/enterprise 검증·bot/subtype 거절 보존, neutral envelope으로 교체, channel map은 DB 조회 |
| `packages/slack/src/presentation.ts` | 378 | 그대로 이식 | `chat-slack/src/presentation.ts`; 의존성 없는 renderer. mrkdwn escaping, trusted mention allowlist, Unicode, block/fallback/overflow 유지 |
| `packages/slack/src/web-api.ts` | 180 | 변경 이식 | `chat-slack/src/delivery.ts`; legacy transport/error 타입 교체, sleep retry→durable 예약, remote `ts`를 receipt에 저장 |
| `packages/slack/src/app-config.ts` | 221 | 변경 이식 | `chat-slack/src/app-config.ts`; manifest/create/update/rotate/OAuth exchange/membership 재사용. 응답 shape·timeout·HTTP 오류 처리 강화 |
| `packages/slack/src/sqlite.ts` | 86 | 재작성 | `db/src/chat/slack-installations.ts`; SQLite JSON doc와 `(tenant_id,kollege_id)` singleton을 정규화 Postgres 저장소로 대체 |
| `packages/slack/package.json` | 14 | 재작성 | `@agent-platform/chat-slack`, workspace dependencies, typecheck script, TS source export. `./sqlite` 폐기 |

presentation의 3,000자 section·12,000자 전체 메시지·50 blocks는 **원본 구현의 정책값**이다. 특히 12,000자를 Slack 전체 플랫폼의 공통 최대치로 설명하지 않는다. 자동 분할은 chunk별 delivery identity 설계 없이 추가하지 않는다.

| 테스트 파일 | 줄 | 판정·현재 검증 | 새 파일 |
|---|---:|---|---|
| `packages/slack/test/signature.test.ts` | 102 | 변경 이식: raw body 변조, 다른 secret/timestamp, ±300초 경계, header 오류 | `chat-slack/src/signature.test.ts` |
| `packages/slack/test/events.test.ts` | 173 | 변경 이식: challenge/malformed, event key, mention/DM/root thread, app/team mismatch, unbound/bot/subtype 거절 | `chat-slack/src/events.test.ts`, `chat-interface/src/session-binding.test.ts` |
| `packages/slack/test/presentation.test.ts` | 190 | 변경 이식: markdown·한국어·code/link, mention, Unicode·block/message limits, deterministic output, URL 처리 | `chat-slack/src/presentation.test.ts` |
| `packages/slack/test/web-api.test.ts` | 272 | 변경 이식: thread/top-level, unsafe mention, overflow 시 API 미호출, `ok:false`, missing `ts`, 429/permanent/transient | `chat-slack/src/delivery.test.ts` |
| `packages/slack/test/app-config.test.ts` | 222 | 변경 이식: 완전 manifest, create/update/rotate/exchange, `ok:false`, membership 3상 결과 | `chat-slack/src/app-config.test.ts`; OAuth callback/state는 별도 |
| `packages/slack/test/sqlite.test.ts` | 115 | 재작성: round-trip, 없는 agent, reprovision, scoped list, agent/app 중복 방지 | `db/src/chat/slack-installations.integration.test.ts` |

### 2.2 `@kollegium/core`

| 소스 파일 | 줄 | 판정 | 대상 및 보존 부분 |
|---|---:|---|---|
| `packages/core/src/schema.ts` | 447 | 변경 이식 | `contracts/src/domain/{agents,authorization,memory,surfaces}.ts`; release/Grant/Memory/Surface 선별. legacy Run/Conversation/provider 설정 제외 |
| `packages/core/src/authorization.ts` | 186 | 변경 이식 | `platform/src/authorization/grants.ts`; exact-match, revoke/expiry, 허가 전 load 금지. in-memory repository는 production 제외 |
| `packages/core/src/ids.ts` | 131 | 변경 이식 | `platform/src/agents/release-ids.ts`에 canonical hash, binding ID는 chat 쪽. command identity는 alpha idempotency와 중복되어 제외 |
| `packages/core/src/stores.ts` | 374 | 변경 이식 | `platform/src/ports/{agent-repository,grant-repository,memory-repository}.ts`; immutable/CAS port 선별. run/job/outbox는 alpha 소유 |
| `packages/core/src/provision.ts` | 206 | 재작성 | `platform/src/agents/agent-service.ts`와 `platform/src/chat/binding-service.ts`로 분리. release와 Slack lifecycle 결합 제거 |
| `packages/core/src/in-memory.ts` | 715 | 제외 | production Map stores 미이식. 선택한 CAS/memory 규칙만 PostgreSQL 및 최소 test fake로 재작성 |
| `packages/core/src/sqlite.ts` | 1,236 | 제외 | `node:sqlite`, JSON doc, migration/queue/credentials 구현 미이식. 선택 규칙만 DB에 재구현 |
| `packages/core/src/agent.ts` | 469 | 제외 | 실행/context/run loop/outbox는 alpha 담당. 모델 호출 전 deny 사례만 새 integration test로 |
| `packages/core/src/contracts.ts` | 1 | 제외 | `@kollegium/contracts` 재export를 대상 계약으로 대체 |
| `packages/core/src/engine-lifecycle.ts` | 86 | 제외 | Pi/native observer 미이식 |
| `packages/core/src/engine-pi.ts` | 148 | 제외 | Pi engine은 I0/I3 범위 밖 |
| `packages/core/src/engine.ts` | 69 | 제외 | 실행 adapter 추상화 중복 도입 금지 |
| `packages/core/src/job-scope.ts` | 139 | 제외 | alpha session/attempt/epoch fencing 사용 |
| `packages/core/src/llm-openai.ts` | 334 | 제외 | LLM/endpoint는 runtime profile 및 worker 책임 |
| `packages/core/src/runtime.ts` | 291 | 제외 | legacy LLM/policy/audit/credential container 미이식 |
| `packages/core/src/index.ts` | 13 | 재작성 | contracts/platform 각 entry에서 필요한 API만 export |
| `packages/core/src/testing.ts` | 1,091 | 재작성 | 전체 store harness 대신 아래 selected contract cases만 새 fixture로 |
| `packages/core/package.json` | 19 | 제외 | 전체 core 의존성 추가 금지; Zod는 대상 버전 사용 |

| 테스트 파일 | 줄 | 판정·검증 내용 | 새 파일/처리 |
|---|---:|---|---|
| `packages/core/test/authorization.test.ts` | 194 | 변경 이식: actor/service/resource/audience exact match, revoke/expiry/cross-scope, read-before-auth 방지, revoke CAS | `platform/src/authorization/grants.test.ts`, `db/src/grants.integration.test.ts` |
| `packages/core/test/schema.test.ts` | 156 | 변경 이식: canonical key 정렬·array 순서·non-JSON 거절, hash, strict/no-secret schema | `contracts/src/domain/agents.test.ts`, `platform/src/agents/release-ids.test.ts` |
| `packages/core/test/provision.test.ts` | 188 | 재작성: version/release/pointer/binding, home binding, 동일 입력 no-op, 변경/CAS, malformed 무변경 | `platform/src/agents/agent-service.test.ts`, `db/src/agents.integration.test.ts`, `platform/src/chat/binding-service.test.ts` |
| `packages/core/test/in-memory-contract.test.ts` | 34 | 재작성: `src/testing.ts` 공용 store contract 실행 | 위 DB 테스트 및 `platform/src/memory/visibility.test.ts` |
| `packages/core/test/sqlite-contract.test.ts` | 55 | 재작성: 같은 contract의 SQLite 구현 | `db/src/agents.integration.test.ts`, `db/src/memory-visibility.integration.test.ts` |
| `packages/core/test/sqlite-durability.test.ts` | 257 | 일부 재작성: 재시작 후 dedup/delivery. legacy SQLite migration/job/conversation 제외 | `db/src/chat/inbox.integration.test.ts`, `db/src/chat/delivery-receipts.integration.test.ts` |
| `packages/core/test/agent.test.ts` | 255 | 일부 재작성: deny 시 모델 미호출. native run loop fixture 제외 | `platform/src/chat/admission.test.ts` |
| `packages/core/test/command-contract.test.ts` | 124 | 제외: legacy command identity | 기존 alpha `apps/api/src/sessions.integration.test.ts` 회귀 유지 |
| `packages/core/test/composite-provider.test.ts` | 17 | 제외: legacy credential provider 합성 | 없음 |
| `packages/core/test/engine-contract.test.ts` | 120 | 제외: native/Pi engine contract | 없음 |
| `packages/core/test/engine-lifecycle.test.ts` | 73 | 제외: engine lifecycle observer | 없음 |
| `packages/core/test/job-scope.test.ts` | 296 | 제외: legacy job scope/fencing | alpha worker 회귀 유지 |
| `packages/core/test/llm-openai.test.ts` | 583 | 제외: legacy OpenAI HTTP/stream/client | 없음 |
| `packages/core/test/pi-api-spike.test.ts` | 114 | 제외: Pi API spike | 없음 |
| `packages/core/test/secure-store.test.ts` | 100 | 제외: SQLite credential encryption | target secret-provider 별도 검증 |

core 밖의 참고 자료는 K `sample/web/src/provisioning.ts`(744줄), `sample/web/test/provisioning.test.ts`(139줄), `sample/web/test/provisioning-flow.test.ts`(1,101줄)이다. Slack 패키지 자체에는 OAuth state/TTL/callback·config-token rotation 직렬화의 전체 lifecycle이 없다. sample의 시나리오만 API integration test로 재작성한다. **CLI·sample/web·examples·Pi engine·SQLite store·production in-memory adapters는 이식하지 않는다.**

## 3. 대상 배치와 ChatInterface

### 3.1 배치·규약

~~~text
packages/contracts/src/
  domain/{agents,authorization,memory,surfaces}.ts
  chat/envelope.ts
packages/platform/src/
  authorization/{policy,grants}.ts
  agents/{release-ids,agent-service}.ts
  memory/visibility.ts
  chat/{admission,binding-service}.ts
  ports/{agent-repository,grant-repository,memory-repository,chat-store}.ts
packages/chat-interface/src/
  {index,contract,session-binding,mute-policy}.ts
packages/chat-slack/src/
  {index,signature,events,presentation,delivery,app-config,installations}.ts
packages/db/src/
  schema.ts
  {agents,grants,memory-visibility}.ts
  chat/{slack-installations,surface-bindings,session-links,inbox,delivery-receipts}.ts
packages/db/migrations/
apps/api/src/routes/
  {slack-events,slack-oauth,slack-installations}.ts
apps/api/src/server.ts
~~~

새 `packages/domain`은 만들지 않는다. 도메인 service는 기존 `platform`, public Zod schema는 `contracts`, DB 구현은 `db`를 사용한다. `chat-interface`는 공통 adapter 계약·binding·mute policy를 가지며 Slack/Postgres/worker를 import하지 않는다. `chat-slack`의 DB·credential 구현은 API composition root가 주입한다. core→adapter 재export나 순환 의존성을 만들지 않는다.

대상 Bun workspaces `apps/*`, `packages/*`, ESM `exports: "./src/index.ts"`, `workspace:*`, 패키지별 `tsc -p tsconfig.json`을 따른다. root `tsconfig.base.json`의 strict/noEmit/ES2022/Preserve, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, unused 검사 유지. import는 `.ts`, formatter는 Biome 2.2.4의 space/double quotes 관례로 정리한다. 테스트는 대상처럼 `src/*.test.ts`의 `bun:test`로 이동한다.

### 3.2 제안 TypeScript 계약

다음은 **신규 계약 제안**이다. public JSON은 `contracts/src/chat/envelope.ts`의 Zod schema에서 추론하고 adapter interface는 `chat-interface/src/contract.ts`에 둔다. 요청 body의 owner/workspace/actor 권한을 신뢰하지 않는다.

~~~ts
export type ActorRef = Readonly<{
  kind: "user" | "service";
  id: string;
}>;

export type ChatInboundEnvelope = Readonly<{
  version: 1;
  interfaceKind: string;
  installationId: string;
  workspaceId: string;
  eventId: string;
  occurredAt: string;
  actor: ActorRef;
  servicePrincipal: ActorRef;
  surfaceBindingId: string;
  conversationKey: string;
  messageId: string;
  trigger: "mention" | "thread_reply" | "direct_message";
  text: string;
  target: { sessionId: string } | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ScopedSessionBinding = Readonly<{
  workspaceId: string;
  ownerId: string;
  surfaceBindingId: string;
  bindingRevision: number;
  sessionLinkId: string;
  sessionId: string;
  agentId: string;
  releaseId: string;
  profileId: string;
}>;

export type ChatOutboundEnvelope = Readonly<{
  deliveryId: string;
  sourceEventId: string;
  scope: ScopedSessionBinding;
  actor: ActorRef;
  audience: {
    surfaceBindingId: string;
    policyRevision: number;
    authorizedActorIds: readonly string[];
  };
  category: "answer" | "progress" | "approval" | "system";
  content: { format: "markdown" | "plain_text"; text: string };
}>;

export type MuteDecision =
  | { action: "send" }
  | { action: "suppress"; reason: string }
  | { action: "defer"; until: string; reason: string };

export interface ScopedSessionBinder {
  bind(input: ChatInboundEnvelope): Promise<ScopedSessionBinding>;
}

export interface ChatInterface<VerifiedInput, PresentedOutput> {
  readonly kind: string;
  normalizeInbound(input: VerifiedInput): Promise<
    | { kind: "message"; envelope: ChatInboundEnvelope }
    | { kind: "challenge"; challenge: string }
    | { kind: "ignored"; reason: string }
  >;
  presentOutbound(input: ChatOutboundEnvelope): PresentedOutput;
  mutePolicy(
    input: ChatOutboundEnvelope,
    policy: Readonly<{
      bindingMuted: boolean;
      linkMuted: boolean;
      suppressProgress: boolean;
    }>,
  ): MuteDecision;
}
~~~

`VerifiedSlackInput`은 Slack 서명 검증 성공 후에만 생성한다. `SlackChatInterface implements ChatInterface<VerifiedSlackInput, SlackPresentation>`는 `thread_ts ?? ts`를 conversation key로, `team_id:api_app_id:event_id`를 event ID로 정규화한다. Slack timestamp는 number로 바꾸지 않는다. `(team_id,user_id)`는 검증된 내부 사용자/외부 identity로 연결하며 자동 가입·Grant 발급을 하지 않는다.

`ScopedSessionBinder`는 platform service와 DB transaction으로 구현하며 normalizer가 Session을 직접 만들지 않는다. explicit target은 classifier만 생략하고 해당 Session의 scope/Grant/audience 검사는 유지한다.

처리 순서:

1. 설치 경로 조회 → bounded raw body → signature/replay 검증 → parse → app/team/enterprise 교차검증.
2. identity·membership·Grant·binding 검사 → durable inbox insert. URL challenge는 Session 생성 없이 응답.
3. consumer가 `(surface_binding_id,conversation_key)`를 lock/unique로 resolve한다. 새 Session·첫 turn·link·alpha receipt/idempotency는 같은 transaction에 저장한다. 기존 thread는 alpha append-turn service를 사용한다.
4. Slack ACK는 **durable inbox commit 뒤**, 모델 실행 전에 반환한다. DB 실패 시 성공 ACK하지 않는다. Slack의 빠른 ACK/retry 요구를 충족해야 한다. [Events API](https://docs.slack.dev/apis/events-api/)
5. 입력별 actor·Grant/binding revision을 저장한다. `turns.message`만으로 부족하므로 inbox→turn FK 또는 typed input provenance로 연결한다.
6. worker durable 결과에서 delivery intent를 만든 뒤, 현재 ACL과 생성 당시 audience의 교집합을 재검사하고 presenter→send→remote receipt를 확정한다.

Mute는 새 구현이다. 원본 core/slack에는 명시적 mute 정책이 없고 `mode=off|mention|ambient`가 있다. `off`는 admission 중지, mute는 출력 억제로 분리한다. 기본 제안은 binding/link mute 시 Slack 출력을 `suppressed`로 기록하고 approval 대기는 Web pending-request에 남기는 것이다. unmute가 과거 private 결과를 자동 재전송해서는 안 된다. 사용자 알림 mute를 채널 전체 mute로 확대하지 않는다.

## 4. Postgres 테이블 제안

현재 Drizzle entry는 `packages/db/src/schema.ts`다. I0는 Agent/version/release/activation/Grant 및 memory/surface 계약을 추가하고 I3는 아래 테이블을 추가한다. 기존 `receipts`는 API 명령 접수 결과이며 Slack 전달 성공으로 덮어쓰지 않는다.

아래는 **검토용 Drizzle 정의**다. `sessions`, `turns`, `events`, `receipts`는 기존 정의다. workspace/agent/release ID 타입과 FK는 I0 schema 확정 후 연결한다. 예시의 text ID를 무조건 UUID로 변환하거나 hash/Slack ID를 절단하지 않는다. 이 snippet만으로 완성 migration이라고 보지 않으며 뒤의 복합 scope 제약까지 구현한다.

~~~ts
import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, integer, jsonb, pgTable,
  text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

type SecretRef = { provider: string; key: string };
const at = (name: string) => timestamp(name, { withTimezone: true });

export const slackInstallations = pgTable("slack_installations", {
  id: uuid().primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  ownerId: text("owner_id").notNull(),
  agentId: text("agent_id").notNull(),
  publicAgentId: text("public_agent_id").notNull().unique(),
  appId: text("app_id").notNull(),
  teamId: text("team_id"),
  enterpriseId: text("enterprise_id"),
  clientId: text("client_id").notNull(),
  clientSecretRef: jsonb("client_secret_ref").$type<SecretRef>().notNull(),
  signingSecretRef: jsonb("signing_secret_ref").$type<SecretRef>().notNull(),
  botTokenRef: jsonb("bot_token_ref").$type<SecretRef>(),
  botRefreshTokenRef: jsonb("bot_refresh_token_ref").$type<SecretRef>(),
  botUserId: text("bot_user_id"),
  grantedScopes: text("granted_scopes").array().notNull(),
  tokenExpiresAt: at("token_expires_at"),
  eventsRequestUrl: text("events_request_url"),
  state: text().notNull().default("created"),
  revision: integer().notNull().default(0),
  installedAt: at("installed_at"),
  revokedAt: at("revoked_at"),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("slack_installations_app_team_uniq")
    .on(t.appId, t.teamId).where(sql`${t.teamId} IS NOT NULL`),
  uniqueIndex("slack_installations_pending_app_uniq")
    .on(t.appId).where(sql`${t.teamId} IS NULL`),
  uniqueIndex("slack_installations_agent_team_uniq")
    .on(t.workspaceId, t.agentId, t.teamId)
    .where(sql`${t.teamId} IS NOT NULL AND ${t.revokedAt} IS NULL`),
  check("slack_installations_state_check", sql`
    ${t.state} IN ('created', 'awaiting_oauth', 'installed',
                  'configuring', 'ready', 'failed', 'revoked')`),
  check("slack_installations_ready_check", sql`
    ${t.state} NOT IN ('installed', 'configuring', 'ready')
    OR (${t.teamId} IS NOT NULL AND ${t.botTokenRef} IS NOT NULL)`),
]);

export const surfaceBindings = pgTable("surface_bindings", {
  id: uuid().primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  ownerId: text("owner_id").notNull(),
  agentId: text("agent_id").notNull(),
  interfaceKind: text("interface_kind").notNull(),
  slackInstallationId: uuid("slack_installation_id")
    .references(() => slackInstallations.id),
  externalSurfaceId: text("external_surface_id").notNull(),
  surfaceKind: text("surface_kind").notNull(),
  mode: text().notNull().default("mention"),
  environment: text().notNull().default("production"),
  memoryWritePolicy: text("memory_write_policy").notNull().default("deny"),
  muted: boolean().notNull().default(false),
  revision: integer().notNull().default(0),
  disabledAt: at("disabled_at"),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("surface_bindings_slack_surface_uniq")
    .on(t.slackInstallationId, t.externalSurfaceId),
  check("surface_bindings_interface_check", sql`
    ${t.interfaceKind} <> 'slack' OR ${t.slackInstallationId} IS NOT NULL`),
  check("surface_bindings_mode_check", sql`${t.mode} IN ('off', 'mention', 'ambient')`),
  check("surface_bindings_kind_check", sql`
    ${t.surfaceKind} IN ('public_channel', 'private_channel', 'dm')`),
  check("surface_bindings_memory_check", sql`
    ${t.memoryWritePolicy} IN ('deny', 'allow_explicit')`),
]);

export const sessionLinks = pgTable("session_links", {
  id: uuid().primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  ownerId: text("owner_id").notNull(),
  surfaceBindingId: uuid("surface_binding_id").notNull()
    .references(() => surfaceBindings.id),
  conversationKey: text("conversation_key").notNull(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  releaseId: text("release_id").notNull(),
  profileId: text("profile_id").notNull(),
  audienceSnapshot: jsonb("audience_snapshot").notNull(),
  muted: boolean().notNull().default(false),
  revision: integer().notNull().default(0),
  revokedAt: at("revoked_at"),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("session_links_conversation_uniq")
    .on(t.surfaceBindingId, t.conversationKey),
]);

export const chatInbox = pgTable("chat_inbox", {
  id: uuid().primaryKey(),
  installationId: uuid("installation_id").notNull()
    .references(() => slackInstallations.id),
  eventKey: text("event_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  envelope: jsonb().notNull(),
  sessionLinkId: uuid("session_link_id").references(() => sessionLinks.id),
  turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
  admissionReceiptId: uuid("admission_receipt_id").references(() => receipts.id),
  state: text().notNull().default("pending"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: at("lease_expires_at"),
  nextAttemptAt: at("next_attempt_at").notNull().defaultNow(),
  receivedAt: at("received_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_inbox_installation_event_uniq").on(t.installationId, t.eventKey),
]);

export const deliveryReceipts = pgTable("delivery_receipts", {
  id: uuid().primaryKey(),
  installationId: uuid("installation_id").notNull()
    .references(() => slackInstallations.id),
  sessionLinkId: uuid("session_link_id").notNull().references(() => sessionLinks.id),
  sourceEventId: bigint("source_event_id", { mode: "number" }).notNull()
    .references(() => events.id),
  admissionReceiptId: uuid("admission_receipt_id").references(() => receipts.id),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  payload: jsonb().notNull(),
  audienceSnapshot: jsonb("audience_snapshot").notNull(),
  status: text().notNull().default("pending"),
  attempts: integer().notNull().default(0),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: at("lease_expires_at"),
  nextAttemptAt: at("next_attempt_at").notNull().defaultNow(),
  remoteChannelId: text("remote_channel_id"),
  remoteMessageTs: text("remote_message_ts"),
  errorCode: text("error_code"),
  sentAt: at("sent_at"),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("delivery_receipts_intent_uniq")
    .on(t.installationId, t.idempotencyKey),
  uniqueIndex("delivery_receipts_source_destination_uniq")
    .on(t.sourceEventId, t.sessionLinkId),
  check("delivery_receipts_status_check", sql`
    ${t.status} IN ('pending', 'sending', 'retry_wait', 'sent',
                   'failed', 'suppressed', 'outcome_unknown')`),
  check("delivery_receipts_sent_check", sql`
    ${t.status} <> 'sent'
    OR (${t.remoteChannelId} IS NOT NULL
        AND ${t.remoteMessageTs} IS NOT NULL AND ${t.sentAt} IS NOT NULL)`),
]);
~~~

완성 migration·repository의 필수 조건:

- I3 v1은 workspace 설치만 지원하며 `org_deploy_enabled=false`를 유지한다. enterprise-wide installation을 `team_id=NULL`인 pending 앱과 혼동하지 않는다. 같은 app을 여러 workspace에 설치하는 제품으로 확장할 때는 app-level credentials를 별도 `slack_apps` 테이블로 분리하고 installation key를 재설계한다.
- `ownerId`는 Slack team ID가 아니다. I0 workspace에 서버가 발급한 안정적인 service owner를 연결하고 session owner도 그 값을 사용한다. actor는 입력별 별도 provenance다.
- installation→binding→link→session workspace/owner 일치를 복합 FK와 transaction validation으로 강제한다. 기존 sessions에 nullable workspace association을 추가·backfill하고 `(id,owner_id,workspace_id)` unique/FK를 도입하거나 동등한 session-scope 테이블을 사용한다. owner 필터만 제거해서는 안 된다.
- `session_links` release/profile은 Session 정본과 일치한다. 기존 sessions에 agent/release pin 또는 1:1 domain extension row를 두고, 복수 링크가 서로 다른 release/profile을 지정하지 못하게 한다.
- channel 수는 JSON map이 아니라 binding 행 수다. app당 복수 채널을 허용하고 다른 설치의 같은 channel 문자열은 충돌하지 않는다.
- revoked link도 natural key를 유지한다. 새 메시지로 자동 Session 재생성하지 않는다. rebind/share에는 expected revision과 별도 Grant가 필요하다.
- inbox event key가 같고 payload hash가 다르면 충돌로 처리한다. 재설치/설치 세대 교체에서도 같은 event를 재실행하지 않도록 source dedup key 이관 정책을 정의한다.
- inbox·delivery에 상태 CHECK, nonnegative attempts, pending/retry/lease-expiry 인덱스와 bounded retention을 추가한다. `FOR UPDATE SKIP LOCKED` + claim token/lease를 사용하고 finish는 같은 token으로 CAS한다.
- delivery row는 durable outbox intent와 영수증을 겸한다. 외부 호출은 transaction 밖에서 한다. Slack 성공 뒤 DB commit 전 crash는 `outcome_unknown`으로 대조한다. `client_msg_id`만으로 exactly-once를 주장하지 않는다.
- secret은 원문이 아닌 secret-store 참조만 저장한다. manifest config token은 bot token과 분리된 operator credential scope로 관리한다.
- 추가 `slack_oauth_states`: state hash PK, actor/workspace/installation/provisioning-operation/redirect URI, expiry, consumed-at. 원자적 consume으로 재사용 방지. provisioning operation 및 token rotation에 durable lock/CAS가 필요하다.
- release activation은 `UPDATE ... WHERE revision = expected AND scope = ... RETURNING ...`; 최초 insert는 unique conflict로 경합 판정. immutable row·pointer·감사 이벤트를 transaction으로 묶는다.
- 기존 migration/data/`pod_id`는 보존한다. SQLite 테이블 이름만 바꿔 가져오지 않는다.

## 5. I0 핵심 규칙과 alpha 합성

### 5.1 Grant / actor authorization

K `authorization.ts:39–46,61–139`: 허가 전에 resource를 load하지 않고, 매 결정에서 Grant 저장소를 조회해 회수를 반영한다. actor·service principal·action·resource·audience·scope·expiry/revocation exact-match를 유지한다. deny는 resource 존재를 노출하지 않는다. wildcard/role 상속은 원본에 없는 기능이다.

대상은 `platform/src/authorization/grants.ts`와 기존 `policy.ts`, wire schema는 `contracts/src/domain/authorization.ts`, DB는 `db/src/grants.ts`다.

유효 권한은 **authenticated caller의 API key scope 또는 사용자 권한 ∩ membership ∩ 현재 Grant ∩ runtime profile capability ∩ release policy ∩ binding/Session/audience**다. Slack 사용자 actor를 app service principal로 대체해 app 권한을 상속시키지 않는다.

| 요청 | 94S-132 key/service ceiling | 도메인 검사 |
|---|---|---|
| Session 조회 | `sessions:read` | membership + `session.read` + 링크 audience |
| 입력/새 Session | `sessions:write` | `session.submit` + binding + 허용 profile/repository |
| pending answer/승인 | `sessions:approve` | request/attempt/input hash, approver Grant; write가 approve를 암묵 허용하지 않음 |
| stop/resume 등 | `sessions:control` | 해당 Session control 권한; Slack 버튼 payload만 믿지 않음 |
| 복구 | `sessions:recover` | operator 권한, epoch/상태 확인 |
| Agent/release/연결 관리 | 별도 관리 permission 명시 필요 | `agent.manage`/`binding.manage`; session scope를 임의 전용하지 않음 |

Slack webhook에는 bearer key가 없으므로 설치의 제한된 service principal과 내부 authorization context를 사용한다. 전역 관리자 API key로 모든 사용자를 대행하지 않는다. 94S-132 도입 시 `ApiKeyStore`를 `{keyId,ownerId,scopes,...}` 반환으로 확장하고 기존 owner-only 경로·기본 deny를 회귀 검증한다.

### 5.2 불변 release 및 activation CAS

K `ids.ts:20–60,99–109`: canonical JSON + SHA-256. 원본 release hash 입력은 `{version_id,dependency_pins,policy_baseline}`이고 `approved_by`는 hash 내용이 아니다. 동일 ID에 다른 canonical content를 덮어쓰지 않는다. pointer key는 tenant/agent/environment/binding_scope, 최초 expected revision은 `-1`이다. 동일 provisioning 재제출은 no-op이다. 실제 구현은 in-memory/SQLite에 있고 PostgreSQL 구현은 없다.

대상 `platform/src/agents/{release-ids,agent-service}.ts`, `db/src/agents.ts`에서 content 불변성과 activation pointer 가변성을 분리한다. 승인 행위·승인자는 별도 감사 기록으로 보존한다. 원본 `provisionKollege`의 self-approval을 실제 승인 workflow로 인정하지 않는다.

94S-132 profile은 operator 실행 설정의 정본이고 Agent release는 그 위의 persona/instructions/tools/policy snapshot이다. release hash에는 profile ID뿐 아니라 **secret 제외 실행 설정의 revision/digest**와 capability/policy pin을 포함한다. 같은 profile ID의 파일 수정으로 release 의미가 바뀌면 digest mismatch를 거절하거나 versioned snapshot을 resolve한다. raw credential/rotating token은 hash나 release JSON에 포함하지 않는다.

Session 생성 시 active release/profile을 pin한다. 새 activation은 새 Session에 적용한다. 기존 Session retry/resume은 같은 pin을 유지하되 현재 revoke/policy는 재검사한다. I0에는 active Session 자동 release 전환을 넣지 않는다.

### 5.3 MemoryRecord 공개 범위

K `schema.ts:271–306`, `in-memory.ts:282–383`, `sqlite.ts:603–731`에는 실제 memory guard/query 규칙이 있다.

- `kollege` → 대상 `agent`: 해당 Agent의 허가된 범위이며 조직 전체 공개가 아니다. `visibility_ref=null`.
- `channel`: ref는 Slack channel ID가 아니라 SurfaceBinding ID.
- `user`: ref는 scoped actor ID. 다른 Slack workspace의 같은 문자열을 같은 사용자로 취급하지 않는다.
- 읽기: 같은 scope/Agent, active, unexpired를 선필터하고 binding/user 조건을 적용한다.
- 쓰기: explicit 요청 + `memory_write_policy=allow_explicit` 필요. private channel/DM에서 agent-wide 승격 금지, source binding의 scope/Agent 불일치 거절.
- 삭제: soft-delete 및 revision 증가. 필요한 confidence/recency ordering 회귀만 보존.

I0에는 `contracts/src/domain/memory.ts`, `platform/src/memory/visibility.ts`와 DB predicate 계약만 둔다. vector/retrieval/요약·routines는 I4다. profile의 tool 허용은 memory 공개 권한을 확대하지 않는다. retrieval은 모델 prompt에 넣기 전에 visibility 검사해야 한다.

### 5.4 SurfaceBinding

K `schema.ts:126–179`: surface 종류, off/mention/ambient, explicit memory policy, budget, opaque transport metadata. generic schema는 contracts, 정책/service는 platform, session key/mute는 chat-interface, Slack channel/installation은 chat-slack/db에 둔다.

기본 mapping은 `(installation,channel) → binding`, `(binding,thread root) → Session`이다. **다른 사용자가 같은 thread에 입력하면 같은 Session, 같은 사용자가 다른 channel/thread에 입력하면 별 Session**이다. 복수 채널에 같은 Session을 노출하는 것은 explicit link/share이며 자동 주제 유사도 병합이 아니다. 좁은 공개 범위의 결과를 다른 링크로 fan-out하지 않는다.

## 6. 의존성·Bun·라이선스/소유권

| 항목 | 확인한 버전/선언 | 이식 결정 |
|---|---|---|
| Slack 직접 의존성 | `@kollegium/core: workspace:*` 하나 | 제거하고 chat-interface/contracts를 `workspace:*`로 참조 |
| `@slack/web-api`, `@slack/bolt`, `@slack/oauth` | **사용하지 않음** | 원본은 `fetch` 직접 호출. 현재 포팅에 SDK 추가·버전 pin 불필요 |
| Core Zod | 선언 `^4.4.3`, K lockfile `4.4.3` | A의 기존 `zod 4.6.5`; strict/schema/hash 회귀 확인 |
| Pi packages | `@earendil-works/pi-agent-core 0.85.0`, `@earendil-works/pi-ai 0.85.0` | 모두 제외; transitive LLM/provider dependencies도 유입 금지 |
| A DB | `drizzle-orm 0.44.5`, `pg 8.16.3`, `drizzle-kit 0.31.4` | 기존 버전·migration entry 사용 |
| A 도구 | Bun `1.3.10`, TypeScript `5.9.2`, Biome `2.2.4`, PGlite `0.3.10` | Bun typecheck/lint/test. PGlite만으로 실제 PostgreSQL 경합 증명을 대신하지 않음 |
| K runtime 요구 | Node `>=24.12.0`, Bun `>=1.3.10` | 원본 test command는 Node runner. Bun 동작은 이식 후 실제 검증 |
| Node API | `node:crypto`, `Buffer`, SQLite의 `node:sqlite`, test의 `node:test`/`node:assert` | crypto/Buffer는 A도 사용. SQLite 제거, tests Bun 전환. 호환 예상과 실행 증거 구별 |
| 표준 API | `fetch`, `URL`, `URLSearchParams`, timer | 유지, timeout/AbortSignal·bounded body·retry budget 추가 |

K Slack/Core package는 Apache-2.0이며 root LICENSE가 존재한다. 조사한 tracked 파일 목록에서 별도 NOTICE를 발견하지 못했다. A root에서는 LICENSE를 발견하지 못했으므로 배포 라이선스 정책을 확정해야 한다. private package가 라이선스 의무를 없애지는 않는다.

원본 repository/commit/path provenance, license/attribution 보존, 수정 사실 표시를 이식 PR에 포함한다. 배포 원본에 NOTICE가 있는지 archive 직전 재확인한다. [Apache-2.0 재배포 조건](https://www.apache.org/licenses/LICENSE-2.0) 기준이다. 같은 GitHub owner라는 사실만으로 모든 기여자의 권리·기업 소유권을 단정하지 않는다. contributor/history와 필요한 승인 기록을 확인하되 credentials·개인 Slack 대화를 ledger에 넣지 않는다.

## 7. 위험과 대응

| 위험 | 원본 가정 및 대응 |
|---|---|
| 자동 app 생성 자격증명 | `apps.manifest.*`는 bot token이 아니라 사용자·개발 workspace에 연결된 configuration access/refresh token 필요. 운영자 사전 발급·설정 및 Slack 설치 동의가 별도 |
| token rotation | config access token은 공식 문서상 12시간 수명. K sample은 process 내부 직렬화 및 단일 rotating process 가정. target은 secret-version CAS/durable lock과 실패 복구 필요. [Manifest/token 관리](https://api.slack.com/reference/manifests) |
| app create 결과 불명확 | 응답 유실 뒤 blind retry 시 앱 중복 가능. provisioning operation 선기록, app ID/secret 저장과 마지막 성공 단계 대조. Agent release와 Slack provisioning 성공을 분리 |
| bootstrap | create 때 event subscription 생략→signing secret 저장→전체 manifest update. signed challenge용 ingress가 먼저 준비되어야 함. update 때 OAuth/scopes/settings 누락 금지 |
| OAuth·ingress | public HTTPS ingress, 등록된 redirect URI, client ID/secret, actor/workspace/operation/redirect에 묶인 one-time state/TTL 필요. 다른 team/app callback으로 설치 바꿔치기 거절. [OAuth flow](https://docs.slack.dev/authentication/installing-with-oauth/) |
| 자동 채널 참여 | K manifest에는 `channels:join`이 없고 membership check는 join이 아님. 자동 참여는 별도 권한·기능. private channel은 권한 있는 초대 필요. ready는 채널별 실제 수신/전달 검증 후 |
| membership 의미 | `getChannelMembership`은 bot의 `conversations.info.is_member`. `channel_not_found`→not_member, `missing_scope`→설정 오류. 사람의 membership/Session 권한 증거가 아님. 필요 시 `conversations.members` pagination과 fail-closed 정책 별도. [info](https://docs.slack.dev/reference/methods/conversations.info/), [members](https://docs.slack.dev/reference/methods/conversations.members/) |
| 이벤트 구독 격차 | BOT_SCOPES=`app_mentions:read,chat:write,channels:read,groups:read`; subscription=`app_mention`만. DM normalize 분기가 실제 DM 구독을 뜻하지 않음. 멘션 없는 thread replies/DM은 event·history scope를 별도 추가하고 bot/edit/delete/subtype 정책 검증 |
| replay·dedup | signature ±300초는 인증 window이며 event 중복 방지가 아님. raw body 검증과 durable event unique를 함께 사용. [Request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/) |
| owner와 actor | 첫 발신자를 `owner_id`로 쓰면 B는 owner 필터에서 거절됨. 안정적인 workspace service owner + 입력별 actor Grant. workspace/team ID를 인증 principal로 무조건 신뢰하지 않음 |
| 첫 입력 경합 | A/B 동시 첫 event→Session 하나·turn 두 개. natural-key lock/unique와 alpha transaction으로 고아 Session/queue 방지 |
| 조직/Slack Connect | alpha 단일 조직에서 I0 workspace는 제품 scope이며 SaaS tenant isolation 완성 아님. Slack Connect/enterprise-wide는 I3 v1 명시 거절 또는 별도 검증 |
| outbound 불명확 | remote 성공과 DB sent 사이 crash를 원자화할 수 없음. `outcome_unknown`/대조 필요. restart test만으로 exactly-once 주장 금지 |
| rate limit | method×app/workspace 및 channel별 throttle, 429/Retry-After를 durable next-attempt로 예약. 한 channel이 모든 sender를 sleep시키지 않음. posting은 대체로 channel당 초당 1건 기준. [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) |
| history API | 신규 비Marketplace 상업 배포의 history/replies에는 1분 1회/15개 제한이 적용될 수 있음. 공식 문서의 internal/Marketplace/기존 설치 예외를 구별. Events를 축적하고 매 turn history fetch에 의존하지 않음. [적용 조건](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) |
| revoke/mute | queued delivery도 전송 직전 Grant·membership·installation·binding revision·mute 재검사. 과거 audience를 새 channel membership으로 확대하지 않음 |
| 응답 검증 | K app-config의 `String(payload[field])`가 누락을 `"undefined"`로 저장하지 않게 schema 검증. HTTP 오류·`ok:false`·timeout 분리, 로그 credentials 제거 |

## 8. PR 크기 티켓 분할

**티켓 초안이며 Linear 생성·상태 변경은 하지 않았다.** 실제 등록 전 live template/acceptance criteria/native blocked-by를 조회하고 기존 작업과 중복을 제거한다. 아래 의존은 Linear relationship으로 표현한다.

### 8.1 I0 — 3개

| 티켓 | 범위·의존 | Acceptance criteria | 이관 테스트 |
|---|---|---|---|
| I0-K1 actor/Grant와 기존 principal 합성 | contracts/platform/Grant repository. users/workspaces/memberships 및 94S-132 principal/scope 계약 의존 | 기존 owner-only 회귀; actor/service/resource/audience exact-match; revoke/expiry 반영; hidden resource 404; 허가 전 content/model 미접근; scope 부족 approve/control/recover 거절; cross-workspace 거절 | core authorization → `platform/src/authorization/grants.test.ts`, `db/src/grants.integration.test.ts`; 기존 API app auth 회귀 |
| I0-K2 immutable release/activation CAS | release schema/hash/service와 DB. K1·94S-132 profile resolve 의존 | canonical deterministic; 동일 ID 다른 content 거절; 재제출 no-op; 동시 CAS 1개 성공; rollback 시 반쪽 row 없음; profile digest pin/secret 제외; activation 후 기존 Session pin 불변 | core schema/provision/selected testing → `release-ids.test.ts`, `agent-service.test.ts`, `db/src/agents.integration.test.ts` |
| I0-K3 SurfaceBinding/Memory/Chat 계약 | contracts, chat-interface contract/mute, platform visibility. K1/K2 의존 | agent/channel/user scope 구별; private/DM global write 거절; explicit/policy guard; expired/deleted 제외; metadata authority override 거절; mode/mute 분리; runtime/Slack/SQLite import 없음; vector retrieval 미포함 | core memory/schema cases → `contracts/src/domain/memory.test.ts`, `platform/src/memory/visibility.test.ts`, `chat-interface/src/mute-policy.test.ts` |

각 PR은 해당 public 계약·service·repository와 필요한 migration/검증까지만 포함한다. 전체 IAM이나 memory retrieval을 함께 구현하지 않는다.

### 8.2 I3 — 7개

| 티켓 | 범위·의존 | Acceptance criteria | 이관 테스트 |
|---|---|---|---|
| I3-S1 Slack 서명·정규화·표현 | 순수 adapter package. I0-K3 | raw HMAC/±300초, app/team/enterprise mismatch·bot/subtype 거절, event key, mention/Unicode/overflow 보존 | Slack signature/events/presentation → `chat-slack/src/{signature,events,presentation}.test.ts` |
| I3-S2 Postgres 설치·binding·link·inbox | schema/repository/migration. I0-K2/K3 | round-trip/scoped FK, 복수 채널, revoke link 유지, event hash 충돌, event 경합 1행, migration 재실행·기존 데이터 보존 | Slack sqlite/core durability subset → `db/src/chat/{slack-installations,session-links,inbox}.integration.test.ts` |
| I3-S3 Manifest/OAuth lifecycle | app-config, install/callback routes, credentials, operation/state. S1/S2·관리 권한 | create→secret 저장→signed challenge→update; state 재사용/만료/cross-actor/team 거절; rotation 경합 1회; 재시작 복구; missing_scope/미초대 구분; 채널별 readiness | app-config → `chat-slack/src/app-config.test.ts`; sample 시나리오만 → `apps/api/src/slack-oauth.integration.test.ts` |
| I3-S4 Durable ingress·다중 사용자 Session | public Hono event route, admission/binder, alpha turn service. S1/S2·I0-K1·실제 alpha append-turn 의존 | commit 전 2xx 금지; 3초 ACK budget을 모델과 분리; A/B 같은 thread→1 Session/2 turns; retry→추가 turn 없음; 다른 channel/thread 분리; owner/target 검증; restart inbox replay; actor 보존 | events/core deny/dedup → `apps/api/src/slack-events.integration.test.ts`, `platform/src/chat/admission.test.ts`, `chat-interface/src/session-binding.test.ts` |
| I3-S5 Durable outbound/receipt | delivery client/event→outbox/claim/retry/mute/ACL. S1/S2/S4·alpha durable output | `ok:false` 미성공; missing ts/timeout unknown; 429 목적지별 예약; restart sent 재전송 금지; stale claim finish 거절; revoke/mute 억제; audience 확대 금지 | Slack web-api/core durability → `chat-slack/src/delivery.test.ts`, `db/src/chat/delivery-receipts.integration.test.ts` |
| I3-S6 Thread 후속 입력·승인 카드 | 멘션 없는 bound reply, DM은 명시 scope 추가 시만, pending answer/control. S3–S5·alpha 해당 service | 같은 thread B의 무멘션 입력 수용; unbound ambient 실행 금지; edited/bot echo 차단; stale/다른 actor approval 거절; approve/control 분리; DM 미지원 시 명시 거절; multi-channel share explicit 권한 | 신규 `chat-slack/src/thread-events.test.ts`, `apps/api/src/slack-actions.integration.test.ts`; 기존 normalization fixtures 확장 |
| I3-S7 실제 QA·전환·archive 증거 | 설정/runbook, 실제 PostgreSQL concurrency, 승인된 Slack sandbox. S3–S6·alpha runtime | 설치→public/private→A/B→실제 runtime 결과→remote ts/receipt 추적; restart/revoke/retry/429 증거; source write 중지·이관 대조·rollback; 미검증 항목 명시 | `tests/integration/slack-port.e2e.test.ts`와 운영 체크리스트; mock을 live QA로 표시하지 않음 |

공통 검증은 대상 root `bun run typecheck`, `bun run lint`, `bun run test`와 PostgreSQL integration test의 실제 명령·환경·출력이다. 자동 skip/fixture/green badge로 DB 또는 Slack 검증을 주장하지 않는다. PR에는 source commit/path, 이관한 test 이름, 제외 범위를 연결한다.

## 9. GitHub repo / Linear project archive 체크리스트

코드 이동·merge·QA·release·deployment·archive는 별도 완료 단계다. 이 문서에서는 외부 상태를 변경하지 않는다.

- [ ] 원본 HEAD/tag·파일 ledger·line counts·license/attribution·제외 목록을 고정한다.
- [ ] 각 I0/I3 작업에 실제 target PR 링크와 정확한 merge SHA를 첨부한다. GitHub 참조는 실제 번호로 `[JeongJaeSoon/agent-platform#123](https://github.com/JeongJaeSoon/agent-platform/pull/123)` 형식을 사용한다. 이 예시는 형식 안내이며 특정 PR의 포팅 완료를 뜻하지 않는다.
- [ ] underlying 명령·CI job/log·실행/skip 결과를 첨부한다. unit, 실제 PostgreSQL migration/concurrency, 실제 Slack OAuth/ingress/delivery, 실제 worker/model, release artifact, 배포 환경/버전을 각각 기록한다.
- [ ] 원본→대상 테스트 mapping을 migrated/replaced/dropped로 종결하고 제외 사유·alpha 대체 책임을 기록한다.
- [ ] 실제 복수 사용자/복수 채널, signature 실패·retry·restart, Grant revoke·mute·approval·429를 확인한다. request/event/session/turn/receipt/remote-ts correlation만 첨부하고 token/private conversation은 제외한다.
- [ ] 기존 설치가 있으면 source DB backup, 설치/binding/link/미전달 intent 수량 대조, ID mapping, audience 보존, cutover 동안 단일 ingress·단일 sender 증거를 남긴다. 기존 dedup 유실로 event를 재실행하지 않는지 확인한다.
- [ ] 새 ingress/OAuth URI·manifest·required scopes·secret refs·채널 readiness를 검증한다. 기존 app/token 유지인지 재설치인지 명시하고 rollback을 시험한다.
- [ ] 원본 README에 대체 repo·이동 위치·지원 종료·남은 보류 작업을 한국어로 기록하고 마지막 알려진 정상 tag/release notes를 보존한다.
- [ ] open issue/PR을 target 작업에 매핑한다. Pi/CLI/sample 등 제외 요청을 구현 완료로 표시하지 않고 범위 제외 이유를 남긴다. 실제 GitHub 참조는 clickable `owner/repo#번호` 형식이다.
- [ ] Linear 열린 이슈·milestone·native blocked-by를 조사하고 target issue에 연결한다. source acceptance criteria/repro/log를 보존하고 `done` 라벨만으로 완료 판정하지 않는다.
- [ ] CI/deploy automation·webhook·OAuth endpoint의 source 의존이 없어졌는지 확인한다. credentials 회수는 새 운영에 필요한 token과 구별한다.
- [ ] 운영 책임자, rollback 보존 기간, archive 승인 및 미해결 blocker 0건의 증거를 붙인 뒤 GitHub/Linear를 archive한다. release/deployment 미검증이면 코드 이동 완료와 archive 보류를 구분한다.

## 10. 근거와 한계

주요 코드 근거는 위 파일별 표다. K `docs/architecture/2026-09-11-detailed-system-design.md`의 release pin, authority intersection, multi-user thread, audience 원칙은 설계 의도이며 실제 Postgres/runtime 구현으로 취급하지 않는다. A의 현재 auth/session/db 근거는 §1에 명시했다. Slack 변동 가능 API 동작은 §7의 공식 문서를 2026-09-22에 확인했다.

과거 메모는 조사 위치를 찾는 데만 사용했고 구현 상태·파일 줄 수·의존성은 현재 checkout에서 다시 확인했다.

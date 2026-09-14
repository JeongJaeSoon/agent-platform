# Claude Code 세션 컨트롤 플레인 설계안

> 상태: v0.5 방향성 반영 · G1 v0.4/M0 완료 이력 유지 · G2 SDK 재검증 대기
> 작성일: 2026-09-12 · 개정: 2026-09-15
> 범위: HTTP API로 Claude Code 세션을 생성·재개·관찰하고, Kubernetes 위에서 세션 워커를 수평 확장하는 시스템
> 배포 대상: AWS EKS

---

## 1. 목적과 배경

Claude Code를 터미널이 아니라 서버 환경에서 돌리고, 여러 클라이언트(웹 UI, Slack, 다른 서비스)가 API를 통해 세션을 만들고 메시지를 주고받을 수 있게 한다. 세션은 요청량에 따라 수평 확장되어야 하며, 작업이 끝나면 리소스를 회수하고, 이후 메시지가 오면 이어서 작업할 수 있어야 한다.

워커는 공식 TypeScript `@anthropic-ai/claude-agent-sdk`를 직접 사용한다. SDK가 구동하는 Claude Code runtime의 도구·agent loop·context management를 재사용하고, API·큐·SSE·격리·영속화는 플랫폼이 담당한다. SDK/CLI 호환성은 고정 버전의 실제 process 검증으로 판단한다.

LLM provider는 Anthropic 직접 연결을 기본으로 하며, 선택 profile로 LiteLLM의 Anthropic Messages endpoint를 거쳐 Claude 모델에 연결한다. **SDK 직접 사용은 runtime 제어 경계이며 게이트웨이 우회를 뜻하지 않는다.** base URL만 바꾸어 완전 호환을 가정하지 않고 인증·모델 alias·streaming·도구 계약을 고정 버전으로 검증한다. non-Claude 모델 호환은 약속하지 않는다. 실제 SDK + local fake Messages API와 실제 LiteLLM proxy + local fake upstream 검증을 분리하고, paid Claude 호출·운영 인증은 별도 승인 후 검증한다(§9.1, §10.0).

### 1.1 핵심 판단

재개에 필요한 최소 영속 데이터는 다음과 같다.

1. root/subagent 트랜스크립트와 재개 메타데이터
2. 작업 디렉토리의 git commit
3. 두 데이터의 같은 저장 시점과 SDK/CLI 버전·설정 profile을 묶는 checkpoint manifest(§6.3.1)

호환 runtime·설정과 같은 `cwd`에서 manifest를 복원하면 새 워커에서 `resume`할 수 있어야 한다. 프로세스 메모리, 열린 승인 callback, 개발 서버, git에 포함되지 않는 cache는 transcript만으로 복구되지 않는다. 개발 서버 등 장기 실행 프로세스로 동작 확인을 하는 동안은 pod와 SDK process를 유지한다.

- **pod 하나 = 세션 하나** (격리 최우선)
- 세션이 활성인 동안 pod 유지, 유휴 N분 후 회수
- 회수된 세션에 메시지가 오면 새 pod에서 resume

인터랙티브 CLI의 TUI·로그인·agent teams 전체를 복제하는 것은 범위 밖이다. raw PTY parsing이나 ACP를 필수 경로로 넣지 않는다. ACP는 다른 agent를 지원해야 할 때, Agent Sandbox는 실행 인프라 비교에서 이점이 확인될 때 별도 검토한다.

### 1.2 Claude Code 호환 범위와 책임

| 항목 | v0.5 결정 | 검증 책임 |
|------|-----------|-----------|
| agent runtime | 공식 Agent SDK 직접 사용, native Claude Code binary와 함께 버전 고정 | 94S-91 → 94S-18·94S-31 |
| prompt | `systemPrompt: { type: "preset", preset: "claude_code" }`, 필요한 규칙만 `append` | 94S-91·94S-18 |
| 프로젝트 기능 | `CLAUDE.md`, rules, skills/custom commands, subagents, hooks, MCP, local plugins를 명시적 profile로 활성화 | 94S-18·94S-32 |
| 사용자 설정 | host의 user/local 설정과 auto memory는 자동 상속하지 않음. project 설정은 해당 owner가 실행을 허용한 repo에서만 로드 | 94S-18·94S-19·94S-45 |
| 이벤트 | SDK native message와 공개 SSE projection을 분리. 버전·tool/parent/message ID를 보존 | 94S-18·94S-24 |
| 승인 | `canUseTool`과 `AskUserQuestion`을 typed answer로 연결, request별 pending 상태 | 94S-23·94S-28 |
| 재개 | SDK SessionStore 채택을 실측해 결정; 어느 backend든 manifest가 지정한 쌍으로 복원 | 94S-92 → 94S-93 → 94S-29 |
| 제품 경계 | CLI 화면의 완전 동일성, 모든 CLI 전용 명령·agent teams, 개인 Pro/Max 로그인 중계는 제공하지 않음 | 94S-36·94S-45 |

SDK의 기본 prompt는 CLI preset과 다르므로 preset을 명시한다. `settingSources`도 기본값에 의존하지 않는다. plugin·MCP·hook은 실행 가능한 코드이므로 서버가 허용한 profile/version을 기록하고 새 worker에서도 동일하게 로드한다. secret 값은 profile·manifest·이벤트에 넣지 않는다.

94S-91 실측에서 격리된 `HOME`, `CLAUDE_CONFIG_DIR`, `settingSources: ["project"]`만으로는 workspace 상위 디렉터리의 `CLAUDE.md` 로딩을 막지 못했다. tenant workspace는 repo만 분리하지 않고 root까지의 전체 상위 경로를 tenant 전용 clean mount로 제공한다. SessionStore나 filesystem backend가 임시 config를 만들 때도 host settings·memory·credential을 복사하지 않고 allowlist profile만 복원한다.

2026-09-15 공식 문서 확인: [SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview), [설정과 기능](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [system prompt](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts). 제3자 제품의 claude.ai 로그인·구독 한도 제공에는 별도 승인이 필요하므로 API key 인증을 기본으로 한다. 내부 프로젝트명과 외부 제품 표시는 구분하며, 외부 UI/문서는 자체 이름과 허용된 Claude Agent 표기를 사용한다.

### 1.3 개정의 완료 경계

94S-8의 SDK 0.3.265/CLI 2.1.265 실측과 G1·M0 완료는 과거 범위의 증거로 보존한다. 2026-09-15 changelog의 0.3.270/2.1.270은 비교 후보이며 아직 채택·검증하지 않았다. 94S-91·94S-92가 실제 runtime 계약과 저장 방식을 닫고, 94S-18·94S-93이 구현한 뒤 94S-32·94S-33에서 통합 검증한다. 이번 문서 개정 자체가 SDK 호환성·CI·실행 QA 완료를 뜻하지 않는다.

현재 제품 코드는 `packages/contracts`, `packages/db`, `packages/queue`, `packages/storage`, `packages/observability`와 M0 의존 인프라다. SDK 의존성·`apps/worker`·API app·SDK 실행 루프는 아직 없다. 아래 API·워커·이미지·배포·E2E 설명은 별도 완료 이력이 명시된 M0 항목을 제외하면 **구현 목표**다. 현재 실행 가능한 명령은 [README](../README.md)를 따른다.

---

## 2. 요구사항

### 2.1 기능 요구사항

| ID | 요구사항 |
|----|---------|
| F1 | 첫 메시지로 세션을 생성하고 즉시 실행을 시작한다 |
| F2 | 세션 출력(텍스트, 툴 호출, 질문, 권한 요청)을 실시간 스트리밍으로 열람할 수 있다 |
| F3 | 세션 ID를 지정해 후속 메시지를 보낼 수 있다 |
| F4 | 세션이 던진 질문·권한 요청에 API로 답할 수 있다 |
| F5 | 종료(회수)된 세션에 메시지를 보내면 resume으로 이어서 작업한다 |
| F6 | 트랜스크립트가 JSONL로 외부 스토리지에 남고, 이를 통해 이력과 상태를 조회할 수 있다 |
| F7 | 세션 목록·상태 조회, 중단, 삭제가 가능하다 |

### 2.2 비기능 요구사항

| ID | 요구사항 |
|----|---------|
| N1 | API 서버는 stateless이며 HPA로 확장된다 |
| N2 | 워커는 요청량에 따라 수평 확장되고 스팟 노드에서 실행 가능하다 |
| N3 | 유휴 세션은 리소스를 점유하지 않는다 |
| N4 | 스팟 선점·OOM 등 비정상 종료 시 마지막 저장 지점에서 복구된다 |
| N5 | 세션 간 파일·프로세스·네트워크가 격리된다 |
| N6 | 같은 세션에 동시에 들어온 메시지는 순서대로 처리된다 |

---

## 3. 전체 아키텍처

```
┌──────────┐
│ 클라이언트 │
└────┬─────┘
     │ HTTP / SSE
┌────▼─────────────────────────┐
│ API 서버 (컨트롤 플레인)       │  stateless, HPA
└────┬─────────────────────────┘
     │
┌────▼─────────────────┐  ┌────────────────────┐
│ Postgres             │  │ S3 + git remote     │
│  정본(세션·매핑)      │  │  JSONL + 세션 브랜치 │
│  세션 큐 · events     │  └────────┬───────────┘
│  워커 리스             │           │
└────┬─────────────────┘           │
     │                             │
┌────▼─────────────────────────────▼──┐
│ 워커 pod (세션 1개)                  │  KEDA, 스팟
│  sidecar → Agent SDK                │
└─────────────┬───────────────────────┘
              │ ANTHROPIC_BASE_URL
        ┌─────▼──────┐
        │ LLM 엔드포인트│
        └────────────┘
```

큐·이벤트·리스가 Postgres 안에 있는 것이 PoC 구성이다(§3.2). 이벤트 팬아웃이 병목이 되면 그 셋만 Redis로 빠지고 정본은 남는다.

### 3.1 컴포넌트

| 컴포넌트 | 역할 | 기술 |
|---------|------|------|
| API 서버 | 세션 CRUD, 메시지 수신·라우팅, SSE 중계, 답변 수신 | Bun + Hono |
| Postgres | 세션 메타·상태·`session → pod` 매핑의 **정본** | Postgres 16 |
| 큐 / 이벤트 스트림 | 세션별 메시지 큐, 워커가 발행하는 이벤트 스트림, heartbeat 리스 | Postgres (`SKIP LOCKED` 큐, `events` 테이블). Redis는 인터페이스 뒤의 선택지로 남긴다(§12.4) |
| 오브젝트 스토리지 | 트랜스크립트 JSONL | S3 (로컬은 LocalStack) |
| git remote | 세션별 브랜치로 코드 변경 영속화 | GitHub/GitLab |
| 워커 pod | 세션 하나를 호스팅. 사이드카가 Agent SDK를 구동하고 큐·스트림과 연결 | Bun + `@anthropic-ai/claude-agent-sdk` |
| KEDA | 미배정 **세션 수** 기반으로 워커 pod 수 조절(§7.2) | KEDA ScaledJob |

### 3.2 상태 저장의 역할 분담

etcd가 쿠버네티스에서 하는 역할(정본, 리스, watch)을 이 시스템에서는 Postgres 하나가 맡는다.

- **정본**: 세션 상태와 `pod_id` 매핑. 매핑 획득과 상태 전이에 트랜잭션이 필요하다(§7.7)
- **큐**: `SKIP LOCKED`로 세션 큐를 소비한다
- **이벤트**: `events` 테이블에 durable하게 쌓고, `LISTEN/NOTIFY`는 구독자를 깨우는 데만 쓴다. NOTIFY는 비영속이라 그것만으로는 SSE 재개가 성립하지 않는다(§5.1)
- **리스**: `workers.last_seen`과 시각 비교

저장소가 하나면 운영이 단순하고, PoC 규모에서 이 조합으로 충분하다. 이벤트 팬아웃이 병목이 되면 Redis로 옮긴다 — TTL 자동 만료, 스트림, 블로킹 pop이 싸기 때문이다. 그때도 정본은 Postgres에 남는다. 이 전환이 앱 코드 변경 없이 되도록 `packages/queue`가 인터페이스를 쥔다(§8.1, §12.4).

---

## 4. 데이터 모델

### 4.1 Postgres

실행 스키마의 정본은 [`packages/db/src/schema.ts`](../packages/db/src/schema.ts)와 [`packages/db/migrations/`](../packages/db/migrations/)다. SQL 사본을 이 문서에 중복하지 않는다.

| 현재 M0 테이블 | 역할 |
|---|---|
| `sessions`, `turns`, `pull_requests` | 세션·턴 상태, SDK session ID를 저장할 필드, PR 참조 |
| `queue_messages` | 세션별 입력, visibility timeout, stale ACK/release를 차단하는 `claim_token` |
| `unassigned_sessions` | 세션당 하나의 미배정 신호, `queue_unassigned_session_count()`의 데이터 |
| `events`, `workers`, `api_keys` | durable 이벤트, heartbeat 시각, owner별 API key hash |

94S-93은 authoritative checkpoint ID/revision과 현재 `owner_id`·`pod_id`·previous revision을 조건으로 pointer를 전진시키는 최소 DB API를 migration으로 추가한다. typed pending request와 durable turn-attempt/terminal 상태도 해당 구현 티켓에서 확장한다. 이 미래 스키마를 M0에 이미 구현된 것으로 보지 않는다. G4의 94S-44 전에는 전체 write에 대한 claim epoch fencing까지 구현됐다고 보지 않는다.

`sessions_pod_uniq` 인덱스가 "pod 하나에 세션 하나"를 DB 수준에서 강제한다.

`unassigned_sessions`의 PK가 `session_id`라는 점이 신호의 중복을 막는다. 같은 세션에 메시지가 여러 개 들어와도 신호는 하나이고, 그래서 §7.2의 스케일 지표가 메시지 수가 아니라 세션 수가 된다.

### 4.2 Redis 전환 시의 후보 키

아래는 미래 Redis backend의 참고 모델이며 PoC의 실행 경로가 아니다. 현재 `packages/queue/src/redis.ts`는 placeholder이고 Postgres 구현만 제공한다. 특히 answers는 §6.4의 typed request별 내구성 계약을 만족해야 하며 단순 `BLPOP`만으로 구현 완료가 되지 않는다.

| 키 | 타입 | 용도 |
|----|------|------|
| `queue:session:{session_id}` | Stream | 그 세션의 메시지. 유일한 메시지 적재처 |
| `queue:unassigned` | Set | 워커를 기다리는 세션 ID. 페이로드 없음. KEDA 스케일 지표 |
| `events:{session_id}` | Stream | SDK native event에서 투영한 versioned public event. SSE 소스 |
| `answer:{session_id}:{request_id}` | List | 그 질문에 대한 답변. 워커가 `BLPOP`(§6.4) |
| `heartbeat:{pod_id}` | String, TTL 30s | 워커 생존 리스 |

pod별 큐는 없다. v0.1에는 `queue:pod:{pod_id}`가 있었고 워커가 클레임 직후 미배정 큐의 잔여 메시지를 자기 큐로 옮겼는데, 이 구조가 세 가지 결함을 만들었다.

1. 클레임에 실패한 워커가 집어든 메시지를 소유 워커에게 전달할 경로가 없어 유실됐다
2. 이관된 메시지가 pod 큐 뒤에 붙어, 이관 전에 pod 큐로 직행한 나중 메시지보다 늦게 처리됐다(N6 위반)
3. pod가 크래시하면 그 pod 큐의 메시지는 아무도 구독하지 않는 채로 남고, 크래시 이후 도착한 메시지는 미배정 경로로 즉시 처리되어 순서가 뒤집혔다. 회수는 reconciler 주기(1분)에 달려 있었다

메시지를 세션 큐 하나에만 두면 셋 다 사라진다. 옮길 대상이 없고, 갇힐 큐가 없고, 새 워커는 세션 큐를 이어서 소비할 뿐이다.

`answer` 키에 `request_id`가 들어가는 이유는 §6.4에 있다.

이벤트 스트림에는 `MAXLEN`을 걸지 않는다. `Last-Event-ID` 재개가 트림 경계 밖을 가리키면 이어보기가 조용히 깨지기 때문이다. 보존 정책이 필요해지면 그때 트림 경계 밖의 커서에 대한 응답(410 또는 gap 이벤트)을 함께 정한다.

### 4.3 오브젝트 스토리지 레이아웃

```
sessions/{session_id}/
  checkpoints/{checkpoint_id}/
    manifest.json         # git·transcript·설정 revision을 묶는 불변 manifest
    transcripts/...       # 94S-92가 선택한 backend의 root/subagent data
```

코드는 스토리지가 아니라 git remote의 `session/{session_id}` 브랜치에 둔다. 브랜치는 최신 작업 위치를 알리는 편의 포인터일 뿐이다. 재수화의 정본은 Postgres session row가 가리키는 checkpoint manifest이며, manifest의 workspace git SHA와 root/subagent transcript revision을 각각 복원한다. 자세한 publish·복구 계약은 §6.3.1에 둔다.

**왜 블록 스토리지가 아니라 오브젝트 스토리지인가**(§12.6). EBS는 볼륨을 노드에 붙이는 모델이라 "세션은 pod에 묶이지 않는다"(§1.1)와 충돌한다. 볼륨이 단일 AZ에 묶이므로 스팟 워커의 스케줄 가능 AZ가 제한되고, 한 번에 한 인스턴스만 붙일 수 있어 API 서버가 같은 데이터를 읽을 수 없다.

**대가**: S3는 append를 지원하지 않는다. 긴 세션은 content-addressed chunk를 재사용하고 manifest만 새 generation으로 발행한다. mutable한 단일 transcript/meta 객체를 덮어쓰지 않는다. 청크 임계값과 garbage collection은 실측 후 정하며, Postgres pointer 또는 보존 중인 manifest가 참조하는 객체는 삭제하지 않는다(94S-93).

`/workspace`는 `emptyDir`(§6.7), 즉 노드 로컬 디스크다. 큰 리포에서는 노드 디스크를 압박할 수 있으므로 `sizeLimit`을 건다. 여기에 EBS를 쓰지 않는 이유도 위와 같다 — attach 지연이 콜드스타트에 더해지고 AZ가 고정된다.

---

## 5. API

Base path: `/v1`

| 메서드 | 경로 | 요청 | 응답 | 설명 |
|--------|------|------|------|------|
| POST | `/sessions` | `{repo_url, base_branch, message, model?, permission_mode?}` | `201 {session_id}` | 세션 생성 + 첫 턴 큐잉 |
| GET | `/sessions` | `?owner_id&status` | `[{session}]` | 목록 |
| GET | `/sessions/{id}` | | `{session, current_turn, pull_requests}` | 상태 조회 |
| POST | `/sessions/{id}/messages` | `{message}` | `202 {turn_id}` | 후속 메시지. 실행 중이면 큐에서 대기 |
| GET | `/sessions/{id}/events` | `Last-Event-ID` 헤더 | `text/event-stream` | 이벤트 스트리밍. 재접속 시 이어보기 |
| POST | `/sessions/{id}/answers` | `{request_id, answer}` | `204` | `answer` 내부 판별 타입으로 질문·권한 요청을 검증. request별 멱등 처리 |
| GET | `/sessions/{id}/transcript` | `?after_uuid` | `[{normalized message}]` | JSONL 정규화 이력. **PoC 범위 밖** — `events` 테이블(§4.1)이 같은 이력을 제공하므로 두 번째 경로를 만들지 않는다. JSONL은 resume용 원본으로만 쓴다 |

| POST | `/sessions/{id}/stop` | | `202` | 현재 턴 중단 |
| POST | `/sessions/{id}/pin` | `{pinned: bool}` | `204` | 유휴 회수 제외 |
| DELETE | `/sessions/{id}` | | `204` | pod·브랜치·스토리지 정리. active session은 `409` |

**F6은 이 엔드포인트가 아니라 `events`로 만족된다.** "트랜스크립트가 외부 스토리지에 남고 이를 통해 이력과 상태를 조회할 수 있다"는 요구에서, 영속화는 §4.3의 S3 업로드(94S-13)가, 조회는 `events` 테이블과 SSE 재생(94S-16, 94S-22)이 담당한다. JSONL 원본 형태 그대로가 필요한 클라이언트가 생기면 그때 이 엔드포인트를 연다(§15.4).

`POST /sessions`와 `POST /sessions/{id}/messages`는 `Idempotency-Key` 헤더를 받는다. 같은 키의 재요청은 새 세션이나 새 턴을 만들지 않고 최초 응답을 그대로 돌려준다. 이 API의 클라이언트는 사람이 아니라 서비스(§12.5)이고, 타임아웃 후 재시도는 그쪽의 기본 동작이다.

`/v1` 밖에 프로브 엔드포인트 두 개를 둔다. 인증을 요구하지 않고 세션 정보를 노출하지 않는다.

| 경로 | 용도 | 성공 조건 |
|------|------|-----------|
| `GET /healthz` | liveness. 프로세스가 살아 있는가 | 항상 200. 의존 서비스를 보지 않는다 |
| `GET /readyz` | readiness. 트래픽을 받을 수 있는가 | Postgres 연결과 마이그레이션 적용 상태 확인 |

둘을 나누는 이유는 실패 시 쿠버네티스의 반응이 다르기 때문이다. liveness 실패는 pod 재시작이고, readiness 실패는 로드밸런서에서 제외다. DB가 잠시 끊겼을 때 재시작을 반복하면 복구가 더 느려지므로, 의존 서비스 확인은 `readyz`에만 넣는다.

`GET /ui`는 세션 인스펙터를 서빙한다. `AUTH_MODE=none`일 때만 등록되므로 운영에서는 경로 자체가 없다(§10.5).

### 5.1 SSE 이벤트 형식

SDK native message는 워커 내부의 versioned envelope로 먼저 수집하고, 공개 계약으로 projection한 뒤 `events`에 저장한다. SDK 객체를 그대로 SSE로 내리지 않는다. 이 경계가 SDK 버전 변화와 공개 API를 분리한다. envelope는 SDK/CLI version, native message type/subtype, message·tool use·parent tool use ID와 관측 순서를 보존하며, 모르는 native variant도 유실 없이 진단할 수 있어야 한다. 공개 이벤트는 필요한 필드만 안정적으로 노출하고 secret·전체 설정·내부 경로를 제거한다. SSE `id`는 **불투명 커서 문자열**이다.

```
id: ev_01J8X2K4M9
event: assistant
data: {"type":"assistant","message":{...}}

id: ev_01J8X2K4MA
event: tool_use
data: {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}

id: ev_01J8X2K4MB
event: question
data: {"request_id":"q_01","kind":"permission","tool_use_id":"tool_01","tool":"Bash","input":{...}}

id: ev_01J8X2K4MC
event: result
data: {"type":"result","subtype":"success","session_id":"...","usage":{...}}
```

공개 이벤트 종류: `system` · `assistant` · `tool_use` · `tool_result` · `question` · `result` · `status`(상태 전이 알림) · `error`. native variant와 공개 event type의 대응은 projection fixture로 검증하며, 둘이 1:1이라고 가정하지 않는다.

**커서는 불투명하다.** 클라이언트는 받은 값을 그대로 `Last-Event-ID`로 돌려줄 뿐, 그 안을 해석하지 않는다. Postgres 백엔드에서는 `events.id`(BIGSERIAL), Redis 백엔드에서는 스트림 엔트리 ID를 인코딩한 것이지만, 그 차이는 `packages/queue` 뒤에 숨는다. v0.1은 Redis 엔트리 ID 포맷(`1726100000000-0`)을 계약에 그대로 노출했는데, 그러면 §12.4가 허용한 백엔드 교체가 클라이언트 계약을 깨뜨린다.

**재개는 durable한 `events` 테이블에서 온다.** Postgres 백엔드에서 `LISTEN/NOTIFY`는 "새 이벤트가 있다"를 깨우는 용도일 뿐이고 이벤트의 저장소가 아니다. NOTIFY는 페이로드가 8000바이트로 제한되어 큰 assistant 메시지를 담지 못하고, 무엇보다 비영속이라 구독자가 없던 동안의 알림이 사라진다. 본문은 항상 테이블에서 읽는다.

### 5.2 스트리밍 방식 선택

읽기는 SSE, 쓰기는 POST로 분리한다. 단방향이라 HPA·로드밸런서와 잘 맞고 재접속 이어보기가 `Last-Event-ID`로 단순하다. 양방향이 꼭 필요하면 WebSocket으로 바꾸되 프로토콜은 동일하게 유지한다.

---

## 6. 워커 설계

### 6.1 구성

워커 pod 하나에 컨테이너 하나. 그 안의 컨트롤러 프로세스(Bun)가 Agent SDK를 구동한다. 아래는 목표 컨테이너 배치이며 현재 checkout의 파일 목록이 아니다. `~/.claude`는 host HOME이 아니라 세션별 격리 HOME/config를 뜻한다.

```
worker pod
├── /app/worker.ts        # 사이드카: 큐 소비, SDK 구동, 이벤트 발행, heartbeat
├── /workspace            # git clone 대상 (emptyDir)
└── ~/.claude/projects/   # 트랜스크립트 (스토리지에서 복원)
```

### 6.2 기동 시퀀스

1. `QueueBackend.lease` heartbeat로 Postgres `workers.last_seen` 갱신 루프 시작(10초 주기, stale 기준 30초)
2. Postgres `unassigned_sessions`에서 세션 ID 후보를 읽음
3. Postgres에서 매핑 획득. 아래 `UPDATE`와 미배정 신호 삭제를 한 트랜잭션에서 실행
   ```sql
   UPDATE sessions SET pod_id = $pod, status = 'running'
   WHERE id = $session AND pod_id IS NULL RETURNING *;
   DELETE FROM unassigned_sessions WHERE session_id = $session;
   ```
   `UPDATE`가 성공한 경우에만 `DELETE`하고 함께 커밋한다. 실패(다른 pod가 선점)하면 신호를 삭제하지 않고 2로 돌아감
4. owner가 일치하는 Postgres checkpoint pointer와 manifest를 검증하고 workspace exact git SHA, root/subagent exact transcript revision, 설정 fingerprint를 같은 generation에서 복원
5. 이후 해당 `session_id`의 Postgres `queue_messages`를 순서대로 소비

`CLAIM_TIMEOUT_SEC` 안에 3을 성공하지 못하면 `exit 0`으로 종료한다. KEDA는 미배정 세션 수만큼 Job을 만들고 스케일 인을 하지 않으므로(§7.6), 클레임하지 못한 워커가 스스로 나가지 않으면 Job이 쌓여 `maxReplicaCount`를 채우고 스케일 아웃이 멈춘다.

v0.1에는 "획득한 세션의 나머지 대기 메시지를 pod 큐로 옮김" 단계가 있었다. 삭제했다. 메시지가 처음부터 세션 큐 하나에만 있으므로 옮길 대상이 없고, 그 이관이 §4.2에 적은 세 결함의 원인이었다. 클레임에 실패한 워커는 로컬 후보만 버리며 DB 신호를 삭제하지 않는다. 메시지는 세션 큐에 그대로 있고 승자가 읽는다.

### 6.3 턴 처리

SDK 호출의 세부 signature는 94S-91이 고정한다. 구현은 다음 의사 흐름을 지키며, 세션 수명 동안 열린 generator에 입력을 무제한 yield하는 방식을 전제로 하지 않는다.

1. owner가 허용한 profile에서 `claude_code` preset, reviewed project settings, setting sources, tool policy와 session별 격리 환경을 구성한다.
2. durable queue에서 아직 ACK되지 않은 다음 input 하나를 가져와 turn을 만든다. 같은 세션의 turn input은 직렬이며, 실행 중 turn에 새 input을 섞지 않는다.
3. SDK native message를 versioned envelope로 먼저 보존하고, 공개 8종 event mapper를 거쳐 SSE event를 저장한다. unknown native variant와 ID·순서는 envelope에 남긴다.
4. permission 또는 `AskUserQuestion` 요청은 pending store에 먼저 등록한 뒤 `question` event를 publish한다. 병렬 요청마다 독립된 `request_id`와 `tool_use_id`를 유지한다.
5. `/answers`의 `answer` 내부 판별 타입을 검사해 해당 callback만 완료한다. timeout도 callback에는 deny로 반환하고 UI에는 typed timeout을 표시하지만, deny 자체를 turn 종료로 간주하지 않는다.
6. SDK `result` subtype, 사용자 interrupt, 인프라 abort를 구분한다. 정상 성공은 checkpoint publish와 durable terminal 기록 후 ACK한다. terminal 오류·사용자 stop은 재실행 금지 상태를 먼저 내구성 있게 기록하며 저장 실패와 별도로 취급한다. 그 뒤 ACK에 실패해도 다음 소비자는 terminal 상태를 확인해 SDK를 호출하지 않고 ACK만 재시도한다. 재시도 가능한 인프라 실패는 ACK하지 않는다.

하나의 입력은 queue row 하나와 stable turn ID 하나를 유지한다. 재시도는 **동일 row의 visibility/claim을 해제**해 다음 attempt가 받게 하며 새 입력을 추가 enqueue하지 않는다. attempt ID·SDK message UUID로 진행 이력을 구분한다. 결과 기록·ACK와 lease release·매핑 해제·미배정 신호에 필요한 DB transaction API는 94S-24·94S-30·94S-20에서 확장한다. M0의 개별 `ack()`/`release()` 호출만으로 이 묶음의 원자성을 가정하지 않는다. 장시간 턴은 delivery visibility 갱신 또는 동등한 소유권 보호를 구현하고 timeout 이후 중복 소비를 테스트한다. 재개 시 SDK가 이미 반영한 메시지를 다시 보내지 않는 계약은 94S-91에서 확정한다. 외부 도구 부작용의 exactly-once를 증명할 수 없는 경우 자동 재실행을 보류하고 명시적인 복구 필요 상태를 남긴다.

### 6.3.1 체크포인트

턴 중 `CHECKPOINT_INTERVAL_SEC`(기본 60초) 타이머는 저장을 **요청**할 뿐이다. SDK event 소비를 멈췄다고 background tool writer까지 멈춘 것은 아니다. 체크포인트는 workspace의 exact git SHA와 root/subagent 각각의 exact transcript revision, runtime·project 설정 fingerprint를 하나의 **불변 generation**으로 묶는다.

v0.1은 JSONL만 60초마다 올리고 git push는 턴 종료에만 했다. 그러면 턴 도중 사고 종료 시 트랜스크립트에는 "파일 X를 이렇게 고쳤다"는 tool_result가 남아 있는데 원격 브랜치에는 그 수정이 없다. 새 워커는 그 상태로 resume하고, Claude는 자기가 이미 썼다고 기억하는 파일이 없는 워크스페이스에서 작업을 이어간다. 진행분 손실이 아니라 트랜스크립트와 실제 상태의 모순이라 재개 후 행동이 어긋난다.

저장 전에는 SDK event 수집뿐 아니라 background writer와 subagent 파일 변경까지 quiesce되었고 진행 중 tool callback·write가 없는지 확인한다. 확인 직후부터 pointer CAS의 성공·실패까지 배타적 checkpoint lease로 새 writer 시작을 거절해 검사와 저장 사이 TOCTOU를 막는다. quiescence를 증명하지 못하거나 lease를 얻지 못하면 새 generation을 publish하지 않고 이전 generation을 유지하며 명시적 오류를 기록한다. 체크포인트 순서는 다음과 같다.

1. workspace를 commit해 exact git SHA를 얻고 remote에 push한다. subagent revision은 git SHA가 아니라 각 transcript backend가 제공하는 exact revision으로 별도 기록한다.
2. 94S-92가 선택한 단일 backend의 root/subagent data를 immutable object로 업로드하고 hash/revision을 검증한다.
3. `checkpoint_id`, owner ID, workspace git SHA, root/subagent transcript revision과 object hash, SDK·Claude Code version, 설정 profile version과 secret을 제외한 fingerprint를 담은 immutable manifest를 쓴다.
4. Postgres의 authoritative checkpoint pointer를 같은 DB transaction에서 `owner_id`, 현재 `pod_id`, previous checkpoint revision 조건으로 CAS해 새 manifest로 전진시킨다. 94S-93은 이를 위한 최소 schema/API를 추가한다.

1~3 사이에서 죽거나 CAS에 실패한 generation은 재개의 대상이 아니다. 새 워커는 Postgres pointer가 가리키고 모든 객체·hash·revision이 검증되는 마지막 generation만 사용하며, 없거나 깨졌으면 안전한 이전 generation으로 돌아간다. branch HEAD와 최신 object를 독립적으로 조합하지 않는다. S3 manifest의 owner 사전 조회나 ETag 조건은 DB와 원자적이지 않으므로 권한·소유권 fence로 쓰지 않는다.

G2는 현재 `pod_id`와 previous revision의 CAS까지만 요구한다. 94S-44는 G4에서 checkpoint 외 전체 write에 claim epoch fencing을 확장하며, G2가 이를 구현 완료했다고 주장하지 않는다.

94S-92 실측 결과 고정 SDK의 `SessionStore`를 단일 transcript backend로 채택한다. S3 mirror의 최신 상태는 checkpoint가 아니다. 94S-93은 root/subagent별 immutable part key와 SHA-256 목록을 exact revision으로 고정하고 manifest가 지정한 revision만 복원한다. SDK가 session 중 `mirror_error`를 보고해도 turn 자체는 성공할 수 있으므로 해당 turn 뒤 suffix는 checkpoint로 승격하지 않는다. append timeout 뒤 늦은 write와 retry가 함께 반영될 수 있어 동일 UUID의 deep-equal entry만 중복 제거하고 payload가 다르면 손상으로 거절한다. manifest revision이 없거나 object/hash 검증이 실패하면 SDK의 local fallback을 호출하지 않고 claim을 실패시킨다.

M0 filesystem snapshot은 병행 write backend가 아니라 lossless legacy importer와 rollback 입력으로만 유지한다. legacy `meta.json`에는 workspace git SHA가 없어 과거 transcript와 branch HEAD를 검증 가능한 동일 시점으로 취급하지 않는다. 원본 object·metadata·branch를 보존한 채 quiescent 전환 시점의 exact git SHA와 가져온 전체 transcript revision을 새 generation으로 발행하고 CAS 전에는 legacy 경로로 롤백한다. SDK가 임시 config directory를 요구하면 session/owner별 allowlist config root를 원본으로 제공하고 host user settings·auto memory·다른 tenant cache를 공유하지 않는다. 상세 실측과 실패 계약은 `spikes/94s-92/README.md`에 기록한다.

### 6.4 질문·권한 요청 처리

`canUseTool`과 `AskUserQuestion`은 서로 다른 typed request/answer 계약으로 연결한다. 한 assistant message가 여러 tool request를 병렬로 만들 수 있으므로 워커는 단일 `waiting` 슬롯이 아니라 turn별 pending-request map을 유지한다. 각 요청은 앱 `request_id`, SDK `tool_use_id`, kind, 입력 schema와 상태를 가진다. 정책:

- 타임아웃 기본 30분. permission과 `AskUserQuestion` callback에는 deny를 반환하고 UI에는 kind별 typed timeout을 표시한다. deny 자체는 turn 종료가 아니며, 다른 pending 요청이 없을 때만 `needs_input`을 해제한다
- 기본 `permissionMode`는 `default`다. project settings·hook·MCP·plugin은 owner가 허용한 repo의 reviewed profile만 로드한다
- read-only 도구도 profile에 명시된 것만 사전 허용한다. Bash를 blanket allow하지 않고 command별 callback과 sandbox 정책을 함께 적용한다
- permission answer는 allow/deny와 선택적인 reviewed input을, `AskUserQuestion` answer는 question ID별 단일/다중 선택 또는 자유 입력을 schema로 검증한다

**답변은 `request_id`별 저장소에서 독립적으로 상관관계를 맞춘다.** 다른 pending request의 답을 소비하거나 폐기하지 않는다. 첫 유효 답변만 원자적으로 확정하고 duplicate는 같은 결과를 돌려주는 멱등 요청으로 처리한다. unknown·종결·타임아웃 request의 답은 권한에 적용하지 않고 감사 가능한 거절 결과를 남긴다. 세션 `needs_input`은 pending set이 하나 이상이라는 projection이며, 일부 요청이 끝나도 다른 요청이 남으면 유지한다.

v0.1의 코드는 `BLPOP answer:{session_id}`로 세션 단위 대기만 했다. 그러면 두 경로로 잘못된 승인이 적용된다.

1. 타임아웃되어 deny로 닫힌 질문에 사람이 뒤늦게 답하면, 그 값이 리스트에 남아 **다음 질문**의 답으로 소비된다
2. 대기 중 워커가 죽고 새 워커가 같은 툴을 다시 물었을 때, 죽은 워커 시절에 쌓인 답변이 그대로 적용된다

권한 승인·거부가 걸린 채널이므로 단순 버그가 아니라 잘못된 권한이 부여되는 경로다. permission 타임아웃과 파싱 실패는 해당 요청만 deny로 닫는다. 질문 timeout의 사용자 표시와 SDK 반환값도 kind별로 명시한다. interrupt나 drain은 모든 pending request에 명시적 종결 event를 남기되, 서로 다른 요청의 답을 삭제하지 않는다.

94S-91은 `@anthropic-ai/claude-agent-sdk` 0.3.270과 Claude Code 2.1.270을 고정했다. 승인 대기 중 `AbortController`는 side effect 없이 `success/completed` result를 먼저 낸 뒤 iterator error로 끝날 수 있고, SIGTERM은 result 없이 transcript의 pending `tool_use_id`를 남기며, SIGKILL은 transcript tail 자체를 잃을 수 있다. abort와 SIGTERM 뒤 resume은 session을 열어도 pending callback이나 tool을 재호출하지 않고, SIGKILL 뒤에는 `No conversation found`가 될 수 있다. 앱 `request_id`는 `tool_use_id`와 별도로 유지하고 늦은 답변은 해당 종결 요청에만 거절한다. `result.success`만으로 승인 대기 turn의 성공을 판정하지 않는다.

0.3.270의 `PreToolUse permissionDecision: "defer"`는 한 assistant message의 복수 tool hook을 모두 호출하고 `success/tool_deferred`로 turn을 닫지만, resume에서 deferred tool을 재호출하지 않는다. 외부 승인 저장소의 continuation 수단으로 채택하지 않는다. 승인 대기 중에는 live callback과 worker process를 유지하고, timeout이면 해당 request를 deny한 뒤 안정된 새 user message UUID로 재시도한다. 같은 UUID의 redelivery는 SDK가 deduplicate하지만 UUID를 재생성하면 새 turn이므로 앱 queue가 UUID의 생성과 재전송 안정성을 소유한다.

### 6.5 턴 종료와 유휴 회수

SDK `result` 수신만으로 성공 종료를 가정하지 않는다. 94S-91이 고정한 terminal subtype을 성공·실패·사용자 interrupt로 분류한 뒤 각각 `idle`·`failed`·`stopped` 정책을 적용한다. 성공 턴 종료 시:

1. 체크포인트 실행(§6.3.1). 턴 중 주기 저장과 같은 루틴이다
2. `status = idle`, `last_turn_at = now()`
3. 유휴 타이머 시작(기본 30분, `pinned`면 무한)

checkpoint publish가 실패하면 완료 event와 input ACK를 보류하고 이전 안전 generation을 유지한다. turn을 완료로 표시한 뒤 저장 실패를 숨기거나, 실패·interrupt를 성공과 같은 `idle` 경로로 보내지 않는다.

타이머 만료 시: 매핑 삭제(`pod_id = NULL`) → 프로세스 종료 → pod 종료. 개발 서버가 떠 있는 세션은 `pinned` 또는 긴 타이머로 회수를 미룬다. 회수 후 재개 시 개발 서버는 다시 띄워야 하므로, CLAUDE.md에 "작업 시작 시 서버 상태를 확인하고 필요하면 기동" 규칙을 둔다.

### 6.6 사용자 interrupt와 인프라 drain

`POST /stop`은 **현재 턴만 취소하는 interrupt**다. SDK turn을 중단하고 pending request를 cancelled로 닫으며, 처리 중 입력은 소비 완료로 남겨 재큐잉하지 않는다. turn의 재실행 금지·`interrupted` 상태와 session의 `stopped` 상태를 durable하게 확정하고, 가능한 안전 경계에서 checkpoint를 시도한다. checkpoint 실패를 이유로 사용자의 취소를 되돌리거나 입력을 다시 실행하지 않는다. 같은 pod는 유지하며 다음 메시지는 새 turn으로 `stopped → running` 전이한다. public `status`·`result`의 순서는 한 번만 기록되어야 한다.

SIGTERM·노드 drain은 **인프라 abort**다. 사용자가 요청한 작업을 취소한 것이 아니므로, 성공적으로 publish된 checkpoint와 durable turn 상태를 기준으로 현재 turn attempt를 재시도할 수 있다. 반면 소유권을 잃은 워커와 사용자 stop turn은 입력을 재큐잉하지 않는다. 사용자 interrupt와 인프라 abort는 SDK/Claude Code process에 미치는 범위를 94S-91에서 별도 runtime 계약으로 고정하고, queue acknowledgment와 상태 전이 정책도 공유하지 않는다.

`terminationGracePeriodSeconds: 120`. SIGTERM 수신 시:

1. pending request를 모두 무효화하고 종결 event를 기록
2. 실행 중인 SDK query를 abort
3. background writer quiescence와 현재 DB owner를 확인한 뒤 checkpoint 실행(§6.3.1)
4. durable turn 상태와 gate의 replay 정책으로 재시도 여부를 판정한다. 완료·취소 입력은 새로 enqueue하지 않으며 ACK가 남았으면 terminal 상태를 근거로 정리한다
5. 재시도 가능한 원래 queue row의 claim/visibility 해제, 현재 owner의 매핑 해제, `status = queued`, 미배정 신호 추가를 같은 DB transaction으로 처리한다. 재시도 불가 입력은 실패/복구 필요를 기록하고 자동 실행하지 않는다. 유휴 세션은 매핑만 해제하고 입력 없이 신호를 만들지 않는다

재전달하는 것은 **워커가 처리 중이던 원래 queue row 하나뿐**이며 새 row를 추가하는 것이 아니다. turn/attempt ID로 중복 실행과 event 중복을 구분한다. grace 기간 안에 checkpoint를 publish하지 못하면 이전 안전 generation은 보존하고, 재큐잉 여부를 durable turn-attempt 상태로 결정한다. 완료되지 않은 새 manifest나 branch HEAD를 재개의 근거로 쓰지 않는다.

스팟 선점은 노드 종료 알림(AWS 2분 전 등)을 node-termination-handler가 받아 drain하므로 위 경로를 탄다. 알림 없이 사라지면 §7.4 heartbeat 경로로 복구된다.

### 6.7 격리

- 세션당 pod, `emptyDir` 워크스페이스
- baseline은 gVisor runtime class. 94S-94는 94S-31·94S-33 이후 Agent Sandbox를 같은 위협 모델·cold start·운영 복잡도로 선택 비교하되, 채택 근거가 없으면 KEDA+gVisor를 유지한다
- NetworkPolicy로 egress를 승인된 LLM/gateway 엔드포인트·git remote·패키지 레지스트리·Postgres·스토리지로 제한
- 리소스: requests `cpu: 1, memory: 2Gi`, limits `cpu: 4, memory: 8Gi` (빌드·테스트 부하 고려)

---

## 7. 다중 워커 관리

### 7.1 메시지 라우팅

```
POST /sessions/{id}/messages
  → 항상 Postgres queue_messages에 session_id로 적재
  → sessions.pod_id 가 NULL 이면 unassigned_sessions에 세션 ID 신호 추가
```

**메시지가 어디로 갈지는 pod 상태와 무관하다.** `pod_id` 조회는 신호를 추가할지 말지에만 쓰이고, 그 판단이 틀려도 안전하다. 워커가 방금 죽었는데 살아 있다고 보고 신호를 안 넣었다면, 메시지는 세션 큐에 그대로 있고 reconciler가 매핑을 해제할 때 신호가 올라간다. 반대로 불필요한 신호가 들어가면 워커 하나가 떠서 클레임에 실패하고 스스로 나간다(§6.2).

신호는 `session_id`가 PK인 집합이므로 같은 세션에 여러 번 넣어도 하나다(§4.1). 그래서 미배정 신호의 수가 곧 워커를 기다리는 세션 수이고, 그대로 스케일 지표가 된다.

v0.1은 heartbeat를 확인해 pod 큐와 미배정 큐 중 하나를 골랐다. 그 분기가 §4.2에 적은 세 결함의 출발점이었으므로 삭제했다. 성능을 이유로 pod별 큐를 다시 들이면 같은 결함이 함께 돌아온다.

### 7.2 스케일 아웃

KEDA 2.20.x ScaledJob이 Postgres의 `unassigned_sessions` 행 수를 본다. **미배정 세션 1개당 pod 1개.** `session_id`가 PK이므로 `COUNT(*)`가 distinct 세션 수이며, 메시지 수가 아니다. 같은 세션에 메시지가 10개 들어와도 그 세션을 집을 워커는 하나면 된다.

스케일 지표는 마이그레이션의 `queue_unassigned_session_count()`로 정의한다. KEDA와 local-scaler가 모두 `SELECT queue_unassigned_session_count()`를 호출하므로 SQL이 서로 어긋나지 않는다. `accurate`의 전제를 지키기 위해 워커는 클레임 성공 시 매핑 획득과 미배정 신호 삭제를 같은 트랜잭션에서 커밋하고, 클레임 실패 시 신호를 삭제하지 않는다. 재큐잉도 매핑 해제와 `status = queued` 전이 뒤 같은 트랜잭션에서 신호를 복원한다(§6.2, §7.4).

`minReplicaCount: 0`으로 상시 대기 워커를 두지 않는다. 아래 YAML은 목표 템플릿이며 image digest·Secret·권한·환경별 설정을 채우기 전에는 배포하지 않는다.

프리웜은 PoC 범위 밖이다. v0.1은 "고정 크기 Deployment로 프리웜 잡 1~2개 유지"를 제안했는데 이 구조로는 작동하지 않는다. 프리웜 pod가 세션을 클레임해도 Deployment는 그것을 여전히 살아 있는 replica로 세므로, 대기 중인 pod가 0이 된다. 콜드스타트 대응은 §11의 노드 이미지 캐시와 이미지 슬림화로 먼저 다룬다.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: claude-worker
spec:
  jobTargetRef:
    backoffLimit: 0
    template:
      spec:
        runtimeClassName: gvisor
        restartPolicy: Never
        terminationGracePeriodSeconds: 120
        nodeSelector: { node-pool: spot }
        containers:
          - name: worker
            image: registry/claude-worker@sha256:<verified-digest>
            envFrom: [{ secretRef: { name: claude-worker-env } }]
            resources:
              requests: { cpu: "1", memory: 2Gi }
              limits: { cpu: "4", memory: 8Gi }
  pollingInterval: 5
  minReplicaCount: 0
  maxReplicaCount: 100
  scalingStrategy: { strategy: accurate }
  triggers:
    - type: postgresql
      metadata:
        connectionFromEnv: DATABASE_URL
        query: SELECT queue_unassigned_session_count()
        targetQueryValue: "1"
        activationTargetQueryValue: "0"
```

`pollingInterval: 5`는 trigger 하나인 ScaledJob 하나당 정상 상태에서 약 분당 12회의 count query다. scaler는 DB pool을 재사용하지만 pool 상한을 직접 설정하지 않으므로 실제 Postgres connection 수와 query 지연은 kind에서 관측한다. scaler 전용 DB role에는 함수 실행에 필요한 최소 권한만 주고 연결 문자열은 Secret에서 주입한다.

ScaledJob을 쓰는 이유: Deployment는 pod가 스스로 종료하면 즉시 대체 pod를 띄우고, 스케일 인 시 어떤 pod를 죽일지 KEDA가 고른다. Job은 워커가 종료하면 그걸로 끝이라 "유휴 pod가 스스로 나간다"는 모델과 맞는다.

### 7.3 스케일 인

워커 주도. §6.5의 유휴 타이머 만료로 pod가 스스로 종료한다. KEDA는 pod를 죽이지 않는다.

### 7.4 생존 감시와 고아 정리

- 워커: `QueueBackend.lease`를 통해 `workers.last_seen`을 10초마다 갱신
- reconciler(CronJob, 1분): `pod_id IS NOT NULL` 중 lease가 없거나 `last_seen`이 stale 기준을 넘은 세션을 조회. 회수 transaction 안에서 heartbeat와 현재 매핑을 재확인

정리는 terminal turn·replay 허용 여부를 확인한 뒤 **원래 queue row의 재전달 허용 → 매핑 해제 → `status = queued` → 미배정 신호**를 한 트랜잭션 안에서 처리한다. 완료·사용자 취소 입력은 실행하지 않으며 재시도 불가 입력은 실패/복구 필요 상태를 남긴다. 대기 입력이 없는 세션은 매핑만 해제하고 신호를 만들지 않는다. 순서가 뒤바뀌면 신호를 보고 온 워커가 아직 남아 있는 `pod_id` 때문에 클레임에 실패한다.

큐 이관 단계는 없다. 죽은 pod가 소유하던 세션의 메시지는 세션 큐에 그대로 있고, 매핑이 풀리면 다음 워커가 순서대로 이어 읽는다.

API는 라우팅 시 heartbeat를 확인하지 않는다(§7.1). v0.1에서는 API가 heartbeat 부재를 즉시 감지해 재라우팅하고 reconciler는 1분 뒤에야 잔여 메시지를 옮겼는데, 두 복구 경로의 속도 차이가 N6를 깨는 반례를 만들었다 — 크래시 직전 메시지는 죽은 pod 큐에 갇히고 크래시 직후 메시지는 새 pod가 초 단위로 처리했다. 이제 복구 경로가 reconciler 하나이고, 메시지 순서는 세션 큐가 지킨다.

백엔드에 따라 `HEARTBEAT_TTL_SEC`를 누가 쥐는지가 다르다. Postgres에서는 reconciler가 `workers.last_seen`과
비교하므로 reconciler 쪽 값이 회수 속도를 정한다. Redis에서는 리스가 TTL 키라 만료를 워커가 정하고 reconciler 쪽
값은 무시된다 — Redis에서 복구를 빠르게 하려면 워커의 값을 낮춰야 한다.

### 7.5 상태 전이표

| 상황 | 매핑 | pod |
|------|------|-----|
| 새 세션 첫 메시지 | 없음 → 워커 획득 | 미배정 → running |
| 매핑된 세션에 메시지 | 유지 | idle → running |
| 턴 종료 | 유지 | running → idle |
| 질문 대기 | 유지 | running → needs_input |
| 유휴 타이머 만료 | 삭제 | 종료 |
| heartbeat 소실 | 삭제(reconciler) | 이미 없음 |
| 클레임 실패가 타임아웃까지 반복 | 없음 | `exit 0` |
| SIGTERM | 삭제, 재큐잉 | 저장 후 종료 |
| `/stop` | 유지 | running/needs_input → stopped. 입력 재큐잉 없음 |
| stopped 세션의 새 메시지 | 유지 | stopped → running. 새 turn 생성 |

### 7.6 pod 실행·종료 제어의 원칙

**시작은 KEDA가, 종료는 워커 자신이 결정한다.** 쿠버네티스는 실행 중인 워커 pod를 임의로 회수하지 않으며, 워커가 `exit 0`하면 Job이 완료 처리될 뿐이다.

| 동작 | 주체 | 근거 |
|------|------|------|
| pod 생성 | KEDA ScaledJob | Postgres 미배정 세션 수와 `accurate` 전략으로 부족한 Job 계산 |
| 세션 획득 | 워커 | `UPDATE sessions SET pod_id=$me WHERE pod_id IS NULL` 성공 |
| 턴 시작 / 종료 | 워커 | 큐 메시지 도착 / SDK `result` 수신 |
| 정상 종료 | 워커 | 유휴 타이머 만료 → 저장 → `exit 0` |
| 강제 종료 | 쿠버네티스 → 워커 | 노드 drain·롤링 업데이트 시 SIGTERM, 워커가 유예 시간 안에 저장 후 종료 |
| 사고 종료 | 없음 | OOM, 선점 알림 없는 노드 소실. reconciler가 사후 정리 |

ScaledJob은 "부족하면 만든다"만 하고 "남으면 지운다"는 하지 않으므로 이 원칙이 성립한다. Deployment였다면 pod가 스스로 종료해도 대체 pod가 즉시 뜨고, 스케일 인 시 어떤 pod를 죽일지 KEDA가 고르게 되어 실행 중 세션이 끊길 수 있다. Job 재시도는 `backoffLimit: 0`으로 끄고, 재시도는 §6.3의 원래 queue row 재전달과 SDK replay 계약으로 처리한다. 새 row 재삽입만으로 중복 실행이 방지된다고 주장하지 않는다.

### 7.7 상태의 저장 위치와 정본

상태는 세 군데에 나뉘어 있고 정본은 하나다.

| 저장소 | 내용 | 쓰는 주체 | 성격 |
|--------|------|-----------|------|
| Postgres `sessions` | `status`, `pod_id` | 워커(획득·전이·해제), reconciler(고아 정리). API는 읽기와 `queued` 전이만 | **정본**. 클라이언트가 보는 세션 상태 |
| Postgres `workers.last_seen` | 마지막 heartbeat 시각 | 워커 10초 주기, reconciler stale 기준 30초 | 최근 생존의 증거이며 현재 소유권 자체를 보장하지 않음 |
| Kubernetes Job/Pod | Running / Complete / Failed | kubelet | 인프라 수준. 세션 상태와 직접 연결하지 않음 |

Job이 Failed여도 세션은 `queued`로 재큐잉되어 다음 pod가 이어받으므로, 세션 상태를 쿠버네티스 상태에서 유도하지 않는다.

### 7.8 워커 프로세스 내부 상태 기계

```ts
let phase: "booting" | "claiming" | "running" | "idle" | "interrupting" | "draining";
let sessionId: string | null;          // 획득한 세션
let idleTimer: Timer | null;           // idle 진입 시 시작, 메시지 도착 시 취소
let currentTurn: { abort: AbortController; turnId: number } | null;
let pendingRequests: Map<string, PendingRequest>;
```

| 전이 | 트리거 | 동작 |
|------|--------|------|
| `booting → claiming` | 기동 | heartbeat 루프 시작, `unassigned_sessions` 후보 조회 |
| `claiming → running` | DB UPDATE 성공 | 검증된 manifest로 transcript·repo 복원, 해당 session의 `queue_messages` 소비 시작. 실패면 `claiming` 유지 |
| `claiming → exit` | `CLAIM_TIMEOUT_SEC` 경과 | 자기 heartbeat lease 해제, `exit 0`. 저장할 것이 없으므로 drain을 거치지 않는다 |
| `running → running` | permission/question 진입 | pending map에 추가하고 `question` 발행. pending이 있으면 session status만 `needs_input`으로 projection |
| `running → running` | request별 답변/타임아웃 | 해당 request만 종결. pending이 비면 session status를 `running`으로 projection |
| `running → interrupting → idle` | `/stop` | 현재 turn interrupt, durable `interrupted`/`stopped` 기록 후 best-effort checkpoint. 저장 실패와 무관하게 재실행 금지, 다음 메시지 대기 |
| `running → idle/failed/stopped` | terminal `result` 판정 | subtype별 상태 결정. 성공은 checkpoint publish 후 ACK·idle, 실패와 interrupt는 각 정책 적용 |
| `idle → running` | 세션 큐에 메시지 | 타이머 취소, 다음 턴 시작 |
| `idle → draining` | 타이머 만료 | 저장 루틴 진입 |
| `* → draining` | SIGTERM | pending 무효화 → SDK abort → quiescence/owner 확인 → checkpoint. durable 미완료 input만 재큐잉 |
| `* → draining` | heartbeat 갱신 시 `pod_id ≠ me` | 소유권 상실 감지. 로컬 callback 취소와 process abort만 수행. DB/event/checkpoint/queue/release write 없이 종료 |
| `draining → exit` | drain 완료 | 현재 소유자일 때만 매핑 해제·durable 상태 전이·미배정 신호를 한 transaction으로 처리하고 heartbeat 삭제 |

`draining`은 공통 정리 phase지만 진입 원인을 보존한다. 유휴 종료, SIGTERM 재시도, 소유권 상실은 checkpoint·재큐잉·DB release 권한이 서로 다르며 같은 후처리로 뭉개지 않는다.

### 7.9 어긋남과 복구

| 어긋남 | 감지 | 복구 |
|--------|------|------|
| 매핑 있음, heartbeat 없음 | reconciler 1분 주기 | 매핑 삭제 → 세션 `queued` → 미배정 신호(§7.4). 메시지는 세션 큐에 그대로 있다 |
| pod 살아 있음, 매핑 없음 | 워커가 heartbeat 갱신 시 `pod_id = $me` 재확인 | reconciler가 강제 해제한 것이므로 워커는 즉시 `draining` |
| 같은 세션에 pod 두 개 | 발생 불가 | `sessions_pod_uniq` + `WHERE pod_id IS NULL` 조건이 원자적으로 차단 |
| 턴 도중 pod 소실 | heartbeat 소실 | 마지막 체크포인트(§6.3.1) 지점에서 resume. 코드와 트랜스크립트가 같은 지점을 가리킨다. 처리 중이던 메시지는 세션 큐로 되돌아가 다음 워커가 이어 읽는다 |
| pod 크래시 직전 메시지가 갇힘 | 발생 불가 | 메시지가 세션 큐에만 있으므로 구독자 없는 큐에 갇힐 수 없다. v0.1에서는 `queue:pod:{죽은 pod}`에 남아 N6를 깼다(§7.4) |
| 클레임 실패 메시지 유실 | 발생 불가 | 워커는 세션 ID 신호만 집으므로 메시지를 들고 있다가 버릴 일이 없다(§6.2) |
| stale 답변이 다음 질문에 적용 | 발생 불가 | 답변 키에 `request_id`가 들어가고 워커가 자기 것만 소비한다(§6.4) |

상태 관리의 정확성은 "세션 획득이 원자적인가"에 달려 있고, 이를 DB 유니크 제약으로 보장하므로 나머지 어긋남은 최종 일관성으로 다뤄도 안전하다.

---

## 8. 모노레포 구성

다음 트리는 **목표 레이아웃**이다. 현재 존재하는 것은 `packages/*` 다섯 개, M0 compose와 `ci.yml` 등이며 `apps/*`, Dockerfile, `infra/kind`, `infra/k8s`, `images.yml`, E2E는 후속 구현 대상이다. 아래 Dockerfile 위치도 목표이며 현 compose의 root placeholder 경로는 이미지 구현 티켓에서 함께 수정한다.

Bun workspaces 기반 단일 저장소. API·워커·reconciler가 같은 타입과 DB 클라이언트를 공유하므로 모노레포가 맞다.

```
claude-session-platform/
├── package.json                 # workspaces: ["apps/*", "packages/*"]
├── bun.lock
├── tsconfig.base.json
├── biome.json
├── apps/
│   ├── api/                     # 컨트롤 플레인 HTTP 서버
│   │   ├── src/
│   │   │   ├── server.ts        # Hono 엔트리
│   │   │   ├── routes/sessions.ts
│   │   │   ├── routes/events.ts # SSE
│   │   │   ├── routes/answers.ts
│   │   │   └── keys.ts          # API 키 발급·대조 (§12.5)
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── worker/                  # 세션 워커 사이드카
│   │   ├── src/
│   │   │   ├── main.ts          # phase 상태 기계 (§7.8)
│   │   │   ├── claim.ts         # 세션 획득
│   │   │   ├── turn.ts          # Agent SDK query 루프
│   │   │   ├── permissions.ts   # canUseTool ↔ answer 큐
│   │   │   ├── persist.ts       # Immutable checkpoint publication
│   │   │   ├── heartbeat.ts
│   │   │   └── drain.ts         # Shared cleanup with reason-specific policy
│   │   ├── claude/
│   │   │   ├── settings.json    # permission·env 기본값
│   │   │   └── CLAUDE.md.template
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── reconciler/              # CronJob. 고아 매핑 정리 (§7.4)
│   │   ├── src/main.ts
│   │   └── package.json         # api 이미지 재사용, Dockerfile 없음
│   └── local-scaler/            # 로컬 전용 KEDA 대체 (§10)
│       └── src/main.ts
├── packages/
│   ├── contracts/               # API 스키마(zod), 이벤트 타입, 상태 enum — 유일한 공유 언어
│   │   └── src/{session,event,answer}.ts
│   ├── db/                      # drizzle 스키마, 마이그레이션, 쿼리 함수(claim, release, transition)
│   │   ├── src/schema.ts
│   │   ├── src/queries.ts
│   │   └── migrations/
│   ├── queue/                   # Postgres backend + interface; Redis placeholder
│   │   └── src/{index,redis,postgres}.ts
│   ├── storage/                 # S3 JSONL 업로드·복원, git clone/push
│   └── observability/           # 구조화 로거, 메트릭, 트레이싱 export (§11.2)
├── infra/
│   ├── k8s/
│   │   ├── base/                # api Deployment+HPA, worker ScaledJob, reconciler CronJob, NetworkPolicy
│   │   └── overlays/{local,staging,prod}/
│   ├── docker-compose.yml       # §10
│   └── kind/                    # kind 클러스터 설정 + KEDA 설치 스크립트
├── docs/
│   └── DESIGN.md                # 이 문서
└── .github/workflows/
    ├── ci.yml                   # bun run check, e2e
    └── images.yml               # apps/*/Dockerfile 빌드·푸시
```

### 8.1 의존 방향

```
apps/api ──────┐
apps/worker ───┼──▶ packages/{contracts, db, queue, storage, observability}
apps/reconciler┘
```

- `packages/contracts`가 계약의 유일한 출처. API 응답, SSE 이벤트, 큐 메시지 페이로드가 전부 여기 zod 스키마로 정의되고 API와 워커가 같은 타입으로 파싱한다
- `apps/*`는 서로 import하지 않는다. 공유가 필요하면 `packages/`로 내린다
- `packages/queue`는 인터페이스(`enqueue`, `consume`, `publish`, `subscribe`, `lease`)만 노출하고 Redis·Postgres 구현을 뒤에 둔다. §3.2의 "PoC는 Postgres 단독" 결정이 이 경계 덕에 앱 코드 변경 없이 가능하다. **pod별 큐를 만드는 API는 노출하지 않는다** — §7.1의 결함이 코드 수준에서 재발할 수 없게 하는 것이 이 경계의 역할이다

### 8.2 빌드·배포

- 루트 `bun install` 한 번으로 전체 워크스페이스 설치
- 이미지는 `apps/api`, `apps/worker`, `apps/local-scaler` 세 개. reconciler는 api 이미지에 포함시켜 `CMD`만 바꿔 실행한다
- local-scaler만 이미지를 따로 두는 이유: 워커 컨테이너를 띄우려면 docker CLI가 필요한데, 이를 api 이미지에 넣으면 외부에 노출되는 API 서버가 docker 소켓을 다룰 수단을 갖게 된다(§9.2). 로컬 전용 컴포넌트의 편의를 위해 운영 이미지의 권한 표면을 넓히지 않는다
- 각 이미지는 lockfile에서 해당 app의 runtime closure만 포함하고 불필요한 workspace package와 실행 파일을 복사하지 않는다
- e2e는 `infra/docker-compose.yml`을 띄우고 `packages/contracts`의 스키마로 응답을 검증


---

## 9. Dockerfile

### 9.1 워커

94S-91이 승인한 base image와 lockfile을 사용한다. 설치된 SDK package에서 bundled Claude Code executable의 **실제 절대 경로와 version**을 process-level로 확인하고, worker가 그 경로를 명시적으로 사용한다. SDK package version, bundled executable version, image digest를 함께 기록한다. `curl .../install.sh`처럼 build 때 latest를 받는 경로와 PATH에서 우연히 발견한 host CLI는 금지한다.

image test는 non-root 사용자로 신규 세션과 manifest 기반 재개 smoke를 모두 실행한다. reviewed project settings와 session별 임시 config만 접근할 수 있어야 하며 host 설정은 image에 복사하지 않는다. worker app의 production dependency closure와 실제 작업에 필요한 개발 도구만 포함한다.

runtime/provider 설정은 서버가 허용한 profile ID로 선택한다. 사용자가 임의 endpoint·env·model을 그대로 주입할 수 없으며 credential 값은 manifest·로그에 넣지 않는다.

| 설정 | 목표 계약 |
|---|---|
| `SDK_MODE=fake\|real` | fake는 앱 adapter 대역, real은 실제 SDK process. API key 유무로 전환하지 않음 |
| `ANTHROPIC_BASE_URL` | direct Anthropic 또는 승인된 LiteLLM Anthropic Messages frontend의 base URL |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | 각각 Bearer / x-api-key. gateway가 요구한 하나를 profile에서 선택 |
| model mapping | primary·보조·subagent가 요청하는 모델 alias를 gateway allowlist와 일치시킴 |
| `DATABASE_URL`, S3·git 설정, `POD_ID` | 기존 인프라 계약을 재사용하며 SDK subprocess에는 필요한 값만 전달 |
| timeout | `IDLE_TIMEOUT_SEC=1800`, `QUESTION_TIMEOUT_SEC=1800`를 기본 후보로 실측 |

TypeScript SDK의 `options.env`는 상속 환경을 대체하므로 필요한 `PATH`와 세션별 `HOME`을 포함한 최소 allowlist를 명시한다. `...process.env`를 그대로 복사하지 않는다. beta 기능 일괄 비활성화는 기본값이 아니며 gateway 호환 실패 시 기능 손실까지 gate에서 판단한다. 이 설정 표는 목표 계약이고 현재 `.env.example`의 `FAKE_SDK` 등 placeholder가 runtime에서 동작한다는 뜻이 아니다. 94S-18·94S-52에서 `SDK_MODE`로 실제 구현과 예시를 함께 정리한다.

LiteLLM은 선택 provider 경로이며 M0 필수 서비스에 추가하지 않는다. 94S-91에서 SDK/CLI·LiteLLM 버전을 함께 고정하고 `/v1/messages` streaming, tool payload, version/beta headers, cache metadata, 모델 alias, error·timeout·취소 전달을 local fake upstream으로 확인한다. non-Claude 모델 라우팅은 본 프로젝트의 지원 범위가 아니다.

근거(2026-09-15): [LiteLLM SDK 연결 예제](https://docs.litellm.ai/docs/tutorials/claude_agent_sdk), [SDK gateway 환경과 인증](https://code.claude.com/docs/en/llm-gateway-connect#agent-sdk), [gateway 프로토콜](https://code.claude.com/docs/en/llm-gateway-protocol), [Anthropic 지원 경계](https://code.claude.com/docs/en/llm-gateway).

### 9.2 API 서버

API app의 production dependency closure만 포함한다. Agent SDK, Claude Code executable, worker 전용 도구를 설치하거나 복사하지 않는다. API HPA는 CPU 또는 SSE 연결 수 기준이다.

### 9.3 reconciler

별도 이미지를 만들지 않는다. API image에 API server와 reconciler 두 entrypoint 및 공통 production dependency closure를 포함하되 Agent SDK와 bundled executable은 포함하지 않는다. reconciler CronJob은 reconciler entrypoint를 선택하며 HTTP server를 기동하지 않는다. 따라서 전체 이미지는 worker, API/reconciler, local-scaler 세 개다.

### 9.4 local-scaler (로컬 전용)

KEDA 대역이라 워커 컨테이너를 직접 띄우고, 그래서 docker CLI와 compose 플러그인이 필요하다. 둘 다 정적 바이너리라
공식 CLI 이미지에서 복사해 넣는다. 쿠버네티스에는 배포하지 않는다 — 거기서는 KEDA가 이 일을 한다(§7.2).

모든 image는 build 뒤 SBOM 또는 동등한 dependency inventory로 app별 closure를 확인한다. `SDK_MODE`는 `fake|real`만 사용한다. actual SDK + local Messages API 검증은 `real` 모드에 local endpoint와 test credential을 주입한다. API key를 추가하는 것만으로 fake가 real로 전환되지 않으며, 운영 manifest는 `SDK_MODE=real`을 명시한다.

---

## 10. 로컬 개발 환경

목표: 쿠버네티스 없이 동일한 메시지 흐름과 pod 생명주기를 재현한다. 워커 "pod"는 docker compose의 컨테이너 하나로 대응하고, KEDA 대신 간단한 스케일러 스크립트가 `docker compose run`으로 워커를 띄운다.

### 10.0 외부 계정 없이 도는가 (94S-52)

**클론한 사람이 AWS 계정도, 쿠버네티스 클러스터도, LLM API 키도 없이 전체 흐름을 돌려볼 수 있어야 한다.** 없으면 "일단 키부터 받아오라"가 첫 장벽이 되고, 기여자와 신규 합류자가 거기서 멈춘다.

| 운영 의존 | 로컬 대체 | 계정 필요? |
|-----------|-----------|-----------|
| S3, Secrets Manager | LocalStack (94S-14) | 아니오 |
| RDS | Postgres 컨테이너 | 아니오 |
| GitHub | gitea 컨테이너 | 아니오 |
| ECR | 로컬 빌드, `kind load` | 아니오 |
| EKS | kind (94S-37) | 아니오 |
| KEDA ScaledJob | local-scaler(compose) / 실제 KEDA(kind) | 아니오 |
| **Anthropic API** | fake adapter + 실제 SDK/Claude Code가 향하는 local fake Messages API (94S-18, 94S-91) | 아니오 |
| 알림 채널 | 로컬 관측 스택의 수신함 (94S-41) | 아니오 |

계정 없는 기본 검증도 두 층이다. 빠르고 결정적인 E2E는 SDK adapter fake가 미리 정한 응답을 재생한다. 별도 contract suite는 고정된 **실제 Agent SDK와 bundled Claude Code process**를 실행하되 local fake Messages API로 향하게 해 init, native event projection, permission/`AskUserQuestion`, 병렬 요청, interrupt/drain, resume을 검증한다. 두 번째 층은 실제 SDK 경로지만 실제 Anthropic 모델 호출은 아니다.

선택 LiteLLM profile에는 **실제 proxy HTTP process + local fake upstream** transport suite를 추가한다. proxy가 실제 실행됐는지 PID/version과 요청 trace로 확인하고, SDK의 direct local endpoint suite와 별도 결과로 기록한다. 94S-91에서 계약을 정하고 94S-18·94S-32에서 반복 검증한다.

paid Claude model smoke는 별도 승인·비용·secret이 필요한 검증이며 G2 기본 CI 조건이 아니다. adapter fake 성공을 SDK 호환성 증거로, local Messages suite 성공을 실제 모델 품질·운영 인증 증거로 표현하지 않는다.

### 10.1 현재 M0 compose와 향후 앱 구성

실행 정본은 [`infra/docker-compose.yml`](../infra/docker-compose.yml)이다. 저장소 루트에 compose 파일이 없으므로 모든 명령에 `-f infra/docker-compose.yml`을 붙인다.

| 구성 | 현재 상태 |
|---|---|
| Postgres 16·LocalStack 3·Gitea 1.22 | M0 의존 서비스와 healthcheck 구현 |
| `migrate` | DB healthy 후 실제 migration runner를 실행하는 one-shot 서비스 |
| `api`, `scaler`의 `apps` profile | 아직 없는 Dockerfile을 가리키는 placeholder. 현재 활성화하지 않음 |
| `worker` profile | 아직 없는 워커 image placeholder. 현재 실행하지 않음 |

Redis는 필요하지 않다. 기본 compose 기동은 의존 서비스 외에 one-shot migration도 포함하므로, 서비스 셋만 필요하면 이름을 명시한다. 현재 실행 가능한 설치·검증 명령과 포트·skip 조건은 [README](../README.md)를 따른다. 사용자 `.env`와 데이터 volume을 자동 덮어쓰거나 삭제하지 않는다.

향후 local-scaler는 KEDA와 같은 count 함수를 5초마다 조회하고 컨테이너를 생성한다. 실제 명령은 `docker compose -f infra/docker-compose.yml run ... worker` 형태로 구현하며 이름/POD_ID·정리 정책은 94S-25에서 검증한다. 컨테이너 종료와 제거는 다르므로 `--rm` 또는 명시적 cleanup을 사용한다.

### 10.2 전체 앱 실행 목표 — 아직 미구현

94S-36에서 `./scripts/dev up`이 의존 서비스 → migration → API/scaler → 샘플 git repo 순서로 기동하게 만든다. 현재 `scripts/dev`, HTTP API와 `/ui`는 없다. 아래는 구현 후 확인할 절차이며 현재 동작하는 quickstart가 아니다.

1. 기존 `.env`를 보존하고 `.env.example`의 실제 구현된 `SDK_MODE=fake` 기본값을 확인한다.
2. `./scripts/dev up` 후 API readiness와 `http://localhost:3000/ui`를 확인한다.
3. HTTP API로 세션 생성 → SSE 구독 → 질문 응답 → 후속 메시지를 순서대로 실행한다.
4. `IDLE_TIMEOUT_SEC=60`으로 워커 종료와 다음 메시지에 따른 새 워커·동일 세션 resume을 확인한다.
5. 별도 real SDK contract suite와 선택 LiteLLM transport suite를 실행한다. fake 성공을 두 suite의 증거로 대체하지 않는다.

### 10.3 어디서 무엇을 확인하는가

아래는 후속 구현의 검증 계획이며 M0에서 전체 실행했다는 기록이 아니다. 검증 환경은 세 단계다. **배포 전에 로컬에서 확인할 수 있는 것은 전부 로컬에서 확인한다.** 실클러스터에서만 볼 수 있는 것을 최소로 밀어내는 것이 이 표의 목적이다.

| 단계 | 환경 | 여기서 확인하는 것 |
|------|------|-------------------|
| 1 | docker compose | 메시지 라우팅, 매핑 획득, 이벤트 스트림, SSE 재접속, resume 왕복, 유휴 회수, heartbeat 소실 복구(`docker kill`), 질문·답변 왕복, 순서 보장, 클레임 경쟁, 헬스·레디니스 응답, 레이트 리밋·백프레셔, 비용 상한, 마이그레이션 적용과 롤백, 구조화 로그·메트릭 출력, 테넌트별 자격증명 분리 |
| 2 | kind + KEDA | ScaledJob이 실제로 Job을 만드는가, HPA 동작, NetworkPolicy가 egress를 막는가, gVisor 런타임 클래스가 무시되지 않는가, 매니페스트·overlay가 적용되는가, node drain 시 SIGTERM 경로, 마이그레이션 Job, 시크릿 주입 |
| 3 | 스테이징(EKS) | 실제 스팟 선점과 2분 알림 처리, 노드 이미지 pull 시간, 실부하에서의 스케일 동작, 알림 파이프라인 |

compose 구성은 §10.1, kind 구성은 `infra/kind/`에 둔다. kind에서는 워커 이미지를 `kind load docker-image`로 올리고, Postgres·스토리지·git remote는 compose 그대로 두고 `host.docker.internal`로 접근한다.

**두 단계 모두 명령 하나로 뜨게 구현한다**(94S-36, 현재 스크립트 없음). 클러스터 계정 없이 쿠버네티스 경로를 그대로 밟아볼 수 있어야 2단계가 실제로 쓰인다.

```bash
./scripts/dev up          # 1단계: compose
./scripts/dev up --kind   # 2단계: kind + KEDA, 같은 매니페스트
```

### 10.4 로컬과 운영의 격차 (94S-14, 94S-37)

앞 표는 무엇을 어디서 확인하는지를 정하지만, **로컬이 운영과 같다는 뜻은 아니다.** 남는 격차를 적어둔다. 적어두지 않으면 "로컬에서 됐으니 괜찮다"가 근거로 쓰인다.

| 격차 | 로컬 | 운영(EKS) | 좁히는 방법 |
|------|------|-----------|-------------|
| **워커 기동 주체** | local-scaler가 `docker compose run` | KEDA ScaledJob | 좁힐 수 없다. compose 경로에는 매니페스트가 등장하지 않으므로, kind 검증(94S-37)을 머지 전 게이트로 둔다 |
| **종료 의미** | 컨테이너 종료 | Job 완료·실패, `backoffLimit: 0`, eviction | kind에서 확인 |
| **AWS API** | LocalStack | S3, Secrets Manager | LocalStack이 같은 API를 제공하므로 SDK 경로는 같다. IAM 역할 위임(IRSA)은 다르다 |
| **git remote** | gitea | GitHub | 프로토콜이 같아 clone·push 경로는 같다. 권한 모델과 레이트 리밋은 다르다 |
| **DB** | 컨테이너 Postgres | RDS | 스키마·쿼리는 같다. 페일오버·백업·커넥션 상한은 다르다 |
| **격리** | 없음 | gVisor | kind에 gVisor가 없으면 런타임 클래스가 무시되는지 확인하고 기록한다(94S-37) |
| **중단** | `docker kill`, `docker stop` | 스팟 선점 2분 알림, node drain | 알림 있는 종료는 kind `drain`으로, 알림 없는 소실은 kind 노드를 죽여서 재현한다. 실제 선점만 스테이징(94S-47) |
| **네트워크** | compose 네트워크 | NetworkPolicy, VPC | kind에서 정책 적용 여부만 확인 |
| **이미지 pull 지연** | 없음 — kind는 `kind load`로 로컬 이미지를 주입하므로 레지스트리 pull을 겪지 않는다 | 스팟 노드가 뜰 때마다 ECR에서 pull | **좁힐 수 없다.** kind 검증을 통과해도 콜드스타트(§11.6)는 스테이징에서야 처음 드러난다. 94S-47이 실측해 §11.6에 기록한다 |
| **리소스 제한** | compose에 메모리 제한을 명시해야 OOM을 재현할 수 있다(§10.1) | `limits: memory` 초과 시 OOMKill | compose의 워커 서비스에 `mem_limit`을 두면 §10.6의 OOM 레시피가 성립한다 |

**가장 큰 격차는 첫 줄이다.** compose는 메시지 흐름과 세션 생명주기를 재현하지만 쿠버네티스를 재현하지 않는다. 그래서 compose는 빠른 반복용이고, kind 검증이 통과하지 않은 변경은 클러스터로 가지 않는다.

### 10.5 세션 인스펙터 (94S-50)

`docker ps`와 `curl -N`으로는 지금 무슨 일이 일어나는지 보기 어렵다. 세션이 몇 개 돌고, 워커가 몇 개 떠 있고, 어떤 세션이 무슨 툴 앞에서 멈춰 답을 기다리는지가 한 화면에 있어야 한다.

API 서버가 `/ui`에 단일 페이지를 서빙한다. 별도 앱도 이미지도 두지 않는다.

| 영역 | 내용 | 출처 |
|------|------|------|
| 세션 목록 | id, `status`, `pod_id`, 마지막 턴 시각, 누적 토큰 | `GET /v1/sessions` |
| 이벤트 타임라인 | 선택한 세션의 이벤트를 실시간으로. 상태 전이(§7.5)를 함께 표시 | `GET /v1/sessions/{id}/events` |
| 대기 중 질문 | `needs_input` 세션과 그 `request_id`, 여기서 바로 답변 | `POST /v1/sessions/{id}/answers` |
| 워커 현황 | 살아 있는 pod와 각자 맡은 세션 | heartbeat 리스 |
| 큐 현황 | 미배정 세션 수, 세션별 대기 메시지 수 | 스케일 지표와 같은 값 |

**`AUTH_MODE=none`일 때만 서빙한다.** 즉 로컬 전용이다. 운영에 브라우저 화면을 노출하면 인증 표면이 늘어나는데, 운영 쪽 가시성은 이미 메트릭·트레이싱(§11.2)이 담당한다. 운영에서도 이 화면이 필요해지면 그때 인증을 붙여 여는 것을 별도로 판단한다.

### 10.6 운영 상황을 로컬에서 일으키기 (94S-53)

설계가 견디겠다고 주장하는 상황들(§7.9)을 **손으로 일으켜 볼 수 있어야 한다.** 자동화된 회귀 테스트(94S-33)는 통과 여부만 알려주고, 무슨 일이 일어나는지는 보여주지 않는다. 눈으로 보는 경로가 따로 필요하다.

각 항목은 명령 한 줄이고, 결과는 `/ui`의 타임라인에서 관찰한다.

| 운영에서 | 로컬에서 일으키는 법 | 기대 결과 |
|----------|---------------------|-----------|
| 스팟 선점(2분 알림) | `docker stop <worker>` — SIGTERM + grace period | drain 경로로 저장 후 종료, 세션이 새 워커에서 이어짐 |
| 알림 없는 노드 소실 | `docker kill <worker>` | heartbeat 만료 → reconciler가 1분 내 재큐잉 |
| OOM | `WORKER_MEM_LIMIT=256m`으로 워커 기동(§10.1) | 위와 같은 사고 종료 경로 |
| node drain·롤링 업데이트 | kind에서 `kubectl drain` | SIGTERM 경로 |
| split-brain | `docker pause <worker>` 후 reconciler가 해제하게 두고 `unpause` | 구 워커의 쓰기가 거부됨(94S-44) |
| 메시지 순서 역전 시도 | 워커를 죽인 직후 메시지 두 개를 연속 전송 | 적재 순서대로 처리 |
| 클레임 경쟁 | 워커를 여러 개 동시 기동 | 정확히 하나만 클레임, 나머지는 스스로 종료 |
| 권한 대기와 타임아웃 | fake adapter가 병렬 permission/question을 내도록 설정, `QUESTION_TIMEOUT_SEC`를 짧게 | pending별 종결, 다른 요청 유지, permission timeout은 deny |
| 예산 초과 | fake SDK의 `usage`를 크게 | 턴 중단, `failed` 전이(94S-43) |
| 큐 적체 | 스케일러를 멈추고 세션을 여러 개 생성 | 미배정 세션 수가 쌓이고, 스케일러 재개 시 해소 |
| DB 순단 | `docker stop postgres` 후 재기동 | `readyz` 실패 → 복구 후 정상화 |

이 표는 런북(94S-49)의 로컬 리허설 대상과 같은 목록이다. 운영에서 대응할 상황을 로컬에서 먼저 겪어보는 것이 목적이다.

### 10.7 단일 머신 CLI wrapper 대안 — 미채택

CLI 명령이나 PTY를 감싸는 HTTP wrapper는 이번 경로에 채택하지 않는다. 공식 Agent SDK를 직접 사용하므로 raw CLI wrapper를 선행해도 native event, typed callback, checkpoint와 resume 계약을 검증하지 못하고 폐기될 구현이 된다. CLI 전용 감독자·백그라운드 명령의 존재나 daemon 동작도 공식 process 검증 없이 설계 전제로 두지 않는다. SDK로 제공되지 않는 CLI 전용 기능이 제품 요구가 될 때 별도 spike로 비교한다.

---

## 11. 운영

대상 환경은 AWS EKS다. 각 항목에 **로컬 확인 방법**을 함께 적는다 — 배포해봐야 아는 것을 최소로 남기기 위해서다(§10.3).

### 11.1 배포 (94S-46, 94S-39)

- **이미지**: ECR. Claude Code CLI 버전은 워커 이미지 태그로 고정한다. `latest` 설치는 재현 불가능한 워커를 만든다
- **승격**: 같은 다이제스트를 staging → prod로 올린다. 환경마다 다시 빌드하지 않는다
- **복구**: 롤링 업데이트 시 워커는 SIGTERM 경로(§6.6)로 안전한 마지막 checkpoint와 replay 정책을 보존한다. 저장되지 않은 진행분과 외부 부작용은 무손실을 보장하지 않으며 실제 drain/restore로 검증한다. API는 `readyz`(§5)로 교체 중 트래픽을 받지 않는다
- *로컬 확인*: kind에 overlay를 적용해 롤링 업데이트를 실행하고, 진행 중 세션이 새 pod에서 이어지는지 본다

### 11.2 관측 (94S-35, 94S-41, 94S-48)

- **로그**: 구조화 JSON. 모든 레코드에 `session_id`·`turn_id`·`pod_id`를 넣어 한 세션의 흐름을 API·워커·reconciler에 걸쳐 이어 붙일 수 있게 한다
- **메트릭**: 미배정 세션 수, 워커 수, 턴 지연, 클레임 실패율, 답변 대기 시간, SSE 연결 수. 앞의 둘은 스케일 지표(§7.2)와 같은 값이어야 한다
- **트레이싱·비용**: 이벤트 스트림을 Langfuse 등으로 보내면 세션 단위 토큰·비용 집계가 된다. `result` 메시지의 `usage`를 `turns.result_json`에 저장한다
- *로컬 확인*: compose에 수집기를 띄우고 세션 하나를 돌려 로그·메트릭·트레이스가 전부 나오는지 본다

### 11.3 한도와 비용 (94S-42, 94S-43)

- **세션 상주 비용**: 유휴 타이머와 `pinned` 세션 수가 결정한다. 기본값은 실사용 패턴을 보고 조정
- **세션당 상한**: 누적 토큰·비용이 상한을 넘으면 턴을 중단하고 `failed`로 닫는다. `/stop` 수동 호출만으로는 폭주를 막지 못한다
- **테넌트 한도**: `owner_id`별 동시 세션 수와 요청 레이트
- **백프레셔**: `maxReplicaCount` 도달 시 신규 세션 생성에 429를 반환할지, 202로 큐에 두고 기다리게 할지를 정한다
- *로컬 확인*: fake SDK의 `usage`를 조작해 상한을 넘기고, compose에 부하를 넣어 레이트 리밋과 백프레셔 응답을 본다

### 11.4 보안 (94S-40, 94S-45)

- **격리**: 세션당 pod + gVisor + NetworkPolicy(§6.7). 워커는 임의 코드를 실행하므로 이 셋이 다 필요하다
- **시크릿**: EKS에서는 IRSA로 AWS 리소스 접근을, Secrets Manager 또는 External Secrets로 LLM·git 자격증명을 주입한다. 매니페스트에 평문을 넣지 않는다
- **테넌트 분리**: 인증된 owner에 결합된 immutable config profile/version으로 LLM·git·storage 자격증명과 허용 repo, model, tool, setting source를 고른다. 클라이언트의 `repo_url`·`permission_mode`가 server policy를 상향하지 못한다. secret은 claim 뒤 request별로 resolve하고 DB·event·manifest·로그에 넣지 않는다
- **runtime config 격리**: SDK config/home, 선택된 transcript backend, plugin·MCP cache와 object prefix는 owner/session으로 namespace한다. worker process 또는 임시 디렉터리를 tenant 간 공유하지 않고 종료 시 해당 session 범위만 정리한다. 동일 repo 이름·session ID·object key를 이용한 교차 tenant 테스트를 둔다
- *로컬 확인*: kind에서 NetworkPolicy가 허용 목록 밖 호스트를 실제로 막는지, gVisor 런타임 클래스가 조용히 무시되지 않는지 확인한다

### 11.5 데이터 (94S-39, 94S-49)

- **마이그레이션**: 배포 전 Job으로 적용한다. 앱 pod의 initContainer에서 돌리면 replica 수만큼 동시 실행된다. 롤백 가능한 변경만 배포하고, 파괴적 변경은 두 단계로 나눈다
- **백업**: Postgres는 자동 스냅샷과 PITR, S3는 버저닝. 세션의 실체는 manifest가 묶은 transcript/SessionStore revision과 exact git SHA(§1.1)이므로 object generation, pointer, git remote가 함께 복구 대상이다
- **복구 목표**: RPO·RTO를 정하고 복구 리허설을 한 번 한다
- *로컬 확인*: compose에서 마이그레이션 적용과 롤백을 리허설하고, 스냅샷에서 복원해 세션이 재개되는지 본다

### 11.6 콜드스타트 (94S-47)

워커 이미지가 크면(개발 도구 포함) 스팟 노드에서 매번 pull이 느리다. 노드 이미지 캐시, 슬림 베이스, 프로젝트별 레이어 분리로 대응한다. 프리웜은 현 구조로 동작하지 않는다(§12.3).

---

## 12. 결정 사항

구현하며 내린 결정이다. 각 항목은 되돌릴 수 있고, 바꾸려면 여기부터 고친다.

### 12.1 워크스페이스 영속화 — git 브랜치만

빌드 캐시는 스냅샷하지 않는다. `node_modules`는 lock 파일에서 재생성되므로 스토리지에 둘 이유가 약하고, 캐시를 스냅샷하면 "세션의 실체는 트랜스크립트와 코드뿐"(§1.1)이라는 전제가 깨진다. 재수화 비용이 실제로 문제가 되면 노드 레벨 캐시(§11 콜드스타트)로 먼저 대응한다.

### 12.2 질문 대기 타임아웃 — 기본 30분, PoC의 대기 중 pod는 유지

`QUESTION_TIMEOUT_SEC=1800`. 94S-8 실측에서 `canUseTool` 대기 중 프로세스를 종료하면 resume이 원 콜백을 재호출하지 않는다는 것을 확인했다. 따라서 현재 PoC 경로는 pod를 유지하며, 30분은 사람이 답할 시간과 잊힌 세션의 pod 점유를 함께 제한하는 제품 정책이다. timeout은 abort가 아니라 해당 pending request만 typed deny/timeout으로 종결한다. 다른 pending 요청이 없고 SDK turn이 끝났을 때만 세션이 idle로 들어간다. 이 동작과 durable defer 경로는 94S-91에서 고정 후보로 다시 검증한다.

### 12.3 ScaledJob 채택

`pod-deletion-cost`는 스케일 인 대상을 *덜 나쁘게* 고르는 장치일 뿐 "실행 중인 세션을 죽이지 않는다"를 보장하지 못한다. §7.6의 원칙을 지키려면 애초에 쿠버네티스가 pod를 고르지 않아야 하므로 ScaledJob으로 확정한다.

**개정(v0.2):** 콜드스타트를 프리웜으로 줄인다는 부분은 철회한다. 고정 크기 Deployment의 프리웜 pod가 세션을 클레임해도 Deployment는 그것을 살아 있는 replica로 세므로 대기 pod가 0이 되고, 프리웜이 프리웜 역할을 하지 못한다. PoC 범위 밖으로 두고 콜드스타트는 §11의 노드 이미지 캐시와 이미지 슬림화로 먼저 대응한다.

### 12.4 큐 백엔드 — Postgres 기본, Redis 선택

기본은 Postgres: 저장소가 하나면 운영이 단순하고, PoC 규모에서 `SKIP LOCKED` 큐와 `LISTEN/NOTIFY` 깨우기로 충분하다. 이벤트 팬아웃이 병목이 되면 Redis backend 구현과 데이터/커서 전환 검증 후 `QUEUE_BACKEND`로 선택할 수 있게 확장한다. 현재 설정 변경만으로 전환할 수는 없다. 어느 쪽이든 세션 정본은 Postgres에 남는다(§7.7).

**개정(v0.2):** v0.1은 "둘 다 구현한다"고 썼는데 §14.1은 "Redis 구현은 인터페이스만 두고 스텁"으로 정해 서로 어긋났다. §14.1로 통일한다 — PoC에서 Redis 구현 본체는 쓰지 않는다.

`LISTEN/NOTIFY`는 이벤트의 저장소가 아니라 깨우기 수단이다. SSE 재개는 `events` 테이블(§4.1)에서 오고, NOTIFY 페이로드에 본문을 싣지 않는다(§5.1).

KEDA 트리거는 **KEDA 2.20.x `postgresql` scaler**로 확정한다(94S-10). Redis 구현을 완성하지 않아도 Postgres 단독 PoC를 kind에 올릴 수 있다. KEDA와 local-scaler의 지표 SQL은 마이그레이션의 `queue_unassigned_session_count()`로 고정한다. 5초 poll의 실제 connection 수·query plan/지연, Pending Job 중복 억제, claim·재큐잉 신호 정합성은 M5의 kind 검증(94S-34, 94S-37)에서 확인한다. Redis 전환은 Postgres 큐가 병목이라는 실측 근거가 생길 때만 검토한다.

### 12.5 인증 — API 키, owner는 키 단위

OIDC가 아니라 API 키다. 이 API의 클라이언트는 사람이 아니라 서비스(웹 UI 백엔드, Slack, CI)이고 어차피 장기 자격증명을 들고 있으며, 키는 IdP 없이도 세울 수 있다. OIDC가 필요해지면 인증은 미들웨어 한 곳이므로 그 자리를 바꾸면 된다.

- `Authorization: Bearer <key>`. 키는 `api_keys`에 SHA-256 해시로만 저장하고 발급 시 한 번만 보여준다
- owner 모델은 키 하나당 `owner_id` 하나. 세션은 소유자에게만 보이고, 남의 세션은 403이 아니라 **404**로 답한다 — 볼 수 없는 사람에게 id의 존재를 확인해주지 않기 위해서다
- `AUTH_MODE=none`은 로컬 개발용이며, 이때만 `X-Owner-Id` 헤더를 믿는다
- 키 관리는 API 이미지의 `keys.ts`로 한다(§9.3과 같은 방식)

### 12.6 트랜스크립트 저장소 — 오브젝트 스토리지(S3)

블록 스토리지(EBS)를 쓰지 않는다. 근거는 §1.1의 "세션은 pod에 묶이지 않는다"이며, EBS는 그 전제와 구조적으로 충돌한다.

| 항목 | EBS | S3 |
|------|-----|-----|
| AZ | 단일 AZ에 고정. 스팟 워커의 스케줄 가능 AZ가 제한되어 가용성이 떨어진다 | 무관 |
| 동시 접근 | 한 번에 인스턴스 하나. API 서버가 같은 데이터를 읽을 수 없다 | 여럿이 동시에 읽는다 |
| 단위 비용 | 볼륨 최소 크기만큼 과금. 세션당 볼륨이면 수 MB짜리에 GiB를 낸다 | 객체 크기만큼 |
| 부착 지연 | attach/detach가 콜드스타트에 더해진다 | 없음 |
| 백업 | 스냅샷을 따로 운영 | 버저닝이 그대로 백업(§11.5) |

EFS도 후보였으나 git 작업처럼 작은 파일이 많은 워크로드에서 느리고, 워크스페이스는 어차피 git remote가 정본이라 공유 파일시스템이 필요 없다.

대가는 append 불가다. §4.3에 적은 대로 파일이 커지면 청크 분할로 바꾼다.

---

## 13. PoC 범위

1. Postgres 단독(Redis 없음), docker compose
2. API: `POST /sessions`, `POST /messages`, `GET /events`, `POST /answers`
3. 워커: 매핑 획득 → resume → 이벤트 발행 → 턴 종료 → 유휴 회수 → 재개 왕복
4. 스팟 선점 시뮬레이션: `docker kill` 후 reconciler가 매핑을 정리하고 재큐잉하는지
5. 동일 세션에 메시지 2개를 연달아 보내 직렬 처리되는지

`GET /sessions/{id}/transcript`는 범위 밖이다(§5). 위 다섯 시나리오의 자동화는 94S-32다.

위 다섯 시나리오에 더해 동시성 회귀 테스트를 둔다(94S-33). v0.1 검토에서 나온 결함이 전부 낮은 확률의 타이밍 문제였고, 그런 것은 수동 실행으로 잡히지 않는다.

- 크래시 직전 메시지가 크래시 직후 메시지보다 먼저 처리되는가(§7.4의 N6 반례)
- 워커 여럿이 한 세션에 동시에 달려들 때 정확히 하나만 클레임하는가
- burst 메시지가 클레임 경쟁 중에도 전부, 순서대로 처리되는가
- 이전 질문의 뒤늦은 답변이 다음 질문에 적용되지 않는가(§6.4)
- checkpoint publish의 각 단계에서 죽여 incomplete generation을 무시하고 exact git/session revision의 이전 안전 generation으로 복구하는가(§6.3.1)
- 병렬 permission/질문 답변이 out-of-order·duplicate·late 도착해도 서로 소비되지 않는가(§6.4)
- `/stop`은 현재 입력을 재큐잉하지 않고, SIGTERM drain은 turn attempt 정책에 따라 안전하게 재시도하는가(§6.6)

이 테스트들은 adapter fake E2E와 actual SDK + local fake Messages API contract suite로 나누어 CI에서 실행한다. 후자는 94S-91이 고정한 SDK/Claude Code version과 executable 경로를 로그에 남긴다. v0.1 §14.2는 e2e를 "스크립트 작성 완료, 실행은 사용자 로컬"로 뒀는데, 결함이 몰려 있던 영역이 정확히 그 미검증 구간이었다.

여기까지 되면 kind + KEDA로 옮겨 §7 매니페스트를 검증한다.

---

## 14. 구현 지침 (Claude Code용)

이 섹션은 구현 에이전트가 따를 지침이다. §1~§13과 충돌하면 §1~§13이 우선한다.

### 14.1 고정된 결정

| 항목 | 결정 |
|------|------|
| 런타임 | Bun workspaces 모노레포, 구조는 §8 |
| API | Hono, 스키마 검증은 zod (`packages/contracts`) |
| DB | Postgres 16 + drizzle-orm, 마이그레이션은 drizzle-kit |
| 큐/이벤트 | PoC는 `packages/queue`의 Postgres 구현만 작성(`SKIP LOCKED` 세션 큐, `events` 테이블 + `LISTEN/NOTIFY` 깨우기, `last_seen` heartbeat). Redis 구현은 인터페이스만 두고 스텁. pod별 큐를 만드는 API는 노출하지 않는다(§7.1) |
| 워커 | 고정된 `@anthropic-ai/claude-agent-sdk`와 bundled Claude Code executable. `claude_code` preset, reviewed setting sources, `permissionMode: default`. SDK 호출은 인터페이스로 감싸되 실제 SDK contract suite를 별도로 둔다 |
| 스토리지 | S3 immutable manifest/object + Postgres authoritative pointer. G2는 owner·현재 `pod_id`·previous revision CAS, 전체 write의 claim epoch fencing은 G4 94S-44. backend는 94S-92가 하나를 선택 |
| 로컬 가시화 | `AUTH_MODE=none`일 때 API 서버가 `/ui`에 단일 페이지 서빙. 빌드 스텝·프레임워크 없음(§10.5) |
| 린트/포맷 | biome |
| 언어 | 코드·코드 식별자·코드 주석은 영어. 티켓·PR 본문·프로젝트 문서는 한국어. 명령·로그·에러는 원문 유지 |

### 14.2 마일스톤

각 마일스톤은 계획 제시 → 승인 → 구현 → `bun run check`(typecheck + lint + unit test) 통과 → 커밋 → 검증/미검증 보고 순으로 진행한다.

| 단계 | 범위 | 티켓 | 완료 조건 |
|------|------|------|-----------|
| M0 | 모노레포 골격, `packages/{contracts,db,queue,storage,observability}`, `infra/docker-compose.yml` | 94S-9, 94S-11, 94S-12, 94S-15, 94S-16, 94S-13, 94S-35, 94S-14 | 쿼리 함수 유닛 테스트 통과 |
| M1 | API 서버: 인증, `/sessions`, `/messages`, `/events`(SSE 재개), `/answers`, `/stop`·`/pin`·`DELETE`, 프로브 | 94S-17, 94S-38, 94S-21, 94S-26, 94S-22, 94S-23, 94S-27 | 라우팅 분기 테스트 통과 |
| M2 | SDK 호환성·SessionStore gate, 워커 native event projection, typed pending requests, immutable checkpoint, interrupt/drain | 94S-91, 94S-92, 94S-18, 94S-93, 94S-19, 94S-24, 94S-28, 94S-29, 94S-30 | 고정 SDK process contract 통과, manifest failure injection과 §7.8 전이 대응 |
| M3 | reconciler(§7.4), local-scaler(§10), 계정 없는 기본 모드, 세션 인스펙터, 원커맨드 기동, 장애 재현 레시피 | 94S-20, 94S-25, 94S-52, 94S-50, 94S-36, 94S-53 | 고아 매핑 정리 테스트 통과. **외부 계정 하나 없이** 브라우저에서 세션 생명주기와 장애 복구를 관찰 가능 |
| M4 | compose E2E: adapter fake 회귀 + actual SDK/local fake Messages API contract | 94S-32, 94S-33 | **CI에서 두 층 모두 통과하고 실제 SDK/CLI version 로그 확인.** paid model 호출은 별도 미검증 항목 |
| M5 | 고정 runtime Dockerfile, `infra/k8s/base`와 overlays, kind/KEDA 검증. Agent Sandbox는 선택적 비교 | 94S-31, 94S-34, 94S-37, 94S-94 | 이미지 빌드·runtime version 검증, kind + KEDA에서 Job 생성. 94S-94는 94S-34의 blocker가 아님 |

M0~M5는 §15의 로컬 트랙이다. 배포 트랙(§16.2)은 이 마일스톤 밖이고, 각 티켓이 §10.3의 1~2단계에서 먼저 확인한 뒤 클러스터로 간다.

v0.5 추가 gate의 최소 의존관계는 다음과 같다. §16의 전체 지도와 Linear live relation은 이 계약에 맞춰 별도로 갱신한다.

- 94S-91: SDK/Claude Code version·bundled executable·preset·event·callback·abort/resume 호환성 gate
- 94S-92: SessionStore 채택 여부 gate. 94S-91에 blocked-by
- 94S-93: 선택된 store와 immutable manifest 구현. 94S-18, 94S-92, 기존 storage 기반 94S-13에 blocked-by
- 94S-94: Agent Sandbox 선택 비교. 94S-31·94S-33 이후 G3에서 수행하며 KEDA ScaledJob을 baseline으로 유지한다. 94S-34의 blocker가 아니다

### 14.3 제약

- 실행 환경에서 docker나 Postgres를 띄울 수 없으면 우회하지 말고 해당 검증을 "미검증"으로 명시하고 진행한다. 유닛 테스트는 pglite로 대체 가능
- 기본 CI는 실제 Anthropic API를 호출하지 않는다. adapter fake와 actual SDK + local fake Messages API를 서로 다른 검증으로 실행한다
- 회사 시스템명이나 내부 URL을 저장소에 넣지 않는다
- 새 의존성 추가 시 이유를 커밋 메시지 또는 PR 본문에 한 줄 남긴다
- 문서에서 벗어나는 결정이 필요하면 구현 전에 사용자에게 묻는다

### 14.4 시작 절차

1. 이 문서를 끝까지 읽는다
2. 문서 내 모순이나 구현 시 결정이 필요한 지점(§12 포함)을 목록으로 제시한다. 94S-8·94S-10은 당시 버전과 KEDA baseline을 확정한 완료 이력이다. 현재 SDK 호환성은 94S-91, SessionStore는 94S-92가 닫기 전까지 미검증이다
3. 작업 단위와 의존관계는 §16과 Linear의 live relation에 있다. M0 완료를 재개하지 않고, 현재 미완료 gate의 `blocked-by` 순서대로 진행한다

---

## 15. 완성 정의

작업을 **로컬 트랙**과 **배포 트랙**으로 나눈다. 나누는 기준은 컴포넌트가 아니라 "무엇을 증명하는가"다.

- 로컬 트랙: 시스템이 **설계대로 동작하는가**
- 배포 트랙: 시스템이 **운영을 견디는가**

두 트랙은 순차가 아니다. 배포 트랙의 항목도 대부분 로컬에서 먼저 확인하고(§10.3), 클러스터에는 이미 확인된 것을 올린다.

### 15.1 게이트

| 게이트 | 통과 조건 | 티켓 | 그 다음 |
|--------|-----------|------|---------|
| G1 — v0.4 설계 확정(완료 이력) | 당시 문서 모순 해소와 조사 종료 | 94S-7, 94S-8, 94S-10 | M0 착수(완료) |
| G2 — v0.5 로컬 동작(미검증) | 선행인 94S-91·94S-92·94S-18·94S-93 결과를 사용해 adapter fake와 actual SDK/local Messages suite·선택 LiteLLM transport suite 및 §13 회귀가 compose CI 통과 | 94S-32, 94S-33 | 클러스터 매니페스트 검증 |
| G3 — 로컬 클러스터(미검증) | kind에서 KEDA·NetworkPolicy·baseline gVisor·overlay가 실제로 동작. 94S-94 비교는 선택적이며 94S-34를 막지 않음 | 94S-34, 94S-37, 94S-94 | 스테이징 배포 |
| G4 — 운영 준비 | §15.3 체크리스트 전부 | §16.2 전체 | 프로덕션 |

G2를 통과하지 못한 채 G3로 넘어가면, 클러스터 문제와 애플리케이션 문제가 섞여 원인을 가릴 수 없게 된다.

게이트 판정 티켓은 94S-32·94S-33이다. 같은 G2 milestone에 속한 94S-36·94S-53 등 다른 로컬 트랙 작업의 전체 완료 수와 게이트 통과를 혼동하지 않는다. 또한 선행 구현 티켓이 닫혔다는 사실만으로 실제 두 기본 계층과 선택 LiteLLM transport CI가 실행됐다고 보지 않는다.

### 15.2 로컬 트랙 완료 조건

- `bun run check`가 전 워크스페이스에서 통과 (94S-9)
- `./scripts/dev up` 한 번으로 `docker compose -f infra/docker-compose.yml`의 전체 앱 스택이 뜨고, 문서만 보고 처음부터 따라할 수 있다. 현재 M0의 의존 서비스 기동과 구분한다 (94S-14, 94S-36)
- §13의 시나리오 5종이 adapter fake와 actual SDK/local fake Messages API 두 층에서 CI 통과 (94S-32, 94S-91)
- 동시성 회귀 테스트가 CI에서 반복 통과 (94S-33)
- 세션 하나를 돌렸을 때 구조화 로그·메트릭·트레이스가 전부 나온다 (94S-35, 94S-41)
- 마이그레이션 적용과 롤백을 로컬에서 리허설했다 (94S-39)
- 세션 인스펙터에서 세션·워커·큐 현황과 이벤트 타임라인을 볼 수 있다 (94S-50)
- 로컬 AWS 의존은 LocalStack을 통해 운영과 같은 AWS SDK 경로를 밟는다. 이는 Agent SDK나 실제 Anthropic 인증 경로가 같다는 뜻이 아니다 (94S-14)
- **AWS 계정·클러스터·LLM 키 없이** 세션 생성부터 resume까지 완주한다 (94S-52)
- §10.6의 운영 장애 상황을 손으로 일으켜 `/ui`에서 관찰할 수 있다 (94S-53)
- kind 검증이 머지 전 게이트로 걸려 있고, 명령 하나로 뜬다 (94S-36, 94S-37)

### 15.3 배포 트랙 완료 조건

**인프라**

- [ ] EKS 클러스터에 매니페스트와 overlay가 적용된다 (94S-34)
- [ ] KEDA가 미배정 세션 수를 보고 워커 Job을 만든다 (94S-10, 94S-34)
- [ ] 스팟 노드 풀과 node-termination-handler가 붙어, 선점 알림이 SIGTERM 경로로 이어진다 (94S-47)
- [ ] gVisor 런타임이 실제로 적용된다(무시되고 있지 않다) (94S-37)
- [ ] NetworkPolicy가 허용 목록 밖 egress를 막는다 (94S-37)

**배포**

- [ ] CD가 이미지를 빌드해 ECR에 올리고 같은 다이제스트를 환경 간 승격한다 (94S-46)
- [ ] 마이그레이션이 배포 전 Job으로 실행되고 롤백 절차가 있다 (94S-39)
- [ ] 시크릿이 매니페스트 밖에서 주입된다 (94S-40)
- [ ] 롤링 업데이트 중 진행 중 세션이 유실되지 않는다 (94S-30, 94S-46)

**운영**

- [ ] 세션 단위로 로그·트레이스를 추적할 수 있다 (94S-35, 94S-41)
- [ ] SLO와 알림 임계치가 정의되고 알림이 실제로 도착한다 (94S-48)
- [ ] 세션당 비용 상한과 테넌트 한도가 집행된다 (94S-42, 94S-43)
- [ ] 테넌트별 자격증명이 분리된다 (94S-45)
- [ ] split-brain 쓰기가 차단된다 (94S-44)
- [ ] 백업과 복구 리허설을 한 번 마쳤다 (94S-49)
- [ ] 런북이 있고, 최소한 "멈춘 세션 수동 회수"와 "워커 전체 재기동"이 적혀 있다 (94S-49)

### 15.4 의도적으로 뒤로 미룬 것

되돌릴 수 있는 결정이고, 필요해지는 시점이 명확한 것들이다.

| 항목 | 미룬 이유 | 당길 시점 |
|------|-----------|-----------|
| Redis 큐 백엔드 | PoC 규모에서 Postgres로 충분(§12.4) | 이벤트 팬아웃이 병목일 때 |
| 프리웜 워커 | 현 구조로 동작하지 않음(§12.3) | 콜드스타트가 실측으로 문제일 때 |
| `GET /transcript` | `events`가 같은 이력을 제공(§5) | JSONL 원본 형태가 필요한 클라이언트가 생길 때 |
| 감독자 모델(pod 하나에 세션 N개) | 격리 우선(§1.1) | pod당 비용이 격리 가치를 넘을 때 |
| OIDC 인증 | 클라이언트가 서비스라 API 키로 충분(§12.5) | 사람이 직접 쓰는 클라이언트가 생길 때 |

---

## 16. 티켓 맵

Linear 팀 `94soon`, 프로젝트 [Claude Code 세션 컨트롤 플레인](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)의 2026-09-15 조회 결과다. **정본은 Linear의 native blocked-by와 milestone**이며 아래는 재생성한 사본이다.

유효 티켓 50개(G1 3 / G2 32 / G3 4 / G4 11). 취소된 [94S-51](https://linear.app/94soon/issue/94S-51)은 이력에 유지하고 아래 표·실행 graph에서는 제외한다. 전체 graph의 순환 의존은 없다. Done은 상태 표시이며 이번 개정에서 해당 QA를 재실행했다는 의미가 아니다.

### 16.1 로컬 트랙

#### G1 설계 확정 — 완료 이력

| 티켓 | 내용 | 상태 | blocked-by |
|------|------|------|------------|
| [94S-7](https://linear.app/94soon/issue/94S-7) | 큐 레이어를 세션 단위 단일 큐로 재설계하고 DESIGN.md 개정 | Done | — |
| [94S-8](https://linear.app/94soon/issue/94S-8) | [조사] 툴 실행 도중 중단된 세션의 resume 동작 실측 | Done | — |
| [94S-10](https://linear.app/94soon/issue/94S-10) | [조사] Postgres 큐 백엔드용 KEDA 스케일 트리거 결정 | Done | [94S-7](https://linear.app/94soon/issue/94S-7) |

#### G2 로컬 동작 — SDK 계약 재검증 포함

| 티켓 | 내용 | 상태 | blocked-by |
|------|------|------|------------|
| [94S-9](https://linear.app/94soon/issue/94S-9) | Bun workspaces 모노레포 골격과 bun run check 파이프라인 세우기 | Done | — |
| [94S-11](https://linear.app/94soon/issue/94S-11) | packages/contracts에 API·이벤트·큐 메시지 zod 스키마 정의 | Done | [94S-7](https://linear.app/94soon/issue/94S-7), [94S-9](https://linear.app/94soon/issue/94S-9) |
| [94S-12](https://linear.app/94soon/issue/94S-12) | packages/db에 drizzle 스키마와 마이그레이션 작성 | Done | [94S-7](https://linear.app/94soon/issue/94S-7), [94S-9](https://linear.app/94soon/issue/94S-9) |
| [94S-13](https://linear.app/94soon/issue/94S-13) | packages/storage에 JSONL S3 동기화와 git 워크스페이스 영속화 구현 | Done | [94S-9](https://linear.app/94soon/issue/94S-9), [94S-14](https://linear.app/94soon/issue/94S-14) |
| [94S-14](https://linear.app/94soon/issue/94S-14) | 로컬 의존 서비스 docker-compose 구성 (Postgres·LocalStack·gitea) | Done | [94S-9](https://linear.app/94soon/issue/94S-9) |
| [94S-15](https://linear.app/94soon/issue/94S-15) | 세션 클레임·해제·상태 전이 쿼리를 원자적으로 구현 | Done | [94S-12](https://linear.app/94soon/issue/94S-12) |
| [94S-16](https://linear.app/94soon/issue/94S-16) | packages/queue 인터페이스와 Postgres 구현 작성 | Done | [94S-11](https://linear.app/94soon/issue/94S-11), [94S-12](https://linear.app/94soon/issue/94S-12) |
| [94S-17](https://linear.app/94soon/issue/94S-17) | Hono API 골격과 API 키 인증 미들웨어 구현 | Backlog | [94S-11](https://linear.app/94soon/issue/94S-11), [94S-14](https://linear.app/94soon/issue/94S-14), [94S-15](https://linear.app/94soon/issue/94S-15) |
| [94S-18](https://linear.app/94soon/issue/94S-18) | Claude Code 호환 SDK 어댑터와 native 이벤트 매핑·fake 제공 | Backlog | [94S-11](https://linear.app/94soon/issue/94S-11), [94S-91](https://linear.app/94soon/issue/94S-91) |
| [94S-19](https://linear.app/94soon/issue/94S-19) | 워커 phase 상태 기계와 heartbeat·클레임·미클레임 종료 구현 | Backlog | [94S-13](https://linear.app/94soon/issue/94S-13), [94S-15](https://linear.app/94soon/issue/94S-15), [94S-16](https://linear.app/94soon/issue/94S-16), [94S-91](https://linear.app/94soon/issue/94S-91), [94S-93](https://linear.app/94soon/issue/94S-93) |
| [94S-20](https://linear.app/94soon/issue/94S-20) | reconciler로 고아 매핑 정리와 세션 재큐잉 구현 | Backlog | [94S-15](https://linear.app/94soon/issue/94S-15), [94S-16](https://linear.app/94soon/issue/94S-16), [94S-91](https://linear.app/94soon/issue/94S-91) |
| [94S-21](https://linear.app/94soon/issue/94S-21) | 세션 생성·목록·상세 엔드포인트 구현 | Backlog | [94S-16](https://linear.app/94soon/issue/94S-16), [94S-17](https://linear.app/94soon/issue/94S-17), [94S-18](https://linear.app/94soon/issue/94S-18) |
| [94S-22](https://linear.app/94soon/issue/94S-22) | SSE 이벤트 스트림과 Last-Event-ID 재개 구현 | Backlog | [94S-16](https://linear.app/94soon/issue/94S-16), [94S-17](https://linear.app/94soon/issue/94S-17) |
| [94S-23](https://linear.app/94soon/issue/94S-23) | 질문·권한 답변 엔드포인트를 request_id 상관관계로 구현 | Backlog | [94S-16](https://linear.app/94soon/issue/94S-16), [94S-17](https://linear.app/94soon/issue/94S-17), [94S-18](https://linear.app/94soon/issue/94S-18) |
| [94S-24](https://linear.app/94soon/issue/94S-24) | 워커 턴 처리 루프와 이벤트 발행 구현 | Backlog | [94S-18](https://linear.app/94soon/issue/94S-18), [94S-19](https://linear.app/94soon/issue/94S-19) |
| [94S-25](https://linear.app/94soon/issue/94S-25) | local-scaler로 로컬 워커 기동 자동화 | Backlog | [94S-14](https://linear.app/94soon/issue/94S-14), [94S-19](https://linear.app/94soon/issue/94S-19) |
| [94S-26](https://linear.app/94soon/issue/94S-26) | 후속 메시지 엔드포인트와 세션 큐 라우팅 구현 | Backlog | [94S-21](https://linear.app/94soon/issue/94S-21) |
| [94S-27](https://linear.app/94soon/issue/94S-27) | 세션 중단·고정·삭제 엔드포인트 구현 | Backlog | [94S-18](https://linear.app/94soon/issue/94S-18), [94S-21](https://linear.app/94soon/issue/94S-21), [94S-28](https://linear.app/94soon/issue/94S-28) |
| [94S-28](https://linear.app/94soon/issue/94S-28) | 병렬 canUseTool·AskUserQuestion과 typed answers 왕복 구현 | Backlog | [94S-8](https://linear.app/94soon/issue/94S-8), [94S-23](https://linear.app/94soon/issue/94S-23), [94S-24](https://linear.app/94soon/issue/94S-24), [94S-91](https://linear.app/94soon/issue/94S-91) |
| [94S-29](https://linear.app/94soon/issue/94S-29) | 트랜스크립트·git 체크포인트를 한 쌍으로 묶어 영속화 | Backlog | [94S-8](https://linear.app/94soon/issue/94S-8), [94S-13](https://linear.app/94soon/issue/94S-13), [94S-24](https://linear.app/94soon/issue/94S-24), [94S-93](https://linear.app/94soon/issue/94S-93) |
| [94S-30](https://linear.app/94soon/issue/94S-30) | 종료 사유별 정책을 적용하는 유휴 회수·drain 구현 | Backlog | [94S-24](https://linear.app/94soon/issue/94S-24), [94S-29](https://linear.app/94soon/issue/94S-29) |
| [94S-32](https://linear.app/94soon/issue/94S-32) | PoC 시나리오 5종 e2e 자동화하고 CI에서 실행 | Backlog | [94S-20](https://linear.app/94soon/issue/94S-20), [94S-22](https://linear.app/94soon/issue/94S-22), [94S-23](https://linear.app/94soon/issue/94S-23), [94S-25](https://linear.app/94soon/issue/94S-25), [94S-26](https://linear.app/94soon/issue/94S-26), [94S-27](https://linear.app/94soon/issue/94S-27), [94S-28](https://linear.app/94soon/issue/94S-28), [94S-30](https://linear.app/94soon/issue/94S-30), [94S-52](https://linear.app/94soon/issue/94S-52), [94S-93](https://linear.app/94soon/issue/94S-93) |
| [94S-33](https://linear.app/94soon/issue/94S-33) | 동시성 회귀 테스트로 순서 보장·클레임 경쟁·답변 상관관계 검증 | Backlog | [94S-32](https://linear.app/94soon/issue/94S-32) |
| [94S-35](https://linear.app/94soon/issue/94S-35) | packages/observability에 구조화 로거와 트레이싱 훅 구현 | Done | [94S-9](https://linear.app/94soon/issue/94S-9), [94S-11](https://linear.app/94soon/issue/94S-11) |
| [94S-36](https://linear.app/94soon/issue/94S-36) | 원커맨드 로컬 기동과 개발 온보딩 문서 정비 | Backlog | [94S-14](https://linear.app/94soon/issue/94S-14), [94S-25](https://linear.app/94soon/issue/94S-25), [94S-38](https://linear.app/94soon/issue/94S-38) |
| [94S-38](https://linear.app/94soon/issue/94S-38) | API 헬스·레디니스 프로브 엔드포인트 구현 | Backlog | [94S-17](https://linear.app/94soon/issue/94S-17) |
| [94S-50](https://linear.app/94soon/issue/94S-50) | 세션 인스펙터 UI로 로컬 실행 상태 가시화 | Backlog | [94S-21](https://linear.app/94soon/issue/94S-21), [94S-22](https://linear.app/94soon/issue/94S-22), [94S-23](https://linear.app/94soon/issue/94S-23) |
| [94S-52](https://linear.app/94soon/issue/94S-52) | 외부 계정 없이 도는 로컬 기본 모드 구성 | Backlog | [94S-14](https://linear.app/94soon/issue/94S-14), [94S-18](https://linear.app/94soon/issue/94S-18), [94S-24](https://linear.app/94soon/issue/94S-24) |
| [94S-53](https://linear.app/94soon/issue/94S-53) | 운영 장애 상황을 로컬에서 재현하는 레시피와 헬퍼 작성 | Backlog | [94S-33](https://linear.app/94soon/issue/94S-33), [94S-44](https://linear.app/94soon/issue/94S-44), [94S-50](https://linear.app/94soon/issue/94S-50), [94S-52](https://linear.app/94soon/issue/94S-52) |
| [94S-91](https://linear.app/94soon/issue/94S-91) | [조사] 고정 Agent SDK의 Claude Code 호환성과 중단·승인·재개 계약을 확정 | Done | [94S-8](https://linear.app/94soon/issue/94S-8), [94S-11](https://linear.app/94soon/issue/94S-11) |
| [94S-92](https://linear.app/94soon/issue/94S-92) | [조사] SessionStore와 filesystem checkpoint의 복구 backend를 선택 | Done | [94S-8](https://linear.app/94soon/issue/94S-8), [94S-13](https://linear.app/94soon/issue/94S-13), [94S-91](https://linear.app/94soon/issue/94S-91) |
| [94S-93](https://linear.app/94soon/issue/94S-93) | 검증된 session 저장 backend와 immutable checkpoint manifest를 연동 | Backlog | [94S-13](https://linear.app/94soon/issue/94S-13), [94S-18](https://linear.app/94soon/issue/94S-18), [94S-92](https://linear.app/94soon/issue/94S-92) |

#### G3 로컬 클러스터

| 티켓 | 내용 | 상태 | blocked-by |
|------|------|------|------------|
| [94S-31](https://linear.app/94soon/issue/94S-31) | API·워커·local-scaler Dockerfile 작성 | Backlog | [94S-17](https://linear.app/94soon/issue/94S-17), [94S-19](https://linear.app/94soon/issue/94S-19), [94S-91](https://linear.app/94soon/issue/94S-91) |
| [94S-34](https://linear.app/94soon/issue/94S-34) | 쿠버네티스 매니페스트와 kustomize overlay 작성 | Backlog | [94S-10](https://linear.app/94soon/issue/94S-10), [94S-31](https://linear.app/94soon/issue/94S-31), [94S-33](https://linear.app/94soon/issue/94S-33), [94S-38](https://linear.app/94soon/issue/94S-38) |
| [94S-37](https://linear.app/94soon/issue/94S-37) | kind 클러스터에서 KEDA·NetworkPolicy·gVisor 실동작 검증 | Backlog | [94S-34](https://linear.app/94soon/issue/94S-34) |
| [94S-94](https://linear.app/94soon/issue/94S-94) | [조사] Agent Sandbox의 실행 기반 적합성을 KEDA 기준선과 비교 | Backlog | [94S-31](https://linear.app/94soon/issue/94S-31), [94S-33](https://linear.app/94soon/issue/94S-33) |

### 16.2 배포 트랙 (G4)

| 티켓 | 내용 | 상태 | blocked-by |
|------|------|------|------------|
| [94S-39](https://linear.app/94soon/issue/94S-39) | DB 마이그레이션 배포 전략과 롤백 절차 수립 | Backlog | [94S-12](https://linear.app/94soon/issue/94S-12), [94S-31](https://linear.app/94soon/issue/94S-31) |
| [94S-40](https://linear.app/94soon/issue/94S-40) | EKS 시크릿 주입 체계 구성 | Backlog | [94S-34](https://linear.app/94soon/issue/94S-34) |
| [94S-41](https://linear.app/94soon/issue/94S-41) | 메트릭·트레이싱 수집기 연결과 로컬 관측 스택 구성 | Backlog | [94S-24](https://linear.app/94soon/issue/94S-24), [94S-35](https://linear.app/94soon/issue/94S-35) |
| [94S-42](https://linear.app/94soon/issue/94S-42) | 레이트 리밋·세션 수 상한·백프레셔 구현 | Backlog | [94S-17](https://linear.app/94soon/issue/94S-17), [94S-21](https://linear.app/94soon/issue/94S-21) |
| [94S-43](https://linear.app/94soon/issue/94S-43) | 세션 토큰·비용 상한 집행 | Backlog | [94S-24](https://linear.app/94soon/issue/94S-24) |
| [94S-44](https://linear.app/94soon/issue/94S-44) | 클레임 fencing token으로 split-brain 쓰기 차단 | Backlog | [94S-15](https://linear.app/94soon/issue/94S-15), [94S-19](https://linear.app/94soon/issue/94S-19) |
| [94S-45](https://linear.app/94soon/issue/94S-45) | 테넌트별 LLM·git 자격증명 분리 | Backlog | [94S-19](https://linear.app/94soon/issue/94S-19), [94S-21](https://linear.app/94soon/issue/94S-21), [94S-40](https://linear.app/94soon/issue/94S-40), [94S-91](https://linear.app/94soon/issue/94S-91) |
| [94S-46](https://linear.app/94soon/issue/94S-46) | CD 파이프라인으로 이미지 승격과 overlay 배포 자동화 | Backlog | [94S-31](https://linear.app/94soon/issue/94S-31), [94S-34](https://linear.app/94soon/issue/94S-34), [94S-39](https://linear.app/94soon/issue/94S-39) |
| [94S-47](https://linear.app/94soon/issue/94S-47) | 스팟 노드 풀과 선점 복구를 스테이징에서 검증 | Backlog | [94S-34](https://linear.app/94soon/issue/94S-34), [94S-37](https://linear.app/94soon/issue/94S-37), [94S-46](https://linear.app/94soon/issue/94S-46) |
| [94S-48](https://linear.app/94soon/issue/94S-48) | SLO와 알림 임계치 정의 | Backlog | [94S-41](https://linear.app/94soon/issue/94S-41) |
| [94S-49](https://linear.app/94soon/issue/94S-49) | 운영 런북과 백업·복구 절차 작성 | Backlog | [94S-47](https://linear.app/94soon/issue/94S-47), [94S-48](https://linear.app/94soon/issue/94S-48), [94S-53](https://linear.app/94soon/issue/94S-53) |

### 16.3 착수 순서와 해석

- M0 8개는 완료 상태를 유지한다: 94S-9·11·12·13·14·15·16·35.
- SDK 경로의 다음 gate는 94S-91이다. 94S-18과 94S-92는 그 결과를 소비하고, 94S-93은 두 경로가 모두 닫힌 뒤 선택 backend를 구현한다.
- API의 독립 골격·프로브 등은 해당 native 선행이 끝나면 착수할 수 있다. M1·M2 같은 단계명만으로 직렬화하지 않는다.
- 94S-27·94S-28·94S-52·94S-93을 94S-32의 선행으로 반영해 stop/승인/실제 SDK 복구 없이 G2 E2E가 완료되지 않게 한다.
- 94S-94는 94S-31·94S-33 이후의 선택 비교이며 94S-34의 blocker가 아니다. 별도 전환 결정 전에는 KEDA를 유지한다.
- G2 마일스톤에는 94S-53 같은 후속 운영 의존 항목도 있다. G3 진입의 애플리케이션 게이트는 94S-32·94S-33의 실행 증거이며 milestone 진행률과 혼동하지 않는다.

현재 graph에서 계산한 최장 선행 사슬 중 하나:

```text
94S-7 → 94S-11 → 94S-91 → 94S-18 → 94S-93 → 94S-19 → 94S-24 → 94S-28 → 94S-27 → 94S-32 → 94S-33 → 94S-34 → 94S-37 → 94S-47 → 94S-49
```

이는 dependency hop 기준이며 기간 기반 critical path가 아니다. 착수 시 반드시 Linear를 새로 조회한다.

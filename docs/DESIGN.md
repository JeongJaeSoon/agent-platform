# Claude Code 세션 컨트롤 플레인 설계안

> 상태: Draft v0.3 · 작성일: 2026-09-12 · 개정: 2026-09-13
> 범위: HTTP API로 Claude Code 세션을 생성·재개·관찰하고, Kubernetes 위에서 세션 워커를 수평 확장하는 시스템
> 배포 대상: AWS EKS

---

## 1. 목적과 배경

Claude Code를 터미널이 아니라 서버 환경에서 돌리고, 여러 클라이언트(웹 UI, Slack, 다른 서비스)가 API를 통해 세션을 만들고 메시지를 주고받을 수 있게 한다. 세션은 요청량에 따라 수평 확장되어야 하며, 작업이 끝나면 리소스를 회수하고, 이후 메시지가 오면 이어서 작업할 수 있어야 한다.

Claude Code 자체가 어떤 LLM 엔드포인트를 쓰는지(직접 API, LiteLLM 등 게이트웨이, Bedrock)는 이 설계와 무관하다. 워커 환경변수 `ANTHROPIC_BASE_URL` 하나로 결정되므로 본 문서에서는 다루지 않는다.

### 1.1 핵심 판단

Claude Code 세션의 실체는 두 가지뿐이다.

1. 트랜스크립트 JSONL — `~/.claude/projects/<cwd-hash>/<session_id>.jsonl`
2. 작업 디렉토리(코드)

이 둘이 외부 스토리지에 있으면 어떤 워커에서든 `resume`으로 재개할 수 있다. 따라서 **세션은 pod에 영구히 묶이지 않는다.** 다만 개발 서버 등 장기 실행 프로세스로 동작 확인을 하는 워크플로우를 지원하려면 세션이 활성인 동안은 pod가 살아 있어야 한다. 결론적으로:

- **pod 하나 = 세션 하나** (격리 최우선)
- 세션이 활성인 동안 pod 유지, 유휴 N분 후 회수
- 회수된 세션에 메시지가 오면 새 pod에서 resume

Claude Code의 `claude agents`(에이전트 뷰)는 이 구조의 단일 머신 버전이다. 감독자 프로세스가 여러 백그라운드 세션을 호스팅하고, 유휴 세션 프로세스를 내렸다가 필요 시 재개한다. 본 설계는 그 개념을 다중 노드로 확장한 것이며, 워커 이미지에 `claude` CLI를 포함해 두면 나중에 "pod 하나에 감독자 + 세션 N개" 모델로 이행하기 쉽다.

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
┌────▼──────────────────────┐
│ API 서버 (컨트롤 플레인)    │  stateless, HPA
└──┬──────────┬──────────┬──┘
   │          │          │
┌──▼───┐  ┌───▼────┐  ┌──▼────────────────┐
│ 큐    │  │Postgres│  │ 오브젝트 스토리지  │
│ 이벤트│  │ 정본   │  │ JSONL + git remote │
└──┬───┘  └───┬────┘  └──┬────────────────┘
   │          │          │
┌──▼──────────▼──────────▼──┐
│ 워커 pod (세션 1개)        │  KEDA, 스팟
│  sidecar → Agent SDK      │
└─────────────┬─────────────┘
              │ ANTHROPIC_BASE_URL
        ┌─────▼─────┐
        │ LLM 엔드포인트│
        └───────────┘
```

### 3.1 컴포넌트

| 컴포넌트 | 역할 | 기술 |
|---------|------|------|
| API 서버 | 세션 CRUD, 메시지 수신·라우팅, SSE 중계, 답변 수신 | Bun + Hono(또는 Elysia) |
| Postgres | 세션 메타·상태·`session → pod` 매핑의 **정본** | Postgres 16 |
| 큐 / 이벤트 스트림 | 세션별 메시지 큐, 워커가 발행하는 이벤트 스트림, heartbeat 리스 | Redis Streams (PoC는 Postgres 단독 가능, §10) |
| 오브젝트 스토리지 | 트랜스크립트 JSONL | S3 (로컬은 LocalStack) |
| git remote | 세션별 브랜치로 코드 변경 영속화 | GitHub/GitLab |
| 워커 pod | 세션 하나를 호스팅. 사이드카가 Agent SDK를 구동하고 큐·스트림과 연결 | Bun + `@anthropic-ai/claude-agent-sdk` |
| KEDA | 미배정 큐 길이 기반으로 워커 pod 수 조절 | KEDA ScaledJob |

### 3.2 상태 저장의 역할 분담

etcd가 쿠버네티스에서 하는 역할(정본, 리스, watch)을 두 저장소로 나눈다.

- **정본** → Postgres: 매핑 획득과 상태 전이에 트랜잭션이 필요
- **리스·큐·스트림** → Redis: TTL 자동 만료, 스트림, 블로킹 pop이 값쌈

PoC 단계에서는 Postgres만으로도 가능하다(`SKIP LOCKED` 큐, `LISTEN/NOTIFY` 이벤트, `last_seen` heartbeat). 이벤트 팬아웃이 병목이 되는 시점에 Redis를 붙이면 되고, 정본은 그대로 Postgres에 둔다.

---

## 4. 데이터 모델

### 4.1 Postgres

```sql
CREATE TYPE session_status AS ENUM (
  'queued', 'running', 'needs_input', 'idle', 'failed', 'stopped'
);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY,
  claude_session_id TEXT,              -- Agent SDK가 발급한 session_id
  owner_id        TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  branch          TEXT NOT NULL,       -- session/<id>
  status          session_status NOT NULL DEFAULT 'queued',
  pod_id          TEXT,                -- NULL이면 미배정
  pinned          BOOLEAN NOT NULL DEFAULT false,
  last_turn_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_pod_uniq ON sessions (pod_id) WHERE pod_id IS NOT NULL;

CREATE TABLE turns (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id),
  message     TEXT NOT NULL,
  status      TEXT NOT NULL,           -- queued | running | done | failed | interrupted
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  result_json JSONB
);

CREATE TABLE pull_requests (
  session_id UUID REFERENCES sessions(id),
  url        TEXT NOT NULL,
  PRIMARY KEY (session_id, url)
);

-- SSE 재개의 소스. LISTEN/NOTIFY는 비영속이라 이 테이블이 없으면
-- 구독이 끊긴 동안의 이벤트가 사라진다(§5.1).
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,   -- 단조 증가. 불투명 커서로 인코딩해 노출
  session_id UUID NOT NULL REFERENCES sessions(id),
  type       TEXT NOT NULL,           -- §5.1의 이벤트 종류
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_session_id_idx ON events (session_id, id);

-- 세션 메시지 큐. 백엔드가 Postgres일 때의 구현(§12.4).
-- 메시지는 세션 단위 큐 하나에만 들어간다. pod별 큐는 없다(§7.1).
CREATE TABLE queue_messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id),
  turn_id     BIGINT REFERENCES turns(id),
  kind        TEXT NOT NULL,          -- message | answer
  payload     JSONB NOT NULL,         -- answer면 request_id 포함(§6.4)
  visible_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX queue_messages_pick_idx ON queue_messages (session_id, id)
  WHERE claimed_by IS NULL;

-- 미배정 세션 신호. 페이로드 없이 session_id만 담는다.
-- 행 수 = 워커를 기다리는 세션 수이고, 그대로 KEDA 스케일 지표가 된다(§7.2).
CREATE TABLE unassigned_sessions (
  session_id UUID PRIMARY KEY REFERENCES sessions(id),
  signaled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 워커 생존 리스. Redis 백엔드에서는 TTL 키가 이 역할을 한다(§4.2).
CREATE TABLE workers (
  pod_id    TEXT PRIMARY KEY,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id         UUID PRIMARY KEY,
  key_hash   BYTEA NOT NULL UNIQUE,   -- SHA-256. 평문은 발급 시 한 번만 보여준다(§12.5)
  owner_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
```

`sessions_pod_uniq` 인덱스가 "pod 하나에 세션 하나"를 DB 수준에서 강제한다.

`unassigned_sessions`의 PK가 `session_id`라는 점이 신호의 중복을 막는다. 같은 세션에 메시지가 여러 개 들어와도 신호는 하나이고, 그래서 §7.2의 스케일 지표가 메시지 수가 아니라 세션 수가 된다.

### 4.2 Redis 키

| 키 | 타입 | 용도 |
|----|------|------|
| `queue:session:{session_id}` | Stream | 그 세션의 메시지. 유일한 메시지 적재처 |
| `queue:unassigned` | Set | 워커를 기다리는 세션 ID. 페이로드 없음. KEDA 스케일 지표 |
| `events:{session_id}` | Stream | 워커가 발행하는 SDK 메시지. SSE 소스 |
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
  transcript.jsonl        # ~/.claude/projects/<hash>/<claude_session_id>.jsonl 사본
  meta.json               # claude_session_id, cwd, 마지막 업로드 시각
```

코드는 스토리지가 아니라 git remote의 `session/{session_id}` 브랜치에 둔다. 워크스페이스 재수화는 `git clone --branch session/{id}`로 한다.

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
| POST | `/sessions/{id}/answers` | `{request_id, answer}` | `204` | 질문·권한 요청 응답 |
| GET | `/sessions/{id}/transcript` | `?after_uuid` | `[{normalized message}]` | JSONL 정규화 이력. **PoC 범위 밖** — `events` 테이블(§4.1)이 같은 이력을 제공하므로 두 번째 경로를 만들지 않는다. JSONL은 resume용 원본으로만 쓴다 |
| POST | `/sessions/{id}/stop` | | `202` | 현재 턴 중단 |
| POST | `/sessions/{id}/pin` | `{pinned: bool}` | `204` | 유휴 회수 제외 |
| DELETE | `/sessions/{id}` | | `204` | pod·브랜치·스토리지 정리 |

`POST /sessions`와 `POST /sessions/{id}/messages`는 `Idempotency-Key` 헤더를 받는다. 같은 키의 재요청은 새 세션이나 새 턴을 만들지 않고 최초 응답을 그대로 돌려준다. 이 API의 클라이언트는 사람이 아니라 서비스(§12.5)이고, 타임아웃 후 재시도는 그쪽의 기본 동작이다.

`/v1` 밖에 프로브 엔드포인트 두 개를 둔다. 인증을 요구하지 않고 세션 정보를 노출하지 않는다.

| 경로 | 용도 | 성공 조건 |
|------|------|-----------|
| `GET /healthz` | liveness. 프로세스가 살아 있는가 | 항상 200. 의존 서비스를 보지 않는다 |
| `GET /readyz` | readiness. 트래픽을 받을 수 있는가 | Postgres 연결과 마이그레이션 적용 상태 확인 |

둘을 나누는 이유는 실패 시 쿠버네티스의 반응이 다르기 때문이다. liveness 실패는 pod 재시작이고, readiness 실패는 로드밸런서에서 제외다. DB가 잠시 끊겼을 때 재시작을 반복하면 복구가 더 느려지므로, 의존 서비스 확인은 `readyz`에만 넣는다.

`GET /ui`는 세션 인스펙터를 서빙한다. `AUTH_MODE=none`일 때만 등록되므로 운영에서는 경로 자체가 없다(§10.5).

### 5.1 SSE 이벤트 형식

이벤트 스트림의 각 엔트리를 그대로 SSE로 내려보낸다. SSE `id`는 **불투명 커서 문자열**이다.

```
id: ev_01J8X2K4M9
event: assistant
data: {"type":"assistant","message":{...}}

id: ev_01J8X2K4MA
event: tool_use
data: {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}

id: ev_01J8X2K4MB
event: question
data: {"request_id":"q_01","kind":"permission","tool":"Bash","input":{...}}

id: ev_01J8X2K4MC
event: result
data: {"type":"result","subtype":"success","session_id":"...","usage":{...}}
```

이벤트 종류: `system` · `assistant` · `tool_use` · `tool_result` · `question` · `result` · `status`(상태 전이 알림) · `error`.

**커서는 불투명하다.** 클라이언트는 받은 값을 그대로 `Last-Event-ID`로 돌려줄 뿐, 그 안을 해석하지 않는다. Postgres 백엔드에서는 `events.id`(BIGSERIAL), Redis 백엔드에서는 스트림 엔트리 ID를 인코딩한 것이지만, 그 차이는 `packages/queue` 뒤에 숨는다. v0.1은 Redis 엔트리 ID 포맷(`1726100000000-0`)을 계약에 그대로 노출했는데, 그러면 §12.4가 허용한 백엔드 교체가 클라이언트 계약을 깨뜨린다.

**재개는 durable한 `events` 테이블에서 온다.** Postgres 백엔드에서 `LISTEN/NOTIFY`는 "새 이벤트가 있다"를 깨우는 용도일 뿐이고 이벤트의 저장소가 아니다. NOTIFY는 페이로드가 8000바이트로 제한되어 큰 assistant 메시지를 담지 못하고, 무엇보다 비영속이라 구독자가 없던 동안의 알림이 사라진다. 본문은 항상 테이블에서 읽는다.

### 5.2 스트리밍 방식 선택

읽기는 SSE, 쓰기는 POST로 분리한다. 단방향이라 HPA·로드밸런서와 잘 맞고 재접속 이어보기가 `Last-Event-ID`로 단순하다. 양방향이 꼭 필요하면 WebSocket으로 바꾸되 프로토콜은 동일하게 유지한다.

---

## 6. 워커 설계

### 6.1 구성

워커 pod 하나에 컨테이너 하나. 그 안에 사이드카 프로세스(Bun)가 Agent SDK를 임베드한다.

```
worker pod
├── /app/worker.ts        # 사이드카: 큐 소비, SDK 구동, 이벤트 발행, heartbeat
├── /workspace            # git clone 대상 (emptyDir)
└── ~/.claude/projects/   # 트랜스크립트 (스토리지에서 복원)
```

### 6.2 기동 시퀀스

1. `heartbeat:{pod_id}` 갱신 루프 시작(10초 주기, TTL 30초)
2. `queue:unassigned`에서 세션 ID 하나를 집음
3. Postgres에서 매핑 획득
   ```sql
   UPDATE sessions SET pod_id = $pod, status = 'running'
   WHERE id = $session AND pod_id IS NULL RETURNING *;
   ```
   실패(다른 pod가 선점)하면 그 신호를 버리고 2로 돌아감
4. 스토리지에서 `transcript.jsonl`을 `~/.claude/projects/<hash>/`에 복원, `git clone --branch session/{id}`
5. 이후 `queue:session:{session_id}`를 처음부터 소비

`CLAIM_TIMEOUT_SEC` 안에 3을 성공하지 못하면 `exit 0`으로 종료한다. KEDA는 미배정 세션 수만큼 Job을 만들고 스케일 인을 하지 않으므로(§7.6), 클레임하지 못한 워커가 스스로 나가지 않으면 Job이 쌓여 `maxReplicaCount`를 채우고 스케일 아웃이 멈춘다.

v0.1에는 "획득한 세션의 나머지 대기 메시지를 pod 큐로 옮김" 단계가 있었다. 삭제했다. 메시지가 처음부터 세션 큐 하나에만 있으므로 옮길 대상이 없고, 그 이관이 §4.2에 적은 세 결함의 원인이었다. 클레임에 실패한 워커는 신호만 버리면 된다 — 메시지는 세션 큐에 그대로 있고 승자가 읽는다.

### 6.3 턴 처리

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function* inbox(sessionId: string) {
  // queue:session:{sessionId}에서 메시지를 적재 순서대로 yield
  for await (const msg of consumeSessionQueue(sessionId)) {
    yield { type: "user", message: { role: "user", content: msg.text } };
  }
}

const result = query({
  prompt: inbox(sessionId),                 // 스트리밍 입력: 프로세스를 죽이지 않고 다음 턴을 이어 넣음
  options: {
    cwd: "/workspace",
    resume: meta.claude_session_id,         // 첫 세션이면 undefined
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    canUseTool: async (tool, input) => {
      const requestId = crypto.randomUUID();
      await publish(sessionId, { type: "question", request_id: requestId, kind: "permission", tool, input });
      await setStatus(sessionId, "needs_input");

      // 이 request_id의 답변만 받는다. 다른 질문의 답이 흘러들어오면 버린다(§6.4).
      const answer = await waitForAnswer(sessionId, requestId, QUESTION_TIMEOUT_SEC);

      await setStatus(sessionId, "running");
      if (!answer) return { behavior: "deny", message: "timeout" };
      return answer.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: answer.reason };
    },
  },
});

for await (const message of result) {
  if (message.type === "system" && message.subtype === "init") {
    await saveClaudeSessionId(sessionId, message.session_id);
  }
  await publish(sessionId, message);        // XADD events:{sessionId}
  if (message.type === "result") {
    await checkpoint(sessionId);            // git commit+push, JSONL 업로드 (한 쌍)
    await onTurnEnd(sessionId);             // status=idle, 유휴 타이머 시작
  }
}
```

### 6.3.1 체크포인트

턴 중에도 `CHECKPOINT_INTERVAL_SEC`(기본 60초)마다 저장해 비정상 종료 시 손실을 줄인다. **저장은 git commit+push와 JSONL 업로드를 한 쌍으로 한다.**

v0.1은 JSONL만 60초마다 올리고 git push는 턴 종료에만 했다. 그러면 턴 도중 사고 종료 시 트랜스크립트에는 "파일 X를 이렇게 고쳤다"는 tool_result가 남아 있는데 원격 브랜치에는 그 수정이 없다. 새 워커는 그 상태로 resume하고, Claude는 자기가 이미 썼다고 기억하는 파일이 없는 워크스페이스에서 작업을 이어간다. 진행분 손실이 아니라 트랜스크립트와 실제 상태의 모순이라 재개 후 행동이 어긋난다.

쌍 안에서는 **git push를 먼저, JSONL 업로드를 나중에** 한다. 둘 사이에 죽으면 코드가 트랜스크립트보다 앞서는데, 이쪽이 반대보다 안전하다 — Claude가 모르는 커밋은 다시 읽으면 되지만, 없는 파일을 있다고 믿는 것은 고칠 방법이 없다.

### 6.4 질문·권한 요청 처리

`canUseTool` 콜백은 툴 실행 직전에 블로킹된다. 툴 호출 도중에는 resume이 불가능하므로 대기 중에는 pod가 살아 있어야 한다. 정책:

- 타임아웃 기본 30분. 넘으면 deny 후 턴을 `needs_input`으로 종료하고 유휴 타이머 진입
- 자주 묻는 툴은 `allowedTools`로 사전 허용하고, 안전은 샌드박스(§6.7)로 확보
- `AskUserQuestion` 툴도 같은 경로로 처리(kind: `question`)

**답변은 `request_id`로 상관관계를 맞춘다.** 워커는 자신이 발행한 `request_id`의 답변만 소비하고, 다른 값이 오면 폐기한 뒤 계속 기다린다. drain 시에는 그 세션의 대기 중 답변 키를 삭제한다.

v0.1의 코드는 `BLPOP answer:{session_id}`로 세션 단위 대기만 했다. 그러면 두 경로로 잘못된 승인이 적용된다.

1. 타임아웃되어 deny로 닫힌 질문에 사람이 뒤늦게 답하면, 그 값이 리스트에 남아 **다음 질문**의 답으로 소비된다
2. 대기 중 워커가 죽고 새 워커가 같은 툴을 다시 물었을 때, 죽은 워커 시절에 쌓인 답변이 그대로 적용된다

권한 승인·거부가 걸린 채널이므로 단순 버그가 아니라 잘못된 권한이 부여되는 경로다. 타임아웃은 항상 deny로 닫고, 파싱에 실패한 답변도 deny로 취급한다.

이 절의 전제인 "툴 호출 도중에는 resume이 불가능하다"는 아직 실측하지 않았다(94S-8). `tool_use`는 있고 `tool_result`가 없는 트랜스크립트를 SDK가 어떻게 처리하는지에 따라 대기 중 pod를 내릴 수 있을지가 갈리고, §12.2의 타임아웃 값도 함께 움직인다.

### 6.5 턴 종료와 유휴 회수

턴 종료(`result` 수신) 시:

1. 체크포인트 실행(§6.3.1). 턴 중 주기 저장과 같은 루틴이다
2. `status = idle`, `last_turn_at = now()`
3. 유휴 타이머 시작(기본 30분, `pinned`면 무한)

타이머 만료 시: 매핑 삭제(`pod_id = NULL`) → 프로세스 종료 → pod 종료. 개발 서버가 떠 있는 세션은 `pinned` 또는 긴 타이머로 회수를 미룬다. 회수 후 재개 시 개발 서버는 다시 띄워야 하므로, CLAUDE.md에 "작업 시작 시 서버 상태를 확인하고 필요하면 기동" 규칙을 둔다.

### 6.6 종료 처리(SIGTERM)

`terminationGracePeriodSeconds: 120`. SIGTERM 수신 시:

1. 실행 중인 `query`를 abort
2. 체크포인트 실행(§6.3.1)
3. 처리 중이던 메시지를 세션 큐 앞쪽으로 되돌리고, 대기 중 답변 키를 삭제
4. `pod_id = NULL`, `status = queued`, `queue:unassigned`에 세션 ID 신호
5. 종료

3번에서 되돌릴 것은 **워커가 집어 처리 중이던 메시지 하나뿐**이다. 아직 읽지 않은 메시지는 세션 큐에 그대로 있고 다음 워커가 순서대로 이어 읽는다.

스팟 선점은 노드 종료 알림(AWS 2분 전 등)을 node-termination-handler가 받아 drain하므로 위 경로를 탄다. 알림 없이 사라지면 §7.4 heartbeat 경로로 복구된다.

### 6.7 격리

- 세션당 pod, `emptyDir` 워크스페이스
- gVisor 또는 Kata 런타임 클래스
- NetworkPolicy로 egress를 LLM 엔드포인트·git remote·패키지 레지스트리·Redis·Postgres·스토리지로 제한
- 리소스: requests `cpu: 1, memory: 2Gi`, limits `cpu: 4, memory: 8Gi` (빌드·테스트 부하 고려)

---

## 7. 다중 워커 관리

### 7.1 메시지 라우팅

```
POST /sessions/{id}/messages
  → 항상 queue:session:{id}에 적재
  → sessions.pod_id 가 NULL 이면 queue:unassigned에 세션 ID 신호 추가
```

**메시지가 어디로 갈지는 pod 상태와 무관하다.** `pod_id` 조회는 신호를 추가할지 말지에만 쓰이고, 그 판단이 틀려도 안전하다. 워커가 방금 죽었는데 살아 있다고 보고 신호를 안 넣었다면, 메시지는 세션 큐에 그대로 있고 reconciler가 매핑을 해제할 때 신호가 올라간다. 반대로 불필요한 신호가 들어가면 워커 하나가 떠서 클레임에 실패하고 스스로 나간다(§6.2).

신호는 `session_id`가 PK인 집합이므로 같은 세션에 여러 번 넣어도 하나다(§4.1). 그래서 미배정 신호의 수가 곧 워커를 기다리는 세션 수이고, 그대로 스케일 지표가 된다.

v0.1은 heartbeat를 확인해 pod 큐와 미배정 큐 중 하나를 골랐다. 그 분기가 §4.2에 적은 세 결함의 출발점이었으므로 삭제했다. 성능을 이유로 pod별 큐를 다시 들이면 같은 결함이 함께 돌아온다.

### 7.2 스케일 아웃

KEDA ScaledJob이 `queue:unassigned`의 크기를 본다. **미배정 세션 1개당 pod 1개.** 메시지 수가 아니라 세션 수다 — 같은 세션에 메시지가 10개 들어와도 그 세션을 집을 워커는 하나면 되고, v0.1처럼 메시지 수를 세면 9개의 pod가 떠서 클레임에 실패하고 도로 나간다.

`minReplicaCount`는 두지 않는다.

프리웜은 PoC 범위 밖이다. v0.1은 "고정 크기 Deployment로 프리웜 잡 1~2개 유지"를 제안했는데 이 구조로는 작동하지 않는다. 프리웜 pod가 세션을 클레임해도 Deployment는 그것을 여전히 살아 있는 replica로 세므로, 대기 중인 pod가 0이 된다. 콜드스타트 대응은 §11의 노드 이미지 캐시와 이미지 슬림화로 먼저 다룬다.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: claude-worker
spec:
  jobTargetRef:
    template:
      spec:
        runtimeClassName: gvisor
        terminationGracePeriodSeconds: 120
        nodeSelector: { node-pool: spot }
        containers:
          - name: worker
            image: registry/claude-worker:latest
            envFrom: [{ secretRef: { name: claude-worker-env } }]
            resources:
              requests: { cpu: "1", memory: 2Gi }
              limits: { cpu: "4", memory: 8Gi }
  pollingInterval: 5
  maxReplicaCount: 100
  scalingStrategy: { strategy: accurate }
  triggers:
    # 백엔드 미정(94S-10). PoC 기본은 Postgres(§12.4, §14.1)이므로 아래
    # redis-streams 트리거로는 워커가 한 대도 뜨지 않는다. 매니페스트 작성
    # 전에 KEDA postgresql 스케일러로 갈지 Redis 구현을 완성할지 결정한다.
    - type: redis-streams
      metadata:
        address: redis:6379
        stream: queue:unassigned
        consumerGroup: workers
        pendingEntriesCount: "1"
```

어느 트리거를 쓰든 지표는 **미배정 세션 수**(`unassigned_sessions`의 행 수, 또는 그에 해당하는 Redis Set 크기)여야 한다.

ScaledJob을 쓰는 이유: Deployment는 pod가 스스로 종료하면 즉시 대체 pod를 띄우고, 스케일 인 시 어떤 pod를 죽일지 KEDA가 고른다. Job은 워커가 종료하면 그걸로 끝이라 "유휴 pod가 스스로 나간다"는 모델과 맞는다.

### 7.3 스케일 인

워커 주도. §6.5의 유휴 타이머 만료로 pod가 스스로 종료한다. KEDA는 pod를 죽이지 않는다.

### 7.4 생존 감시와 고아 정리

- 워커: `SET heartbeat:{pod_id} 1 EX 30`을 10초마다
- reconciler(CronJob, 1분): `pod_id IS NOT NULL`인 세션 중 heartbeat 없는 것을 일괄 정리

정리는 **매핑 해제 → `status = queued` → 미배정 신호** 순서로, 한 트랜잭션 안에서 한다. 순서가 뒤바뀌면 신호를 보고 온 워커가 아직 남아 있는 `pod_id` 때문에 클레임에 실패한다.

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
| `/stop` | 유지 | running → stopped(턴만 중단) |

### 7.6 pod 실행·종료 제어의 원칙

**시작은 KEDA가, 종료는 워커 자신이 결정한다.** 쿠버네티스는 실행 중인 워커 pod를 임의로 회수하지 않으며, 워커가 `exit 0`하면 Job이 완료 처리될 뿐이다.

| 동작 | 주체 | 근거 |
|------|------|------|
| pod 생성 | KEDA ScaledJob | `queue:unassigned` pending 수 > 실행 중 Job 수 |
| 세션 획득 | 워커 | `UPDATE sessions SET pod_id=$me WHERE pod_id IS NULL` 성공 |
| 턴 시작 / 종료 | 워커 | 큐 메시지 도착 / SDK `result` 수신 |
| 정상 종료 | 워커 | 유휴 타이머 만료 → 저장 → `exit 0` |
| 강제 종료 | 쿠버네티스 → 워커 | 노드 drain·롤링 업데이트 시 SIGTERM, 워커가 유예 시간 안에 저장 후 종료 |
| 사고 종료 | 없음 | OOM, 선점 알림 없는 노드 소실. reconciler가 사후 정리 |

ScaledJob은 "부족하면 만든다"만 하고 "남으면 지운다"는 하지 않으므로 이 원칙이 성립한다. Deployment였다면 pod가 스스로 종료해도 대체 pod가 즉시 뜨고, 스케일 인 시 어떤 pod를 죽일지 KEDA가 고르게 되어 실행 중 세션이 끊길 수 있다. Job 재시도는 `backoffLimit: 0`으로 끄고, 재시도는 큐 재삽입으로만 처리해 같은 세션이 두 번 실행되는 것을 막는다.

### 7.7 상태의 저장 위치와 정본

상태는 세 군데에 나뉘어 있고 정본은 하나다.

| 저장소 | 내용 | 쓰는 주체 | 성격 |
|--------|------|-----------|------|
| Postgres `sessions` | `status`, `pod_id` | 워커(획득·전이·해제), reconciler(고아 정리). API는 읽기와 `queued` 전이만 | **정본**. 클라이언트가 보는 세션 상태 |
| Redis `heartbeat:{pod_id}` | pod 생존 여부 | 워커 10초 주기, TTL 30초 | 증거. `pod_id`가 "있어야 한다"는 주장이면 heartbeat는 "실제로 살아 있다"는 증거 |
| Kubernetes Job/Pod | Running / Complete / Failed | kubelet | 인프라 수준. 세션 상태와 직접 연결하지 않음 |

Job이 Failed여도 세션은 `queued`로 재큐잉되어 다음 pod가 이어받으므로, 세션 상태를 쿠버네티스 상태에서 유도하지 않는다.

### 7.8 워커 프로세스 내부 상태 기계

```ts
let phase: "booting" | "claiming" | "running" | "waiting" | "idle" | "draining";
let sessionId: string | null;          // 획득한 세션
let idleTimer: Timer | null;           // idle 진입 시 시작, 메시지 도착 시 취소
let currentTurn: { abort: AbortController; turnId: number } | null;
```

| 전이 | 트리거 | 동작 |
|------|--------|------|
| `booting → claiming` | 기동 | heartbeat 루프 시작, `queue:unassigned` 소비 시작 |
| `claiming → running` | DB UPDATE 성공 | JSONL·repo 복원, `queue:session:{claimed}` 소비 시작. 실패면 `claiming` 유지 |
| `claiming → exit` | `CLAIM_TIMEOUT_SEC` 경과 | heartbeat 키 삭제, `exit 0`. 저장할 것이 없으므로 drain을 거치지 않는다 |
| `running → waiting` | `canUseTool` 진입 | `question` 발행, `status = needs_input`, 해당 `request_id`의 답변 대기 |
| `waiting → running` | 일치하는 `request_id`의 답변 도착 | `status = running`, 툴 실행 계속. 타임아웃이면 deny 후 턴 종료 |
| `running → idle` | `result` 수신 | 체크포인트(§6.3.1), `status = idle`, 타이머 시작 |
| `idle → running` | 세션 큐에 메시지 | 타이머 취소, 다음 턴 시작 |
| `idle → draining` | 타이머 만료 | 저장 루틴 진입 |
| `* → draining` | SIGTERM | `currentTurn.abort()`, 저장 루틴 진입 |
| `* → draining` | heartbeat 갱신 시 `pod_id ≠ me` | 강제 해제 감지. 저장 루틴 진입 |
| `draining → exit` | 저장 완료 | 처리 중이던 메시지를 세션 큐로 되돌림, 답변 키 삭제, `pod_id = NULL`, 미배정 신호, heartbeat 키 삭제, `exit 0` |

`draining`은 진입 경로(타이머, SIGTERM, 강제 해제 감지)와 무관하게 같은 저장 루틴을 타게 해 종료 경로를 하나로 모은다.

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
│   │   │   ├── persist.ts       # JSONL 업로드, git push
│   │   │   ├── heartbeat.ts
│   │   │   └── drain.ts         # 종료 루틴 (단일 경로)
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
│   ├── queue/                   # Redis Streams 래퍼. PoC에서는 Postgres 구현으로 교체 가능한 인터페이스
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
- Dockerfile은 루트 컨텍스트에서 빌드하고 `bun install --filter` 대신 워크스페이스 전체를 복사한 뒤 `--production`으로 정리(Bun은 filter 지원이 제한적)
- e2e는 `infra/docker-compose.yml`을 띄우고 `packages/contracts`의 스키마로 응답을 검증


---

## 9. Dockerfile

### 9.1 워커

```dockerfile
FROM oven/bun:1.2-debian AS base

# Claude Code CLI + 개발 도구
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates openssh-client build-essential python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -s /root/.local/bin/claude /usr/local/bin/claude

# 프로젝트별로 필요한 런타임은 여기에 추가 (예: node, go)
# RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY worker.ts ./
COPY claude-settings.json /root/.claude/settings.json   # permission defaults, env
COPY CLAUDE.md.template /app/

RUN useradd -m -u 1000 agent && mkdir -p /workspace && chown -R agent /workspace /root/.claude
USER agent
ENV HOME=/home/agent
RUN mkdir -p $HOME/.claude && cp /root/.claude/settings.json $HOME/.claude/ 2>/dev/null || true

VOLUME ["/workspace"]
ENTRYPOINT ["bun", "run", "/app/worker.ts"]
```

주요 환경변수(Secret으로 주입):

```
SDK_MODE=fake|real                       # 로컬 기본은 fake, 운영은 real (§10.0)
ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY   # LLM 엔드포인트. SDK_MODE=real일 때만 필요
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 # 서드파티 게이트웨이 사용 시
REDIS_URL, DATABASE_URL
S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
GIT_REMOTE_BASE, GIT_TOKEN
POD_ID   (fieldRef: metadata.name)
IDLE_TIMEOUT_SEC=1800, QUESTION_TIMEOUT_SEC=1800
```

### 9.2 API 서버

```dockerfile
FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
EXPOSE 3000
USER bun
CMD ["bun", "run", "src/server.ts"]
```

API 서버는 Claude CLI가 필요 없다. HPA는 CPU 또는 SSE 연결 수 기준.

### 9.3 reconciler

API 서버 이미지를 그대로 쓰고 `CMD ["bun", "run", "src/reconcile.ts"]`로 CronJob에 등록한다.

### 9.4 local-scaler (로컬 전용)

KEDA 대역이라 워커 컨테이너를 직접 띄우고, 그래서 docker CLI와 compose 플러그인이 필요하다. 둘 다 정적 바이너리라
공식 CLI 이미지에서 복사해 넣는다. 쿠버네티스에는 배포하지 않는다 — 거기서는 KEDA가 이 일을 한다(§7.2).

---

## 10. 로컬 개발 환경

목표: 쿠버네티스 없이 동일한 메시지 흐름과 pod 생명주기를 재현한다. 워커 "pod"는 docker compose의 컨테이너 하나로 대응하고, KEDA 대신 간단한 스케일러 스크립트가 `docker compose run`으로 워커를 띄운다.

### 10.0 외부 계정 없이 도는가 (94S-52)

**클론한 사람이 AWS 계정도, 쿠버네티스 클러스터도, LLM API 키도 없이 전체 흐름을 돌려볼 수 있어야 한다.** 없으면 "일단 키부터 받아오라"가 첫 장벽이 되고, 기여자와 신규 합류자가 거기서 멈춘다.

| 운영 의존 | 로컬 대체 | 계정 필요? |
|-----------|-----------|-----------|
| S3, Secrets Manager | LocalStack (94S-51) | 아니오 |
| RDS | Postgres 컨테이너 | 아니오 |
| GitHub | gitea 컨테이너 | 아니오 |
| ECR | 로컬 빌드, `kind load` | 아니오 |
| EKS | kind (94S-37) | 아니오 |
| KEDA ScaledJob | local-scaler(compose) / 실제 KEDA(kind) | 아니오 |
| **Anthropic API** | **fake SDK 모드** (94S-18) | **아니오 — 기본값이 fake다** |
| 알림 채널 | 로컬 관측 스택의 수신함 (94S-41) | 아니오 |

`ANTHROPIC_API_KEY`는 **선택**이다. 키가 없으면 fake SDK가 미리 정해진 응답 시퀀스를 재생하므로, 세션 생성 → 이벤트 스트림 → 권한 질문 → 답변 → 턴 종료 → 유휴 회수 → resume까지 전 경로를 그대로 체험할 수 있다. 실제 모델 출력이 필요할 때만 키를 넣는다.

fake를 e2e 전용으로 두지 않고 **로컬 기본값**으로 두는 이유는 두 가지다. 키 없이 시작할 수 있어야 하고, 개발 중 반복 실행이 과금되지 않아야 한다.

### 10.1 docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: sessions }
    ports: ["5432:5432"]
    volumes: ["./sql:/docker-entrypoint-initdb.d"]

  localstack:                  # S3 + Secrets Manager. 운영과 같은 AWS API (94S-51)
    image: localstack/localstack:3
    environment: { SERVICES: "s3,secretsmanager", AWS_DEFAULT_REGION: ap-northeast-1 }
    ports: ["4566:4566"]

  gitea:                       # 로컬 git remote. GitHub 토큰이 있으면 생략 가능
    image: gitea/gitea:1.22
    ports: ["3001:3000", "2222:22"]

  api:                         # /ui 세션 인스펙터도 여기서 서빙 (§10.5)
    build: { context: ., dockerfile: Dockerfile.api }
    ports: ["3000:3000"]
    env_file: .env
    depends_on: [postgres, localstack]

  worker:                      # 스케일러가 `docker compose run worker`로 띄움. 기본 0개
    build: { context: ., dockerfile: Dockerfile.worker }
    env_file: .env
    environment:
      POD_ID: "${POD_ID:-local-worker}"
    profiles: ["worker"]
    depends_on: [postgres, localstack]

  scaler:                      # KEDA 대체
    build: { context: ., dockerfile: Dockerfile.local-scaler }
    env_file: .env
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
    depends_on: [postgres]
```

Redis는 없다. PoC 큐 백엔드가 Postgres 단독이므로(§12.4, §14.1) 쓰지 않는 서비스를 띄우면 "Redis도 필요하다"는 오해가 굳는다.

스토리지는 원래 MinIO였고 한때 s3mock이었으나 LocalStack으로 바꿨다(94S-51). 이유는 운영 격차를 줄이는 것이다 — LocalStack은 S3와 Secrets Manager를 실제 AWS API로 제공하므로, 앱이 쓰는 SDK 호출 경로가 운영과 같아진다. s3mock은 S3만 흉내냈다. 운영에서는 실제 S3를 쓴다(§4.3).

`local-scaler.ts`는 5초마다 미배정 세션 수를 보고, 그 수가 실행 중 워커 수보다 많으면 `docker compose run -d --name worker-$(uuid) -e POD_ID=... worker`를 실행한다. 지표 계산은 KEDA가 읽을 값과 같은 함수를 쓴다(§7.2). 워커는 유휴 타이머 만료 시 스스로 종료하므로 컨테이너는 사라진다.

### 10.2 실행 순서

키도 계정도 없이 시작한다(§10.0).

```bash
cp .env.example .env            # 그대로 써도 된다. LLM은 fake 모드가 기본
./scripts/dev up                # 의존 서비스 → 마이그레이션 → api·scaler → 샘플 리포 (94S-36)

open http://localhost:3000/ui   # 세션 인스펙터 (§10.5)

# 세션 생성
curl -X POST localhost:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"repo_url":"http://gitea:3000/dev/sample.git","base_branch":"main","message":"README에 설치 방법 섹션을 추가해줘"}'
# → {"session_id":"..."}

# 이벤트 구독
curl -N localhost:3000/v1/sessions/<id>/events

# 후속 메시지
curl -X POST localhost:3000/v1/sessions/<id>/messages -d '{"message":"테스트도 추가해줘"}'

# 유휴 타이머를 짧게(IDLE_TIMEOUT_SEC=60) 두고 resume 검증
docker ps                       # 워커 컨테이너가 사라진 것 확인
curl -X POST localhost:3000/v1/sessions/<id>/messages -d '{"message":"이어서 진행해"}'
docker ps                       # 새 워커가 뜨고 같은 세션을 resume
```

### 10.3 어디서 무엇을 확인하는가

검증 환경은 세 단계다. **배포 전에 로컬에서 확인할 수 있는 것은 전부 로컬에서 확인한다.** 실클러스터에서만 볼 수 있는 것을 최소로 밀어내는 것이 이 표의 목적이다.

| 단계 | 환경 | 여기서 확인하는 것 |
|------|------|-------------------|
| 1 | docker compose | 메시지 라우팅, 매핑 획득, 이벤트 스트림, SSE 재접속, resume 왕복, 유휴 회수, heartbeat 소실 복구(`docker kill`), 질문·답변 왕복, 순서 보장, 클레임 경쟁, 헬스·레디니스 응답, 레이트 리밋·백프레셔, 비용 상한, 마이그레이션 적용과 롤백, 구조화 로그·메트릭 출력, 테넌트별 자격증명 분리 |
| 2 | kind + KEDA | ScaledJob이 실제로 Job을 만드는가, HPA 동작, NetworkPolicy가 egress를 막는가, gVisor 런타임 클래스가 무시되지 않는가, 매니페스트·overlay가 적용되는가, node drain 시 SIGTERM 경로, 마이그레이션 Job, 시크릿 주입 |
| 3 | 스테이징(EKS) | 실제 스팟 선점과 2분 알림 처리, 노드 이미지 pull 시간, 실부하에서의 스케일 동작, 알림 파이프라인 |

compose 구성은 §10.1, kind 구성은 `infra/kind/`에 둔다. kind에서는 워커 이미지를 `kind load docker-image`로 올리고, Postgres·스토리지·git remote는 compose 그대로 두고 `host.docker.internal`로 접근한다.

**두 단계 모두 명령 하나로 뜬다**(94S-36). 클러스터 계정 없이 쿠버네티스 경로를 그대로 밟아볼 수 있어야 2단계가 실제로 쓰인다.

```bash
./scripts/dev up          # 1단계: compose
./scripts/dev up --kind   # 2단계: kind + KEDA, 같은 매니페스트
```

### 10.4 로컬과 운영의 격차 (94S-37, 94S-51)

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
| OOM | 워커 메모리 한도를 낮춰 기동 | 위와 같은 사고 종료 경로 |
| node drain·롤링 업데이트 | kind에서 `kubectl drain` | SIGTERM 경로 |
| split-brain | `docker pause <worker>` 후 reconciler가 해제하게 두고 `unpause` | 구 워커의 쓰기가 거부됨(94S-44) |
| 메시지 순서 역전 시도 | 워커를 죽인 직후 메시지 두 개를 연속 전송 | 적재 순서대로 처리 |
| 클레임 경쟁 | 워커를 여러 개 동시 기동 | 정확히 하나만 클레임, 나머지는 스스로 종료 |
| 권한 대기와 타임아웃 | fake SDK가 툴 요청을 내도록 설정, `QUESTION_TIMEOUT_SEC`를 짧게 | `needs_input` 전이 → 타임아웃 시 deny |
| 예산 초과 | fake SDK의 `usage`를 크게 | 턴 중단, `failed` 전이(94S-43) |
| 큐 적체 | 스케일러를 멈추고 세션을 여러 개 생성 | 미배정 세션 수가 쌓이고, 스케일러 재개 시 해소 |
| DB 순단 | `docker stop postgres` 후 재기동 | `readyz` 실패 → 복구 후 정상화 |

이 표는 런북(94S-49)의 로컬 리허설 대상과 같은 목록이다. 운영에서 대응할 상황을 로컬에서 먼저 겪어보는 것이 목적이다.

### 10.7 단일 머신 대안: 에이전트 뷰 감독자 활용

컨트롤 플레인을 아직 만들기 전에 "여러 세션을 API로 다루는" 감을 잡고 싶다면, 한 머신에서 `claude --bg`, `claude agents --json`, `claude logs`, `claude stop`을 감싸는 얇은 HTTP 래퍼를 먼저 만들어 볼 수 있다. 감독자가 세션 프로세스 관리·유휴 회수·worktree 격리를 대신 해주므로 API 표면만 검증할 수 있다. 다만 후속 메시지 전달이 `attach` 경유라 API화가 어색하고, 다중 노드로 확장이 안 되므로 PoC 이후에는 본 설계로 옮긴다.

---

## 11. 운영

대상 환경은 AWS EKS다. 각 항목에 **로컬 확인 방법**을 함께 적는다 — 배포해봐야 아는 것을 최소로 남기기 위해서다(§10.3).

### 11.1 배포 (94S-46, 94S-39)

- **이미지**: ECR. Claude Code CLI 버전은 워커 이미지 태그로 고정한다. `latest` 설치는 재현 불가능한 워커를 만든다
- **승격**: 같은 다이제스트를 staging → prod로 올린다. 환경마다 다시 빌드하지 않는다
- **무중단**: 롤링 업데이트 시 워커는 SIGTERM 경로(§6.6)로 세션을 재큐잉하므로 진행 중 작업이 유실되지 않는다. API는 `readyz`(§5)로 교체 중 트래픽을 받지 않는다
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
- **테넌트 분리**: LLM 키와 git 자격증명을 세션 생성 시 테넌트별로 고른다. 단일 `GIT_TOKEN`(§9.1)은 모든 세션이 같은 권한으로 clone·push한다는 뜻이다
- *로컬 확인*: kind에서 NetworkPolicy가 허용 목록 밖 호스트를 실제로 막는지, gVisor 런타임 클래스가 조용히 무시되지 않는지 확인한다

### 11.5 데이터 (94S-39, 94S-49)

- **마이그레이션**: 배포 전 Job으로 적용한다. 앱 pod의 initContainer에서 돌리면 replica 수만큼 동시 실행된다. 롤백 가능한 변경만 배포하고, 파괴적 변경은 두 단계로 나눈다
- **백업**: Postgres는 자동 스냅샷과 PITR, S3는 버저닝. 세션의 실체가 트랜스크립트와 git 브랜치(§1.1)이므로 git remote도 복구 대상이다
- **복구 목표**: RPO·RTO를 정하고 복구 리허설을 한 번 한다
- *로컬 확인*: compose에서 마이그레이션 적용과 롤백을 리허설하고, 스냅샷에서 복원해 세션이 재개되는지 본다

### 11.6 콜드스타트 (94S-47)

워커 이미지가 크면(개발 도구 포함) 스팟 노드에서 매번 pull이 느리다. 노드 이미지 캐시, 슬림 베이스, 프로젝트별 레이어 분리로 대응한다. 프리웜은 현 구조로 동작하지 않는다(§12.3).

---

## 12. 결정 사항

구현하며 내린 결정이다. 각 항목은 되돌릴 수 있고, 바꾸려면 여기부터 고친다.

### 12.1 워크스페이스 영속화 — git 브랜치만

빌드 캐시는 스냅샷하지 않는다. `node_modules`는 lock 파일에서 재생성되므로 스토리지에 둘 이유가 약하고, 캐시를 스냅샷하면 "세션의 실체는 트랜스크립트와 코드뿐"(§1.1)이라는 전제가 깨진다. 재수화 비용이 실제로 문제가 되면 노드 레벨 캐시(§11 콜드스타트)로 먼저 대응한다.

### 12.2 질문 대기 타임아웃 — 기본 30분, 대기 중 pod는 유지

`QUESTION_TIMEOUT_SEC=1800`. 툴 실행 도중에는 resume이 불가능하므로(§6.4) 대기 중 pod를 내릴 수 없고, 30분은 사람이 알림을 보고 답하기에 충분하면서 잊힌 세션이 pod를 하루 종일 붙들지 않는 선이다. 타임아웃은 deny로 끝나고 세션은 유휴 타이머로 들어간다.

### 12.3 ScaledJob 채택

`pod-deletion-cost`는 스케일 인 대상을 *덜 나쁘게* 고르는 장치일 뿐 "실행 중인 세션을 죽이지 않는다"를 보장하지 못한다. §7.6의 원칙을 지키려면 애초에 쿠버네티스가 pod를 고르지 않아야 하므로 ScaledJob으로 확정한다.

**개정(v0.2):** 콜드스타트를 프리웜으로 줄인다는 부분은 철회한다. 고정 크기 Deployment의 프리웜 pod가 세션을 클레임해도 Deployment는 그것을 살아 있는 replica로 세므로 대기 pod가 0이 되고, 프리웜이 프리웜 역할을 하지 못한다. PoC 범위 밖으로 두고 콜드스타트는 §11의 노드 이미지 캐시와 이미지 슬림화로 먼저 대응한다.

### 12.4 큐 백엔드 — Postgres 기본, Redis 선택

기본은 Postgres: 저장소가 하나면 운영이 단순하고, PoC 규모에서 `SKIP LOCKED` 큐와 `LISTEN/NOTIFY` 깨우기로 충분하다. 이벤트 팬아웃이 병목이 되면 `QUEUE_BACKEND`만 바꿔 Redis로 옮긴다. 어느 쪽이든 세션 정본은 Postgres에 남는다(§7.7).

**개정(v0.2):** v0.1은 "둘 다 구현한다"고 썼는데 §14.1은 "Redis 구현은 인터페이스만 두고 스텁"으로 정해 서로 어긋났다. §14.1로 통일한다 — PoC에서 Redis 구현 본체는 쓰지 않는다.

`LISTEN/NOTIFY`는 이벤트의 저장소가 아니라 깨우기 수단이다. SSE 재개는 `events` 테이블(§4.1)에서 오고, NOTIFY 페이로드에 본문을 싣지 않는다(§5.1).

이 결정이 §7.2의 KEDA 트리거와 맞물린다. 현재 매니페스트는 `redis-streams` 트리거만 정의하므로, Postgres 백엔드로 클러스터에 올리려면 KEDA `postgresql` 스케일러로 바꾸거나 Redis 구현을 완성해야 한다. 배포 착수 전에 정한다.

### 12.5 인증 — API 키, owner는 키 단위

OIDC가 아니라 API 키다. 이 API의 클라이언트는 사람이 아니라 서비스(웹 UI 백엔드, Slack, CI)이고 어차피 장기 자격증명을 들고 있으며, 키는 IdP 없이도 세울 수 있다. OIDC가 필요해지면 인증은 미들웨어 한 곳이므로 그 자리를 바꾸면 된다.

- `Authorization: Bearer <key>`. 키는 `api_keys`에 SHA-256 해시로만 저장하고 발급 시 한 번만 보여준다
- owner 모델은 키 하나당 `owner_id` 하나. 세션은 소유자에게만 보이고, 남의 세션은 403이 아니라 **404**로 답한다 — 볼 수 없는 사람에게 id의 존재를 확인해주지 않기 위해서다
- `AUTH_MODE=none`은 로컬 개발용이며, 이때만 `X-Owner-Id` 헤더를 믿는다
- 키 관리는 API 이미지의 `keys.ts`로 한다(§9.3과 같은 방식)

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
- 체크포인트 직후 죽였을 때 트랜스크립트와 워크스페이스가 같은 지점을 가리키는가(§6.3.1)

이 테스트들은 CI에서 실행한다. v0.1 §14.2는 e2e를 "스크립트 작성 완료, 실행은 사용자 로컬"로 뒀는데, 결함이 몰려 있던 영역이 정확히 그 미검증 구간이었다.

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
| 워커 | `@anthropic-ai/claude-agent-sdk`. 상태 기계는 §7.8의 phase를 그대로 코드로. SDK 호출은 인터페이스로 감싸 테스트에서 fake로 대체 |
| 스토리지 | S3. 로컬은 LocalStack, 운영은 실제 S3. `@aws-sdk/client-s3` |
| 로컬 가시화 | `AUTH_MODE=none`일 때 API 서버가 `/ui`에 단일 페이지 서빙. 빌드 스텝·프레임워크 없음(§10.5) |
| 린트/포맷 | biome |
| 언어 | 커밋·PR·코드 주석은 영어. 문서와 사용자와의 대화는 한국어 |

### 14.2 마일스톤

각 마일스톤은 계획 제시 → 승인 → 구현 → `bun run check`(typecheck + lint + unit test) 통과 → 커밋 → 검증/미검증 보고 순으로 진행한다.

| 단계 | 범위 | 티켓 | 완료 조건 |
|------|------|------|-----------|
| M0 | 모노레포 골격, `packages/{contracts,db,queue,storage,observability}`, `infra/docker-compose.yml` | 94S-9, 94S-11, 94S-12, 94S-15, 94S-16, 94S-13, 94S-35, 94S-14 | 쿼리 함수 유닛 테스트 통과 |
| M1 | API 서버: 인증, `/sessions`, `/messages`, `/events`(SSE 재개), `/answers`, `/stop`·`/pin`·`DELETE`, 프로브 | 94S-17, 94S-38, 94S-21, 94S-26, 94S-22, 94S-23, 94S-27 | 라우팅 분기 테스트 통과 |
| M2 | 워커: §6.2 기동, §6.3 턴 처리, §6.4 `canUseTool`↔answers, §6.3.1 체크포인트, §6.5 유휴 타이머, §6.6 SIGTERM drain | 94S-19, 94S-18, 94S-24, 94S-28, 94S-29, 94S-30 | §7.8 전이표의 모든 전이가 코드에 대응, drain은 단일 경로 |
| M3 | reconciler(§7.4), local-scaler(§10), LocalStack 전환, 계정 없는 기본 모드, 세션 인스펙터, 원커맨드 기동, 장애 재현 레시피 | 94S-20, 94S-25, 94S-51, 94S-52, 94S-50, 94S-36, 94S-53 | 고아 매핑 정리 테스트 통과. **외부 계정 하나 없이** 브라우저에서 세션 생명주기와 장애 복구를 관찰 가능 |
| M4 | e2e: docker compose 위에서 §13 시나리오 1~5와 동시성 회귀 테스트 자동화, SDK는 fake 모드 | 94S-32, 94S-33 | **CI(GitHub Actions)에서 전체 통과.** 초록 체크가 아니라 `gh run view <id> --log`의 실제 로그로 확인 |
| M5 | Dockerfile(§9), `infra/k8s/base`와 overlays, kind 검증. 착수 전 KEDA 트리거 백엔드 확정(§12.4) | 94S-31, 94S-34, 94S-37 | 이미지 빌드 성공, kind + KEDA에서 세션 생성 시 Job이 실제로 생성 |

M0~M5는 §15의 로컬 트랙이다. 배포 트랙(§16.2)은 이 마일스톤 밖이고, 각 티켓이 §10.3의 1~2단계에서 먼저 확인한 뒤 클러스터로 간다.

### 14.3 제약

- 실행 환경에서 docker나 Postgres를 띄울 수 없으면 우회하지 말고 해당 검증을 "미검증"으로 명시하고 진행한다. 유닛 테스트는 pglite로 대체 가능
- 실제 Anthropic API를 호출하지 않는다. SDK 관련 코드는 fake 구현으로 테스트
- 회사 시스템명이나 내부 URL을 저장소에 넣지 않는다
- 새 의존성 추가 시 이유를 커밋 메시지 또는 PR 본문에 한 줄 남긴다
- 문서에서 벗어나는 결정이 필요하면 구현 전에 사용자에게 묻는다

### 14.4 시작 절차

1. 이 문서를 끝까지 읽는다
2. 문서 내 모순이나 구현 시 결정이 필요한 지점(§12 포함)을 목록으로 제시한다 — v0.2 개정이 이 단계의 결과이며, 남은 미결 항목은 §6.4(툴 실행 중 resume 동작, 94S-8)와 §12.4(KEDA 트리거 백엔드, 94S-10) 둘이다
3. 작업 단위와 의존관계는 §16에 있다. M0 계획을 제안하고 승인을 기다린다

---

## 15. 완성 정의

작업을 **로컬 트랙**과 **배포 트랙**으로 나눈다. 나누는 기준은 컴포넌트가 아니라 "무엇을 증명하는가"다.

- 로컬 트랙: 시스템이 **설계대로 동작하는가**
- 배포 트랙: 시스템이 **운영을 견디는가**

두 트랙은 순차가 아니다. 배포 트랙의 항목도 대부분 로컬에서 먼저 확인하고(§10.3), 클러스터에는 이미 확인된 것을 올린다.

### 15.1 게이트

| 게이트 | 통과 조건 | 티켓 | 그 다음 |
|--------|-----------|------|---------|
| G1 — 설계 확정 | 문서 내 모순 해소, 미결 항목이 조사로 닫힘 | 94S-7, 94S-8, 94S-10 | 구현 착수 |
| G2 — 로컬 동작 | §13의 시나리오와 동시성 회귀가 compose 위에서 CI 통과 | 94S-32, 94S-33 | 클러스터 매니페스트 작성 |
| G3 — 로컬 클러스터 | kind에서 KEDA·NetworkPolicy·gVisor·overlay가 실제로 동작 | 94S-34, 94S-37 | 스테이징 배포 |
| G4 — 운영 준비 | §15.3 체크리스트 전부 | §16.2 전체 | 프로덕션 |

G2를 통과하지 못한 채 G3로 넘어가면, 클러스터 문제와 애플리케이션 문제가 섞여 원인을 가릴 수 없게 된다.

### 15.2 로컬 트랙 완료 조건

- `bun run check`가 전 워크스페이스에서 통과 (94S-9)
- `docker compose up` 한 번으로 전체 스택이 뜨고, 문서만 보고 처음부터 따라할 수 있다 (94S-14, 94S-36)
- §13의 시나리오 5종이 CI에서 자동 통과 (94S-32)
- 동시성 회귀 테스트가 CI에서 반복 통과 (94S-33)
- 세션 하나를 돌렸을 때 구조화 로그·메트릭·트레이스가 전부 나온다 (94S-35, 94S-41)
- 마이그레이션 적용과 롤백을 로컬에서 리허설했다 (94S-39)
- 세션 인스펙터에서 세션·워커·큐 현황과 이벤트 타임라인을 볼 수 있다 (94S-50)
- 로컬 AWS 의존이 LocalStack이라 SDK 호출 경로가 운영과 같다 (94S-51)
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

Linear 팀 `94soon`. 부모 이슈는 [94S-6](https://linear.app/94soon/issue/94S-6)이고 아래가 그 자식 47개다. **의존관계는 Linear의 blocked-by 관계가 정본이며**, 아래 표는 읽기 편하도록 옮겨 적은 것이다. 둘이 어긋나면 Linear가 맞다.

문서의 다른 절에 붙은 `(94S-NN)`은 이 표를 가리킨다.

### 16.1 로컬 트랙

**설계 확정 (G1)**

| 티켓 | 내용 | 선행 |
|------|------|------|
| [94S-7](https://linear.app/94soon/issue/94S-7) | 큐 레이어 세션 단위 단일 큐 재설계, 문서 개정 | — |
| [94S-8](https://linear.app/94soon/issue/94S-8) | [조사] 툴 실행 도중 중단된 세션의 resume 동작 실측 (§6.4) | — |
| [94S-10](https://linear.app/94soon/issue/94S-10) | [조사] Postgres 백엔드용 KEDA 스케일 트리거 결정 (§12.4) | 94S-7 |

**기반 패키지**

| 티켓 | 내용 | 선행 |
|------|------|------|
| [94S-9](https://linear.app/94soon/issue/94S-9) | 모노레포 골격과 `bun run check` (§8) | — |
| [94S-11](https://linear.app/94soon/issue/94S-11) | `packages/contracts` zod 스키마 (§5, §5.1) | 94S-7, 94S-9 |
| [94S-12](https://linear.app/94soon/issue/94S-12) | `packages/db` 스키마·마이그레이션 (§4.1) | 94S-7, 94S-9 |
| [94S-15](https://linear.app/94soon/issue/94S-15) | 클레임·해제·상태 전이 쿼리 (§7.5, §7.8, §7.9) | 94S-12 |
| [94S-16](https://linear.app/94soon/issue/94S-16) | `packages/queue` 인터페이스와 Postgres 구현 (§4.2, §12.4) | 94S-11, 94S-12 |
| [94S-13](https://linear.app/94soon/issue/94S-13) | `packages/storage` JSONL·git 영속화 (§4.3, §6.3.1) | 94S-9 |
| [94S-35](https://linear.app/94soon/issue/94S-35) | `packages/observability` 구조화 로거 (§11.2) | 94S-9, 94S-11 |
| [94S-14](https://linear.app/94soon/issue/94S-14) | 로컬 의존 서비스 docker-compose (§10.1) | 94S-9 |

**API 서버**

| 티켓 | 내용 | 선행 |
|------|------|------|
| [94S-17](https://linear.app/94soon/issue/94S-17) | Hono 골격과 API 키 인증 (§12.5) | 94S-11, 94S-14, 94S-15 |
| [94S-38](https://linear.app/94soon/issue/94S-38) | 헬스·레디니스 프로브 (§5) | 94S-17 |
| [94S-21](https://linear.app/94soon/issue/94S-21) | 세션 생성·목록·상세 (§5, F1·F7) | 94S-16, 94S-17 |
| [94S-26](https://linear.app/94soon/issue/94S-26) | 후속 메시지와 세션 큐 라우팅 (§7.1, F3·F5) | 94S-21 |
| [94S-22](https://linear.app/94soon/issue/94S-22) | SSE 스트림과 `Last-Event-ID` 재개 (§5.1, F2) | 94S-16, 94S-17 |
| [94S-23](https://linear.app/94soon/issue/94S-23) | 답변 엔드포인트, `request_id` 상관관계 (§6.4, F4) | 94S-16, 94S-17 |
| [94S-27](https://linear.app/94soon/issue/94S-27) | 중단·고정·삭제 (§5, §7.5, F7) | 94S-21 |

**워커**

| 티켓 | 내용 | 선행 |
|------|------|------|
| [94S-19](https://linear.app/94soon/issue/94S-19) | phase 상태 기계·heartbeat·클레임·미클레임 종료 (§6.2, §7.8) | 94S-13, 94S-15, 94S-16 |
| [94S-18](https://linear.app/94soon/issue/94S-18) | Agent SDK 어댑터와 fake (§14.1) | 94S-11 |
| [94S-24](https://linear.app/94soon/issue/94S-24) | 턴 처리 루프와 이벤트 발행 (§6.3) | 94S-18, 94S-19 |
| [94S-28](https://linear.app/94soon/issue/94S-28) | `canUseTool` ↔ answers 왕복 (§6.4) | 94S-8, 94S-23, 94S-24 |
| [94S-29](https://linear.app/94soon/issue/94S-29) | 체크포인트 한 쌍 영속화 (§6.3.1) | 94S-13, 94S-24 |
| [94S-30](https://linear.app/94soon/issue/94S-30) | 유휴 타이머와 단일 drain 경로 (§6.5, §6.6) | 94S-24, 94S-29 |

**보조 컴포넌트와 검증 (G2)**

| 티켓 | 내용 | 선행 |
|------|------|------|
| [94S-20](https://linear.app/94soon/issue/94S-20) | reconciler 고아 매핑 정리 (§7.4) | 94S-15, 94S-16 |
| [94S-25](https://linear.app/94soon/issue/94S-25) | local-scaler (§9.4, §10) | 94S-14, 94S-19 |
| [94S-51](https://linear.app/94soon/issue/94S-51) | 로컬 AWS 의존을 LocalStack으로 통일 (§10.1, §10.4) | 94S-13, 94S-14 |
| [94S-52](https://linear.app/94soon/issue/94S-52) | 외부 계정 없이 도는 로컬 기본 모드 (§10.0) | 94S-18, 94S-24, 94S-51 |
| [94S-50](https://linear.app/94soon/issue/94S-50) | 세션 인스펙터 UI (§10.5) | 94S-21, 94S-22, 94S-23 |
| [94S-36](https://linear.app/94soon/issue/94S-36) | 원커맨드 기동(compose·kind)과 온보딩 문서 (§10.2, §15.2) | 94S-14, 94S-25, 94S-38 |
| [94S-53](https://linear.app/94soon/issue/94S-53) | 운영 장애 상황 로컬 재현 레시피 (§10.6) | 94S-33, 94S-50, 94S-52 |
| [94S-32](https://linear.app/94soon/issue/94S-32) | PoC 시나리오 5종 e2e, CI 실행 (§13) | 94S-20, 94S-22, 94S-23, 94S-25, 94S-26, 94S-30 |
| [94S-33](https://linear.app/94soon/issue/94S-33) | 동시성 회귀 테스트 (§13) | 94S-32 |

**클러스터 매니페스트와 로컬 검증 (G3)**

| 티켓 | 내용 | 선행 |
|------|------|------|
| [94S-31](https://linear.app/94soon/issue/94S-31) | Dockerfile 3종 (§9) | 94S-17, 94S-19 |
| [94S-34](https://linear.app/94soon/issue/94S-34) | 쿠버네티스 매니페스트와 overlay (§7.2, §6.7) | 94S-10, 94S-31, 94S-33, 94S-38 |
| [94S-37](https://linear.app/94soon/issue/94S-37) | kind에서 KEDA·NetworkPolicy·gVisor 실동작 검증 (§10.3) | 94S-34 |

94S-37은 **머지 전 게이트**다. compose 경로에는 매니페스트가 등장하지 않으므로(§10.4), 이것을 통과하지 않은 변경은 클러스터로 가지 않는다.

### 16.2 배포 트랙 (G4)

전부 §10.3의 1~2단계에서 먼저 확인한다. 각 티켓에 "로컬 확인" 인수 조건이 붙어 있다.

| 티켓 | 내용 | 선행 | 근거 |
|------|------|------|------|
| [94S-39](https://linear.app/94soon/issue/94S-39) | 마이그레이션 배포 전략과 롤백 | 94S-12, 94S-31 | §11.5 |
| [94S-40](https://linear.app/94soon/issue/94S-40) | EKS 시크릿 주입(IRSA·Secrets Manager) | 94S-34 | §11.4 |
| [94S-41](https://linear.app/94soon/issue/94S-41) | 메트릭·트레이싱 수집기, 로컬 관측 스택 | 94S-24, 94S-35 | §11.2 |
| [94S-48](https://linear.app/94soon/issue/94S-48) | SLO와 알림 임계치 | 94S-41 | §11.2 |
| [94S-42](https://linear.app/94soon/issue/94S-42) | 레이트 리밋·세션 수 상한·백프레셔 | 94S-17, 94S-21 | §11.3 |
| [94S-43](https://linear.app/94soon/issue/94S-43) | 세션 토큰·비용 상한 집행 | 94S-24 | §11.3 |
| [94S-44](https://linear.app/94soon/issue/94S-44) | 클레임 fencing token | 94S-15, 94S-19 | §7.4, §7.9 |
| [94S-45](https://linear.app/94soon/issue/94S-45) | 테넌트별 LLM·git 자격증명 분리 | 94S-19, 94S-21 | §11.4 |
| [94S-46](https://linear.app/94soon/issue/94S-46) | CD 파이프라인, 이미지 승격 | 94S-31, 94S-34, 94S-39 | §11.1 |
| [94S-47](https://linear.app/94soon/issue/94S-47) | 스팟 노드 풀과 선점 복구 스테이징 검증 | 94S-34, 94S-37, 94S-46 | §11.6, N2·N4 |
| [94S-49](https://linear.app/94soon/issue/94S-49) | 운영 런북과 백업·복구 | 94S-47, 94S-48, 94S-53 | §11.5, §15.3 |

### 16.3 최장 경로

```
94S-7 → 94S-9 → 94S-12 → 94S-15 → 94S-19 → 94S-24 → 94S-29
      → 94S-30 → 94S-32 → 94S-33 → 94S-34 → 94S-37 → 94S-46
      → 94S-47 → 94S-49
```

이 사슬이 일정의 하한이다. 94S-8과 94S-10은 사슬 밖이지만 각각 94S-28과 94S-34를 막으므로 일찍 닫는다.

94S-38(프로브)은 작지만 94S-34와 94S-36 둘을 막는다. 매니페스트에 liveness·readiness를 걸려면 엔드포인트가 먼저 있어야 하고, 기동 스크립트의 준비 대기도 `readyz`를 폴링한다.

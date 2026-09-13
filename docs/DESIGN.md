# Claude Code 세션 컨트롤 플레인 설계안

> 상태: Draft v0.1 · 작성일: 2026-09-12
> 범위: HTTP API로 Claude Code 세션을 생성·재개·관찰하고, Kubernetes 위에서 세션 워커를 수평 확장하는 시스템

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
| 오브젝트 스토리지 | 트랜스크립트 JSONL, 워크스페이스 스냅샷 | S3 호환(MinIO, S3, GCS) |
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
```

`sessions_pod_uniq` 인덱스가 "pod 하나에 세션 하나"를 DB 수준에서 강제한다.

### 4.2 Redis 키

| 키 | 타입 | 용도 |
|----|------|------|
| `queue:unassigned` | Stream | 매핑 없는 세션의 메시지. KEDA 스케일 지표 |
| `queue:pod:{pod_id}` | Stream | 해당 pod에 매핑된 세션의 메시지 |
| `events:{session_id}` | Stream | 워커가 발행하는 SDK 메시지. SSE 소스. `MAXLEN ~10000` |
| `answer:{session_id}` | List | 질문·권한 요청에 대한 답변. 워커가 `BLPOP` |
| `heartbeat:{pod_id}` | String, TTL 30s | 워커 생존 리스 |

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
| GET | `/sessions/{id}/transcript` | `?after_uuid` | `[{normalized message}]` | JSONL 정규화 이력 |
| POST | `/sessions/{id}/stop` | | `202` | 현재 턴 중단 |
| POST | `/sessions/{id}/pin` | `{pinned: bool}` | `204` | 유휴 회수 제외 |
| DELETE | `/sessions/{id}` | | `204` | pod·브랜치·스토리지 정리 |

### 5.1 SSE 이벤트 형식

`events:{session_id}` 스트림의 각 엔트리를 그대로 SSE로 내려보낸다. Redis 엔트리 ID를 SSE `id`로 쓴다.

```
id: 1726100000000-0
event: assistant
data: {"type":"assistant","message":{...}}

id: 1726100000001-0
event: tool_use
data: {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}

id: 1726100000002-0
event: question
data: {"request_id":"q_01","kind":"permission","tool":"Bash","input":{...}}

id: 1726100000003-0
event: result
data: {"type":"result","subtype":"success","session_id":"...","usage":{...}}
```

이벤트 종류: `system` · `assistant` · `tool_use` · `tool_result` · `question` · `result` · `status`(상태 전이 알림) · `error`.

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
2. `queue:unassigned`에서 메시지 하나를 `XREADGROUP`으로 집음
3. Postgres에서 매핑 획득
   ```sql
   UPDATE sessions SET pod_id = $pod, status = 'running'
   WHERE id = $session AND pod_id IS NULL RETURNING *;
   ```
   실패(다른 pod가 선점)하면 메시지를 ACK하고 2로 돌아감
4. 스토리지에서 `transcript.jsonl`을 `~/.claude/projects/<hash>/`에 복원, `git clone --branch session/{id}`
5. 획득한 세션의 나머지 대기 메시지를 `queue:pod:{pod_id}`로 옮김
6. 이후 `queue:pod:{pod_id}`만 소비

5번이 없으면 클레임 이전에 `queue:unassigned`에 쌓인 같은 세션의 메시지가 고아가 된다. 매핑된 세션의 메시지는 다른 워커가 집어도 클레임에 실패할 뿐이고, 소유 워커는 자기 큐만 보기 때문이다.

### 6.3 턴 처리

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

async function* inbox(sessionId: string) {
  // queue:pod:{pod_id}에서 이 세션의 메시지를 순서대로 yield
  for await (const msg of consumePodQueue()) {
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
      const answer = await blpop(`answer:${sessionId}`, TIMEOUT_SEC);
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
    await onTurnEnd(sessionId);             // JSONL 업로드, git push, status=idle, 유휴 타이머 시작
  }
}
```

턴 중에도 60초마다 JSONL을 스토리지에 동기화해 비정상 종료 시 손실을 줄인다.

### 6.4 질문·권한 요청 처리

`canUseTool` 콜백은 툴 실행 직전에 블로킹된다. 툴 호출 도중에는 resume이 불가능하므로 대기 중에는 pod가 살아 있어야 한다. 정책:

- 타임아웃 기본 30분. 넘으면 deny 후 턴을 `needs_input`으로 종료하고 유휴 타이머 진입
- 자주 묻는 툴은 `allowedTools`로 사전 허용하고, 안전은 샌드박스(§6.7)로 확보
- `AskUserQuestion` 툴도 같은 경로로 처리(kind: `question`)

### 6.5 턴 종료와 유휴 회수

턴 종료(`result` 수신) 시:

1. JSONL 업로드, `git add -A && git commit && git push`
2. `status = idle`, `last_turn_at = now()`
3. 유휴 타이머 시작(기본 30분, `pinned`면 무한)

타이머 만료 시: 매핑 삭제(`pod_id = NULL`) → 프로세스 종료 → pod 종료. 개발 서버가 떠 있는 세션은 `pinned` 또는 긴 타이머로 회수를 미룬다. 회수 후 재개 시 개발 서버는 다시 띄워야 하므로, CLAUDE.md에 "작업 시작 시 서버 상태를 확인하고 필요하면 기동" 규칙을 둔다.

### 6.6 종료 처리(SIGTERM)

`terminationGracePeriodSeconds: 120`. SIGTERM 수신 시:

1. 실행 중인 `query`를 abort
2. JSONL 업로드, `git push`
3. 처리 중이던 메시지와 `queue:pod:{pod_id}`에 남은 메시지를 `queue:unassigned` 앞쪽으로 재삽입
4. `pod_id = NULL`, `status = queued`
5. 종료

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
  → sessions.pod_id 조회
  → pod_id 있고 heartbeat:{pod_id} 존재  → XADD queue:pod:{pod_id}
  → 그 외                                → pod_id = NULL, XADD queue:unassigned
```

매핑된 세션의 메시지는 `queue:unassigned`를 거치지 않으므로 스케일 지표를 오염시키지 않는다.

### 7.2 스케일 아웃

KEDA ScaledJob이 `queue:unassigned`의 pending 길이를 본다. 미배정 메시지 1개당 pod 1개. `minReplicaCount`는 두지 않고 대신 별도 "프리웜" 잡을 1~2개 유지해 콜드스타트를 줄인다(에이전트 뷰의 사전 준비 워커와 같은 발상).

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
    - type: redis-streams
      metadata:
        address: redis:6379
        stream: queue:unassigned
        consumerGroup: workers
        pendingEntriesCount: "1"
```

ScaledJob을 쓰는 이유: Deployment는 pod가 스스로 종료하면 즉시 대체 pod를 띄우고, 스케일 인 시 어떤 pod를 죽일지 KEDA가 고른다. Job은 워커가 종료하면 그걸로 끝이라 "유휴 pod가 스스로 나간다"는 모델과 맞는다.

### 7.3 스케일 인

워커 주도. §6.5의 유휴 타이머 만료로 pod가 스스로 종료한다. KEDA는 pod를 죽이지 않는다.

### 7.4 생존 감시와 고아 정리

- 워커: `SET heartbeat:{pod_id} 1 EX 30`을 10초마다
- API: 라우팅 전 heartbeat 확인, 없으면 매핑 삭제 후 미배정 큐로
- reconciler(CronJob, 1분): `pod_id IS NOT NULL`인 세션 중 heartbeat 없는 것을 일괄 정리하고, `queue:pod:{pod_id}`에 남은 메시지를 `queue:unassigned`로 이동

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
| heartbeat 소실 | 삭제(API/reconciler) | 이미 없음 |
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
| `claiming → running` | DB UPDATE 성공 | JSONL·repo 복원, `queue:pod:{me}` 소비로 전환. 실패면 `claiming` 유지 |
| `running → waiting` | `canUseTool` 진입 | `question` 발행, `status = needs_input`, `BLPOP answer:{id}` |
| `waiting → running` | 답변 도착 | `status = running`, 툴 실행 계속. 타임아웃이면 deny 후 턴 종료 |
| `running → idle` | `result` 수신 | JSONL 업로드, git push, `status = idle`, 타이머 시작 |
| `idle → running` | `queue:pod:{me}` 메시지 | 타이머 취소, 다음 턴 시작 |
| `idle → draining` | 타이머 만료 | 저장 루틴 진입 |
| `* → draining` | SIGTERM | `currentTurn.abort()`, 저장 루틴 진입 |
| `draining → exit` | 저장 완료 | `pod_id = NULL`, 큐 잔여분을 `unassigned`로 재삽입, heartbeat 키 삭제, `exit 0` |

`draining`은 진입 경로(타이머, SIGTERM, 강제 해제 감지)와 무관하게 같은 저장 루틴을 타게 해 종료 경로를 하나로 모은다.

### 7.9 어긋남과 복구

| 어긋남 | 감지 | 복구 |
|--------|------|------|
| 매핑 있음, heartbeat 없음 | API 라우팅 시, reconciler 1분 주기 | 매핑 삭제, 세션 `queued`, `queue:pod:{id}` 잔여분을 `unassigned`로 |
| pod 살아 있음, 매핑 없음 | 워커가 heartbeat 갱신 시 `pod_id = $me` 재확인 | reconciler가 강제 해제한 것이므로 워커는 즉시 `draining` |
| 같은 세션에 pod 두 개 | 발생 불가 | `sessions_pod_uniq` + `WHERE pod_id IS NULL` 조건이 원자적으로 차단 |
| 턴 도중 pod 소실 | heartbeat 소실 | 마지막 60초 주기 JSONL 동기화 지점에서 resume, 진행 중 메시지 재큐잉 |

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
│   │   │   └── router.ts        # pod_id 조회 → 큐 선택 (§7.1)
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
│   └── observability/           # 로거, 트레이싱 export
├── infra/
│   ├── k8s/
│   │   ├── base/                # api Deployment+HPA, worker ScaledJob, reconciler CronJob, NetworkPolicy
│   │   └── overlays/{local,staging,prod}/
│   ├── docker-compose.yml       # §10
│   └── kind/                    # kind 클러스터 설정 + KEDA 설치 스크립트
├── docs/
│   └── design.md                # 이 문서
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
- `packages/queue`는 인터페이스(`enqueue`, `consume`, `publish`, `subscribe`, `lease`)만 노출하고 Redis·Postgres 구현을 뒤에 둔다. §3.2의 "PoC는 Postgres 단독" 결정이 이 경계 덕에 앱 코드 변경 없이 가능하다

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
ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY   # LLM 엔드포인트
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

### 10.1 docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: sessions }
    ports: ["5432:5432"]
    volumes: ["./sql:/docker-entrypoint-initdb.d"]

  redis:
    image: redis:7
    ports: ["6379:6379"]

  s3:                          # S3 호환 스토리지. 버킷은 기동 시 스스로 만든다
    image: adobe/s3mock:4.9.0
    environment: { COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS: claude-sessions }
    ports: ["9000:9090"]

  gitea:                       # 로컬 git remote. GitHub 토큰이 있으면 생략 가능
    image: gitea/gitea:1.22
    ports: ["3001:3000", "2222:22"]

  api:
    build: { context: ., dockerfile: Dockerfile.api }
    ports: ["3000:3000"]
    env_file: .env
    depends_on: [postgres, redis, s3]

  worker:                      # 스케일러가 `docker compose run worker`로 띄움. 기본 0개
    build: { context: ., dockerfile: Dockerfile.worker }
    env_file: .env
    environment:
      POD_ID: "${POD_ID:-local-worker}"
    profiles: ["worker"]
    depends_on: [postgres, redis, s3]

  scaler:                      # KEDA 대체
    build: { context: ., dockerfile: Dockerfile.api }
    command: bun run src/local-scaler.ts
    env_file: .env
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
    depends_on: [redis]
```

스토리지는 원래 MinIO였으나 서버 이미지가 Docker Hub에서 더 이상 받아지지 않아 s3mock으로 바꿨다. 워커가 쓰는 S3 API(put/get/head/list/delete)는 그대로이고, 버킷을 스스로 만들므로 초기화 컨테이너가 필요 없다. 운영에서는 실제 S3·GCS를 쓴다(§4.3).

`local-scaler.ts`는 5초마다 `XPENDING queue:unassigned`를 보고, pending 수 > 실행 중 워커 수이면 `docker compose run -d --name worker-$(uuid) -e POD_ID=... worker`를 실행한다. 워커는 유휴 타이머 만료 시 스스로 종료하므로 컨테이너는 사라진다.

### 10.2 실행 순서

```bash
cp .env.example .env            # ANTHROPIC_BASE_URL 등 채우기
docker compose up -d postgres redis s3 gitea
docker compose up -d api scaler

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

### 10.3 쿠버네티스 없이 확인할 수 있는 것 / 없는 것

| 확인 가능 | 확인 불가(kind/k3d 필요) |
|-----------|--------------------------|
| 메시지 라우팅, 매핑 획득, 이벤트 스트림, SSE 재접속 | KEDA ScaledJob 동작, gVisor 런타임 |
| resume 왕복, 유휴 회수, heartbeat 소실 복구(`docker kill`) | 스팟 선점, node drain, NetworkPolicy |
| 질문·답변 왕복 | HPA |

쿠버네티스까지 로컬에서 보고 싶으면 `kind` 클러스터에 KEDA를 설치하고 §7.2 매니페스트를 그대로 적용한다. 이때는 워커 이미지를 `kind load docker-image`로 올리고, 스토리지·Redis·Postgres는 compose 그대로 두고 `host.docker.internal`로 접근한다.

### 10.4 단일 머신 대안: 에이전트 뷰 감독자 활용

컨트롤 플레인을 아직 만들기 전에 "여러 세션을 API로 다루는" 감을 잡고 싶다면, 한 머신에서 `claude --bg`, `claude agents --json`, `claude logs`, `claude stop`을 감싸는 얇은 HTTP 래퍼를 먼저 만들어 볼 수 있다. 감독자가 세션 프로세스 관리·유휴 회수·worktree 격리를 대신 해주므로 API 표면만 검증할 수 있다. 다만 후속 메시지 전달이 `attach` 경유라 API화가 어색하고, 다중 노드로 확장이 안 되므로 PoC 이후에는 본 설계로 옮긴다.

---

## 11. 운영 고려사항

- **콜드스타트**: 워커 이미지가 크면(개발 도구 포함) 스팟 노드에서 매번 pull이 느리다. 노드 이미지 캐시, 프리웜 잡, 슬림 베이스 + 프로젝트별 레이어 분리로 대응
- **관측**: 이벤트 스트림을 그대로 Langfuse 등 트레이싱 백엔드로도 보내면 세션 단위 비용·토큰 집계가 된다. `result` 메시지의 `usage`를 `turns.result_json`에 저장
- **비용**: 유휴 타이머와 `pinned` 세션 수가 pod 상주 비용을 결정한다. 타이머 기본값은 실제 사용 패턴 보고 조정
- **버전 업그레이드**: Claude Code CLI 버전은 워커 이미지 태그로 고정. 롤링 업데이트 시 SIGTERM 경로로 세션이 재큐잉되므로 무중단
- **다중 테넌시**: `owner_id`별 세션 수 제한, LLM 키를 테넌트별로 분리하려면 Secret을 세션 생성 시 선택

---

## 12. 결정 사항

구현하며 내린 결정이다. 각 항목은 되돌릴 수 있고, 바꾸려면 여기부터 고친다.

### 12.1 워크스페이스 영속화 — git 브랜치만

빌드 캐시는 스냅샷하지 않는다. `node_modules`는 lock 파일에서 재생성되므로 스토리지에 둘 이유가 약하고, 캐시를 스냅샷하면 "세션의 실체는 트랜스크립트와 코드뿐"(§1.1)이라는 전제가 깨진다. 재수화 비용이 실제로 문제가 되면 노드 레벨 캐시(§11 콜드스타트)로 먼저 대응한다.

### 12.2 질문 대기 타임아웃 — 기본 30분, 대기 중 pod는 유지

`QUESTION_TIMEOUT_SEC=1800`. 툴 실행 도중에는 resume이 불가능하므로(§6.4) 대기 중 pod를 내릴 수 없고, 30분은 사람이 알림을 보고 답하기에 충분하면서 잊힌 세션이 pod를 하루 종일 붙들지 않는 선이다. 타임아웃은 deny로 끝나고 세션은 유휴 타이머로 들어간다.

### 12.3 ScaledJob 채택

`pod-deletion-cost`는 스케일 인 대상을 *덜 나쁘게* 고르는 장치일 뿐 "실행 중인 세션을 죽이지 않는다"를 보장하지 못한다. §7.6의 원칙을 지키려면 애초에 쿠버네티스가 pod를 고르지 않아야 하므로 ScaledJob으로 확정한다. 콜드스타트는 §7.2의 프리웜으로 줄인다 — 프리웜만 고정 크기 Deployment인데, 오토스케일러가 붙지 않아 회수 대상을 고르는 주체가 없기 때문이다.

### 12.4 큐 백엔드 — Postgres 기본, Redis 선택

둘 다 구현한다(`QUEUE_BACKEND`). 기본은 Postgres: 저장소가 하나면 운영이 단순하고, PoC 규모에서 `SKIP LOCKED`와 `LISTEN/NOTIFY`로 충분하다. 이벤트 팬아웃이 병목이 되면 환경변수만 바꿔 Redis로 옮긴다. 어느 쪽이든 세션 정본은 Postgres에 남는다(§7.7).

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
| 큐/이벤트 | PoC는 `packages/queue`의 Postgres 구현만 작성(`SKIP LOCKED` 큐, `LISTEN/NOTIFY` 이벤트, `last_seen` heartbeat). Redis 구현은 인터페이스만 두고 스텁 |
| 워커 | `@anthropic-ai/claude-agent-sdk`. 상태 기계는 §7.8의 phase를 그대로 코드로. SDK 호출은 인터페이스로 감싸 테스트에서 fake로 대체 |
| 스토리지 | S3 호환(MinIO), `@aws-sdk/client-s3` |
| 린트/포맷 | biome |
| 언어 | 커밋·PR·코드 주석은 영어. 문서와 사용자와의 대화는 한국어 |

### 14.2 마일스톤

각 마일스톤은 계획 제시 → 승인 → 구현 → `bun run check`(typecheck + lint + unit test) 통과 → 커밋 → 검증/미검증 보고 순으로 진행한다.

| 단계 | 범위 | 완료 조건 |
|------|------|-----------|
| M0 | 모노레포 골격, `packages/contracts`(§5, §5.1), `packages/db`(§4.1 스키마·마이그레이션·claim/release/transition 쿼리), `infra/docker-compose.yml`(§10.1) | 쿼리 함수 유닛 테스트 통과 |
| M1 | API 서버: `/sessions`, `/messages`, `/{id}`, `/events`(SSE, `Last-Event-ID` 재개), `/answers`, §7.1 라우팅 | 라우팅 분기 테스트 통과 |
| M2 | 워커: §6.2 기동, §6.3 턴 처리, §6.4 `canUseTool`↔answers, §6.5 유휴 타이머, §6.6 SIGTERM drain | §7.8 전이표의 모든 전이가 코드에 대응, drain은 단일 경로 |
| M3 | reconciler(§7.4), local-scaler(§10) | 고아 매핑 정리 테스트 통과 |
| M4 | e2e: docker compose 위에서 §13 시나리오 1~5 자동화, SDK는 fake 모드 | 시나리오 스크립트 작성 완료(실행은 사용자 로컬) |
| M5 | `infra/k8s/base`(api Deployment+HPA, worker ScaledJob §7.2, reconciler CronJob, NetworkPolicy), kustomize overlays, Dockerfile(§9) | 이미지 빌드 성공 |

### 14.3 제약

- 실행 환경에서 docker나 Postgres를 띄울 수 없으면 우회하지 말고 해당 검증을 "미검증"으로 명시하고 진행한다. 유닛 테스트는 pglite로 대체 가능
- 실제 Anthropic API를 호출하지 않는다. SDK 관련 코드는 fake 구현으로 테스트
- 회사 시스템명이나 내부 URL을 저장소에 넣지 않는다
- 새 의존성 추가 시 이유를 커밋 메시지 또는 PR 본문에 한 줄 남긴다
- 문서에서 벗어나는 결정이 필요하면 구현 전에 사용자에게 묻는다

### 14.4 시작 절차

1. 이 문서를 끝까지 읽는다
2. 문서 내 모순이나 구현 시 결정이 필요한 지점(§12 포함)을 목록으로 제시한다
3. M0 계획을 제안하고 승인을 기다린다

# OBS-SPIKE: 엔진 OTel 트레이스를 Langfuse와 Grafana LGTM으로 비교

스파이크 전용 경로다. 머지 대상이 아니다.

## 구성

```
worker 컨테이너
  Claude Code CLI ──OTLP/HTTP──> 127.0.0.1:4318 (worker 안 중계, apps/worker/src/otlp-relay.ts)
                                   └─absolute-form HTTP─> egress-proxy (forward 허용 목록 otel-collector:4318)
                                                            └─> otel-collector (앱 스택 compose project)
                                                                  ├─> Langfuse  /api/public/otel  (수집기 project)
                                                                  ├─> grafana/otel-lgtm :4318      (수집기 project)
                                                                  └─> file 덤프 spans.jsonl, logs.jsonl
```

- 앱 스택 overlay: `compose.app-otel.yml`(collector, egress 허용 목록 한 항목, scheduler의 텔레메트리 env)
- 수집기 overlay: `compose.collectors.yml`(Langfuse 공식 compose 위에 포트·이미지 고정, `TELEMETRY_ENABLED=false`, Grafana 분석·업데이트 확인 끔, `grafana/otel-lgtm`)
- collector 설정: `collector.yaml`

## env가 들어가는 곳

| 단계 | 위치 | 무엇 |
|---|---|---|
| scheduler 컨테이너 | `compose.app-otel.yml` `scheduler.environment` | `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_*`, `WORKER_OTLP_RELAY_UPSTREAM` |
| worker 컨테이너 | `packages/adapters/execution/local-docker/src/backend.ts` `telemetryEnvironmentFor` | scheduler env의 위 변수를 그대로, `OTEL_RESOURCE_ATTRIBUTES`에 `agent_platform.session_id`·`agent_platform.execution_id` 추가. `CLAUDE_CODE_ENABLE_TELEMETRY`가 없으면 아무것도 넣지 않는다 |
| CLI 프로세스 | `packages/adapters/runtimes/claude/src/profile.ts` `runtimeEnvironment` | worker env의 `OTEL_*`, `TRACEPARENT`·`TRACESTATE`, 텔레메트리 플래그 |
| 중계 | `apps/worker/src/main.ts` → `apps/worker/src/otlp-relay.ts` | `WORKER_OTLP_RELAY_UPSTREAM`이 있을 때만 127.0.0.1:4318에 뜬다 |

중계가 필요한 이유: CLI의 OTLP exporter는 평문 `http://` 엔드포인트에도 `HTTPS_PROXY`로 CONNECT 터널을 연다. egress-proxy는 CONNECT 안에 TLS만 통과시켜 `first record is not a TLS handshake`로 끊는다.

## 실행

1. 이미지: `orch heavy obs -- docker pull …`(compose 파일의 태그)
2. Langfuse 공식 compose를 고정 커밋에서 받는다.

   ```sh
   mkdir -p "$TMPDIR/obs-spike/langfuse-src"
   curl -sSfL -o "$TMPDIR/obs-spike/langfuse-src/docker-compose.yml" \
     https://raw.githubusercontent.com/langfuse/langfuse/29a40eb027c5f4bb8c72c2f6d2d7e98aa1ce0cbf/docker-compose.yml
   ```

3. 수집기 스택: `docker compose -p obs-spike-collectors -f "$TMPDIR/obs-spike/langfuse-src/docker-compose.yml" -f infra/spike/otel/compose.collectors.yml up -d --wait`
   - Langfuse 화면 `http://localhost:23000`, Grafana `http://localhost:23001`, Tempo API `http://127.0.0.1:23200`
   - 공식 compose의 기본 비밀값(`# CHANGEME`)을 그대로 쓴다. 루프백 전용 일회용 스택에서만 쓴다.
   - Langfuse에 가입하고 프로젝트와 API key를 만든다.
4. 앱 스택: `OBS_SPIKE_DUMP_DIR=<덤프 디렉터리> .claude/skills/verify-agent-platform/scripts/up.sh infra/spike/otel/compose.app-otel.yml`
5. collector에 Langfuse key를 넘긴다(파일에 쓰지 않는다): `LANGFUSE_BASIC_AUTH=$(printf '%s:%s' "$pk" "$sk" | base64)`를 붙여 `ap_compose up -d otel-collector`
6. 세션: `.claude/skills/verify-agent-platform/features/sessions.md`의 권한 요청 대본(Bash 도구 1회 + 권한 요청 1회)
   - 프롬프트·응답·도구 입력과 출력까지 보려면 `OBS_SPIKE_CONTENT=1`을 붙여 `ap_compose up -d --no-deps scheduler`로 scheduler를 다시 만든다. 그 뒤 새로 뜨는 worker부터 `OTEL_LOG_USER_PROMPTS`·`OTEL_LOG_ASSISTANT_RESPONSES`·`OTEL_LOG_TOOL_DETAILS`·`OTEL_LOG_TOOL_CONTENT`가 켜진다. 기본은 `0`(끔)이다. log는 LGTM과 `logs.jsonl`로만 가고 Langfuse로는 가지 않는다
7. 확인: Tempo `GET /api/search?q={ resource.agent_platform.session_id = "<세션 id>" }`, Langfuse `GET /api/public/v2/observations?traceId=<trace id>`(v4는 `/api/public/traces`·`/sessions`가 404)
8. 정리: `down.sh <run id>`, `docker compose -p obs-spike-collectors … down -v --remove-orphans`

## 한계

- 중계는 egress 정책 안에서 돌지만 worker 코드에 장애 지점이 하나 늘고, 엔진이 내보내는 내용을 worker가 본다. 운영 경로(TLS collector, 중계, 다른 방식)는 설계에서 정한다.
- worker에 OTel SDK가 없어 Agent SDK가 `TRACEPARENT`를 넣지 않는다. api 요청 → worker → CLI trace는 이어지지 않고 CLI의 `claude_code.interaction`이 root다.

# 플랫폼 지표 (Kubernetes)

Helm 설치에서 `metrics.enabled: true`로 켜면 플랫폼이 설치 전체의 세션 상태, turn 수와 소요 시간, 도구 호출, provider 토큰과 추정 비용, 대기열을 지표로 낸다. 운영자의 수집기(Prometheus, Datadog Agent, OpenTelemetry Collector)가 Prometheus text 형식(0.0.4)으로 읽는다. 대시보드와 알림 규칙은 운영자가 만든다. Pod의 CPU·메모리·재시작·로그는 클러스터의 수집기가 모으므로 여기에 없다.

## 켜기

```yaml
metrics:
  enabled: true
  podAnnotations:          # 수집기가 Pod를 찾는 방법. 설치처가 고른다
    prometheus.io/scrape: "true"
    prometheus.io/port: "9464"
networkPolicy:
  metrics:
    ingressFrom: []        # 비우면 어디서든 9464에 닿는다. 수집기 namespace로 좁힐 수 있다
```

켜면 chart가 `<release>-metrics` Deployment(replica 1, `Recreate`), 같은 이름의 ClusterIP Service(9464), 9464만 여는 NetworkPolicy를 만든다. 끄면(기본값) 아무것도 만들지 않으므로 기본 설치의 렌더 결과는 그대로다. 값의 전체 목록은 `deploy/helm/agent-platform/values.yaml`의 `metrics` 블록이다.

`metrics` 역할이 읽는 설정:

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `METRICS_PORT` | `9464` | `/metrics`와 `/healthz`를 받는 포트. chart는 `metrics.port`로 넣는다 |
| `DATABASE_URL` | 없음(필수) | 읽기 전용으로 여는 DB 주소. chart는 다른 역할과 같은 Secret key를 넣는다 |
| `config.limits`의 상한 | [configuration.md](configuration.md) | launch 대기열을 scheduler와 같은 비용·토큰 상한으로 센다. chart는 scheduler와 같은 값을 넣는다 |
| `LOG_LEVEL` | `info` | 읽기 실패를 남기는 로그 수준 |

확인:

```sh
kubectl -n <namespace> port-forward deploy/<release>-metrics 9464
curl -s localhost:9464/metrics
```

## 수집기가 읽는 법

| 수집기 | 방법 |
|---|---|
| Prometheus | `metrics.podAnnotations`의 `prometheus.io/*` annotation, 또는 운영자의 ServiceMonitor가 Service `<release>-metrics`의 `metrics` 포트를 가리킨다 |
| Datadog Agent(Helm) | Autodiscovery `openmetrics` 체크. `metrics.podAnnotations`에 `ad.datadoghq.com/metrics.checks`를 넣는다. Datadog에 어떤 이름(점 표기 등)으로 저장할지는 수집기 쪽 설정이다 |
| OpenTelemetry Collector | `prometheus` receiver로 같은 엔드포인트를 scrape해 OTLP로 보낸다 |

플랫폼이 OTLP로 지표를 밀어내지는 않는다. pull 엔드포인트 하나를 두면 수집기 종류와 상관없이 같은 정의를 읽고, 앱에 수집기 주소나 SDK 설정이 필요 없다. 세션 트레이스 내보내기(OTLP·Langfuse)는 별도 설정이 맡는다.

## 값을 만드는 방식

- **scrape할 때 DB에서 계산한다.** `metrics` 역할(`bun run apps/control-host/src/main.ts metrics`)은 상태를 갖지 않는다. 요청마다 `packages/db/src/metrics-reader.ts`의 질의로 DB를 읽어 `apps/control-host/src/metrics/families.ts`가 지표로 바꾼다. 그래서 Pod가 재시작해도 counter가 0으로 돌아가지 않는다.
- **target은 하나다.** 값은 설치 전체의 합이라 replica가 둘이면 같은 값을 두 번 낸다. chart가 replica를 1로 고정하고 `Recreate`로 바꾼다.
- **읽기 전용 연결이다.** DB 연결은 `default_transaction_read_only=on`으로 열려 있어 쓰기는 DB가 거절한다.
- **동시 scrape는 한 번 읽는다.** 읽는 동안 들어온 요청은 같은 결과를 받는다. 읽기가 실패하면 503을 돌려주고 이전 값을 내지 않는다(수집기에서는 scrape 실패, Prometheus의 `up` = 0).
- **`/healthz`** 는 프로세스가 응답하는지만 본다. probe는 DB를 읽지 않는다.

큰 표(`tool_calls`, `provider_usage`, `turns`)를 scrape마다 전체 집계한다. scrape 간격을 짧게 잡을수록 DB 부하가 는다. 수집 시간이 scrape 간격의 절반을 넘으면 집계 표를 따로 두는 쪽을 검토한다.

## 지표

접두어는 `agent_platform_`이다. 코드에서는 `apps/control-host/src/metrics/families.ts`의 `METRIC_PREFIX` 한 곳에서 정한다.

| 이름 | 타입 | 라벨 | 뜻 |
|---|---|---|---|
| `agent_platform_sessions` | gauge | `state`, `status`, `admission` | 세션 수. `state`는 아래 상태표로 정한다. `status`는 API가 보여 주는 상태(`needs_input` 포함), `admission`은 `sessions.admission_state` |
| `agent_platform_turns_total` | counter | `status` | `completed`·`failed`·`interrupted`·`cancelled`로 끝난 turn 수 |
| `agent_platform_turn_duration_seconds` | histogram | `status`, `le` | 위 turn 중 시작한 것의 시작부터 끝까지 걸린 시간. bucket 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600초 |
| `agent_platform_turns_outcome_unknown` | gauge | 없음 | 실행이 사라져 결과를 모르는 turn 수. 운영자의 복구 결정을 기다린다 |
| `agent_platform_tool_calls_total` | counter | `tool` | 엔진이 부른 도구 호출 수 |
| `agent_platform_tool_calls` | gauge | `tool`, `outcome` | 도구 호출 수를 지금의 결과별로. `ok`, `failed`, `denied`, `unknown`(결과가 아직 없음) |
| `agent_platform_provider_tokens_total` | counter | `model`, `priced_by`, `kind` | provider 호출에서 잰 토큰 수. `kind`는 `input`·`output`·`cache_read`·`cache_creation` |
| `agent_platform_provider_cost_usd_total` | counter | `model`, `priced_by` | provider 추정 비용(USD). Kubernetes 인프라 비용이 아니다 |
| `agent_platform_launch_queue_sessions` | gauge | 없음 | worker launch를 기다리는 세션 수 |
| `agent_platform_launch_queue_oldest_wait_seconds` | gauge | 없음 | launch 대기열에서 가장 오래 기다린 세션의 대기 시간. 비면 0 |
| `agent_platform_input_queue_oldest_age_seconds` | gauge | 없음 | worker가 아직 가져가지 않은 입력 중 가장 오래된 것의 나이. 비면 0 |

`tool_calls`가 counter가 아니라 gauge인 이유: 도구 결과는 나중에 바뀔 수 있다. 결과 이벤트가 늦게 도착하면 `unknown`이 `ok`나 `failed`가 되고, 더 이른 결과가 뒤에 도착하면 기존 결과를 바꾼다(`packages/db/src/tool-calls.ts`의 projection). counter 값이 줄면 수집기가 reset으로 읽어 증가량이 튄다. 호출 수의 증가량은 `tool_calls_total`로 보고, 결과별 비율은 `tool_calls`로 본다.

`outcome_unknown` turn을 `turns_total`에 넣지 않는 이유도 같다. 운영자가 복구하면 `completed`나 `cancelled`로 바뀌고 끝난 시각도 그때로 바뀐다. 바뀐 turn은 그때 `turns_total`과 histogram에 들어간다.

### 세션 상태표

위에서부터 처음 맞는 줄이 `state`다. 모든 세션이 정확히 한 줄에 들어가므로 `state`별 합은 전체 세션 수와 같다.

| `state` | 조건 | 티켓의 네 상태 |
|---|---|---|
| `ended` | `admission`이 `stopping`·`stopped`·`closing`·`closed`, 또는 저장된 status가 `stopped` | 종료 |
| `paused` | `admission`이 `pausing`·`paused` | 일시정지 |
| `recovery_required` | `admission`이 `recovery_required` | — |
| `awaiting_approval` | API status가 `needs_input`이고 사람이 답할 수 있는 permission 요청이 있다 | 승인 대기 |
| `awaiting_answer` | API status가 `needs_input`이고 사람이 답할 수 있는 요청이 question뿐이다 | — |
| `running`·`queued`·`idle`·`failed` | API status 그대로 | 실행 중은 `running` |

`needs_input`은 DB에 저장되지 않는다. 실행 중인 세션이나 turn을 멈춰 둔(parked) 세션에 사람이 답할 수 있는 요청이 있으면 읽을 때 `needs_input`이 된다(`packages/db/src/pending-requests.ts`의 `publicStatus`). 지표도 같은 규칙(`actionableOfSession`)을 쓴다. `ended`는 닫힌 세션이 지워지지 않으므로 계속 커진다. 지금의 부하는 `ended`를 뺀 합으로 본다.

### 도구 결과와 거절

- `ok`·`failed`·`unknown`은 `tool_calls.outcome`(도구 결과 블록의 `is_error`)이다.
- `denied`는 사람이 permission 요청에 `deny`로 답한 호출이다. `pending_requests`(`kind = 'permission'`, `answer.decision = 'deny'`)와 `tool_calls`를 `(session_id, tool_use_id)`로 잇는다. tool_use id는 provider가 주는 고유값이라, 멈춰 둔 요청에 다음 attempt가 답한 경우도 같은 호출로 잇는다.
- 에이전트 도구 정책의 `deny`, 만료되거나 취소된 요청, `tool_use_id`를 보내지 않는 옛 worker의 거절은 `denied`가 아니라 결과 블록대로(`failed` 등) 센다.

### 비용과 토큰

- 비용은 `provider_usage.cost_usd`의 합이다. 이 값은 호출을 기록할 때 플랫폼 가격표(`packages/platform/src/limits/model-prices.ts`의 `priceProviderUsage`, `MODEL_PRICES`)가 계산했다. 지표는 단가를 다시 계산하지 않고, 단가 설정도 따로 두지 않는다.
- `priced_by`는 그 호출의 가격 근거다. `table`(가격표에 있는 모델), `fallback`(가격표에 없는 모델이라 가장 비싼 단가로 계산), `unmetered`(profile이 `billing: none`이라 비용 0). 사내 모델처럼 비용이 0인 호출은 `priced_by="unmetered"`의 토큰 수로 사용량을 본다.
- **기간 기준은 호출을 기록한 시각(`provider_usage.recorded_at`)이다.** 기간 비용은 `increase(agent_platform_provider_cost_usd_total[1h])`처럼 counter 증가량으로 본다.
- `GET /v1/usage/summary`와 다른 점이 셋 있다. 기간 안에 만들고 기간 안에 과금한 세션만 있으면 둘은 같다(`packages/db/src/metrics-reader.test.ts`).
  - summary는 기간 안에 **만든** 세션(`sessions.created_at`)을 골라 그 세션의 비용 전체를 더한다. 기간 전에 만든 세션이 기간 안에 쓴 비용은 지표에만 있다.
  - summary는 `sessions.cost_usd`를 더한다. 이 값은 세션 비용 상한 칸(99,999,999.999999 USD)에서 멈추지만 호출별 비용은 멈추지 않는다.
  - summary에는 호출 단위 기록이 생기기 전(마이그레이션 0169 이전)의 세션 비용(`session_pre_metering_cost`)이 들어 있고 지표에는 없다.
- 토큰은 `provider_usage`의 호출별 값을 더한다. `cache_creation`은 1시간 cache 쓰기를 포함한 전체 cache 쓰기다.

### 대기열

- **launch 대기열**: scheduler가 다음 pass에 worker를 띄울 수 있는 세션이다. scheduler와 같은 SQL 조건(`packages/db/src/scheduler-store.ts`의 `awaitingLaunch`)으로 센다. launch 가능한 admission, 실행 회수·takeover 없음, 비용·토큰 상한 안, restore 재시도 시각 지남, 슬롯을 잡은 launch 없음. 상한은 scheduler와 같은 `config.limits`에서 읽는다. 대기 시간은 `unassigned_sessions.signaled_at`부터 잰다.
- **입력 대기열**: `queue_messages` 중 아무 worker도 가져가지 않았고 보일 시각이 지난 입력이다. compose의 `agent_platform.queue.oldest_age_seconds`와 뜻이 같다.

## 라벨 규칙

- 세션 id, turn id, 사용자 id, API key id, 에이전트 id, attempt id는 라벨로 쓰지 않는다. 에이전트별 비용은 `GET /v1/usage/*`로 본다.
- `state`·`status`·`admission`·`outcome`·`priced_by`·`kind`·`le`는 정해진 값만 나온다.
- `tool`과 `model`은 데이터에서 온다. MCP 도구 `mcp__<server>__<tool>`은 `mcp__<server>`로 접는다. 그다음 처음 나타난 순서로 `tool`은 100개, `model`은 50개까지만 이름을 두고 나머지는 `other`로 합친다. 행을 지우지 않으므로 한 번 이름을 얻은 값은 `other`로 옮겨 가지 않는다.
- 테스트: `apps/control-host/src/metrics/families.test.ts`의 cardinality 절이 라벨 이름 목록, id 모양 값이 없음, 상한을 확인한다.

## compose 지표와의 대응

compose의 Datadog overlay는 PostgreSQL custom query로 비슷한 값을 낸다([monitoring-datadog.md](monitoring-datadog.md), `infra/datadog/conf.d/postgres.d/conf.yaml`). Kubernetes 설치에서는 이 지표를 읽으면 된다.

| compose(DB query) | 이 지표 |
|---|---|
| `agent_platform.queue.oldest_age_seconds` | `agent_platform_input_queue_oldest_age_seconds`(같은 뜻) |
| `agent_platform.provider.cost_usd_1h` | `increase(agent_platform_provider_cost_usd_total[1h])` |
| `agent_platform.provider.unmetered_tokens_1h` | `increase(agent_platform_provider_tokens_total{priced_by="unmetered"}[1h])`의 합 |
| `agent_platform.provider.fallback_pricing_count_1h` | 대응 없음(호출 수 대신 `priced_by="fallback"`의 비용·토큰을 본다) |
| `agent_platform.turn.outcome_unknown_count` | 대응 없음. `agent_platform_turns_outcome_unknown`은 최근 5분에 생긴 수가 아니라 지금 남은 수다 |
| `agent_platform.checkpoint.pending_age_seconds`, `agent_platform.lease.stale_count` | 대응 없음 |

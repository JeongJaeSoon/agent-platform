# Datadog 알파 감시 기준

이 문서는 24시간 soak를 다시 돌리지 않고 알파를 진행할 때 서버 배포에서 확인할 최소 감시 기준이다. 앱에 Datadog SDK나 OTel을 넣지 않는다. Datadog Agent가 Docker의 JSON stdout 로그, `/readyz`, 읽기 전용 PostgreSQL query, 호스트 지표를 수집한다. 정의는 [`infra/datadog/definitions`](../infra/datadog/definitions)에만 버전 관리하며 이 저장소의 도구나 CI는 Datadog API를 호출하지 않는다.

모든 임계는 **서버 배포 뒤 첫 7일 동안 조정할 초기값**이다. `threshold_stage:first-week-tuning` tag가 붙은 monitor를 첫 주 데이터 없이 장기 기준으로 간주하지 않는다. 이 문서에서 실제 신호가 없는 항목은 모두 `계측 공백 → 94S-487`로 표시한다.

## 시작과 비밀 관리

Agent는 선택형 [`infra/compose.datadog.yml`](../infra/compose.datadog.yml)에서만 생긴다. 이 파일을 지정하지 않는 로컬·test-ops 기본 stack에는 Agent, mount, label, 필수 환경 변수가 하나도 추가되지 않는다. Agent image는 `gcr.io/datadoghq/agent:7.83.3`으로 고정한다.

`DD_API_KEY`와 Datadog용 PostgreSQL password는 저장소나 shell history에 넣지 않는다. 서버에서 운영자가 `/etc/agent-platform/datadog.env`를 만들고 mode 600을 확인한다. 값은 예시 자리표시자이며 실제 값을 문서·티켓·로그에 복사하지 않는다.

```dotenv
DD_API_KEY=<operator-supplied>
DD_SITE=datadoghq.com
DD_ENV=alpha
DD_VERSION=<release-sha>
DD_POSTGRES_PASSWORD=<read-only-role-password>
```

```bash
sudo chown root:root /etc/agent-platform/datadog.env
sudo chmod 600 /etc/agent-platform/datadog.env
stat -c '%a %U:%G' /etc/agent-platform/datadog.env
```

Agent service는 이 절대 경로를 `env_file`로만 읽는다. compose YAML에는 `DD_API_KEY`의 이름이나 값 interpolation이 없으므로 ambient `DD_API_KEY`로 우회할 수 없다. `DD_ENV`와 `DD_VERSION`은 같은 파일을 compose의 두 번째 `--env-file`로 읽어 product container의 unified tags에 쓴다.

PostgreSQL role은 `queue_messages`, `sessions`, `turns`, `attempts`, `provider_usage`에 `SELECT`만 허용하고 기본 transaction을 read-only로 고정한다. 아래 명령은 서버 운영자가 admin connection에서 한 번 실행한다.

```sql
CREATE ROLE datadog LOGIN PASSWORD :'datadog_password';
ALTER ROLE datadog SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE sessions TO datadog;
GRANT USAGE ON SCHEMA public TO datadog;
GRANT SELECT ON TABLE queue_messages, sessions, turns, attempts, provider_usage TO datadog;
```

test-ops S3 설치의 예시는 다음과 같다. 기존 배포 명령의 layer는 그대로 두고 마지막에 overlay만 더한다.

```bash
docker compose \
  --env-file /etc/agent-platform/test-ops.env \
  --env-file /etc/agent-platform/datadog.env \
  -f infra/compose.core.yml \
  -f infra/compose.test-ops.yml \
  -f infra/compose.test-ops.s3.yml \
  -f infra/compose.datadog.yml \
  --profile apps up -d
```

Agent는 Docker socket과 container log directory를 read-only로 mount하고 host PID·cgroup namespace를 읽는다. `DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=true`로 동적 worker도 수집한다. compose service는 `service`·`env`·`version` label을 받는다. 동적 worker의 `service`는 container short-image에서 유도되고, `env`는 Agent의 전역 `DD_ENV`, `version`은 전역 `DD_TAGS`에서 받는다. `session_id`·`turn_id`는 조사할 로그 attribute로만 남기며 metric tag나 facet으로 만들지 않는다.

## 신호와 초기 monitor

구조화 logger의 원본 record는 `timestamp`, `level`, `message`, 선택형 `fields`, context(`session_id` 등)다. log pipeline은 JSON을 parse하고 `message`를 `event`로 복사한다. 따라서 아래의 `event`는 코드가 logger에 넘긴 문자열이며, 상세 값은 `fields.*` 아래다. query의 metric 이름은 [`log-metrics.json`](../infra/datadog/definitions/log-metrics.json)과 PostgreSQL custom query가 만든 이름이다.

| 위험 | 현재 신호(로그 event·필드, DB query, readyz) | Datadog monitor(query·임계·창) | 경보 시 대응 runbook | 계측 공백 |
| --- | --- | --- | --- | --- |
| interrupt effect가 5초를 넘김 | `worker.turn.interrupting`(`fields.control_id`, `fields.turn_id`)과 `worker.turn.engine_stopped`(같은 필드). `turns.outcome_unknown`의 5분 count는 `agent_platform.turn.outcome_unknown_count` | unknown 결과: `max(last_5m):max:agent_platform.turn.outcome_unknown_count{*} > 0` | [interrupt 뒤 결과를 알 수 없는 turn](operations.md#interrupt-뒤-결과를-알-수-없는-turn) | 두 로그를 직접 상관해 effect latency를 만드는 단일 duration 신호 없음 — **계측 공백 → 94S-487** |
| terminate·control 수락 지연 | HTTP 202인 `Terminate API request completed`의 `fields.duration_ms` → `agent_platform.terminate.acceptance.duration_ms`. 같은 `request_id`의 `Terminate control transaction completed`에 DB 단계별 시간이 있음 | p95 `avg(last_5m):p95:agent_platform.terminate.acceptance.duration_ms{*} > 200` | [API 설정의 terminate 계측](operations.md#api-설정-94s-389) | terminate 외 interrupt·pause·resume의 acceptance duration 없음 — **계측 공백 → 94S-487** |
| 세션 생성 p95 | 세션 row의 `created_at`은 있으나 요청 시작·응답 완료 pair가 없음 | p95 monitor 정의 없음 | [API 설정](operations.md#api-설정-94s-389) | API create latency histogram 없음 — **계측 공백 → 94S-487** |
| checkpoint 실패 | `worker.checkpoint.failed`(`fields.stage`, `fields.reason`, `fields.revision`) → `agent_platform.checkpoint.failed` | `sum(last_5m):sum:agent_platform.checkpoint.failed{*}.as_count() > 0` | [checkpoint 복원이 계속 실패하는 세션](operations.md#checkpoint-복원이-계속-실패하는-세션-94s-345) | 없음 |
| checkpoint pending 사유·경과 | `sessions.checkpoint_pending_reason`; custom query `agent_platform.checkpoint.pending_age_seconds` | `max(last_5m):max:agent_platform.checkpoint.pending_age_seconds{*} > 300` | [checkpoint 복원이 계속 실패하는 세션](operations.md#checkpoint-복원이-계속-실패하는-세션-94s-345) | `sessions.updated_at`을 pending 시작의 보수적 proxy로 쓰므로 정확한 시작 시각은 **계측 공백 → 94S-487** |
| capture 지연, PUT 수·bytes·manifest 크기 | `worker.checkpoint.published`의 `fields.total_ms`, `durations_ms`, `untracked_uploads`, `bundle_bytes`, `untracked_bytes`, `manifest_bytes`; 늦으면 `worker.checkpoint.late`(`budget_ms`). 같은 이름의 `agent_platform.checkpoint.*` distribution과 late count를 만듦 | capture p95 `> 20,000 ms/5m`; late count `> 0/5m`; bundle·untracked `> 214,748,364 bytes/15m`; manifest `> 6,710,886 bytes/15m` | [checkpoint 복원이 계속 실패하는 세션](operations.md#checkpoint-복원이-계속-실패하는-세션-94s-345) | transcript를 포함한 전체 PUT 수·전체 checkpoint bytes는 없음 — **계측 공백 → 94S-487** |
| S3 5xx·stall | checkpoint 실패의 `fields.reason` 문자열과 proxy의 `Upstream connection failed`뿐이며 S3 status·operation·duration이 구조화되지 않음 | 신뢰할 query가 없어 monitor 정의 없음 | [object store 고르기](backup-restore.md#object-store-고르기) | S3 operation/status/duration 없음 — **계측 공백 → 94S-487** |
| worker launch/exit 반복 | `Launching execution failed; intent kept for retry`, `Execution resource exited right after launch`, `Launch attempt failed; retrying after a backoff` → `agent_platform.launch.failed`; `Execution exited; resource reclaimed`, `Claimed execution resource vanished; binding released` → `agent_platform.execution.exited` | launch: `sum(last_10m):sum:agent_platform.launch.failed{*}.as_count() > 3`; exit: `sum(last_10m):sum:agent_platform.execution.exited{*}.as_count() > 5` | [시작 단계에서 계속 죽는 세션](operations.md#시작-단계에서-계속-죽는-세션-94s-302-94s-347) | 없음 |
| 저장소 장애 뒤 수렴 | `Execution launched`, 위 launch/exit event, `Orphan session reconciliation completed`의 `fields.requeued_count`·`fields.blocked_count` | 반복 launch/exit monitor로 증상은 감지 | [reconciler·scheduler](operations.md#reconcilerscheduler와-worker-격리) | 장애 시작부터 모든 session 수렴까지 걸린 시간과 미수렴 session 수 없음 — **계측 공백 → 94S-487** |
| lease lost | `Expired lease reconciliation completed`(`fields.fenced_count`, `fields.ended_count`); custom query `agent_platform.lease.stale_count` | `max(last_5m):max:agent_platform.lease.stale_count{*} > 0` | [reconciler·scheduler](operations.md#reconcilerscheduler와-worker-격리) | 없음 |
| queue oldest age | unclaimed·visible `queue_messages.created_at`의 최솟값 → `agent_platform.queue.oldest_age_seconds` | `max(last_5m):max:agent_platform.queue.oldest_age_seconds{*} > 30` | [reconciler·scheduler](operations.md#reconcilerscheduler와-worker-격리) | 없음 |
| readyz 가용률 | Agent HTTP check `agent-platform-readyz` → `http.can_connect` | 마지막 3회 중 실패, 5분 no-data | [API 설정](operations.md#api-설정-94s-389) | 없음 |
| provider 429·5xx | proxy는 upstream connect 실패만 기록하고 provider response status를 기록하지 않음 | 신뢰할 status query가 없어 monitor 정의 없음 | [provider·egress 설정](operations.md#provider-키와-저장소-자격-증명은-worker에-가지-않는다-94s-252) | provider status·retry 결과 없음 — **계측 공백 → 94S-487** |
| provider 비용·fallback pricing | `provider_usage` 1시간 합계 → `agent_platform.provider.cost_usd_1h`, `agent_platform.provider.fallback_pricing_count_1h` | cost `> 20 USD/1h`; fallback count `> 0/1h` | [설치 상한](operations.md#설치-상한-94s-131) | 없음. 비용 임계는 설치 예산에 맞춰 첫 주에 반드시 조정 |
| disk·inode·XFS quota | Agent host `system.disk.in_use`, `system.fs.inodes.in_use`; 현재 `scripts/test-ops.sh status`와 `xfs_quota` 수동 확인 | host disk·inode `> 0.8` for 10m | [worker workspace의 상한과 회수](operations.md#worker-workspace의-상한과-회수) | workspace별 XFS project quota 사용률 metric 없음 — **계측 공백 → 94S-487** |
| legal hold·orphan 증가 | 현재 checkpoint inventory metric 없음 | monitor 정의 없음 | [checkpoint 객체의 version과 hold](backup-restore.md#checkpoint-객체의-version-복원-뒤-재고정-94s-282) | inventory 구현은 94S-482 범위이며 현재 감시는 **계측 공백 → 94S-487** |
| backup 실패 | `scripts/backup.sh` exit와 운영 history는 Docker JSON stdout에 들어오지 않음 | monitor 정의 없음 | [백업](backup-restore.md#백업) | backup 실행 결과를 구조화 신호로 보내지 않음 — **계측 공백 → 94S-487** |

## DB 점검 query 계약

[`infra/datadog/conf.d/postgres.d/conf.yaml`](../infra/datadog/conf.d/postgres.d/conf.yaml)의 `custom_queries`가 정본이다. 모든 query는 `SELECT` 하나이며 table을 바꾸지 않는다.

- queue oldest age: 아직 claim되지 않았고 이미 visible인 message의 가장 오래된 `created_at`을 DB clock과 비교한다.
- checkpoint pending age: `checkpoint_pending_reason IS NOT NULL`인 session의 `updated_at` 중 가장 오래된 값을 쓴다. checkpoint와 무관한 같은 session 갱신이 이 시각을 움직일 수 있으므로 exact SLI가 아니라 하한 proxy다.
- `outcome_unknown`: 최근 5분에 만들어진 `turns.outcome_unknown = true` row 수다.
- stale lease: `exited`·`lost`가 아닌 attempt 가운데 `lease_expires_at < clock_timestamp()`인 수다.
- provider 비용: 최근 1시간 `cost_usd` 합계와 `priced_by = 'fallback'` row 수다.

어느 query도 `session_id`를 반환하지 않는다. [`log-metrics.json`](../infra/datadog/definitions/log-metrics.json)의 group-by도 `service`·`env`와 낮은 cardinality 상태만 쓴다. `session_id`는 incident에서 원본 로그나 DB를 좁힐 때만 쓴다.

## 정의 적용과 검증

이 PR은 Datadog API를 호출하지 않는다. 운영자는 JSON을 검토한 뒤 각 파일의 `endpoint`에 `requests` 항목을 하나씩 적용한다. [`log-facets.json`](../infra/datadog/definitions/log-facets.json)은 UI에서 만들 facet과 만들지 않을 high-cardinality attribute 목록이다. [`dashboard.json`](../infra/datadog/definitions/dashboard.json)은 dashboard create body다.

서버 배포에서 다음을 확인한다.

1. 기본 stack을 overlay 없이 render·기동했을 때 service 목록과 설정이 이전과 같다.
2. overlay를 더한 `docker compose config`가 `DD_ENV`·`DD_VERSION` 누락을 거부하고, Agent의 Docker socket mount가 `ro`이며 `/etc/agent-platform/datadog.env`만 읽는다.
3. Agent status에서 Docker log, `http_check:agent-platform-readyz`, PostgreSQL custom query가 모두 성공한다.
4. `/readyz`를 잠깐 실패시켜 service check가 바뀌고 복구되는지 서버에서 확인한다. 실제 장기 stack 실행과 monitor notification 전달은 로컬 검증 증거로 대체하지 않는다.

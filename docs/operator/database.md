# 데이터베이스 연결과 느린 쿼리

플랫폼이 PostgreSQL 16에 거는 연결 수와 세션 설정, 그리고 느린 쿼리와 잠금 대기를 보는 법을 적는다. compose 설치는 Postgres를 직접 띄우므로 서버 설정도 compose가 건다. Helm 설치는 운영자가 가져온 DB를 쓰므로 서버 설정은 운영자가 켠다. 코드가 기여자에게 요구하는 규칙(트랜잭션 범위, 잠금 순서, migration)은 [개발 문서의 DB 사용 규칙](../contributing/development.md#db-사용-규칙)에 있다.

## 역할별 연결 수

모든 역할은 `packages/db/src/pool.ts`의 `createEnforcedPool`로 풀을 만든다. 풀 상한은 역할마다 다르다.

| 역할 | 풀 상한 | 이유 |
|---|---|---|
| api | 10 + readiness probe 1 + LISTEN 1 | 요청을 동시에 처리한다. probe는 자기 풀(상한 1)을 써서 요청과 연결을 다투지 않는다. 이벤트 알림을 받는 LISTEN 연결(`agent-platform:api-listen`)은 풀 밖에 하나 둔다 |
| metrics | 10 | scrape 한 번이 집계 7개를 동시에 읽는다 |
| scheduler | 4 | pass가 문장을 하나씩 낸다. pass lock이 연결 하나를 더 쥔다 |
| reconciler | 4 | pass가 문장을 하나씩 낸다 |
| slack | 4 | inbox와 outbox를 차례로 비운다 |
| checkpoint GC, upgrade check, migrate, 운영자 CLI(`keys`·`grants` 등) | 10 | 잠깐 돌고 끝난다 |

Helm 기본값(api 2개, slack 1개, scheduler·reconciler 1개, metrics 꺼짐)으로 늘 열려 있을 수 있는 연결은 api 24 + scheduler 4 + reconciler 4 + slack 4 = 36개다. `metrics.enabled`를 켜면 10개, GC·upgrade check·migrate job이 겹치면 최대 30개가 더 붙는다. compose는 api 12 + scheduler 4 + reconciler 4 + slack 4 = 24개다. PostgreSQL 기본 `max_connections`는 100이고 그중 3개는 superuser 몫이다. api나 slack replica를 늘리면 replica 하나에 12개(slack은 4개)씩 더해서 `max_connections`와 견준다. 관리형 DB는 인스턴스 크기에 따라 `max_connections`가 100보다 작을 수 있으니 그 값을 확인한다.

## 연결마다 거는 세션 설정

`createEnforcedPool`이 연결을 열 때 건다. `DATABASE_URL`에 같은 이름의 query parameter가 있어도 timeout은 코드 값이 이긴다.

| 설정 | api·job 값 | migrate 값 | 뜻 |
|---|---|---|---|
| 연결 대기(`connectionTimeoutMillis`) | 5초 | 5초 | 풀이 비지 않으면 이 시간 뒤에 실패한다. api는 503으로 답한다 |
| `statement_timeout` | 10초 | 300초 | 서버가 문장을 취소한다. 잠금을 기다리는 시간도 여기에 든다 |
| 응답 읽기(`query_timeout`) | 20초 | 330초 | 서버가 답하지 않는 소켓을 클라이언트가 버린다 |
| `idle_in_transaction_session_timeout` | 30초 | 30초 | 트랜잭션을 연 채 30초 동안 문장을 내지 않은 연결을 서버가 끊는다. 그 연결이 쥔 잠금도 풀린다 |
| `application_name` | `agent-platform:<역할>` | `agent-platform:migrate` | `pg_stat_activity`와 서버 로그에서 역할을 가른다. `DATABASE_URL`에 `application_name`이 있으면 그 값을 쓴다 |

역할마다 열린 연결 수는 DB에서 본다. compose는 `docker compose -f infra/compose.yml exec postgres psql -U postgres -d sessions`로 들어가고, Helm은 운영자의 DB 클라이언트로 들어간다.

```sql
SELECT application_name, state, count(*)
  FROM pg_stat_activity
 WHERE application_name LIKE 'agent-platform:%'
 GROUP BY 1, 2 ORDER BY 1, 2;
```

세션 설정은 그 연결에만 걸리므로 운영자 `psql`의 `SHOW`는 서버 기본값을 보인다. 플랫폼 연결의 값은 api 컨테이너(Helm은 api Pod) 안에서 같은 풀로 읽는다.

```bash
docker compose -f infra/compose.yml exec -T -w /app/apps/control-host api bun -e '
import { createLogger } from "@werft-ai/observability";
import { createApiPool } from "./src/api/pool.ts";
const pool = createApiPool(process["env"]["DATABASE_URL"], createLogger());
const { rows } = await pool.query(
  "SELECT current_setting($1) AS statement_timeout, current_setting($2) AS idle_in_transaction, current_setting($3) AS application_name",
  ["statement_timeout", "idle_in_transaction_session_timeout", "application_name"],
);
console.log(JSON.stringify(rows[0]));
await pool.end();'
# {"statement_timeout":"10s","idle_in_transaction":"30s","application_name":"agent-platform:api"}
```

Helm은 `docker compose … exec -T -w /app/apps/control-host api` 대신 `kubectl -n agent-platform exec deploy/agent-platform-api -- sh -c 'cd /app/apps/control-host && bun -e …'`로 같은 스크립트를 돌린다. release 이름이 `agent-platform`이 아니면 namespace와 deployment 이름을 그 설치의 것으로 바꾼다.

## 느린 쿼리와 잠금 대기 보기

### compose

`infra/compose.core.yml`의 postgres가 다음을 켜고 뜬다.

- `log_min_duration_statement=500ms`: 500ms를 넘긴 문장을 본문과 시간으로 로그에 남긴다. `POSTGRES_LOG_MIN_DURATION_STATEMENT`로 바꾸고 `-1`이면 끈다.
- `log_lock_waits=on`: `deadlock_timeout`(1초)보다 오래 기다린 잠금을, 그 잠금을 쥔 PID와 함께 남긴다.
- `shared_preload_libraries=pg_stat_statements`: 문장별 누적 통계를 모은다. 보려면 처음 한 번 `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`를 실행한다.

```bash
docker compose -f infra/compose.yml logs postgres | grep -E 'duration:|still waiting'
```

```sql
SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms,
       round(total_exec_time::numeric) AS total_ms, left(query, 120)
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
```

이 설정을 바꾸면 postgres 컨테이너가 다시 만들어진다. 데이터는 `postgres-data` volume에 남는다.

### Helm (운영자 DB)

chart는 DB를 만들지 않으므로 서버 설정도 바꾸지 않는다. 운영자가 DB 파라미터에 다음을 건다. RDS·Aurora는 parameter group에서 바꾸고, `shared_preload_libraries`는 인스턴스를 다시 시작해야 적용된다.

| 파라미터 | 값 |
|---|---|
| `log_min_duration_statement` | `500` (ms) |
| `log_lock_waits` | `on` |
| `shared_preload_libraries` | 기존 값에 `pg_stat_statements` 추가 |

그다음 플랫폼 DB에서 `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`를 한 번 실행한다. 확장을 만들 권한(RDS는 `rds_superuser`)이 필요하다. migration은 확장을 만들지 않는다. 권한이 없는 설치에서도 migrate가 실패하지 않게 하기 위해서다.

로그는 DB가 남기는 곳(RDS는 CloudWatch Logs의 `postgresql` 로그)에서 `duration:`과 `still waiting`으로 찾는다. kind 확인 환경(`deploy/kind/deps.yaml`)의 Postgres는 이 표의 값으로 뜬다.

## migration이 잠그는 시간

migrate job은 문장마다 최대 300초를 쓴다. migrate가 둘 겹치면(손으로 돌린 `db:migrate`와 Helm hook Job 등) 뒤의 것은 앞의 것이 끝날 때까지 기다린 뒤 남은 migration만 적용한다. Helm hook Job은 `migrate.activeDeadlineSeconds`(기본 600초)가 지나면 끝난다. 커지는 표에 인덱스를 만드는 migration은 `CREATE INDEX CONCURRENTLY`로 쓰기를 막지 않고 만든다. 표가 커서 300초를 넘길 것 같으면 그 migration의 릴리스 노트가 따로 알린다. `CONCURRENTLY` 인덱스는 시작할 때 열려 있던 트랜잭션이 모두 끝나기를 기다리므로, 오래 열린 운영자 세션(`psql`의 열린 `BEGIN`)이 있으면 그만큼 늦어진다.

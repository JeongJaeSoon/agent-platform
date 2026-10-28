# 설정 레퍼런스

설치 상한, API 설정, scheduler·worker 컨테이너·egress 설정을 적는다. reconciler·scheduler 감독 루프의 설정은 [실행 기반과 worker 격리](execution.md)에, 카탈로그(`connections.yaml`·`repositories.yaml`, 빈 DB의 시드 `profiles.yaml`)와 인증 설정은 [API 서버](api-server.md)에, Kubernetes backend의 설정은 [Kubernetes 실행 backend](kubernetes-backend.md)에 있다.

## 설치 상한

API와 scheduler는 아래 값 중 `SESSION_TOKEN_LIMIT`를 뺀 여섯 값이 없거나, 어느 값이든 형식이 틀리면 문제를 한 줄에 모두 로그로 남기고 기동하지 않는다. `SESSION_TOKEN_LIMIT`는 나중에 더한 값이라 없으면 0(상한 없음)으로 읽는다. 두 프로세스는 같은 parser(`packages/platform/src/limits/installation-limits.ts`)를 쓴다. `SESSION_TOKEN_LIMIT`의 0 말고는 코드에 기본값이 없고, compose의 `x-installation-limits` 블록이 로컬 기본값을 준다. 떠 있는 API의 `/readyz`는 같은 검증을 `config` 체크로 다시 수행한다.

| 변수 | 의미 | 넘었을 때 |
|---|---|---|
| `EXECUTION_SLOT_LIMIT` | 동시에 슬롯을 잡는 worker 수. 0이면 접수만 받고 아무것도 띄우지 않는다 | 입력은 거부하지 않고 `queued`로 둔다 |
| `QUEUED_INPUT_LIMIT_PER_SESSION` | 세션 하나가 쌓아 둘 수 있는 `queued` turn 수 | `429 RATE_LIMITED`, `retryable:true`, `Retry-After: 5` |
| `STORAGE_LIMIT_BYTES` | 설치 전체가 보존하는 입력 message의 UTF-8 bytes. event·checkpoint object·worker 디스크는 세지 않는다(디스크는 workspace quota가 맡는다) | `413 STORAGE_LIMIT_EXCEEDED`, `retryable:false` |
| `MAX_TURN_SECONDS` | turn 하나의 벽시계 상한. 승인 대기도 포함한다. worker env `WORKER_MAX_TURN_SEC`로 전달된다 | turn `failed(turn_timeout)`. 엔진이 응답하지 않으면 `outcome_unknown(turn_timeout)` |
| `SESSION_COST_LIMIT_USD` | 세션 누적 비용(egress proxy가 계측한 Messages 호출별 usage를 플랫폼 가격표로 환산한 합, 추정치) | 새 turn을 dispatch하지 않는다. 세션 상세 `attention.code=BUDGET_EXCEEDED`가 뜨고 worker는 슬롯을 반납한다. 입력은 계속 `queued`로 받는다 |
| `SESSION_TOKEN_LIMIT` | 세션 누적 provider token 수. 비용 상한과 같은 호출을 세되 단가와 무관하다. 0이면 상한이 없다(기본) | `SESSION_COST_LIMIT_USD`와 같다. 두 상한은 같은 판정(`budgetExceeded`)을 지나며 어느 쪽이 먼저 닿아도 `BUDGET_EXCEEDED`다. `attention.reason`은 닿은 상한만 적는다 |
| `PROVIDER_MAX_RETRIES` | 실패한 Messages 요청을 다시 보내는 횟수. worker env `WORKER_PROVIDER_MAX_RETRIES`를 거쳐 SDK `CLAUDE_CODE_MAX_RETRIES`로 전달된다. 0이면 첫 실패에서 turn이 끝난다 | turn `failed(api_error)`. turn 상세 `result`에 `api_error_status`·`provider_error`·`last_retry_status`가 남는다 |

- 세션 비용은 credential route가 센다. proxy는 2xx `/v1/messages` 응답(JSON과 SSE 모두)에서 usage를 읽는다. 응답이 끝나거나 끊기면 authorizer listener의 `POST /usage`로 보고한다. `count_tokens`와 오류 응답은 세지 않는다.
  - 응답이 usage를 다 말하지 않으면 많게 추정한다. `message_stop` 전에 끊긴 stream은 전달한 content 한 글자를 token 하나로 쳐서 output에 넣고, 전달한 web search 결과 블록 하나를 검색 한 번으로 친다. usage를 읽지 못한 JSON 응답(끊김, 8 MiB 초과, JSON 아님)은 요청으로 센다. 요청 1 byte를 input token 하나로, `max_tokens`를 output 전부로 본다. 이런 호출은 proxy가 `Provider usage estimated` 경고를 남기고 ledger에 `estimated=true`로 적힌다.
  - API는 가격표로 USD를 구해 micro-dollar 단위로 올림한다. 그 금액을 `provider_usage`에 교환 하나당 한 줄로 쓰고, 같은 트랜잭션에서 세션 비용에 더한다. 그래서 ledger 합과 세션 비용이 맞는다.
  - engine의 호출과 도구가 engine의 token으로 직접 부른 호출을 똑같이 센다.
  - 보고에는 proxy가 교환마다 만든 id가 붙는다. authorizer가 답하지 못하면 1·5·15초 뒤에 다시 보내고, 같은 id는 한 번만 센다. 끝내 보고하지 못하면 proxy가 `Provider usage went unreported` 오류 로그를 남기고 그 교환은 세지 않는다.
- turn 종료 때 SDK가 알려 준 `total_cost_usd` 증분은 turn 결과(`cost_usd`)에만 남고 세션 비용에는 더하지 않는다. engine의 turn별 `maxBudgetUsd`는 그대로 SDK 값으로 판정한다. proxy 계측 전에 만든 세션은 그때까지 SDK 값을 더한 비용을 이어받는다.
- 가격표는 플랫폼 코드(`packages/platform/src/limits/model-prices.ts`)가 소유한다. 모델 id별로 input, output, cache write(5분 1.25배, 1시간 2배), cache read 단가를 둔다. 모델이 추가되거나 가격이 바뀌면 릴리스와 함께 고친다.
  - fast mode는 따로 둔 fast 단가표로 센다. 지금은 Opus 5.5($8/$40)와 Opus 5·Opus 4.8($10/$50)만 있다. cache 배수는 fast 단가 위에 그대로 곱한다. speed는 응답의 `usage.speed`를 따르고, 응답이 말하지 않으면 요청의 `speed`를 따른다. 둘 다 없으면 `standard`다.
  - 표에 없는 모델, fast 단가가 없는 모델의 fast 응답, 이름이 아닌 speed 값은 항목마다 두 표를 통틀어 최고 단가로 센다. authorizer가 `Provider usage priced at the fallback rate` 경고를 남기고, ledger에는 `priced_by=fallback`으로 적힌다.
  - 응답 `usage.server_tool_use`의 web search 한 번마다 $0.01(1,000회 $10)을 더한다. web fetch는 token 말고 요금이 없다. code execution은 더하지 않는다. web search·web fetch와 함께 쓰면 요금이 없고, 아니면 호출 수가 아니라 컨테이너 시간으로 과금되며 조직 무료 시간이 있기 때문이다. 세 횟수와 speed는 ledger(`provider_usage`)에 함께 적힌다.
  - 4.6 이후 모델은 US 전용 추론(`inference_geo: "us"`)이면 token 단가 전부(fast·cache 포함)에 1.1배를 곱한다. web search 요금에는 곱하지 않는다. geo는 응답의 `usage.inference_geo`를 따르고, 응답이 말하지 않으면 요청의 `inference_geo`를 따른다. 둘 다 없으면 `unknown`이다. workspace 기본값이 `us`일 수 있어서다. `global`과 `us`가 아닌 값은 최고 단가에 1.1배로 센다(`priced_by=fallback`). geo는 ledger에 `inference_geo`로 적힌다. `inference_geo`를 모르는 옛 API는 이 필드가 붙은 보고를 `400`으로 거절하고, proxy는 그 교환을 세지 못한다(`Provider usage went unreported`). 그래서 업그레이드할 때는 API(migration 포함)를 egress proxy보다 먼저 올린다. 한 번의 `up -d`는 이 순서를 지키지 않으므로 compose 설치는 `docker compose -f infra/compose.yml --profile apps up -d api`(migrate가 먼저 돈다)로 API를 올리고, `curl -s http://127.0.0.1:3000/readyz`가 ready인 것을 본 뒤 `docker compose -f infra/compose.yml --profile apps up -d egress-proxy`로 proxy를 올린다. 새 API는 이 필드가 없는 옛 proxy의 보고도 받는다.
  - 4.6 이전 모델(Opus 4.5·4, Sonnet 4.5·4, Haiku 4.5)은 `inference_geo`를 받지 않으므로 geo와 상관없이 표준 단가로 센다. 이 모델들의 창은 200K이고 공개된 long-context 단가가 없다. 그래서 input·cache write·cache read 합이 200K를 넘는 호출은 최고 단가로 센다(`priced_by=fallback`). 4.6 이후 모델은 1M 전체가 표준 단가다.
  - batch는 credential route가 `/v1/messages/batches`를 열지 않아서 해당이 없다.
- 토큰 상한은 `provider_usage` 한 줄의 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`를 `sessions.provider_tokens`에 더해 센다. 더하는 일은 `provider_usage` insert trigger가 같은 트랜잭션에서 한다. 그래서 rollout 중이나 롤백 뒤에 0127 이전 API가 기록한 호출도 빠지지 않는다. cache read도 모델이 처리한 token이라 센다. 많게 추정한 보고는 추정치 그대로 더한다. 이 누계를 더한 migration은 기존 세션의 값을 `provider_usage` 합으로 채운다. 그 전에 SDK 값으로만 비용을 셌던 세션의 token은 채울 수 없다. 누계는 2^53-1(`Number.MAX_SAFE_INTEGER`)에서 멈춘다(migration 0129). trigger는 numeric으로 더하므로 비정상적으로 큰 token 값이 와도 오류로 usage 기록과 비용을 되돌리지 않는다.
  - SDK에는 token 예산 옵션이 없다. 그래서 turn 도중의 토큰 상한은 아래 egress 거절과 재인가만 맡는다. 상한에 닿은 뒤 열린 Messages 호출은 거절되어 turn이 `failed(budget_exceeded)`로 끝나고, 다음 turn부터는 `BUDGET_EXCEEDED`로 dispatch되지 않는다. proxy는 authorizer의 `BUDGET_EXCEEDED` 거절을 Messages 오류 형식(`message`가 `BUDGET_EXCEEDED:`로 시작)으로 전한다. 사유는 이 문구로 정하지 않는다. 엔진은 이 403을 `api_error`로 보고하고, 재인가에서 끊긴 교환도 재시도가 남지 않았으면(`PROVIDER_MAX_RETRIES=0`) 끊긴 연결 그대로 `api_error`로 보고한다. finalize는 `api_error`로 끝난 turn의 세션이 이미 상한을 넘었으면 사유를 `budget_exceeded`로, receipt 오류를 `BUDGET_EXCEEDED`로 기록하고, 엔진의 provider 진단(`provider_error`)은 비운다. 상한 아래에서 난 403은 지금처럼 `api_error`다.
- 비용 상한과 토큰 상한은 호출이 끝난 뒤에 판정한다. 동시에 열린 호출은 모두 인가를 통과할 수 있고, 진행 중인 turn은 상한을 넘을 수 있다.
- 누적 비용이나 누적 token이 상한 이상인 세션의 provider egress token은 authorizer가 403 `BUDGET_EXCEEDED`로 거절한다. 새 provider 교환은 곧바로 거절되고, 이미 열린 교환은 다음 재인가(30초 주기)에서 끊긴다. repository·object store route는 거절하지 않는다.

### 과금 없는 profile (`billing: none`)

자체 호스팅 모델(Ollama, 사설망의 LiteLLM 등)은 토큰당 청구가 없다. 가격표에도 없어서 그대로 두면 fallback 최고 단가로 계산되고, `SESSION_COST_LIMIT_USD`와 SDK `maxBudgetUsd`에 걸려 turn이 끊긴다. 이런 profile은 `provider.billing: none`으로 선언한다.

```yaml
provider:
  kind: litellm
  endpoint: http://litellm:4000
  billing: none
  auth:
    kind: bearer
    value_env: LITELLM_MASTER_KEY
```

- 생략하면 `per_token`이다. 생략한 profile과 `per_token`이라고 적은 profile은 fingerprint가 같고, 지금과 똑같이 가격표·fallback으로 계산한다.
- `none` profile로 만든 세션의 provider 호출은 응답이 어떤 model 이름을 대든 비용 0, ledger `priced_by=unmetered`로 적힌다. 토큰은 그대로 적힌다. 세션 비용이 늘지 않으므로 비용 상한 판정 네 곳(egress 인가, `nextInput`, 메시지 접수, 엔진)에 걸리지 않는다.
- claim의 `remaining_budget_usd`는 `null`이고 worker는 SDK에 `maxBudgetUsd`를 넘기지 않는다. SDK는 모르는 model을 자체 추정 단가로 계산해 예산에서 turn을 끊기 때문이다. 묶을 예산이 없으므로 `/clear` 등으로 SDK의 비용 집계가 다시 시작돼도 worker는 drain하지 않는다.
- `GET /v1/sessions/{id}/usage`는 `cost.kind: "unmetered"`로 답한다. `amount_usd`는 `"0.000000"`이다. 이 세션에는 비용 상한이 적용되지 않으므로 `cost_limit_usd`는 `null`이다. 상한 도달 안내(`attention.reason`)에도 달러 상한은 나오지 않는다. `budget_exceeded`는 토큰 상한에 닿았을 때만 `true`가 된다.
- 과금 여부는 세션을 만들 때 세션 행(`sessions.unmetered`)에 고정된다. 가격·claim 예산·usage 표시는 이 값을 읽고, 보고를 받은 API의 카탈로그는 보지 않는다. 그래서 rolling update 중 그 profile을 모르는 replica가 보고를 받아도 비용이 붙지 않는다. `billing`을 바꾸면 fingerprint가 바뀌므로 새 id로 추가한다(같은 id를 고치면 기존 세션은 `CATALOG_MISMATCH`가 된다).
- `none` profile로 세션을 만드는 것은 모든 API replica와 모든 scheduler의 `WORKER_IMAGE`를 이 버전으로 올린 뒤에 한다. 옛 API는 `unmetered` 세션의 보고도 가격표로 계산하고, 옛 worker는 claim의 `remaining_budget_usd: null`을 계약 위반으로 거절해 엔진을 띄우지 못한다. 같은 이유로 `unmetered` 세션이 남아 있는 동안에는 API·worker를 옛 버전으로 되돌리지 않는다.
- 토큰 상한(`SESSION_TOKEN_LIMIT`)과 시간·동시성 상한(`MAX_TURN_SECONDS`, `EXECUTION_SLOT_LIMIT`, `QUEUED_INPUT_LIMIT_PER_SESSION`)은 그대로 걸린다. `unmetered` 행의 토큰도 `sessions.provider_tokens`에 더해진다.
- API는 endpoint host가 사설 주소(10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, 169.254/16, `::1`, fc00::/7, fe80::/10)이거나 공개 DNS에 없는 이름(점 없는 compose 서비스 이름, `localhost`, `.internal`·`.local`·`.localhost`·`.lan`·`.home.arpa`)일 때만 `none`을 받는다. 그 밖이면 기동하지 않는다. egress proxy 쪽에서는 그 host를 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 둔다.
- 사설 주소는 필요조건일 뿐이다. 사설망의 LiteLLM도 유료 upstream을 대리할 수 있다. `none` 선언이 맞는지는 운영자가 책임진다. 잘못 선언하면 유료 호출이 비용 상한 없이 나간다. `SESSION_TOKEN_LIMIT`을 설정해 두면 그때도 세션당 토큰은 묶인다. Datadog `agent_platform.provider.unmetered_tokens_1h`(최근 1시간 `unmetered` 행 토큰 합)와 provider 콘솔의 사용량을 같이 본다.

## API 설정

API는 설치 상한 말고도 아래 값을 기동 때 한 parser(`apps/control-host/src/api/api-settings.ts`)로 읽는다. 설정하지 않으면 기본값을 쓴다. 설정했는데 틀린 값이면(빈 문자열 포함) 기본값으로 돌아가지 않는다. 숫자 설정은 API·scheduler·reconciler·worker와 설치 상한이 모두 이 규칙을 따른다(`packages/contracts/src/shared/settings.ts`). 기본값이 없는 값은 설정하지 않으면 `X is required`로, 틀린 값은 `X must be a positive integer`처럼 기대한 범위를 적어 거부한다. 받은 값은 적지 않는다. 로그에 남고, 다른 변수에 잘못 넣은 비밀일 수 있어서다. 이때 `Refusing to start: API settings are invalid` 한 줄에 문제를 모두 남기고 기동하지 않는다. 떠 있는 API의 `/readyz`도 같은 검증을 `config` 체크로 다시 수행한다.

| 변수 | 기본값 | 허용 범위 |
|---|---|---|
| `HEARTBEAT_TTL_SEC` | 30 | 20 초과 86400 이하. worker는 lease가 끝나기 10초 전에 lease를 내려놓고(`WORKER_LEASE_SAFETY_MARGIN_SEC`), 5초마다 heartbeat를 보낸다(`WORKER_HEARTBEAT_INTERVAL_SEC`, 이전 버전 worker는 10초). 마진과 10초의 합 이하이면 이전 버전 worker의 attempt가 첫 heartbeat 무렵 lease를 잃는다. launcher는 두 worker 값을 넘기지 않으므로 기본값을 기준으로 판정한다 |
| `PENDING_REQUEST_TTL_SEC` | 1800 | 정수 1–604800. 승인·질문 요청을 받는 기간이다. 등록된 요청은 worker가 이 값만큼 기다린다. worker의 `QUESTION_TIMEOUT_SEC`는 gateway가 등록을 확인하기 전에만 적용된다. turn 벽시계 `MAX_TURN_SECONDS`에는 대기 시간도 들어가므로, 대기는 그 상한을 넘지 못한다 |
| `SSE_MAX_STREAMS` · `SSE_MAX_STREAMS_PER_OWNER` · `SSE_REPLAY_MAX_BYTES` | 256 · 8 · 1 MiB | 양의 정수 |
| `LOG_LEVEL` | `info` | `debug`·`info`·`warn`·`error`(대소문자 무관, 빈 값은 `info`). scheduler·reconciler loop와 egress-proxy도 같은 규칙으로 기동을 거부한다. worker는 scheduler의 값을 받는다 |
| `WEB_DIST_DIR` | 없음(웹 콘솔을 서빙하지 않음). control-host 이미지는 `/app/apps/web/dist` | `index.html`이 있는 절대 경로. 웹 콘솔(`apps/web`)의 빌드 결과다 |

모든 `/v1` 응답은 `api.request.completed`를 남긴다. 실제 id가 없는 Hono `route_template`, `method`, `status`, 인증과 route 처리를 포함한 `duration_ms`, `operation=api_request`, `outcome`, `reason_code`가 있고 `request_id`는 log context에 있다. request body·credential·provider key는 넣지 않는다. terminate 요청은 같은 `request_id`의 `Terminate control transaction completed`도 남기며, 여기에는 pool checkout, binding·launch·session lock, 각 SQL, commit 또는 rollback, control transaction 전체의 millisecond 계측이 들어간다. 배포 환경에서 수락 지연을 조사할 때는 두 로그를 `request_id`로 묶어 어느 단계가 느렸는지 판단한다.

terminate가 이미 사라진 execution에서 즉시 끝나거나 scheduler/reconciler가 execution 부재를 확인하면 `control.result`가 `operation=terminate`, receipt id인 `control_id`, `outcome`, `reason_code`, durable 수락부터 확인까지의 `effect_ms`(`duration_ms`와 같음)를 남긴다. 기한을 넘긴 receipt는 먼저 `outcome=unknown`·`reason_code=deadline_exceeded`를 남기며, 이후 execution 부재를 확인해 receipt를 성공으로 올리면 `outcome=succeeded`·`reason_code=execution_gone` 결과를 추가로 남긴다.

`WEB_DIST_DIR`가 있으면 API가 웹 콘솔을 같은 origin에서 서빙한다. `/v1`·`/internal` 밖의 GET·HEAD는 그 디렉터리의 파일을 돌려주고, 파일이 없으면 `index.html`을 돌려준다(SPA fallback). 그래서 `/login`·`/bootstrap`을 새로고침해도 화면이 열린다. `/v1`·`/internal` 아래는 fallback하지 않는다. 인증된 `/v1/nope`는 JSON `404 NOT_FOUND`다. `/assets/` 아래 파일은 content hash가 붙은 이름이라 `immutable`로 캐시하고, 없는 asset은 페이지 대신 404를 준다. `index.html`은 `no-cache`이며 inline script를 허용하지 않는 CSP(`script-src 'self'`)를 붙인다. control-host 이미지는 `web` build stage에서 `apps/web`을 빌드하고 `dist/`만 담는다. 별도 web 이미지는 없다. 로컬에서 웹만 고칠 때는 `bun run --cwd apps/web dev`(Vite, `/v1`을 `VITE_API_TARGET` 기본 `http://127.0.0.1:3000`으로 proxy)를 쓴다.

`AUTH_MODE=none`은 egress authorizer(`EGRESS_AUTHORIZER_PORT`)와 함께 쓸 수 없다. authorizer가 켜져 있다는 것은 worker가 proxy를 거쳐 이 API에 닿는다는 뜻이다. `none` 모드에서는 worker 안의 코드가 `X-Owner-Id`로 아무 owner나 행세할 수 있으므로 기동을 거부한다. `AUTH_MODE` 값 자체(`none`|`api-key`)는 readiness가 판정한다.

worker도 기동 때 교차 검사를 한다. `WORKER_PROVIDER_MAX_RETRIES`가 없으면 기동하지 않는다. 코드 기본값이 없는 설치 상한이고, scheduler가 항상 넘긴다. `WORKER_NEXT_INPUT_WAIT_SEC`가 `WORKER_REQUEST_TIMEOUT_SEC` 이상이어도 기동하지 않는다. 그 설정에서는 모든 long poll이 요청 timeout에 잘린다. scheduler와 reconciler는 빈 `DATABASE_URL`을 설정하지 않은 것으로 보고 `QUEUE_DATABASE_URL`을 쓴다.

`WERFT_API_KEY`·`WERFT_BASE_URL`은 서버 설정이 아니다. TypeScript SDK(`packages/sdk`)를 쓰는 호출자 쪽 스크립트가 읽는 값이고, SDK 예제는 `WERFT_PROFILE_ID`·`WERFT_REPOSITORY_ID`도 읽는다([TypeScript SDK](../sdk.md)).

## scheduler·worker 컨테이너·egress 설정

scheduler가 worker 컨테이너를 만들 때 읽는 값이다. 없으면 기본값을 쓰고, 형식이 틀리면 기동하지 않는다. user, HOME·workspace 경로, tmpfs 크기, credential 포트, stop timeout은 `agent-platform.isolation` 지문에 들어간다([실행 기반과 worker 격리](execution.md#reconcilerscheduler와-worker-격리)). 그래서 바꾸면 실행 중인 worker가 교체된다. CPU·메모리·PID 한도는 다음 launch부터 적용된다.

`WORKER_MEMORY_MB`는 transcript 상한(`MAX_TRANSCRIPT_BYTES`)과 함께 정한 값이다. 둘의 관계, 실측, 노드당 세션 수, 바꾸는 방법은 [capacity.md](capacity.md)에 있다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `WORKER_CPUS` | 1 | worker 하나의 CPU 몫. 0.01 이상 |
| `WORKER_MEMORY_MB` | 4608 | worker 하나의 메모리 한도(MiB). 압축 없는 512MiB transcript를 resume한 엔진이 한도의 절반 아래에 들도록 잡은 값이다 |
| `WORKER_PIDS_LIMIT` | 512 | worker 하나의 PID 한도. compose는 넘기지 않는다 |
| `EXECUTION_DOCKER_USER` | `1000:1000` | worker의 숫자 `uid[:gid]`. uid나 gid가 0이면 기동을 거부한다. worker 이미지의 `/workspace` 소유자와 같아야 한다 |
| `EXECUTION_DOCKER_HOME_DIR` | `/home/worker` | tmpfs로 마운트하는 HOME. 절대 경로 |
| `EXECUTION_DOCKER_WORKSPACE_DIR` | `/workspace` | 세션 volume을 마운트하는 곳. 절대 경로이고 HOME과 달라야 하며 공백·역슬래시를 쓸 수 없다. worker에는 `WORKER_WORKSPACE_DIR`로 간다 |
| `EXECUTION_DOCKER_TMPFS_SIZE_MB` | 256 | HOME과 `/tmp` tmpfs 각각의 크기(MiB) |
| `EXECUTION_DOCKER_STOP_TIMEOUT_SEC` | 120 | SIGTERM에서 SIGKILL까지의 유예. 30 미만이면 기동을 거부한다. worker에는 `WORKER_STOP_GRACE_SEC`로 가고, worker는 drain을 그 안에 맞춘다 |
| `EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC` | 30 | Docker Engine API 요청 하나의 기한 |
| `EXECUTION_DOCKER_COMMAND` | 없음 | 이미지 entrypoint 대신 돌릴 명령(공백으로 나눈다). 테스트용이다 |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker daemon 주소 |
| `DOCKER_API_VERSION` | `v1.44` | 요청에 쓰는 Engine API 버전 |
| `EXECUTION_EGRESS_CREDENTIAL_PORT` | 3129 | proxy credential route의 포트. proxy의 `EGRESS_CREDENTIAL_PORT`와 같아야 하고, `EXECUTION_EGRESS_PROXY_URL`의 포트와는 달라야 한다 |

`EXECUTION_DOCKER_NETWORK`·`EXECUTION_DOCKER_NETWORK_ALLOWLIST`는 더 이상 읽지 않는다. 값이 있으면 기동을 거부한다.

egress-proxy와 API의 authorizer listener는 아래 값을 읽는다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `EGRESS_PROXY_HOST` | `0.0.0.0` | proxy의 두 listener(forward, credential route)가 여는 주소 |
| `EGRESS_PROXY_PORT` | 3128 | forward proxy 포트 |
| `EGRESS_CREDENTIAL_PORT` | 3129 | credential route 포트 |
| `LOG_LEVEL` | `info` | proxy 로그 수준. 규칙은 위 API 설정과 같다 |
| `EGRESS_AUTHORIZER_HOST` | `0.0.0.0` | API의 authorizer listener(`EGRESS_AUTHORIZER_PORT`)가 여는 주소 |

compose의 세 포트와 두 내부 URL은 `infra/compose.core.yml` 상단의 `x-egress-ports` 한 곳에서 정한다. proxy의 `EGRESS_PROXY_PORT`·`EGRESS_CREDENTIAL_PORT`·`EGRESS_AUTHORIZER_URL`, api의 `EGRESS_AUTHORIZER_PORT`, scheduler의 `EXECUTION_EGRESS_PROXY_URL`·`EXECUTION_EGRESS_CREDENTIAL_PORT`는 모두 그 anchor를 쓴다. 포트를 바꿀 때는 같은 블록의 listener와 URL 짝을 함께 바꾼다. `tests/images.test.ts`가 `docker compose config` 결과에서 두 URL의 포트와 세 listener가 맞는지 확인한다.

API 컨테이너의 메모리는 checkpoint bundle 검증이 정한다. 검증은 동시에 두 개까지 돌고, 검증마다 git fetch와 index-pack이 각자 `CHECKPOINT_GIT_MEMORY_MB`의 주소 공간 상한 아래에서 함께 돈다. 두 값은 함께 바꾼다. 상한만 올리면 OOM killer가 무엇을 죽일지 정하게 된다. 계산은 `infra/compose.core.yml`의 api 서비스 주석에 있다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `API_MEMORY_MB` | 7168 | compose api 컨테이너의 `mem_limit`(MiB) |
| `CHECKPOINT_GIT_MEMORY_MB` | 1536 | bundle 검증 git 프로세스 하나의 주소 공간 상한(MiB). 512 미만이면 기동을 거부한다 |

compose의 Postgres는 `POSTGRES_USER`(`postgres`)·`POSTGRES_PASSWORD`(`dev`)·`POSTGRES_DB`(`sessions`)로 만들고, 모든 서비스가 같은 값으로 DSN을 만든다. 로컬 Gitea 예시 저장소의 agent 사용자 비밀번호는 `GITEA_AGENT_PASSWORD`이고, 비워 두면 아무도 모르는 무작위 값이 된다.

worker는 아래 값도 env로 읽는다. 하지만 scheduler가 넘기지 않으므로 운영에서는 코드 기본값으로 고정이다. `WORKER_ANSWER_POLL_SEC`(1), `WORKER_CLAIM_TIMEOUT_SEC`(60), `WORKER_DRAIN_TIMEOUT_SEC`(100, stop 유예 안으로 줄어든다), `WORKER_HEARTBEAT_INTERVAL_SEC`(5), `WORKER_IDLE_TIMEOUT_SEC`(1800), `WORKER_LEASE_SAFETY_MARGIN_SEC`(10), `WORKER_NEXT_INPUT_RETRY_SEC`(60), `WORKER_NEXT_INPUT_WAIT_SEC`(20), `WORKER_REQUEST_TIMEOUT_SEC`(30), `WORKER_STARTUP_TIMEOUT_SEC`(3600), `QUESTION_TIMEOUT_SEC`(1800), `WORKER_CLAUDE_CONFIG_DIR`(`$HOME/.claude`).

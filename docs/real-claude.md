# 실제 Claude로 확인하기

[quickstart](quickstart.md)의 로컬 스택을 fake 대신 실제 Messages API에 붙이는 방법 둘을 다룬다.

- **A. 유료 e2e 한 번**: `tests/e2e/run.sh --real-model`. 스택을 띄우고 정해진 시나리오를 돌린 뒤 스스로 지운다.
- **B. 직접 대화**: `scripts/local.sh up --real-model`. 스택을 띄워 두고 curl로 자유 문장을 보낸다.

둘 다 같은 overlay(`infra/compose.real-model.yml`)와 카탈로그(`config/real-model/`)를 쓴다. 필요한 것은 **실행하는 사람 본인의 Anthropic API key** 하나다([94S-376](https://linear.app/94soon/issue/94S-376)). AWS 계정은 필요 없다(S3·Secrets Manager는 그대로 LocalStack이다). 유료 호출이므로 CI에서는 돌지 않는다. 실 AWS S3까지 쓰는 확인은 [94S-303](https://linear.app/94soon/issue/94S-303)이다.

준비물은 [quickstart 0장](quickstart.md#0-준비물)과 같고, Docker Compose는 **2.24.6 이상**이어야 한다(`include`로 합친 스택 위에 overlay를 겹친다). B는 quickstart 2장의 curl 헬퍼를 쓴다.

## overlay가 바꾸는 것

- API가 `config/real-model/`의 카탈로그를 읽는다. profile은 `claude-coding-real` 하나이고, `claude-sonnet-5`로 `https://api.anthropic.com`을 부른다. 이 카탈로그에는 fake를 가리키는 profile이 없다.
- key는 셸의 `ANTHROPIC_API_KEY`에서 **API 컨테이너에만** 이름으로 전달된다. compose 파일과 명령 인자 어디에도 값이 없다. worker는 attempt 범위의 egress token만 받고, egress proxy가 `api.anthropic.com:443`(기본 `EGRESS_CREDENTIAL_ALLOWLIST`)으로 나가는 요청에 key를 붙인다([94S-252](https://linear.app/94soon/issue/94S-252)).
- 상한: `SESSION_COST_LIMIT_USD=1`(세션당 1달러), `MAX_TURN_SECONDS=600`(turn당 600초). A와 B가 같은 값을 쓴다.

`ANTHROPIC_API_KEY`가 export되지 않았거나 비어 있으면 두 명령 모두 Docker를 건드리기 전에 exit 2로 끝난다. fake로 대신 뜨지 않는다.

## key 입력과 폐기

이 용도로 쓸 **전용 key**를 만들고 Console에서 workspace 지출 한도를 걸어 두기를 권한다. 상한은 세션마다 따로 걸리므로 세션을 여러 개 만들면 합계는 상한보다 커질 수 있다.

key는 셸 history에 남지 않도록 `read -rs`로 입력받는다. A와 B 모두 이 세 줄로 시작한다.

```sh
printf 'Anthropic API key: '
read -rs ANTHROPIC_API_KEY
echo
```

- 명령을 실행한 뒤에는 `unset ANTHROPIC_API_KEY`로 셸에서 지운다. B는 `up`이 끝나면 key가 이미 API 컨테이너에 넘어가 있으므로 바로 지워도 된다.
- 스택이 떠 있는 동안에는 API 컨테이너 설정(`docker inspect`)에 key가 있다. 다 쓰면 스택을 내린다(A는 스스로, B는 `scripts/local.sh down`).
- 다 쓴 key는 Console의 API Keys에서 비활성화하거나 삭제한다.

## A. 명령 하나로 real-model e2e

```sh
export ANTHROPIC_API_KEY
tests/e2e/run.sh --real-model
unset ANTHROPIC_API_KEY
```

`run.sh`는 평소 e2e와 같은 스택을 자기 compose project와 루프백 임시 포트로 띄워 overlay를 얹고, 스크립트된 스위트 대신 `tests/e2e/real-model.e2e.ts`를 돈다. 끝나면 자기가 만든 것을 모두 지운다. 1장 스택과 겹치지 않는다.

**무엇을 확인하나.** 모델의 문장은 보지 않는다. 도구 결과(저장소 상태)와 플랫폼 기록을 본다.

1. turn 1: 샘플 저장소에 파일을 만들고 커밋한다. 권한 요청은 테스트가 허용한다.
2. turn 2: 같은 worker에서 `git log`와 `cat`으로 그 커밋을 읽는다.
3. pause: checkpoint가 turn 2까지 덮는다.
4. resume 후 turn 3: 새 worker(turn 1과 겹치는 attempt 없음)에서 같은 커밋 hash와 파일 내용이 나오고, Claude Code 세션 id가 turn 1과 같다.
5. `GET /v1/sessions/{id}/usage`: 세 turn 모두 비용을 보고했고(`complete: true`) 금액이 0보다 크며 상한을 넘지 않았다. `cost_limit_usd`는 `GET /v1/limits`와 같다.

run record(`E2E_OUT`, 끝에 경로를 출력한다)의 `record.txt`에는 tested SHA, 이미지 id, SDK·Claude Code 버전과 함께 `model`, `provider_endpoint`, `session_cost_limit_usd`가 남는다. `test.log`에는 세션 id, 커밋, attempt, 실제 비용을 담은 `real_model` JSON 한 줄이 남는다. 성공하면 `tests: pass=1 skip=0 fail=0`이다.

`run.sh`는 끝날 때 `E2E_OUT` 전체(compose 로그, 모든 worker 로그, run record, 테스트 출력)에서 key 값을 찾는다. 하나라도 나오면 파일 이름만 출력하고 실행을 실패시킨다. key 값은 어떤 로그에도 출력되지 않는다. `E2E_KEEP=1`로 스택을 남겼다면 끝에 출력되는 `kept: compose project <project>, installation <installation>`의 두 값으로 직접 지운다. scheduler가 만든 worker 컨테이너·네트워크·workspace volume은 compose 소유가 아니므로 label로 지우고, run.sh가 tag를 붙인 이미지 셋은 이름으로 지운다.

```sh
P='e2e-123456789'; I='e2e123456789'   # kept: 줄의 project와 installation 값으로 바꾼다
docker compose -p "$P" -f infra/docker-compose.yml -f tests/e2e/compose.yml \
  -f infra/compose.real-model.yml --profile apps down -v --remove-orphans --rmi local
docker ps -aq --filter "label=agent-platform.installation=$I" | xargs -r docker rm -f
docker network ls -q --filter "label=agent-platform.installation=$I" | xargs -r docker network rm
docker volume ls -q --filter "label=agent-platform.installation=$I" | xargs -r docker volume rm
docker image rm "agent-platform-control-host:$P" "agent-platform-worker:$P" "agent-platform-egress-proxy:$P"
```

## B. 실제 Claude와 직접 대화하기

스택을 띄워 두고 대본 없이 자유 문장을 보낸다. fake 스택과 같은 project(`agent-platform`)와 포트를 쓰므로 둘을 동시에 띄울 수 없다. fake 스택이 떠 있을 때 실행하면 api와 scheduler만 real 카탈로그로 다시 만들어진다. 그 전에 만든 fake 세션은 카탈로그에 profile이 없으므로 다음 메시지부터 `CATALOG_MISMATCH`로 실패한다([operations.md](operations.md#운영자-카탈로그-agent-profile--repository)). 처음부터 하려면 `up` 대신 `scripts/local.sh reset --real-model`을 쓴다(기존 세션과 데이터가 지워진다). 옵션 없이 `scripts/local.sh up`을 다시 실행하면 fake 카탈로그로 돌아가고 API 컨테이너에서 key도 빠진다.

**1. 스택 띄우기.** key 입력 세 줄 뒤에 이어서 붙여 넣는다.

```sh
export ANTHROPIC_API_KEY
scripts/local.sh up --real-model
unset ANTHROPIC_API_KEY
KEY=$(scripts/local.sh key real-claude \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover)
echo "${KEY:0:12}…"
```

`up`은 quickstart 1장과 같이 `/readyz`가 ready가 될 때까지 기다린 뒤 끝난다.

**2. 헬퍼 설정.** [quickstart 2장](quickstart.md#2-curl-준비)의 블록을 같은 터미널에 그대로 붙여 넣은 다음, 세션을 만드는 `body`만 real profile로 바꾼다.

```sh
body() { jq -nc --arg m "$1" '{profile_id:"claude-coding-real", repository_id:"sample-app", message:$m}'; }
```

**3. 대화 시작.** 샘플 저장소에는 제목 한 줄짜리 `README.md`뿐이라 요약을 시키면 "내용이 없다"는 답이 온다. 파일을 만드는 요청으로 시작한다.

```sh
created=$(post /v1/sessions "$(body 'hello.py에 인사를 출력하는 스크립트를 만들고, README에 실행 방법을 적은 뒤 커밋해 주세요')")
echo "$created" | jq .
SID=$(echo "$created" | jq -r .session_id)
```

파일을 바꾸려 하면 권한 요청(`kind: "permission"`)이 오고 세션이 `needs_input`이 된다. quickstart ③·④와 같은 방법으로 허용한다. 권한 요청 자체는 30분 뒤에 만료되지만 이 overlay는 turn을 600초로 제한하므로, turn이 시작된 뒤 10분 안에 답해야 한다. 요청은 여러 번 올 수 있으니 turn이 끝날 때까지 되풀이한다.

```sh
wait_for "/v1/sessions/$SID" .status needs_input
get "/v1/sessions/$SID/pending-requests" | jq '.items[] | {request_id, kind, tool, input}'
REQ=$(get "/v1/sessions/$SID/pending-requests" | jq -r '.items[0].request_id')
post "/v1/sessions/$SID/answers" "$(jq -nc --arg r "$REQ" '{request_id:$r, kind:"permission", decision:"allow"}')" | jq .
```

대화 흐름을 보려면 다른 터미널에서 이벤트 스트림을 연다(Ctrl-C로 닫는다): `curl -sSN "$API/v1/sessions/$SID/events" -H "Authorization: Bearer $KEY"`.

커밋 작성자는 워커 이미지의 기본값 `agent-platform <noreply@agent-platform.invalid>`다([94S-423](https://linear.app/94soon/issue/94S-423)). 그래서 요청에 git 사용자 이름과 이메일을 적지 않아도 Claude가 커밋한다. 결과는 Gitea(`http://127.0.0.1:3001`)의 `agent/sample-app`에서 볼 수 있다.

**4. pause → resume 뒤 이어서 대화.** turn이 끝나 세션이 `idle`이 되면 quickstart ⑦·⑧과 같이 멈췄다 되살린다. 새 worker가 checkpoint에서 저장소와 Claude Code 세션을 복원하므로 앞의 대화를 기억한다.

```sh
wait_for "/v1/sessions/$SID" .status idle
post "/v1/sessions/$SID/pause" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r, reason:"real-claude"}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state paused
post "/v1/sessions/$SID/resume" "$(jq -nc --argjson r "$(revision)" '{expected_revision:$r}')" | jq .
wait_for "/v1/sessions/$SID" .admission_state active
post "/v1/sessions/$SID/messages" "$(say '방금 만든 커밋의 hash와 hello.py 내용을 알려 주세요')" | jq .
```

후속 메시지는 모두 `post "/v1/sessions/$SID/messages" "$(say '…')"`로 보낸다. 지금까지 든 비용은 `get "/v1/sessions/$SID/usage" | jq .`로 본다.

**5. 정리.**

```sh
scripts/local.sh down
```

스택과 모든 데이터(세션, checkpoint, API key, Gitea 저장소)를 지운다. key를 가진 API 컨테이너도 이때 사라진다. 마지막으로 Console에서 key를 비활성화한다.

## 비용

Sonnet 5 기준(100만 토큰당 입력 2달러, 출력 10달러, 캐시 쓰기 2.5달러, 캐시 읽기 0.2달러) 추정치다. Claude Code 요청 하나는 system prompt와 도구 정의로 약 2만5천 토큰이다.

- A는 turn 세 개에 모델 호출이 10번 안팎이다. 캐시가 맞으면 한 번 실행에 약 0.2달러이고, 캐시가 전혀 맞지 않아도 0.6달러를 넘지 않을 것으로 본다. 이미지 빌드까지 합쳐 처음에는 10분 남짓 걸린다.
- B는 보내는 메시지만큼 든다. 위 예시(turn 두 개)는 A와 비슷한 규모다.
- 상한은 세션당 1달러다. SDK가 호출이 끝날 때마다 누적 비용을 확인하므로 마지막 호출 하나만큼은 넘을 수 있다. 넘으면 그 turn이 `budget_exceeded`로 실패한다. B에서는 새 세션을 만들면 다시 1달러가 생긴다.

실제로 든 비용은 A는 `test.log`의 `cost_usd`, B는 세션의 `usage`에 있다. 둘 다 egress proxy가 계측한 usage를 플랫폼 가격표로 환산한 추정치다(94S-409). 청구액은 Console에서 확인한다.

## 막혔을 때

| 증상 | 원인과 조치 |
|---|---|
| `--real-model`이 바로 exit 2로 끝난다 | `ANTHROPIC_API_KEY`가 export되지 않았거나 비었다. [key 입력](#key-입력과-폐기) 세 줄과 `export ANTHROPIC_API_KEY`를 같은 셸에서 한 뒤 다시 실행한다 |
| `local.sh up --real-model`이 `too old for --real-model`로 끝난다 | Docker Compose가 2.24.6보다 낮다. 2.24.0–2.24.5는 `include` 위의 overlay를 `conflicts with imported resource`로 거부한다. compose를 올린다 |
| turn이 `budget_exceeded`로 실패한다 | 세션 비용이 1달러 상한을 넘었다. 새 세션을 만든다 |
| 그 밖의 증상 | [quickstart 8장](quickstart.md#8-막혔을-때)을 본다 |

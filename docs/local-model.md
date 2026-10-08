# 로컬 모델(Ollama·LiteLLM)로 확인하기

[real-model e2e](real-claude.md#a-명령-하나로-real-model-e2e)와 같은 시나리오(세션 생성 → tool로 commit → 두 번째 turn → pause와 checkpoint → 새 worker에서 재개)를 Anthropic API 대신 이 컴퓨터의 Ollama 모델로 돌린다. 유료 호출이 없어 key 없이 몇 번이고 돌릴 수 있다.

```sh
tests/e2e/run.sh --local-model
```

## 준비물

- [quickstart 0장](quickstart.md#0-준비물)과 같은 Docker·bun.
- `127.0.0.1:11434`에서 도는 Ollama와 `gemma4:26b-mlx` 모델. 다른 모델을 쓰려면 `config/local-model/profiles.yaml`의 `model`과 `infra/local-model/litellm.yaml`의 `model`을 함께 바꾼다.
- Ollama가 응답하지 않으면 Docker를 건드리기 전에 exit 2로 끝난다.

## overlay가 바꾸는 것

`infra/compose.local-model.yml`이 로컬 스택 위에 겹친다.

- API가 `config/local-model/`의 카탈로그를 읽는다. profile은 둘이고 같은 모델을 다른 길로 부른다.
  - `local-ollama`: Ollama의 Anthropic 호환 `/v1/messages`를 직접 부른다. Ollama는 key를 검사하지 않으므로 `LOCAL_OLLAMA_API_KEY`는 아무 값이면 된다(기본 `ollama-local`).
  - `local-litellm`: overlay의 `litellm` 서비스(LiteLLM proxy, `infra/local-model/litellm.yaml`)를 Bearer로 부르고, LiteLLM이 Ollama로 넘긴다. `LITELLM_MASTER_KEY`는 셸에 없으면 실행마다 새로 만든다.
- 두 key 모두 이름으로만 전달된다. 값은 API(그리고 LiteLLM)에만 있고 worker는 egress token만 받는다.
- egress proxy의 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 `ollama.internal:11434`와 `litellm:4000`을 더한다. 둘 다 credential route로만 닿고 forward proxy 목록에는 없다.
- suite는 `tests/e2e/real-model.e2e.ts` 하나를 두 profile에 한 번씩 돌린다(`E2E_PROFILE_IDS`).

### 호스트의 Ollama를 relay로 부르는 이유

egress proxy는 `host.docker.internal`로 바로 가지 못한다. OrbStack에서는 이 이름이 `0.250.250.254`로 풀리는데, 이 주소는 `0.0.0.0/8`이라 proxy 정책이 항상 거부한다(`apps/egress-proxy/src/policy.ts`). 그래서 compose 네트워크 안의 `ollama` 서비스(socat)가 호스트의 Ollama로 TCP를 그대로 넘기고, proxy는 사설 주소의 서비스 이름으로 닿는다.

relay는 `ollama.internal`이라는 별칭으로 부른다. loopback에 바인딩된 Ollama는 Host 헤더가 loopback·`*.localhost`·`*.local`·`*.internal`이 아니면 403을 돌려주기 때문이다. 이 403은 엔진에 `authentication_failed`로 보이므로, 원인은 egress proxy 로그의 provider route status로 확인한다.

## 결과를 읽는 법

- 통과는 연결과 프로토콜이 된다는 뜻이다. tool_use, permission, transcript 보관, checkpoint, 새 worker에서 재개가 로컬 모델로도 돈다. 모델이 열린 과제를 얼마나 잘 하는지는 따로 봐야 한다. 이 시나리오는 정해진 명령 하나를 실행시킬 뿐이다.
- 약한 모델은 tool을 한 번 부른 뒤 결과를 보고하지 않고 turn을 끝낼 수 있다. 엔진은 이것을 정상 종료로 기록하므로 turn이 `completed`라도 과제가 끝났다는 뜻은 아니다. 여러 단계가 필요한 과제는 저장소 상태로 결과를 확인한다.
- 비용은 실제 비용이 아니다. 가격표(`packages/platform/src/limits/model-prices.ts`)에 없는 모델이라 가장 비싼 단가로 추정한다. Ollama는 prompt cache를 `cache_read_input_tokens`로 보고하지만 LiteLLM 경로는 전부 `input_tokens`로 보고해서, 같은 대화라도 LiteLLM 쪽 추정치가 몇 배 크다. 세션 상한은 compose 기본값 `SESSION_COST_LIMIT_USD=25`이다.
- LiteLLM의 `num_ctx`는 MLX runner(`gemma4:26b-mlx`)에 반영되지 않는다. context 길이는 Ollama가 모델을 올린 값을 따른다.

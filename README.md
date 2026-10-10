# Agent Platform

이 저장소 코드의 중심은 Werft의 Kiel 모듈(세션 런타임)과 그 공개 `/v1` API다. 공식 TypeScript Claude Agent SDK 세션을 격리된 worker에서 실행하고, HTTP API·이벤트·승인·제어·checkpoint 복구로 다룬다. Werft의 다른 모듈과 개발 순서는 아래 이름 범위 문단에, 어떤 코드가 어느 모듈인지는 [architecture.md](docs/architecture.md)에 있다.

이름 범위: 제품 이름은 Agent Platform이고 저장소 이름은 agent-platform이다. Werft는 Agent Platform을 이루는 에이전트 기반 전체의 설계상 이름이고, 제품 이름을 대신하지 않는다. Werft는 네 모듈로 나뉜다. Musterrolle은 사용자·로그인·워크스페이스·역할·연동 계정과 권한 판정, Kollegium은 에이전트 정의·버전·런치와 에이전트를 부르는 웹·Slack·API 채널, Lotse는 세션끼리의 연결과 협업, Kiel은 세션 런타임(격리 실행·제어·승인·복구)을 맡는다. 지금 구현된 모듈은 Kiel이고, Musterrolle은 첫 owner bootstrap·cookie 로그인·API 키와 권한 데이터 일부가 먼저 들어와 Kiel 안에서 돈다. 개발 순서는 Musterrolle → Kollegium → Lotse다. 지금의 `/v1` API는 Kiel이 서빙하고, 그 안의 인증 경로 `/v1/auth/*`는 Musterrolle 몫이다. Kollegium의 API 채널은 앞으로 만들 에이전트 호출 입구다. 외부 도구는 Werft 안에 넣지 않고 Werft 밖의 remote MCP server에 연결해 쓰는 것이 설계 방향이다.

## 현재 상태

**신뢰된 내부 인원만 쓰는 private alpha다.** 24시간 soak는 LocalStack OOM으로 무효였고 재실행하지 않기로 결정했다. 실제 AWS S3, HTTPS, provider 호출, 장시간 부하를 포함한 남은 검증은 [실서버 배포 절차](docs/alpha-deployment.md)에 따라 서버에서 수행한다. 이 상태는 24시간 soak 통과나 외부 공개 준비 완료를 뜻하지 않는다.

provider key와 저장소·object store credential은 worker에 직접 전달하지 않지만, 살아 있는 attempt는 제한된 egress token으로 허용된 경로를 호출할 수 있다. provider key 소유 모델과 외부 공개 경계를 결정하는 [94S-376](https://linear.app/94soon/issue/94S-376)을 닫기 전에는 외부에 공개하지 않는다.

## 문서 지도

| 독자 | 먼저 읽을 문서 | 이어서 볼 문서와 파일 |
| --- | --- | --- |
| API 사용자 | [API 유즈케이스 가이드](docs/api-guide.md) | 배포 서버의 인증 없는 `GET /docs`에서 읽기 전용 API 참조를 보고, `GET /v1/openapi.json`에서 같은 사양을 받는다. 저장소 생성물은 [HTML](docs/api/index.html)과 [OpenAPI JSON](docs/openapi.json)이다 |
| 운영자 | [내부 알파 실서버 배포](docs/alpha-deployment.md) | [운영 참고](docs/operations.md), [Datadog 감시 기준](docs/monitoring-datadog.md), [Datadog compose overlay](infra/compose.datadog.yml), [test-ops](docs/test-ops.md), [백업과 복원](docs/backup-restore.md) |
| 개발자 | [Quickstart](docs/quickstart.md) | [개발 환경과 검증](docs/development.md), [구성요소와 경계](docs/architecture.md), [CI](docs/ci.md), [실제 Claude 확인](docs/real-claude.md), [과거 soak 결과](docs/soak.md) |

`docs/openapi.json`과 `docs/api/` 아래 생성물은 손으로 고치지 않는다. `bun run --cwd apps/control-host openapi:generate`로 함께 다시 만든다.

라이선스는 [LICENSE](LICENSE)를 따른다. 이 저장소는 source-available이며 오픈소스가 아니다.

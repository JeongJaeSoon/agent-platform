# Agent Platform (코드명 Kollegium)

공식 TypeScript Claude Agent SDK 세션을 격리된 worker에서 실행하고 HTTP API, 이벤트, 승인, 제어, checkpoint 복구로 다루는 세션 컨트롤 플레인이다.

## 현재 상태

**신뢰된 내부 인원만 쓰는 private alpha다.** 24시간 soak는 LocalStack OOM으로 무효였고 재실행하지 않기로 결정했다. 실제 AWS S3, HTTPS, provider 호출, 장시간 부하를 포함한 남은 검증은 [실서버 배포 절차](docs/alpha-deployment.md)에 따라 서버에서 수행한다. 이 상태는 24시간 soak 통과나 외부 공개 준비 완료를 뜻하지 않는다.

provider key와 저장소·object store credential은 worker에 직접 전달하지 않지만, 살아 있는 attempt는 제한된 egress token으로 허용된 경로를 호출할 수 있다. BYOK와 외부 공개 경계를 다루는 [94S-253](https://linear.app/94soon/issue/94S-253)을 닫기 전에는 외부에 공개하지 않는다.

## 문서 지도

| 독자 | 먼저 읽을 문서 | 이어서 볼 문서와 파일 |
| --- | --- | --- |
| API 사용자 | [API 유즈케이스 가이드](docs/api-guide.md) | [HTML API 참조](docs/api/index.html), [OpenAPI JSON](docs/openapi.json). 배포 API도 인증 전 `GET /v1/openapi.json`에서 같은 사양을 제공한다 |
| 운영자 | [내부 알파 실서버 배포](docs/alpha-deployment.md) | [운영 참고](docs/operations.md), [Datadog 감시 기준](docs/monitoring-datadog.md), [Datadog compose overlay](infra/compose.datadog.yml), [test-ops](docs/test-ops.md), [백업과 복원](docs/backup-restore.md) |
| 개발자 | [Quickstart](docs/quickstart.md) | [개발 환경과 검증](docs/development.md), [구성요소와 경계](docs/architecture.md), [CI](docs/ci.md), [실제 Claude 확인](docs/real-claude.md), [과거 soak 결과](docs/soak.md) |

`docs/openapi.json`과 `docs/api/` 아래 생성물은 손으로 고치지 않는다. `bun run --cwd packages/contracts openapi:generate`로 함께 다시 만든다.

라이선스는 [LICENSE](LICENSE)를 따른다. 이 저장소는 source-available이며 오픈소스가 아니다.

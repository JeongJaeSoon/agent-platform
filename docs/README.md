# 문서 색인

문서를 읽는 사람별로 나눴다. 운영자 문서는 `operator/`, 기여자 문서는 `contributing/`에 있다. 사용자 문서는 `docs` 바로 아래에 둔다.

## 사용자

API로 세션을 만들고 쓰는 사람.

| 문서 | 내용 |
| --- | --- |
| [Quickstart](quickstart.md) | 로컬 스택을 띄우고 curl로 세션 한 바퀴 |
| [API 유즈케이스 가이드](api-guide.md) | 유즈케이스별 API 호출 |
| [API 참조 페이지](api/index.html) | 배포 서버가 `GET /docs`로 서빙하는 읽기 전용 참조의 저장소 생성물. 페이지가 부르는 스크립트는 [api/scalar.js](api/scalar.js)다 |
| [OpenAPI 사양](openapi.json) | 서버가 `GET /v1/openapi.json`으로 내주는 사양의 저장소 생성물 |

## 운영자

서버나 Kubernetes에 설치하고 운영하는 사람.

| 문서 | 내용 |
| --- | --- |
| [단일 서버 배포](operator/server-deployment.md) | compose로 서버 한 대에 배포 |
| [Kubernetes 설치](operator/kubernetes-deployment.md) | Helm chart로 설치 |
| [운영 참고](operations.md) | 실행 기반, 구성요소별 보장, 설정값 |
| [백업과 복원](operator/backup-restore.md) | compose 설치의 백업·복원 |
| [용량 관리](operator/capacity.md) | transcript 상한, worker 메모리, 노드당 세션 수 |
| [Datadog 감시 기준](operator/monitoring-datadog.md) | Datadog Agent와 monitor |
| [세션 데이터가 흐르는 길](operator/observability.md) | 이벤트 표와 OTel 트레이스 |
| [test-ops 운영 runbook](operator/test-ops.md) | test-ops 설치의 운영 절차 |

## 기여자

이 저장소의 코드를 고치는 사람.

| 문서 | 내용 |
| --- | --- |
| [개발 환경과 검증](contributing/development.md) | 로컬 개발 환경, 테스트·스크립트 배치 |
| [구성요소와 경계](contributing/architecture.md) | 저장소 구성, 앱과 패키지의 경계 |
| [CI에서 실행되는 것](contributing/ci.md) | CI job과 그 조건 |
| [로컬 모델로 확인하기](contributing/local-model.md) | Ollama·LiteLLM으로 확인 |
| [결정: transcript 저장](contributing/decisions/session-store.md) | SessionStore를 고른 이유, 실패 계약, 그 계약을 지키는 테스트 |
| [실제 Claude로 확인하기](real-claude.md) | 실제 Claude로 스택 확인 |

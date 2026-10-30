# 문서 색인

문서를 읽는 사람별로 나눴다. 운영자 문서는 `operator/`, 기여자 문서는 `contributing/`에 있다. 사용자 문서는 `docs` 바로 아래에 둔다.

## 사용자

API로 세션을 만들고 쓰는 사람.

| 문서 | 내용 |
| --- | --- |
| [Quickstart](quickstart.md) | 로컬 스택을 띄우고 curl로 세션 한 바퀴 |
| [API 유즈케이스 가이드](api-guide.md) | 유즈케이스별 API 호출 |
| [TypeScript SDK](sdk.md) | 서버·스크립트에서 API key로 세션을 다루는 `@werft-ai/sdk` |
| [API 참조 페이지](api/index.html) | 배포 서버가 `GET /docs`로 서빙하는 읽기 전용 참조의 저장소 생성물. 페이지가 부르는 스크립트는 [api/scalar.js](api/scalar.js)다 |
| [OpenAPI 사양](openapi.json) | 서버가 `GET /v1/openapi.json`으로 내주는 사양의 저장소 생성물 |

## 운영자

서버나 Kubernetes에 설치하고 운영하는 사람.

| 문서 | 내용 |
| --- | --- |
| [단일 서버 배포](operator/server-deployment.md) | compose로 서버 한 대에 배포 |
| [Kubernetes 설치](operator/kubernetes-deployment.md) | Helm chart로 설치 |
| [실행 기반과 worker 격리](operator/execution.md) | reconciler·scheduler, 세션 실패 처리, workspace 상한과 회수, worker 네트워크 |
| [Kubernetes 실행 backend](operator/kubernetes-backend.md) | worker를 Pod로 띄울 때의 동작, chart가 넣는 env, probe |
| [API 서버](operator/api-server.md) | 운영자 카탈로그, 자격 증명, checkpoint 저장소, 인증과 권한 |
| [이미지와 공급망](operator/images-and-supply-chain.md) | 이미지와 Compose `apps` profile, 업그레이드·롤백, 취약점 정책 |
| [설정 레퍼런스](operator/configuration.md) | 설치 상한, API 설정, scheduler·worker·egress 설정 |
| [백업과 복원](operator/backup-restore.md) | compose 설치의 백업·복원 |
| [용량 관리](operator/capacity.md) | transcript 상한, worker 메모리, 노드당 세션 수 |
| [Datadog 감시 기준](operator/monitoring-datadog.md) | Datadog Agent와 monitor |
| [세션 데이터가 흐르는 길](operator/observability.md) | `events` 표, 비밀값 마스킹, 보존 기간, 예제 OTLP 수집기 |
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
| [결정: Agent SDK 버전](contributing/decisions/agent-sdk.md) | SDK·LiteLLM 버전 고정 방식, 운영 제약, 호환 harness가 지키는 계약과 실행 방법 |
| [결정: GitHub Packages와 App token](contributing/decisions/github-packages-app-token.md) | App installation token으로 사설 npm·gem을 읽을 수 있는지의 실측 결과, 94S-1096 진행 여부, 안 될 때의 대안 |
| [결정: 실행 프로필 DB 단일 관리](contributing/decisions/profile-db.md) | 설치 상한·워크스페이스 프로필을 DB에서 관리하는 계약, YAML 이전, 3단계 롤백, PD-2~PD-5 계획 |
| [실제 Claude로 확인하기](real-claude.md) | 실제 Claude로 스택 확인 |

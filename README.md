# Agent Platform

이 저장소 코드의 중심은 Werft의 Kiel 모듈(세션 런타임)과 그 공개 `/v1` API다. 공식 TypeScript Claude Agent SDK 세션을 격리된 worker에서 실행하고, HTTP API·이벤트·승인·제어·checkpoint 복구로 다룬다. Werft의 다른 모듈과 개발 순서는 아래 모듈 구성 문단에, 어떤 코드가 어느 모듈인지는 [architecture.md](docs/contributing/architecture.md)에 있다.

이름 범위: 바깥에 내놓는 이름은 Werft다. 앞으로 낼 TypeScript SDK도 이 이름을 써서, 클래스는 `Werft`, 환경 변수는 `WERFT_API_KEY`·`WERFT_BASE_URL`로 정했다. SDK는 아직 이 저장소에 없고, npm 패키지 이름은 `@werft-ai/sdk`로 정했지만 아직 배포하지 않았다. Agent Platform은 Werft를 만드는 이 저장소의 이름이다. 저장소 `agent-platform`이 이 이름을 쓰고, 내부 패키지는 이제 `@werft-ai/*` 스코프를 쓴다. 바깥에 보이는 이름 가운데 바꾸면 기존 클라이언트나 설치가 깨지는 것, 곧 웹 콘솔의 `X-Requested-With` 값, Helm 차트·이미지 이름, Datadog 메트릭 이름에는 아직 `agent-platform`이 남아 있다.

모듈 구성: Werft는 안에서 네 모듈로 나뉜다. 모듈 이름은 저장소 안에서만 쓰고, API나 SDK처럼 바깥에 보이는 곳에는 내놓지 않는다. Musterrolle은 사용자·로그인·워크스페이스·역할·연동 계정과 권한 판정, Kollegium은 에이전트 정의·버전·런치와 에이전트를 부르는 웹·Slack·API 채널, Lotse는 세션끼리의 연결과 협업, Kiel은 세션 런타임(격리 실행·제어·승인·복구)을 맡는다. 지금 구현된 모듈은 Kiel이고, Musterrolle은 첫 owner bootstrap·cookie 로그인·API 키와 권한 데이터 일부가 먼저 들어와 Kiel 안에서 돈다. 개발 순서는 Musterrolle → Kollegium → Lotse다. 지금의 `/v1` API는 Kiel이 서빙하고, 그 안의 인증 경로 `/v1/auth/*`는 Musterrolle 몫이다. Kollegium의 API 채널은 앞으로 만들 에이전트 호출 입구다. 외부 도구는 Werft 안에 넣지 않고 Werft 밖의 remote MCP server에 연결해 쓰는 것이 설계 방향이다.

## credential 경계

provider key와 저장소·object store credential은 worker에 직접 전달하지 않지만, 살아 있는 attempt는 제한된 egress token으로 허용된 경로를 호출할 수 있다.

## 문서 지도

| 독자 | 먼저 읽을 문서 | 이어서 볼 문서와 파일 |
| --- | --- | --- |
| API 사용자 | [API 유즈케이스 가이드](docs/api-guide.md) | 배포 서버의 인증 없는 `GET /docs`에서 읽기 전용 API 참조를 보고, `GET /v1/openapi.json`에서 같은 사양을 받는다. 저장소 생성물은 [HTML](docs/api/index.html)과 [OpenAPI JSON](docs/openapi.json)이다 |
| SDK 사용자 | [TypeScript SDK](docs/sdk.md) | 서버·스크립트에서 API key로 세션을 다루는 `packages/sdk`(`@werft-ai/sdk`). 예제는 [packages/sdk/examples](packages/sdk/examples/session-close.ts) |
| 운영자 | [단일 서버 배포](docs/operator/server-deployment.md) | [운영자 문서 색인](docs/README.md#운영자), [Datadog 감시 기준](docs/operator/monitoring-datadog.md), [Datadog compose overlay](infra/compose.datadog.yml), [test-ops](docs/operator/test-ops.md), [백업과 복원](docs/operator/backup-restore.md) |
| 개발자 | [Quickstart](docs/quickstart.md) | [개발 환경과 검증](docs/contributing/development.md), [구성요소와 경계](docs/contributing/architecture.md), [CI](docs/contributing/ci.md), [실제 Claude 확인](docs/real-claude.md) |

독자별 전체 문서 색인은 [docs/README.md](docs/README.md)에 있다.

`docs/openapi.json`과 `docs/api/` 아래 생성물은 손으로 고치지 않는다. `bun run --cwd apps/control-host openapi:generate`로 함께 다시 만든다.

## UI 컴포넌트 보기 (Storybook)

`packages/ui`의 primitive·pattern과 화면 상태(로딩·빈·오류)는 [apps/storybook](apps/storybook)에서 스토리로 본다. 툴바의 Theme으로 라이트·다크를, Viewport로 390px(Mobile 390)·360px·768px·1440px를 바꾼다.

```bash
bun install
bun run --filter @werft-ai/storybook dev     # http://localhost:6006
bun run --filter @werft-ai/storybook build   # 정적 빌드: apps/storybook/dist
bun run --filter @werft-ai/storybook test:stories  # 모든 스토리를 Chrome에서 그리고 a11y(axe) 위반이 있으면 실패
```

Storybook과 Vitest CLI는 Node 20.19 이상에서 돈다. `test:stories`는 설치된 Chrome을 쓴다. CI의 `storybook` job이 빌드와 a11y 검사를 하고, main push에서만 `storybook-pages` job이 GitHub Pages에 배포한다.

라이선스는 [LICENSE](LICENSE)를 따른다. 이 저장소는 source-available이며 오픈소스가 아니다. 소스는 읽고 검토할 수 있게 공개돼 있지만, 사용·실행·복제·수정·재배포에는 저작권자의 사전 서면 허가가 필요하다.

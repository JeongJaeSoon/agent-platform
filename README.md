# Agent Platform

이 저장소 코드의 중심은 Werft의 Kiel 모듈(세션 런타임)과 그 공개 `/v1` API다. 공식 TypeScript Claude Agent SDK 세션을 격리된 worker에서 실행하고, HTTP API·이벤트·승인·제어·checkpoint 복구로 다룬다. Werft의 다른 모듈과 개발 순서는 아래 모듈 구성 문단에, 어떤 코드가 어느 모듈인지는 [architecture.md](docs/contributing/architecture.md)에 있다.

이름 범위: 바깥에 내놓는 이름은 Werft다. TypeScript SDK는 `packages/sdk`에 있고, npm 공개 패키지 `@werft-ai/sdk`로 배포한다(배포 절차는 [packages/sdk/README.md](packages/sdk/README.md)). 클래스는 `Werft`, 환경 변수는 `WERFT_API_KEY`·`WERFT_BASE_URL`이다. [SDK 샘플](examples/README.md)은 세션 목록, 이벤트 스트림, 재시도, 질문·권한 답변, 세션 제어, close, push 승인을 유즈케이스별로 보여 준다. Agent Platform은 Werft를 만드는 이 저장소의 이름이다. 저장소 `agent-platform`이 이 이름을 쓰고, 내부 패키지는 이제 `@werft-ai/*` 스코프를 쓴다. 바깥에 보이는 이름 가운데 바꾸면 기존 클라이언트나 설치가 깨지는 것, 곧 웹 콘솔의 `X-Requested-With` 값, Helm 차트·이미지 이름, Datadog 메트릭 이름에는 아직 `agent-platform`이 남아 있다.

모듈 구성: Werft는 안에서 네 모듈로 나뉜다. 모듈 이름은 저장소 안에서만 쓰고, API나 SDK처럼 바깥에 보이는 곳에는 내놓지 않는다. Musterrolle은 사용자·로그인·워크스페이스·역할·연동 계정과 권한 판정, Kollegium은 에이전트 정의·버전·런치와 에이전트를 부르는 웹·Slack·API 채널, Lotse는 세션끼리의 연결과 협업, Kiel은 세션 런타임(격리 실행·제어·승인·복구)을 맡는다. 지금 구현된 모듈은 Kiel이고, Musterrolle은 첫 owner bootstrap·cookie 로그인·API 키와 권한 데이터 일부가 먼저 들어와 Kiel 안에서 돈다. 개발 순서는 Musterrolle → Kollegium → Lotse다. 지금의 `/v1` API는 Kiel이 서빙하고, 그 안의 인증 경로 `/v1/auth/*`는 Musterrolle 몫이다. Kollegium의 API 채널은 앞으로 만들 에이전트 호출 입구다. 외부 도구는 Werft 안에 넣지 않고 Werft 밖의 remote MCP server에 연결해 쓰는 것이 설계 방향이다.

## credential 경계

provider key와 저장소·object store credential은 worker에 직접 전달하지 않지만, 살아 있는 attempt는 제한된 egress token으로 허용된 경로를 호출할 수 있다.

## 문서 지도

| 독자 | 먼저 읽을 문서 | 이어서 볼 문서와 파일 |
| --- | --- | --- |
| API 사용자 | [API 유즈케이스 가이드](docs/api-guide.md) | 배포 서버의 인증 없는 `GET /docs`에서 읽기 전용 API 참조를 보고, `GET /v1/openapi.json`에서 같은 사양을 받는다. 저장소 생성물은 [HTML](docs/api/index.html)과 [OpenAPI JSON](docs/openapi.json)이다 |
| SDK 사용자 | [TypeScript SDK](docs/sdk.md) | 서버·스크립트에서 API key로 세션을 다루는 `packages/sdk`(`@werft-ai/sdk`). 예제는 [examples](examples/README.md) |
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

Storybook과 Vitest CLI는 Node 20.19 이상에서 돈다. `test:stories`는 설치된 Chrome을 쓴다. CI의 `storybook` job이 빌드와 a11y 검사를 하고, `pages` job이 [apps/docs](apps/docs) 문서 사이트를 루트에, Storybook을 `/storybook/`에, API 레퍼런스를 `/api/`에 모은다. main push에서만 `storybook-pages` job이 GitHub Pages에 배포한다.

## 콘솔 데모 (읽기 전용)

예시 데이터가 들어간 웹 콘솔을 서버 없이 눌러 보는 정적 데모는 별도 저장소 [JeongJaeSoon/agent-platform-demo](https://github.com/JeongJaeSoon/agent-platform-demo)에 있다. 공개 주소는 [jeongjaesoon.github.io/agent-platform-demo/](https://jeongjaesoon.github.io/agent-platform-demo/)다. 데모 owner로 로그인된 상태로 열리고, 저장·실행 요청은 보내지 않고 "데모에서는 저장되지 않습니다"라고 알린다.

이 저장소에는 코드만 있다.

- `apps/web/src/demo/`: 데모 빌드(`vite build --mode demo`). GET은 녹화 fixture로 답하고 쓰기는 막는다.
- `apps/web/scripts/demo-record.ts`: 녹화기. 로그인 한 번 말고는 GET만 스택에 넘기고, 끝나면 로그아웃한다.
- `apps/web/scripts/demo-scan.ts`: 공개 전 검사. 토큰·`example.test` 밖 이메일·내부 호스트·기계 이름을 찾는다.

녹화 데이터(`fixtures.json`)는 데모 저장소에 있다. `apps/web/src/demo/fixtures.json`은 로그인 응답 하나만 든 자리표시이고, CI `demo` job은 이것으로 검사와 빌드만 확인한다. 데모 빌드는 `DEMO_FIXTURES=<파일>`이 있으면 그 파일을, 없으면 자리표시를 쓴다. 상대 경로는 `apps/web` 기준이라 절대 경로로 준다.

### 다시 녹화하기

`example.test` 계정으로 채운 스택(오너 Mac의 4620 스택)을 상대로, 이 저장소 루트에서 돌린다. `<demo>`(데모 저장소 checkout)와 `<리포트.json>`은 절대 경로로 쓴다. 리포트는 데모 저장소 밖에 둔다.

```bash
bun run --cwd apps/web build                      # 녹화에 쓰는 일반 빌드
bun apps/web/scripts/demo-record.ts --api http://127.0.0.1:<API 포트> \
  --accounts <계정 표 파일> --out <demo>/fixtures.json
(cd <demo> && gitleaks dir fixtures.json --redact=100 -f json -r <리포트.json>)
bun apps/web/scripts/demo-scan.ts --fixtures <demo>/fixtures.json --root <demo> --write-ignores <리포트.json>
bun apps/web/scripts/demo-scan.ts --fixtures <demo>/fixtures.json --root <demo>
DEMO_FIXTURES=<demo>/fixtures.json bun run --cwd apps/web build:demo   # 로컬 확인: apps/web/dist-demo
```

gitleaks의 `generic-api-key` 규칙은 사용량 breakdown 응답의 `"key": "<에이전트 id>"` 줄을 비밀값으로 읽는다. 그 줄만 데모 저장소의 `.gitleaksignore`에 fingerprint로 넣는다. 줄 번호가 녹화마다 바뀌므로 다시 녹화하면 fingerprint도 다시 만든다. `--write-ignores`는 모든 발견이 breakdown 응답 안에 있고, UUID이며, 녹화된 에이전트 목록의 id일 때만 항목을 바꿔 쓴다. 하나라도 어긋나면 아무것도 쓰지 않는다. 기본 실행은 남은 항목을 같은 기준으로 다시 확인하고, 실제 줄과 맞지 않는 항목이 있으면 실패한다.

검사가 깨끗하면 데모 저장소에 `fixtures.json`·`.gitleaksignore`를 커밋해 main에 push한다. 화면 코드가 바뀌어 녹화를 새로 했다면 데모 저장소 워크플로의 `SOURCE_REF`도 이 저장소의 그 커밋으로 올린다. push하면 데모 저장소 워크플로가 같은 검사와 빌드를 다시 돌리고 Pages에 배포한다.

## 라이선스

[PolyForm Small Business License 1.0.0](LICENSE)을 따르는 source-available 저장소다. 아래 두 디렉터리만 예외로 [Apache License 2.0](packages/sdk/LICENSE)을 따른다.

| 경로 | 라이선스 |
| --- | --- |
| `packages/sdk` (npm `@werft-ai/sdk`) | Apache-2.0. npm 배포본에는 빌드 때 함께 묶는 `packages/client`의 코드와 `packages/contracts`의 타입이 들어가며, 그 배포본 전체가 Apache-2.0이다([NOTICE](packages/sdk/NOTICE)) |
| `examples/` | Apache-2.0([examples/LICENSE](examples/LICENSE)) |
| 그 밖의 모든 경로 (서버, 웹 콘솔, `packages/client`·`packages/contracts`를 포함한 나머지 패키지) | PolyForm Small Business 1.0.0 |

UI 라이브러리 `packages/ui`(`@werft-ai/ui`)는 npm에 공개하지 않는 내부 패키지이고 PolyForm Small Business 1.0.0을 따른다.

PolyForm Small Business 1.0.0의 조건은 다음과 같다.

- 직원과 독립 계약자를 합쳐 100명 미만이고 직전 과세연도 총매출이 100만 달러(2019년 기준, 물가 보정) 미만인 회사는 무료로 사용·수정·배포·셀프호스팅할 수 있다. 회사를 지배하거나 회사가 지배하는 조직, 회사와 같은 지배를 받는 조직도 합쳐서 센다.
- 그 기준을 넘는 회사가 쓰려면 상용 라이선스가 필요하다.
- 복사본을 넘길 때는 라이선스 전문(또는 그 URL)과 `LICENSE` 첫 줄의 `Required Notice:`를 함께 넘긴다.

평가·상용 라이선스 문의: jaesoon@94soon.dev

# 콘솔 데모 (읽기 전용)

예시 데이터가 들어간 웹 콘솔을 서버 없이 눌러 보는 정적 데모는 별도 저장소 [JeongJaeSoon/agent-platform-demo](https://github.com/JeongJaeSoon/agent-platform-demo)에 있다. 공개 주소는 [jeongjaesoon.github.io/agent-platform-demo/](https://jeongjaesoon.github.io/agent-platform-demo/)다. 데모 owner로 로그인된 상태로 열리고, 저장·실행 요청은 보내지 않고 "데모에서는 저장되지 않습니다"라고 알린다.

이 저장소에는 코드만 있다.

- `apps/web/src/demo/`: 데모 빌드(`vite build --mode demo`). GET은 녹화 fixture로 답하고 쓰기는 막는다.
- `apps/web/scripts/demo-record.ts`: 녹화기. 로그인 한 번 말고는 GET만 스택에 넘기고, 끝나면 로그아웃한다.
- `apps/web/scripts/demo-scan.ts`: 공개 전 검사. 토큰·`example.test` 밖 이메일·내부 호스트·기계 이름·옛 제품 이름을 찾는다.

녹화 데이터(`fixtures.json`)는 데모 저장소에 있다. `apps/web/src/demo/fixtures.json`은 로그인 응답 하나만 든 자리표시이고, CI `demo` job은 이것으로 검사와 빌드만 확인한다. 데모 빌드는 `DEMO_FIXTURES=<파일>`이 있으면 그 파일을, 없으면 자리표시를 쓴다. 상대 경로는 `apps/web` 기준이라 절대 경로로 준다.

## 다시 녹화하기

`example.test` 계정으로 채운 스택(로컬에서 띄운 스택)을 상대로, 이 저장소 루트에서 돌린다. `<demo>`(데모 저장소 checkout)와 `<리포트.json>`은 절대 경로로 쓴다. 리포트는 데모 저장소 밖에 둔다.

```bash
bun run --cwd apps/web build                      # plain build used for recording
bun apps/web/scripts/demo-record.ts --api http://127.0.0.1:<API 포트> \
  --accounts <계정 표 파일> --out <demo>/fixtures.json
(cd <demo> && gitleaks dir fixtures.json --redact=100 -f json -r <리포트.json>)
bun apps/web/scripts/demo-scan.ts --fixtures <demo>/fixtures.json --root <demo> --write-ignores <리포트.json>
bun apps/web/scripts/demo-scan.ts --fixtures <demo>/fixtures.json --root <demo>
DEMO_FIXTURES=<demo>/fixtures.json bun run --cwd apps/web build:demo   # local check: apps/web/dist-demo
```

gitleaks의 `generic-api-key` 규칙은 사용량 breakdown 응답의 `"key": "<에이전트 id>"` 줄을 비밀값으로 읽는다. 그 줄만 데모 저장소의 `.gitleaksignore`에 fingerprint로 넣는다. 줄 번호가 녹화마다 바뀌므로 다시 녹화하면 fingerprint도 다시 만든다. `--write-ignores`는 모든 발견이 breakdown 응답 안에 있고, UUID이며, 녹화된 에이전트 목록의 id일 때만 항목을 바꿔 쓴다. 하나라도 어긋나면 아무것도 쓰지 않는다. 기본 실행은 남은 항목을 같은 기준으로 다시 확인하고, 실제 줄과 맞지 않는 항목이 있으면 실패한다.

검사가 깨끗하면 데모 저장소에 `fixtures.json`·`.gitleaksignore`를 커밋해 main에 push한다. 화면 코드가 바뀌어 녹화를 새로 했다면 데모 저장소 워크플로의 `SOURCE_REF`도 이 저장소의 그 커밋으로 올린다. push하면 데모 저장소 워크플로가 같은 검사와 빌드를 다시 돌리고 Pages에 배포한다.

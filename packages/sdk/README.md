# @werft-ai/sdk

서버와 스크립트에서 API key로 Werft 세션을 다루는 TypeScript SDK다. 세션 생성, 메시지, 이벤트 스트림, 권한 요청 답변, push 요청, close를 감싸고 재시도·Idempotency-Key·turn 대기를 대신 한다. Node 20 이상과 Bun에서 돈다. 브라우저에서는 API key가 새므로 막혀 있다.

```sh
npm install @werft-ai/sdk
```

```ts
import { Werft, waitForTurn } from "@werft-ai/sdk";

// WERFT_BASE_URL, WERFT_API_KEY 환경 변수를 읽는다.
const werft = new Werft();
const created = await werft.sessions.create({
  profile_id: "claude-coding-local",
  repository_id: "sample-app",
  message: "README를 요약해 줘",
});
const turn = await waitForTurn(werft, created.session_id, created.turn_id);
console.log(turn.status);
```

- 사용 안내: [TypeScript SDK](https://github.com/JeongJaeSoon/agent-platform/blob/main/docs/sdk.md)
- 에이전트 key와 별도 승인자로 세션을 돌리는 샘플: [examples/sdk-approver](https://github.com/JeongJaeSoon/agent-platform/tree/main/examples/sdk-approver)
- HTTP API 규칙: [API 유즈케이스 가이드](https://github.com/JeongJaeSoon/agent-platform/blob/main/docs/api-guide.md)

## 라이선스

[Apache License 2.0](LICENSE)이다. npm 배포본에는 저장소의 `packages/client` 코드와 `packages/contracts` 타입이 함께 묶여 들어가며, 배포본 전체가 Apache-2.0이다([NOTICE](NOTICE)). 저장소의 나머지(서버, 웹 콘솔, 그 밖의 패키지)는 PolyForm Small Business 1.0.0을 따르는 source-available 코드다.

## 빌드와 배포 (저장소 안)

`bun run --cwd packages/sdk build:package`가 `packages/sdk/dist`에 배포본을 만든다. ESM 모듈 하나와 d.ts 하나에 `@werft-ai/client`와 `@werft-ai/contracts` 타입을 묶고, 런타임 의존성은 `openapi-fetch`, d.ts가 참조하는 의존성은 `zod`만 남긴다. 소스맵은 넣지 않는다. 저장소의 `package.json`은 계속 `src`를 가리키고 `private`이라 workspace는 이 빌드 없이 돈다.

`bun scripts/sdk-pack-smoke.ts`는 배포본을 `npm pack`한 tarball을 빈 디렉터리에 `npm install`하고, `skipLibCheck` 없이 타입 검사한 뒤, [examples/sdk-approver](https://github.com/JeongJaeSoon/agent-platform/blob/main/examples/sdk-approver/src/session-close.ts) 샘플을 Node로 가짜 API에 대고 돌린다.

배포는 [.github/workflows/sdk-release.yml](../../.github/workflows/sdk-release.yml)이 한다. pull request와 수동 실행은 빌드·검사·pack까지만 하는 dry run이다. main에 있는 커밋에 `sdk-v<버전>` 태그를 push하면, `release` environment 승인 뒤 `npm publish --provenance --access public`으로 그 tarball을 올린다. 실패한 배포는 그 태그의 실행을 다시 돌린다. 토큰은 `release` environment의 `NPM_TOKEN` secret이다. 버전은 `package.json`의 `version`과 `src/version.ts`의 `SDK_VERSION`을 함께 올린다. `tests/sdk-release.test.ts`가 이 게이트를 검사한다.

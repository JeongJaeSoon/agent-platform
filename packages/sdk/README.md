# @werft-ai/sdk

서버와 스크립트에서 API key로 Werft 세션을 다루는 TypeScript SDK다. 세션 생성, 메시지, 이벤트 스트림, 권한 요청 답변, push 요청, close를 감싸고 재시도·Idempotency-Key·turn 대기를 대신 한다. Node 20.3 이상과 Bun에서 돈다. 브라우저에서는 API key가 새므로 막혀 있다.

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

- 사용 안내: [TypeScript SDK](https://github.com/JeongJaeSoon/werft/blob/main/docs/sdk.md)
- 유즈케이스별 샘플(세션 목록, 이벤트 스트림, 재시도, 질문·권한 답변, 세션 제어, close, push): [examples](https://github.com/JeongJaeSoon/werft/tree/main/examples)
- HTTP API 규칙: [API 유즈케이스 가이드](https://github.com/JeongJaeSoon/werft/blob/main/docs/api-guide.md)

## 라이선스

[Apache License 2.0](LICENSE)이다. npm 배포본에는 저장소의 `packages/client` 코드와 `packages/contracts` 타입이 함께 묶여 들어가며, 배포본 전체가 Apache-2.0이다([NOTICE](NOTICE)). 저장소의 나머지(서버, 웹 콘솔, 그 밖의 패키지)는 PolyForm Small Business 1.0.0을 따르는 source-available 코드다.

## 빌드와 배포 (저장소 안)

`bun run --cwd packages/sdk build:package`가 `packages/sdk/dist`에 배포본을 만든다. ESM 모듈 하나와 d.ts 하나에 `@werft-ai/client`와 `@werft-ai/contracts` 타입을 묶고, 런타임 의존성은 `openapi-fetch`, d.ts가 참조하는 의존성은 `zod`만 남긴다. 소스맵은 넣지 않는다. 저장소의 `package.json`은 계속 `src`를 가리키고 `private`이라 workspace는 이 빌드 없이 돈다.

`bun scripts/sdk-pack-smoke.ts`는 배포본을 `npm pack`한 tarball을 빈 디렉터리에 `npm install`하고, `skipLibCheck` 없이 타입 검사한 뒤, [examples/sdk-approver](https://github.com/JeongJaeSoon/werft/blob/main/examples/sdk-approver/src/session-close.ts) 샘플을 Node로 가짜 API에 대고 돌린다.

배포는 [.github/workflows/sdk-release.yml](https://github.com/JeongJaeSoon/werft/blob/main/.github/workflows/sdk-release.yml)이 한다. pull request와 버전 없는 수동 실행은 빌드·검사·pack까지만 하는 dry run이다. 게시는 버전을 넣은 수동 실행 하나로 끝난다.

1. `package.json`의 `version`과 `src/version.ts`의 `SDK_VERSION`을 함께 올려 main에 머지하고, 그 커밋의 main CI가 끝나기를 기다린다.
2. main에서 workflow를 실행한다. `<버전>`은 `package.json`의 값 그대로다.

   ```sh
   gh workflow run sdk-release.yml --repo JeongJaeSoon/werft --ref main -f version=<버전>
   ```

3. `build`가 다음을 모두 확인하고 빌드·검사·pack을 마친다. run의 ref가 main이고, 입력이 패키지 버전과 같고, 커밋이 main에 있고, 그 커밋의 main CI가 성공했고, `sdk-v<버전>` 태그가 없어야 한다. 하나라도 어긋나거나 조회에 실패하면 아무것도 쓰지 않고 멈춘다.
4. `tag`가 그 커밋에 `sdk-v<버전>` 태그를 만든다.
5. `publish`가 `release` environment 승인을 기다린다. 승인하면 `npm publish --provenance --access public`으로 3에서 검사한 tarball을 올린다. 토큰 없이 [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)의 OIDC로 인증한다.

대상 커밋은 실행 시점의 main head다. 그 커밋의 CI가 아직 돌고 있으면 끝난 뒤 다시 실행한다. 태그는 승인 앞에서 만들므로 게시가 실패하거나 승인을 거부해도 태그가 남는다. 다시 시도할 때는 같은 run의 Re-run failed jobs를 쓴다. 새로 실행하면 태그가 이미 있어 멈춘다. 그 버전을 포기할 때는 사람이 태그를 지우거나 버전을 올린다. tarball artifact와 다시 실행은 30일까지이므로 그 뒤에는 태그를 지우고 새로 실행한다. 태그를 직접 push해도 아무것도 게시되지 않는다. `tests/sdk-release.test.ts`가 이 게이트를 검사한다.

게시 전에 사람이 다음을 준비해 둔다. 둘 중 하나라도 없으면 `publish`가 environment에서 거부되거나 npm 인증 오류로 실패한다.

1. `release` environment의 배포 정책에 브랜치 `main`을 둔다. 수동 실행의 ref는 태그가 아니라 `refs/heads/main`이다. 다른 브랜치나 와일드카드는 두지 않는다. 태그 패턴 `sdk-v*`는 더 쓰지 않으니 지운다. `v*`와 `ui-v*`는 이미지와 `@werft-ai/ui` 게시가 쓰므로 그대로 둔다. `release`에는 required reviewer를 둔다. 없으면 승인 없이 바로 게시된다. 승인자는 승인 전에 그 run의 ref가 `main`인지 본다. workflow 파일의 조건은 브랜치나 태그에서 고칠 수 있고, 정책은 다른 브랜치만 거부할 뿐 `v*`·`ui-v*` 태그에서 수동 실행한 run은 통과시킨다.
2. npmjs.com의 패키지 설정에 trusted publisher를 등록한다. 값은 GitHub Actions, 저장소 `JeongJaeSoon/werft`, workflow `sdk-release.yml`, environment `release`이고 `Allow npm publish`를 켠다. 값은 대소문자까지 정확히 맞아야 하고, `package.json`의 `repository.url`도 이 저장소와 일치해야 한다. 새 등록은 2일 안에 첫 게시가 성공해야 한다. 그 안에 게시하지 못하면 만료되므로 지우고 다시 만든다. 등록은 고칠 수 없어서 workflow 파일이나 environment, 저장소 이름이 바뀌어도 다시 만든다.

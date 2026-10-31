# 결정: GitHub Packages(npm·RubyGems)를 App token으로 읽을 수 있는가

- 상태: 1차(`--no-packages`) 결과만 있음. 결론은 2차 실측 대기. 94S-1098. 이 결론에 따라 94S-1096(조직 레지스트리에 App token을 붙인다)을 시작하거나 보류한다.
- 기준 커밋: `origin/main` `fc1e7f26`. 아래 `파일:줄`은 모두 이 커밋 기준이다.
- 실측 로그: `~/share/owner-checks/session-deps-20261031/1098-measure.log`(오너가 실행, 이 문서의 표는 그 로그에서 옮겼다).

## 왜 실측했나

조직 자격 증명은 GitHub App 하나로 간다(PAT는 machine user라도 개인·계정에 기대므로 넣지 않는다). 그런데 GitHub 문서는 Packages 레지스트리 인증을 PAT(classic)와 Actions의 `GITHUB_TOKEN`으로만 설명한다. App installation token이 레지스트리에 통한다는 기술도, 막는다는 기술도 없다. 문서로 판정할 수 없어서 실제로 token을 발급해 요청을 보냈다.

## 어떻게 쟀나

- 스크립트: [`scripts/github-packages-probe.ts`](../../../scripts/github-packages-probe.ts). 제품의 발급 경로(#941 GitHub 게이트, `packages/platform/src/sessions/github-gate.ts`)를 거치지 않는 일회성 측정이다. `apps/control-host/src/api/forge-github.ts:546`의 `@octokit/auth-app` 호출과 같은 REST 요청(`POST /app/installations/{id}/access_tokens`, `repositories: [<repo>]`, `permissions`)을 직접 보낸다. 그래서 422(권한 거절)를 HTTP status 그대로 본다.
- token과 App 키는 출력·기록하지 않는다. 출력은 행마다 `<행> <대상> <status> <redirect host|-> <요약>`뿐이다. 발급한 token은 끝날 때(예외·SIGINT 포함) `DELETE /installation/token`으로 폐기한다(R행).
- redirect는 token을 붙인 채 따라가지 않는다. 다음 요청은 Authorization 없이 보낸다(proxy가 보낼 모양).
- 순서: 먼저 오너의 classic PAT로 받아지는지(양성 대조, `--control`의 `C-pat/` 행)와 token 없이는 실패하는지(`C-anon/` 행)를 본다. 그다음 PAT·캐시 없는 환경(`env -i`, 빈 HOME, `.npmrc`·gem 설정·프록시 없음)에서 설치 token만으로 받는다. 패키지별 접근 설정(visibility, 저장소 권한 상속, 연결 저장소)은 오너가 로그에 `# owner:` 줄로 남긴다.
- 대상: `JeongJaeSoon/werft-sandbox`(private, 사용자 계정 소유), App `werft-sandbox-agent`(App ID 5513262, installation 176243287).
- token 세 가지: `M1` `{contents: read}`, `M2` `{packages: read}`, `M3` 권한 생략. M3은 설치가 가진 권한 전체를 받는 token이 잠깐 생기는 비교군이다.

| 행 | 대상 | 요청 |
| --- | --- | --- |
| M1~M3 | token 발급 | 위 세 권한 집합. status 201이면 발급, 422면 설치에 없는 권한 |
| 0-* | 패키지 없이 | 없는 npm 이름(`@jeongjaesoon/werft-probe-absent`)과 gem index(`specs.4.8.gz`)를 익명과 각 token으로. 401/403이면 레지스트리가 token을 거절, 404면 받아들임 |
| 1 | npm metadata | `GET https://npm.pkg.github.com/@<scope>%2f<name>`, Bearer |
| 2 | npm tarball | metadata의 `dist.tarball`(레지스트리 host일 때만), Bearer |
| 3 | gem index | `GET https://rubygems.pkg.github.com/<owner>/specs.4.8.gz`, Basic `x-access-token:<token>`과 Bearer |
| 4 | `.gem` | `GET https://rubygems.pkg.github.com/<owner>/gems/<name>-<ver>.gem`, Basic과 Bearer |
| 5 | 1~4 반복 | `M2`·`M3` token으로 |
| C-pat/1~4, C-anon/1~4 | 대조 | 1~4와 같은 요청을 오너 PAT와 무인증으로 |

## 결과

### 1차: `--no-packages` (2026-10-31T07:13:28Z)

로그에서 그대로 옮겼다. 첫 `# owner:` 줄은 절차 파일의 빈 양식이 한 번 붙은 것이라 뺐다.

| 행 | 대상 | status | redirect host | 요약 |
| --- | --- | --- | --- | --- |
| owner | App 권한 목록의 Packages | - | - | 항목이 있고 값은 No access |
| M1 | mint:contents | 201 | - | granted=contents:read+metadata:read |
| M2 | mint:packages | 422 | - | granted=- |
| M3 | mint:none | 201 | - | granted=actions:write+checks:write+contents:write+issues:write+metadata:read+pull_requests:write+workflows:write |
| 0-anon | npm-absent | 404 | - | content-length=yes |
| 0-anon | gem-index | 401 | - | content-length=yes |
| 0-contents | npm-absent | 404 | - | content-length=yes |
| 0-contents | gem-index | 403 | - | content-length=yes |
| 0-packages | npm-absent | - | - | skipped=no-token |
| 0-packages | gem-index | - | - | skipped=no-token |
| 0-none | npm-absent | 404 | - | content-length=yes |
| 0-none | gem-index | 403 | - | content-length=yes |
| R1 | revoke:contents | 204 | - | - |
| R3 | revoke:none | 204 | - | - |

읽은 것:

- **App 권한 목록에는 Packages가 있다.** 티켓 배경의 "GitHub App 권한 목록에는 Packages가 없다"는 사실과 다르다. 이 App은 그 권한을 받지 않았을 뿐이다(값 No access).
- M2의 422는 설치가 받지 않은 권한을 요청한 결과다(`forge-github.ts`의 422 처리와 같은 뜻). App token이 레지스트리에 원래 안 통한다는 근거는 아니다.
- gem index는 익명이면 401, App token이면 403이다. RubyGems 레지스트리는 App token을 인증 정보로 받아들이고, 권한이 없다고 거절했다.
- npm은 익명과 token 모두 없는 이름에 404를 준다. 이 행으로는 token을 받아들이는지 알 수 없다.
- M3(권한 생략)은 설치가 가진 권한 전체를 받는다. 그 안에 packages가 없으므로 0-none도 403이다.

## 결론

<!-- TODO(94S-1098): 가능/불가/부분, 94S-1096 진행 여부. -->

## 사용자 계정과 org

이 실측은 사용자 계정 소유 저장소와 패키지에서만 했다. 조직 소유 패키지는 권한 모델(조직 패키지 설정, 조직 수준 App 설치)이 다를 수 있으므로 이 결과를 조직에 일반화하지 않는다. 조직 재검증이 필요하다(todo 등록됨).

<!-- TODO(94S-1098): 실측 결과에 따른 판단을 덧붙인다. -->

## 안 될 때의 대안 (보류)

| 안 | 장점 | 단점 | 다시 볼 조건 |
| --- | --- | --- | --- |
| A. 조직 소유 machine user의 `read:packages` classic PAT를 proxy가 붙인다 | 지금 바로 동작한다. 94S-1096의 proxy 모양을 그대로 쓴다 | 개인·계정에 기댄다(App만 쓴다는 원칙과 어긋난다). 만료·순환이 수동이다. classic PAT는 저장소 단위로 좁힐 수 없다 | 사설 npm·gem 설치를 요구하는 사용자가 생기고, 오너가 PAT 예외를 받아들일 때 |
| B. 레지스트리 앞 gateway(Verdaccio·Gemstash 같은 조직 운영 캐시) | worker와 proxy는 사내 host 하나만 본다. 캐시 효과가 있다 | 운영 대상이 늘어난다. gateway의 상류 자격 증명은 결국 A와 같은 문제다 | A의 조건에 더해, 조직에 그런 gateway가 이미 있을 때 |
| C. Actions `GITHUB_TOKEN`으로 받은 tarball을 artifact로 넘긴다 | 문서가 지원하는 token이다 | 세션 중 즉시 받을 수 없고 workflow를 한 번 돌아야 한다. 경로가 복잡하다 | 사설 패키지가 적고 버전이 고정일 때 |
| D. 비활성으로 둔다 | App만 쓴다는 원칙을 지킨다 | 사설 npm·gem에 기대는 저장소는 세션 안에서 설치할 수 없다 | GitHub가 App token의 Packages 지원을 공지할 때 |

# 결정: GitHub Packages(npm·RubyGems)를 App token으로 읽을 수 있는가

- 상태: 실측 결과 대기. 94S-1098. 이 결론에 따라 94S-1096(조직 레지스트리에 App token을 붙인다)을 시작하거나 보류한다.
- 기준 커밋: `origin/main` `fc1e7f26`. 아래 `파일:줄`은 모두 이 커밋 기준이다.
- 실측 로그: `~/share/owner-checks/session-deps-20261031/1098-measure.log`(오너가 실행, 이 문서의 표는 그 로그에서 옮겼다).

## 왜 실측했나

조직 자격 증명은 GitHub App 하나로 간다(PAT는 machine user라도 개인·계정에 기대므로 넣지 않는다). 그런데 GitHub 문서는 Packages 레지스트리 인증을 PAT(classic)와 Actions의 `GITHUB_TOKEN`으로만 설명한다. App installation token이 레지스트리에 통한다는 기술도, 막는다는 기술도 없다. 문서로 판정할 수 없어서 실제로 token을 발급해 요청을 보냈다.

## 어떻게 쟀나

- 스크립트: [`scripts/github-packages-probe.ts`](../../../scripts/github-packages-probe.ts). 제품의 발급 경로(#941 GitHub 게이트, `packages/platform/src/sessions/github-gate.ts`)를 거치지 않는 일회성 측정이다. `apps/control-host/src/api/forge-github.ts:546`의 `@octokit/auth-app` 호출과 같은 REST 요청(`POST /app/installations/{id}/access_tokens`, `repositories: [<repo>]`, `permissions`)을 직접 보낸다. 그래서 422(권한 거절)를 HTTP status 그대로 본다.
- token과 App 키는 출력·기록하지 않는다. 출력은 행마다 `<행> <대상> <status> <redirect host|-> <요약>`뿐이다. 발급한 token은 끝날 때(예외·SIGINT 포함) `DELETE /installation/token`으로 폐기한다(R행).
- redirect는 token을 붙인 채 따라가지 않는다. 다음 요청은 Authorization 없이 보낸다(proxy가 보낼 모양).
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

## 결과

<!-- TODO(94S-1098): 로그에서 행별 status·redirect host를 옮긴다. -->

## 결론

<!-- TODO(94S-1098): 가능/불가/부분, 94S-1096 진행 여부. -->

## 사용자 계정과 org

<!-- TODO(94S-1098): 사용자 계정 sandbox 결과로 충분한지, org에서 다시 재야 하는지. -->

## 안 될 때의 대안 (보류)

| 안 | 장점 | 단점 | 다시 볼 조건 |
| --- | --- | --- | --- |
| A. 조직 소유 machine user의 `read:packages` classic PAT를 proxy가 붙인다 | 지금 바로 동작한다. 94S-1096의 proxy 모양을 그대로 쓴다 | 개인·계정에 기댄다(App만 쓴다는 원칙과 어긋난다). 만료·순환이 수동이다. classic PAT는 저장소 단위로 좁힐 수 없다 | 사설 npm·gem 설치를 요구하는 사용자가 생기고, 오너가 PAT 예외를 받아들일 때 |
| B. 레지스트리 앞 gateway(Verdaccio·Gemstash 같은 조직 운영 캐시) | worker와 proxy는 사내 host 하나만 본다. 캐시 효과가 있다 | 운영 대상이 늘어난다. gateway의 상류 자격 증명은 결국 A와 같은 문제다 | A의 조건에 더해, 조직에 그런 gateway가 이미 있을 때 |
| C. Actions `GITHUB_TOKEN`으로 받은 tarball을 artifact로 넘긴다 | 문서가 지원하는 token이다 | 세션 중 즉시 받을 수 없고 workflow를 한 번 돌아야 한다. 경로가 복잡하다 | 사설 패키지가 적고 버전이 고정일 때 |
| D. 비활성으로 둔다 | App만 쓴다는 원칙을 지킨다 | 사설 npm·gem에 기대는 저장소는 세션 안에서 설치할 수 없다 | GitHub가 App token의 Packages 지원을 공지할 때 |

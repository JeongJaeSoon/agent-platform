# 결정: GitHub Packages(npm·RubyGems)를 App token으로 읽을 수 있는가

- 상태: 결정됨(2026-10-31), 확정(2026-11-01). **App 설치 token으로는 GitHub Packages(npm·RubyGems)를 받을 수 없다(불가 확정).** App에 Packages: Read를 준 뒤에도 403이다. 조직 레지스트리(GitHub Packages) 요청에 proxy가 App token을 붙이는 작업(이하 "조직 레지스트리 작업")은 하지 않는다. 대신 조직 bot 계정의 `read:packages` classic PAT를 proxy가 주입하는 방식으로 간다(아래 "대안과 후속"의 A).
- 기준 커밋: `origin/main` `fc1e7f26`. 아래 `파일:줄`은 모두 이 커밋 기준이다.
- 실측 로그: `~/share/owner-checks/session-deps-20261031/1098-measure.log`(오너가 실행, 이 문서의 표는 그 로그에서 옮겼다).
- 조사: `~/share/owner-checks/github-packages-multiuser-20261101/report.md`(GitHub 문서·커뮤니티·타사 사례), `~/share/owner-checks/devin-github-packages-20261101.md`(Devin 비교). 요약은 아래 "근거"에 있다.

## 왜 실측했나

조직 자격 증명은 GitHub App 하나로 간다(PAT는 machine user라도 개인·계정에 기대므로 넣지 않는다. 이 결정으로 GitHub Packages에만 예외가 생겼다, 아래 대안 A). 그런데 GitHub 문서는 Packages 레지스트리 인증을 PAT(classic)와 Actions의 `GITHUB_TOKEN`으로만 설명한다. App installation token이 레지스트리에 통한다는 기술도, 막는다는 기술도 없다. 문서로 판정할 수 없어서 실제로 token을 발급해 요청을 보냈다.

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

- **App 권한 목록에는 Packages가 있다.** "GitHub App 권한 목록에는 Packages가 없다"는 이전 가정은 사실과 다르다. 이 App은 그 권한을 받지 않았을 뿐이다(값 No access).
- M2의 422는 설치가 받지 않은 권한을 요청한 결과다(`forge-github.ts`의 422 처리와 같은 뜻). App token이 레지스트리에 원래 안 통한다는 근거는 아니다.
- gem index는 익명이면 401, App token이면 403이다. 이때는 레지스트리가 App token을 알아보고 권한이 없다고 거절했다고 읽었다. 4차에서 권한을 준 뒤에도 403이어서, 이 읽기는 "자격 증명 종류를 받지 않는다"로 바뀌었다.
- npm은 익명과 token 모두 없는 이름에 404를 준다. 이 행으로는 token을 받아들이는지 알 수 없다.
- M3(권한 생략)은 설치가 가진 권한 전체를 받는다. 그 안에 packages가 없으므로 0-none도 403이다.

### 패키지 접근 설정

오너가 게시한 테스트 패키지 두 개의 설정이다. 로그의 `# owner(agent-read):` 줄로, 에이전트가 브라우저로 설정 화면을 읽어 기록했다.

| 패키지 | visibility | 저장소 권한 상속 | 저장소 접근 |
| --- | --- | --- | --- |
| npm `@jeongjaesoon/werft-probe` 0.0.1 | private | yes | `werft-sandbox` 있음 |
| gem `werft-probe` 0.0.1 | private | yes | `werft-sandbox` 있음 |

### 2차: `--control` (2026-10-31T08:43:05Z, 오너 classic PAT와 무인증)

| 행 | 대상 | status | redirect host | 요약 |
| --- | --- | --- | --- | --- |
| C-pat/1 | npm-metadata | 200 | - | versions=yes |
| C-pat/2 | npm-tarball | 302 | `pkg-npm.githubusercontent.com` | followed=200+content-length=yes |
| C-pat/3-basic | gem-index | 200 | - | gzip=yes |
| C-pat/3-bearer | gem-index | 200 | - | gzip=yes |
| C-pat/4-basic | gem-file | 302 | `rubygemsregistryv2prod.blob.core.windows.net` | followed=200+content-length=yes |
| C-pat/4-bearer | gem-file | 302 | `rubygemsregistryv2prod.blob.core.windows.net` | followed=200+content-length=yes |
| C-anon/1 | npm-metadata | 401 | - | content-length=yes |
| C-anon/2 | npm-tarball | 401 | - | content-length=yes |
| C-anon/3-basic | gem-index | 401 | - | content-length=yes |
| C-anon/3-bearer | gem-index | 401 | - | content-length=yes |
| C-anon/4-basic | gem-file | 401 | - | content-length=yes |
| C-anon/4-bearer | gem-file | 401 | - | content-length=yes |

PAT로는 네 대상이 모두 받아지고, 무인증은 모두 401이다. 테스트 패키지가 맞게 게시됐고 private이다. 본체(tarball·`.gem`)는 레지스트리가 302로 다른 host에 넘기고, 그 host는 Authorization 없이 200을 준다.

### 3차: 전체 (2026-10-31T08:44:27Z, 설치 token만, `env -i`·빈 HOME)

| 행 | 대상 | status | redirect host | 요약 |
| --- | --- | --- | --- | --- |
| M1 | mint:contents | 201 | - | granted=contents:read+metadata:read |
| M2 | mint:packages | 422 | - | granted=- |
| M3 | mint:none | 201 | - | granted=actions:write+checks:write+contents:write+issues:write+metadata:read+pull_requests:write+workflows:write |
| 1 | npm-metadata | 403 | - | content-length=yes |
| 2 | npm-tarball | - | - | skipped=no-url |
| 3-basic | gem-index | 403 | - | content-length=yes |
| 3-bearer | gem-index | 403 | - | content-length=yes |
| 4-basic | gem-file | 403 | - | content-length=yes |
| 4-bearer | gem-file | 403 | - | content-length=yes |
| 5-packages/1~4 | 전부 | - | - | skipped=no-token(M2가 422) |
| 5-none/1 | npm-metadata | 403 | - | content-length=yes |
| 5-none/2 | npm-tarball | - | - | skipped=no-url |
| 5-none/3-basic | gem-index | 403 | - | content-length=yes |
| 5-none/3-bearer | gem-index | 403 | - | content-length=yes |
| 5-none/4-basic | gem-file | 403 | - | content-length=yes |
| 5-none/4-bearer | gem-file | 403 | - | content-length=yes |
| R1 | revoke:contents | 204 | - | - |
| R3 | revoke:none | 204 | - | - |

- 설치 token은 `contents:read`든 설치 권한 전체든 npm metadata·gem index·`.gem` 모두 403이다. 저장소 권한을 상속하는 private 패키지인데도 그렇다. **Packages: No access인 App에서는 저장소 권한 상속이 installation token에 이어지지 않는다.**
- 2행(tarball)은 재지 못했다. tarball URL은 metadata 응답에서만 얻는데 metadata가 403이었다. 같은 레지스트리 host의 같은 인증이므로 결론을 바꾸지 않는다고 본다.
- 이때는 403을 token을 알아보고 권한이 없다고 거절한 것으로 읽었다(무인증은 401). 사용자 계정에서 남은 변수는 App의 Packages 권한 하나였다. 그래서 4차에서 그 권한을 줬고, 그 결과 이 읽기는 바뀌었다(4차).

### 4차: 전체, App에 Packages: Read를 준 뒤 (2026-11-01T11:09:27Z)

오너가 App의 Packages 권한을 Read로 바꾸고 설치에서 새 권한을 승인한 뒤 3차와 같은 명령을 다시 돌렸다.

| 행 | 대상 | status | redirect host | 요약 |
| --- | --- | --- | --- | --- |
| M1 | mint:contents | 201 | - | granted=contents:read+metadata:read |
| M2 | mint:packages | 201 | - | granted=metadata:read+packages:read |
| M3 | mint:none | 201 | - | granted=actions:write+checks:write+contents:write+issues:write+metadata:read+packages:read+pull_requests:write+workflows:write |
| 1 | npm-metadata | 403 | - | content-length=yes |
| 5-packages/1 | npm-metadata | 403 | - | content-length=yes |
| 5-none/1 | npm-metadata | 403 | - | content-length=yes |
| 2, 5-packages/2, 5-none/2 | npm-tarball | - | - | skipped=no-url |
| 3-basic, 3-bearer | gem-index | 403 | - | content-length=yes |
| 4-basic, 4-bearer | gem-file | 403 | - | content-length=yes |
| 5-packages/3-basic, 5-packages/3-bearer | gem-index | 403 | - | content-length=yes |
| 5-packages/4-basic, 5-packages/4-bearer | gem-file | 403 | - | content-length=yes |
| 5-none/3-basic, 5-none/3-bearer | gem-index | 403 | - | content-length=yes |
| 5-none/4-basic, 5-none/4-bearer | gem-file | 403 | - | content-length=yes |
| R1~R3 | revoke | 204 | - | - |

- M2가 201이고 `packages:read`가 붙은 token이 나왔다. M3(설치 권한 전체)에도 `packages:read`가 들어갔다.
- 그런데도 세 token 모두 npm metadata·gem index·`.gem`이 basic·bearer 가리지 않고 403이다. 같은 패키지를 PAT는 200으로 받는다(2차). **권한이 모자란 것이 아니라 레지스트리가 App 설치 token이라는 자격 증명 종류를 받지 않는다.**

## 근거

1. 실측(위 4차): App에 `packages:read`를 준 설치 token도 npm·RubyGems 전부 403. PAT 200, 무인증 401.
2. 조사(`~/share/owner-checks/github-packages-multiuser-20261101/report.md`): GitHub 문서가 Packages 레지스트리 인증으로 이름을 대는 것은 classic PAT와 Actions `GITHUB_TOKEN`뿐이고, App 설치 token과 fine-grained PAT는 나오지 않는다. 지원하지 않는다는 명시는 커뮤니티 답변과 그곳에 옮겨진 GitHub Support 답변에 있다. App token 지원은 공개 로드맵에 오른 적이 없고, fine-grained PAT 항목은 2024-11에 로드맵 보드에서 빠졌다. 조직 소유 패키지·조직 설치 App에서도 같은 403(`installation not allowed to Read organization package`)이 커뮤니티에 여러 건 보고돼 있다.
3. 비교(`~/share/owner-checks/devin-github-packages-20261101.md`): Devin 공개 문서에는 GitHub Packages 전용 기능이 없다. 문서가 설명하는 것은 일반 사설 레지스트리 방식뿐으로, 사용자가 넣은 Secret을 설치 단계에서 환경 변수로 참조해 설정 파일을 쓴다. 그 Secret이 GitHub Packages에서는 classic PAT일 것이라는 점, Devin GitHub App의 `packages` 읽기 권한이 레지스트리 설치용이 아니라는 점은 추정이다(실제 화면은 확인하지 않았다).

## 결론

**App 설치 token으로는 불가(확정).** App에 Packages: Read를 주고 설치에서 승인해도, 설치 token으로는 사설 npm·gem의 metadata·index·본체를 하나도 받지 못한다. 패키지가 저장소 권한을 상속하고 그 저장소에 App이 설치돼 있어도 마찬가지다.

- **조직 레지스트리 작업(App token을 proxy가 붙이는 방식)은 하지 않는다.** 그 대신 아래 "대안과 후속"의 A(PAT 주입 방식)으로 간다. 관리자가 PAT를 등록하지 않은 워크스페이스에서는 사설 GitHub Packages 설치가 비활성이다. 공개 레지스트리(npm·RubyGems·Go module proxy)를 자격 증명 없이 받는 경로는 이 결정과 관계없다.
- 후속 작업에 쓸 사실(PAT 대조 run의 `C-pat/2`·`C-pat/4` 행. App token으로는 본체까지 가지 못해 보지 못했다): 본체 redirect host는 npm이 `pkg-npm.githubusercontent.com`, gem이 `rubygemsregistryv2prod.blob.core.windows.net`이다. 둘 다 Authorization 없이 받아진다. proxy는 이 host만 따라가고 Authorization을 떼면 된다.
- 측정에 쓴 PAT 파일은 지우고 PAT는 GitHub에서 폐기한다(오너 절차 `publish-steps.md` 끝). 테스트 패키지는 이 문서가 들어간 뒤 오너가 정리한다.

## 사용자 계정과 org

이 실측은 사용자 계정 소유 저장소와 패키지에서만 했다. 조직 소유 패키지와 조직에 설치한 App으로는 직접 재지 않았으므로, 조직 재검증은 할 일로 남긴다(프로그램 할 일 목록). 다만 조직에서 같은 403이 여러 건 보고돼 있고(근거 2) 거부 이유가 자격 증명 종류이므로, 결과가 바뀔 기대값은 낮다. 조직에서 App token이 통한다면 이 결론을 다시 연다.

## 대안과 후속

| 안 | 장점 | 단점 | 상태 |
| --- | --- | --- | --- |
| A. 조직 bot 계정의 `read:packages` classic PAT를 proxy가 붙인다 | 지금 바로 동작한다. PAT 값은 egress proxy만 알고 worker·에이전트에 노출되지 않는다. Renovate·Artifactory도 같은 모양이다(Devin도 그렇다고 추정) | App만 쓴다는 원칙의 예외다. 만료·회전이 수동이다. bot이 읽을 수 있는 조직 패키지 전부가 읽히므로 허용 목록이 필요하다 | **고른 안.** 오너 승인 2026-11-01, 구현은 [결정: GitHub Packages bot token](github-packages-bot-token.md) |
| B. 레지스트리 앞 gateway(Verdaccio·Gemstash 같은 조직 운영 캐시) | worker와 proxy는 사내 host 하나만 본다. 캐시 효과가 있다 | 운영 대상이 늘어난다. 상류 자격 증명은 결국 A의 PAT다 | 보류. 캐시가 필요해지면 A 위에 얹는다 |
| C. Actions `GITHUB_TOKEN`으로 받은 tarball을 artifact로 넘긴다 | 문서가 지원하는 token이다. PAT가 없다 | 세션 중 즉시 받을 수 없고 workflow를 한 번 돌아야 한다. 경로가 복잡하다 | 보류. 조직이 classic PAT를 막아 둔 경우의 대안 |
| D. 비활성으로 둔다 | 노출이 없다. 구현할 것이 없다 | 사설 npm·gem에 기대는 저장소는 세션 안에서 설치할 수 없다 | 관리자가 PAT를 등록하지 않은 워크스페이스의 기본값 |

A를 구현할 때 지킬 것(구현은 이 문서 범위 밖이다):

- PAT는 조직 관리자만 등록·교체·삭제한다. scope가 `read:packages` 하나가 아니면 거절한다.
- proxy는 `npm.pkg.github.com`·`rubygems.pkg.github.com` 요청에만 Authorization을 붙이고, 본체 redirect는 Authorization 없이 따라간다.
- 요청마다 세션의 저장소·에이전트에 허용된 패키지인지 확인하고(허용 목록), 세션·사용자·패키지·버전·status를 감사 기록으로 남긴다. token 값은 남기지 않는다.

App token 지원은 기다리지 않는다. GitHub changelog에 App token의 Packages 지원이 실리면 이 결정을 다시 연다.

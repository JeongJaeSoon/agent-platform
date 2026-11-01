# 결정: GitHub Packages는 조직 bot의 classic PAT를 proxy가 붙여 받는다

- 상태: 구현됨. 콘솔 화면은 아직 없어 API로 등록한다.
- 배경 결정: [GitHub Packages와 App token](github-packages-app-token.md). App installation token은 레지스트리에서 403이라 안 A(bot PAT 주입)를 골랐다.
- 오너 승인(2026-11-01): "GitHub Packages 키 방식은 이해햇어 그렇게 진행하자"

## 무엇을 골랐나

워크스페이스마다 조직 bot 계정의 classic PAT(`read:packages` 하나) 하나를 등록한다. 이 값은 control-host DB에 봉인되고, egress proxy가 GitHub Packages 레지스트리로 나가는 요청에만 붙인다. worker·에이전트·세션 출력에는 값이 가지 않는다. 어떤 패키지를 받을지는 워크스페이스 허용 목록이 정하고, 요청마다 receipt를 남긴다.

| 구성 | 위치 | 하는 일 |
|---|---|---|
| token 저장 | `secret_values`(owner `workspace`, purpose `github_packages_token`), `github_packages_settings`(login·만료·허용 목록·revision) | AES-GCM 봉인(`PLATFORM_SECRET_KEY`). 콘솔·API에는 끝 네 자리와 login·만료만 보인다 |
| 등록 API | `GET /v1/workspaces/{id}/github-packages`, `PUT`·`DELETE …/token`, `PUT …/allowlist` | 읽기는 멤버, 쓰기는 owner·admin의 웹 세션만. API key로는 읽기도 쓰기도 못 한다 |
| scope 확인 | `createGitHubPackagesTokenVerifier`(`GET /user`) | `X-OAuth-Scopes`가 정확히 `read:packages`가 아니면 400 `token_scopes`. scope 헤더가 없는 fine-grained·App token도 같다. 401·403이면 `token_invalid`, 그 밖에는 503 |
| 판정 | `createGitHubPackagesEgress`(`packages/platform/src/workers/github-packages-egress.ts`) | 경로에서 owner·패키지·버전을 읽고 허용 목록과 맞춘다. 맞으면 receipt를 쓴 뒤 Bearer를 내준다 |
| 주입 | egress proxy `packages` route | 레지스트리 `github-npm`(`npm.pkg.github.com`)·`github-rubygems`(`rubygems.pkg.github.com`)에만 authorizer가 준 `Authorization`을 붙인다. worker가 보낸 `Authorization`은 버린다 |
| worker 설정 | `apps/worker/src/package-managers.ts` | claim의 `packages.github`(owner 이름만)로 npm scope와 Bundler mirror를 GitHub route로 돌린다 |

## 왜 이 모양인가

### token이 worker에 가지 않는다

worker의 `.npmrc`·`.bundle/config`에는 지금처럼 attempt마다 발급하는 `wek_` packages token만 들어간다. proxy가 authorizer에 묻고, authorizer가 허용할 때만 bot token을 upstream 헤더로 돌려준다. 그래서 세션이 `cat ~/.npmrc`·`env`를 해도 bot token은 없다. 응답 본문에 token이 되돌아오면 proxy의 기존 scrubber가 지운다.

### 허용 목록은 경로로 판정한다

bot은 조직 패키지 전부를 읽을 수 있다. 그래서 요청 경로가 무엇을 읽는지 알아볼 수 있을 때만 허용한다. 알아보지 못한 경로(`/-/whoami`, 검색, 알 수 없는 query)는 `path_not_recognized`로 거절한다.

| 레지스트리 | 받아들이는 경로 | 판정 단위 |
|---|---|---|
| npm | `/@owner%2fname`, `/@owner/name`, `/download/@owner/name/<ver>/<digest>`, `/@owner/name/-/name-<ver>.tgz` | 패키지(metadata는 버전 없음) |
| RubyGems | `/<owner>/versions`, `/<owner>/(latest_|prerelease_)?specs.4.8.gz` | owner(전체 index). 그 owner의 항목이 하나라도 있으면 허용 |
| RubyGems | `/<owner>/info/<gem>` | 패키지 |
| RubyGems | `/<owner>/gems/<file>.gem`, `/<owner>/quick/Marshal.4.8/<file>.gemspec.rz` | 항목 이름 + `-` + 숫자로 시작하는 버전으로 나눈다 |
| RubyGems | `/<owner>/api/v1/dependencies?gems=a,b` | 모든 이름이 허용돼야 한다 |

RubyGems index(`versions`·`specs`)는 owner의 gem 이름 전부를 보여 준다. 이름은 비밀로 보지 않고 받는 것(`.gem`)만 막는다. 항목은 `repository_id`·`agent_id`로 좁힐 수 있다. 좁힌 항목은 그 저장소·에이전트의 세션에만 적용된다. owner는 대소문자를 가리지 않는다.

### npm tarball이 npm route로 온다

npm 11은 `replace-registry-host=always`일 때 GitHub tarball 위치(`https://npm.pkg.github.com/download/@owner/...`)를 scope registry가 아니라 기본 registry 기준으로 바꾼다(2026-11-01 npm 11.19.1에서 확인). 그래서 그 요청은 `/packages/npm/download/@owner/...`로 온다. 공개 npm에는 이 모양의 경로가 없으므로 gateway는 이 경로를 GitHub npm 요청으로 판정한다. worker는 허용된 npm owner가 있을 때만 `replace-registry-host=always`를 쓴다. 없으면 이 설정 자체를 쓰지 않는다.

### 감사는 실패하면 닫힌다

허용한 요청은 receipt(`fetch_github_package`, `succeeded`)를 먼저 쓰고 나서 token을 내준다. 쓰기가 실패하면 요청이 실패한다. 거절도 `failed` receipt와 `reason_code`(`token_not_configured`·`token_expired`·`path_not_recognized`·`package_not_allowed`)를 남긴다. receipt에는 세션·attempt·에이전트·release·저장소·레지스트리·owner·패키지·버전이 있고 token은 없다. proxy가 30초마다 다시 묻는 regrant는 판정만 다시 하고 receipt를 새로 쓰지 않는다. token 등록·삭제와 허용 목록 변경도 각자 receipt를 남긴다.

### 만료

등록할 때 GitHub가 알려 준 만료(`GitHub-Authentication-Token-Expiration`)를 저장한다. 만료가 지나면 GitHub에 묻기 전에 `token_expired`로 거절한다. 회전은 관리자가 새 token을 같은 API로 덮어쓴다. 자동 회전은 없다.

## 대안

- 저장소마다 다른 token: bot 하나로 충분하고, 저장소 단위는 허용 목록이 맡는다.
- proxy 환경 변수로 token을 넣는 방식: 설치마다 재배포가 필요하고 워크스페이스를 구분할 수 없다. 저장과 회전을 콘솔에 두려고 DB에 봉인했다.
- 레지스트리 앞 캐시(Verdaccio·Gemstash): 보류. 필요해지면 이 token을 상류 자격 증명으로 쓴다.

## 운영자가 할 일

[실행 기반 § 공개 패키지 레지스트리](../../operator/execution.md)의 GitHub Packages 단락에 있다. 요약하면 `EGRESS_CREDENTIAL_ALLOWLIST`에 `npm.pkg.github.com:443,rubygems.pkg.github.com:443`을, `EGRESS_PACKAGES_REDIRECT_ALLOWLIST`에 tarball·gem 본체가 redirect되는 `pkg-npm.githubusercontent.com:443,rubygemsregistryv2prod.blob.core.windows.net:443`을 더한다.

## 다시 열 조건

- GitHub가 App installation token의 Packages 읽기를 지원하면 App token으로 옮긴다.
- 조직이 classic PAT를 막으면(조직 정책) 이 방식은 동작하지 않는다. 그때는 배경 결정의 안 C(Actions `GITHUB_TOKEN`)를 다시 본다.

# 변경 기록

Werft의 사용자와 운영자에게 보이는 변경을 적는다. 게시 패키지(이미지, Helm chart, SDK)를 설치하거나 올리는 사람이 읽는 글이다. 내부 리팩터링과 테스트 변경은 적지 않는다.

## 쓰는 방식

- 가장 위의 "미출시" 절에 변경을 쌓는다. 릴리스 태그를 만드는 사람이 그 절의 제목을 태그와 날짜로 바꾸고, 새 "미출시" 절을 위에 더한다.
- 각 항목은 PR 링크(`JeongJaeSoon/werft#123`)를 붙인다.
- 이미 설치한 곳이 직접 해야 하는 일은 "운영자가 할 일"에 모은다. 안 하면 조용히 깨지는 변경이 먼저 온다.
- 이 파일은 사람이 쓴다. 태그가 있다고 전제하고 쓰지 않는다.

## 미출시

첫 릴리스 `v0.1.0`이 `9e2098e5`에 게시됐다(GitHub Release, 이미지 태그 `v0.1.0`, chart `0.1.0`). `main`에 머지될 때마다 나오는 `main-<12>` 이미지 태그와 `0.1.0-main-<12>` chart는 릴리스가 아니다. SDK `@werft-ai/sdk`는 npm에 올라 있다(현재 `latest`는 `0.1.2`).

이름이 `agent-platform`에서 `werft`로 바뀌었고 옛 이름과의 호환은 없다. 이전 스냅샷으로 만든 설치는 제자리로 올릴 수 없으므로 새로 설치한다.

### 운영자가 할 일

이미 `main-<12>` 게시물로 설치한 곳이 올릴 때 직접 해야 하는 일이다. 업그레이드 명령은 [업그레이드](https://jeongjaesoon.github.io/werft/ko/run-server/self-hosting/upgrade/)를 따른다.

1. **지표 이름이 `werft`로 바뀌었다. 옛 이름 별칭은 없다**(JeongJaeSoon/werft#1188).
   - Prometheus: `agent_platform_*`가 `werft_*`가 됐다. 이름 외에 라벨, 단위, 의미는 같다. 이 지표로 만든 규칙과 대시보드의 쿼리를 바꾼다.
   - Datadog: 사용자 지표 `agent_platform.*`가 `werft.*`가 됐다. 정의(`infra/datadog/definitions`의 log metric, 모니터, 대시보드)는 자동으로 적용되지 않는다. 새 정의를 적용하기 전에는 옛 지표 id가 계속 쌓이고, 적용하면 새 id로 시계열이 새로 시작한다. 옛 시계열은 이어지지 않는다. Datadog Agent의 postgres 설정 `metric_prefix`도 `werft`가 됐다.
   - 로그 파이프라인의 grok 규칙 이름 `agent_platform_json`은 `werft_json`이 됐다. 규칙 이름만 바뀌고 동작은 같다.
   - Datadog compose overlay를 쓰는 곳은 overlay를 새로 적용하면 `http_check` 인스턴스 이름 `agent-platform-readyz`가 `werft-readyz`로, 로그 `source:agent-platform`이 `source:werft`로 바뀐다(JeongJaeSoon/werft#1189). Helm으로만 설치한 곳은 이 이름들을 쓰지 않으니 바꿀 것이 없다. 옛 이름으로 만든 모니터 쿼리(`instance:agent-platform-readyz`), 로그 파이프라인 필터(`source:agent-platform OR service:werft-worker`), 저장한 로그 검색을 새 이름으로 바꾼다.
2. **CSS 이름이 `werft`로 바뀌었다**(JeongJaeSoon/werft#1188). 웹 콘솔을 임베드하며 스타일을 덮어쓰는 곳이 해당한다. 옛 이름은 조용히 무시된다.

   | 옛 | 새 |
   | --- | --- |
   | `--ap-*` (CSS 변수) | `--werft-*` |
   | `ap-button`, `ap-dialog`, `ap-input`, `ap-state`, `ap-status`, `ap-receipt`, `ap-skeleton`, `ap-visually-hidden`와 `__`·`--` 변형 | `werft-*` |
   | `data-ap-button`, `data-ap-dialog` | `data-werft-button`, `data-werft-dialog` |
   | `@layer ap` | `@layer werft` |
   | 키프레임 `ap-spin`, `ap-pulse`, `ap-fade-in`, `ap-dialog-in` | `werft-*` |

   worker 이름 `ap-worker-*`는 이미 떠 있는 스택의 소유권 판별에 쓰이므로 바꾸지 않았다. 작업 공간·네트워크 이름과 라벨은 아래 8번에서, compose project 이름은 10번과 11번에서 바뀐다.
3. **chart와 이미지 이름이 `werft`다**(JeongJaeSoon/werft#1166). chart 이름이 `agent-platform`이던 release는 지우고 새로 설치한다.
4. **설정 파일 카탈로그가 없어지고 DB 설정만 쓴다**(JeongJaeSoon/werft#1167). 파일 카탈로그로 돌던 이전 스냅샷의 설치는 제자리로 올릴 수 없으므로 새로 설치한다.
5. **worker 이미지가 같아도 직전 이미지(`images.workerPrevious`)를 빼거나 바꾸면 업그레이드 전 검사가 `refused`로 멈출 수 있다**(JeongJaeSoon/werft#1204). 대상 이미지(현재 이미지와, 있으면 직전 이미지) 어느 쪽과도 맞지 않거나 조합이 기록되지 않은 세션이 있을 때다. 이전에는 그대로 통과했고, 맞지 않는 세션은 재개 때 멈췄다. 보관한 `worker-previous.json`을 계속 넘긴다. 이 검사의 직전 이미지 경로는 클러스터에서 실행해 확인하지 않았다.
6. **worker가 workspace에 남기는 이름이 `werft`로 바뀌었다**(JeongJaeSoon/werft#1226). 지침 파일 제외 마커는 `# werft: instruction files`, 복원 디렉터리는 `.git/werft-checkpoint`, 임시 이름은 `.git/werft-<용도>-*`다. 이전 스냅샷으로 만든 workspace는 새로 만든다.
7. **세션 쿠키 이름과 CSRF 헤더 값이 `werft`로 바뀌어 올린 직후 로그인이 한 번 끊긴다**(JeongJaeSoon/werft#1231). 세션 쿠키는 `__Host-ap_session`에서 `__Host-werft_session`으로, Google 로그인 쿠키는 `__Host-werft_google_login`으로, GitHub·Slack 연결 쿠키는 `werft_github_link`·`werft_slack_link`로 바뀌었다. 옛 쿠키는 읽지 않으므로 모든 사용자가 다시 로그인한다. 데이터는 잃지 않고, 진행 중이던 GitHub·Slack 연결과 Google 로그인은 처음부터 다시 한다. `X-Requested-With: agent-platform-web`을 보내던 스크립트는 쿠키 세션의 변경 요청에서 `403`을 받으므로 `werft-web`으로 바꾼다. API key 호출에는 영향이 없다.
8. **컨테이너·볼륨·Pod의 라벨과 이름 접두사가 `werft`로 바뀌었다**(JeongJaeSoon/werft#1232). 라벨은 `agent-platform.*`에서 `werft.*`로, Kubernetes의 `part-of`는 `werft`로, 작업 공간 볼륨·PVC 이름은 `ap-ws-*`에서 `werft-ws-*`로, 네트워크는 `ap-net-*`에서 `werft-net-*`로 바뀐다. 볼륨 라벨과 PVC 이름은 만든 뒤에 고칠 수 없어서, 이전 스냅샷으로 만든 설치를 그 자리에서 올리면 기존 작업 공간을 찾지 못한다. 이 경우 새로 설치한다.
9. **기본 secret id가 `werft/*`로 바뀌었다**(JeongJaeSoon/werft#1239). 로컬 스택의 시드, 예시 설정 문서, Helm 예시(`werft/prod/control-plane`)가 해당한다. 옛 id로 설정을 import한 DB에 새 예시 문서를 import하면 충돌로 전체 거부되어 `migrate`가 실패하고 API가 시작하지 않는다. 이전 스냅샷의 DB는 그대로 쓰지 말고 새로 설치한다.
10. **단일 서버(test-ops)의 기본 설정 파일, 상태 디렉터리, compose project, Datadog 환경 파일 경로가 `werft`로 바뀌었다**(JeongJaeSoon/werft#1251). 새 기본값은 `/etc/werft`, `/var/lib/werft/test-ops`, `werft-test-ops`다. 이전 스냅샷으로 만든 설치는 옛 경로의 설정 파일을 읽지 않으므로 제자리로 올릴 수 없다. 새로 설치한다.

11. **로컬 스택의 compose project, kind 클러스터, 백업 스크립트 기본값, 상태·캐시 디렉터리가 `werft`로 바뀌었다**(JeongJaeSoon/werft#1247). 새로 띄우는 스택은 `werft` project의 새 volume에서 시작한다. 이전 이름으로 띄운 스택의 데이터는 지우지 않지만 새 project는 읽지 않는다. 비밀 키 파일이 없는데 project의 `postgres-data` volume이 있으면 `scripts/local.sh up`은 새 키를 만들지 않고 멈춘다. 새 키로는 저장된 비밀 값을 못 읽기 때문이다.

### 게시 패키지

- 이미지 셋(`werft-control-host`, `werft-worker`, `werft-egress-proxy`)이 `ghcr.io/jeongjaesoon/`에 `main-<12>` 태그로 `main` 머지마다 게시된다(JeongJaeSoon/werft#1168).
- 이미지는 `linux/amd64`와 `linux/arm64`를 담은 index다. 노드가 자기 아키텍처를 받고, chart의 digest는 index를 가리킨다(JeongJaeSoon/werft#1186). 이 변경 전의 `main-<12>` 태그는 amd64뿐이다.
- Helm chart `werft`가 `oci://ghcr.io/jeongjaesoon/werft`에 `0.1.0-main-<12>` 버전으로 게시된다. chart 하나가 세 이미지의 digest와 worker runtime을 담아, checkout 없이 설치한다(JeongJaeSoon/werft#1177). 로그인 없이 받는다.
- TypeScript SDK `@werft-ai/sdk`는 npm trusted publishing으로 게시된다(JeongJaeSoon/werft#1176).

### 단일 서버

- `scripts/test-ops.sh`에 `stop`(volume 유지)과 `start`(내려간 설치를 같은 volume으로 다시 올림)를 더했다. `compose down`이나 재부팅 뒤에는 `deploy`(release 기록이 있어 거부)나 `upgrade`(postgres 없이 실패)가 아니라 `start`를 쓴다. 재부팅하면 postgres, api, localstack은 스스로 올라오지 않으므로 `start`를 직접 부른다(JeongJaeSoon/werft#1249).

### 게시 이미지에서 빠진 것

- 게시 이미지(control-host, worker, egress-proxy)에서 테스트 소스, testkit, Storybook, 스냅샷, 데모 계정·데모 데이터를 뺐다(JeongJaeSoon/werft#1194). 이미지가 작아지고, 서버에 시험 도구가 남지 않는다.
- 그래서 **게시 이미지로 띄운 스택(게시 chart로 띄운 preview 포함)에서는 데모 계정 CLI(`demo-accounts.ts`)를 쓸 수 없다.** 부르면 `Module not found`로 실패한다. 데모 계정과 시험용 IdP, mock-slack은 저장소의 로컬 스택(`local` target)에만 있다.

### 문서

- 셀프 호스팅 문서를 단일 서버 설치와 Kubernetes 설치로 나눴다(JeongJaeSoon/werft#1193). Kubernetes 설치는 게시 chart로 kind에서 확인했으나 DB Secret 단계는 문서 블록 그대로가 아니었고, 고친 kind Secret 블록은 실행하지 않았다. 이후 `v0.1.0`과 같은 commit(`9e2098e5`)에서 `main-<12>` 게시물로 확인했다(Kubernetes: chart 설치부터 rollout, readyz·docs 200, bootstrap 201과 재요청 409, 키 있음 200·없음 401. 단일 서버: 3~7단계에서 readyz·docs 200, bootstrap 201, 키 있음 200·없음 401). 실제 AWS S3·IAM과 실제 DNS·공인 인증서에서의 실행은 아직 실측하지 않았다.
- 업그레이드 문서를 한국어, 영어, 일본어로 문서 사이트에 더했다. 업그레이드 문서가 적은 범위 밖의 절차와 **릴리스 버전(`v0.1.0`)으로 올리는 업그레이드는 실행해 확인하지 않았다.**

### 라이선스

- 저장소는 [PolyForm Small Business License 1.0.0](LICENSE)을 따르는 source-available 코드다.
- `packages/sdk`(npm `@werft-ai/sdk`)와 `examples/`만 Apache License 2.0이다. 범위는 [README](README.md#라이선스)에 있다.

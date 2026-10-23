# API 서버 — 카탈로그, 자격 증명, checkpoint 저장소, 인증과 권한

API 서버가 운영자 카탈로그(Agent Profile·repository)와 자격 증명을 다루는 방식, checkpoint object store, API 인증과 세션 실행 권한을 적는다. 설정값은 [설정 레퍼런스](configuration.md)에, worker 실행과 격리는 [실행 기반과 worker 격리](execution.md)에 있다.

## provider 키와 저장소 자격 증명은 worker에 가지 않는다

worker 컨테이너 env에도, claim 응답에도 provider 키와 저장소 로그인이 없다. claim은 attempt마다 새로 만든 **egress token** 세 개만 준다(`runtime_config.provider.auth = {kind: "egress_token", token}`, `workspace.repository.access`, `object_store.access`). 세 token은 session credential과 수명이 같다. claim 재생이면 폐기하고 다시 발급하며, heartbeat가 연장하고, attempt가 끝나면 폐기한다. 각 token은 claim 시점의 profile fingerprint, 저장소 binding, 세션 object prefix에 묶여 있다.

* **credential route:** egress proxy는 forward proxy(3128) 옆에 두 번째 listener `EGRESS_CREDENTIAL_PORT`(기본 3129)를 연다. 이 listener가 받는 요청은 아래 다섯 가지뿐이고, 나머지는 404다.
  * `POST /provider/v1/messages`
  * `POST /provider/v1/messages/count_tokens`(query는 없거나 `?beta=true`)
  * `GET /repository/info/refs?service=git-upload-pack`
  * `POST /repository/git-upload-pack`
  * `/object-store/<bucket>/<key>` 아래의 S3 요청(아래 object store route)
* **요청 하나의 처리:** proxy는 요청마다 API의 authorizer에 token을 묻는다. authorizer는 API의 별도 listener로, `EGRESS_AUTHORIZER_PORT`의 `POST /authorize`에서 `EGRESS_AUTHORIZER_TOKEN` bearer를 요구한다. 같은 listener의 `POST /usage`는 proxy가 Messages 호출의 usage를 보고하는 곳이다([설치 상한](configuration.md#설치-상한)). token이 지금 유효하면 authorizer는 upstream과 붙일 헤더를 돌려준다. 유효하다는 것은 lease가 DB 시계로 살아 있고 epoch가 맞으며 purpose가 일치한다는 뜻이다. proxy는 worker의 token을 떼고 카탈로그의 자격 증명을 붙여 upstream으로 보낸다.
* **fail-closed:** 긍정 응답은 캐시하지 않는다. 그래서 authorizer가 죽어 있으면 503이고, attempt를 잃은 token은 다음 요청부터 401·409다.
* **upstream 연결:** upstream은 forward proxy와 같은 allowlist·주소 규칙으로 판정한다. 연결은 판정한 주소에 하고, TLS 인증서는 카탈로그의 host 이름으로 요청을 보내기 전에 검증한다. redirect는 따라가지도 전달하지도 않는다(502, GitHub의 경우는 아래 "GitHub 저장소" 절). 오류 본문에 주입한 자격 증명이 되비쳐 있거나, 본문이 압축돼 있거나, 64 KiB를 넘으면 본문을 보류한다.
* **요청 본문 상한:** Bun은 handler가 읽지 않은 요청 본문도 소켓에서 곧바로 받아 메모리에 쌓는다. 그래서 proxy는 await 전에, 요청 head만 보고 받을지 정한다. provider·repository 본문은 요청당 32 MiB(Messages API 한도)이고, 넘게 선언하면 authorizer에 묻기 전에 413이다. chunked 본문은 32 MiB까지만 읽고 413이다. object store 본문은 길이를 선언해야 한다(chunked면 411). 받은 요청은 선언한 길이(chunked면 32 MiB)만큼 설치 전체 예산 512 MiB(`DEFAULT_MAX_BODY_BYTES_IN_FLIGHT`)에서 떼어 두고, 교환이 끝나면 돌려놓는다(upstream은 본문을 다 받기 전에 답할 수 있다). 받은 본문은 예약한 크기의 버퍼 하나에 모은다. 예산에 들어가지 않는 요청은 503 `too many request bytes in flight`다. authorizer도 요청 본문을 16 KiB까지만 읽고 413으로 끊는다.
* **proxy 컨테이너:** compose `egress-proxy`는 worker처럼 `read_only`·`cap_drop: [ALL]`·`no-new-privileges`로 돌고 `/tmp`만 tmpfs다. `mem_limit`은 3072 MiB다. 요청 본문 예산 512 MiB, 응답 큐 64 MiB, forward proxy 큐 2048 MiB(연결 256 × 2 × 4 MiB), Bun 256 MiB를 더한 상한이다. 측정값이 아니다. 이 상한들을 바꾸면 한도도 같이 바꾼다. 죽으면 `restart: unless-stopped`로 같은 컨테이너가 다시 뜨고, worker 네트워크 연결은 그대로 남는다.
* **object store route:** 워커의 S3 SDK는 `object_store` token을 SigV4 access key id로(secret은 아무 값이나) 삼아 `<route>/object-store`에 path-style로 보낸다. proxy는 `Authorization`의 `Credential=`에서 token을 꺼내 요청의 method·target·헤더와 함께 authorizer에 묻는다. authorizer는 token과 generation fence를 확인하고 요청이 세션 prefix 안의 허용된 연산인지 판정한 뒤, API 자신의 키로 서명한 target과 헤더를 돌려준다. 허용하는 연산은 넷이다: prefix 안 object의 GetObject·HeadObject(버전 지정 포함), 새 key를 만드는 PutObject(`If-None-Match: *` 필수라서 덮어쓰기가 없다. checksum 헤더 허용), 세션 prefix의 ListObjectsV2. Delete, legal hold·retention·ACL, governance 우회, copy, multipart, version 목록, `aws-chunked` 본문, 인코딩된 `/`·dot segment는 전부 403 `AccessDenied`다. 모르는 token은 401 `InvalidAccessKeyId`다. proxy는 서명된 헤더와 target만 upstream에 보내고, PUT 본문은 서명된 길이만큼 흘려 보낸다(서명은 `UNSIGNED-PAYLOAD`, 요청당 512 MiB 상한). 비밀 키는 API를 떠나지 않는다. 다음 generation이 claim하면 이전 token의 새 요청은 곧바로 거부되고, 이미 열린 교환은 regrant 주기(30초) 안에 끊긴다. 그 사이에 끝나는 늦은 PUT도 create-only라서 이미 있는 object를 바꾸지 못하고, 커밋된 checkpoint가 가리키지 않는 object를 하나 더할 뿐이다. API는 checkpoint object store 설정(아래)으로 서명하며, `CHECKPOINT_OBJECT_STORE=disabled`면 이 route는 503이다.
* **engine:** `ANTHROPIC_BASE_URL`이 `<route>/provider`다. checkpoint fingerprint에는 여전히 카탈로그 endpoint가 들어가고, `auth_kind`는 `egress_token`이 된다. 따라서 이전에 만든 checkpoint는 fingerprint 불일치로 재개가 거부된다(출시 전이라 옮기지 않는다).
* **engine의 token은 env에 없다:** worker는 token을 env가 아니라 engine의 fd 3에 붙인 socket으로 준다(`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3`). engine은 첫 요청 전에 한 줄을 읽고 fd를 닫는다. 그래서 turn 안의 도구는 자기 env에서도, 같은 uid인 모든 프로세스의 `/proc/<pid>/environ`에서도 token을 찾지 못한다. socket이라 `/proc/<pid>/fd/3`으로 다시 열 수도 없다.
  * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`은 쓰지 않는다. bubblewrap이 필요하고, 워커 격리(`cap_drop: ALL`, `no-new-privileges`)에서는 namespace를 만들지 못한다. permission mode도 `default`로 강제한다.
  * 남은 경로는 engine 메모리를 읽는 것(ptrace, `process_vm_readv`)이다. 도구는 engine의 자손이므로 host의 `kernel.yama.ptrace_scope`가 1 이상이면 막힌다. 0인 host에서는 막히지 않는다.
  * LiteLLM `bearer` 인증은 fd 경로가 없어 `ANTHROPIC_AUTH_TOKEN` env로 준다. worker는 늘 `egress_token`을 쓰므로 이 경우가 없다.
* **git:** `<route>/repository`로 clone하며 token은 git 자식 프로세스의 `http.extraHeader`로만 들어간다. `http.followRedirects=false`를 걸고, clone 직후 origin을 카탈로그 URL(userinfo 없음)로 되돌린다. push 경로는 없다.
* **이벤트에서 값 지우기:** engine의 도구는 worker 프로세스의 env를 읽을 수 있다. 그래서 worker는 자기가 가진 비밀을 값 그대로 찾아 `<redacted>`로 바꾼 뒤 이벤트·pending 요청을 내보낸다. 대상은 nonce, session credential, egress token 셋이다. base64처럼 다시 인코딩된 값은 걸러지지 않는다. token은 attempt 범위이고 worker 네트워크 밖에서는 쓸 수 없으므로 그 한계를 받아들인다.
* **이벤트·승인 요청의 가림:** worker는 그에 앞서 Claude adapter의 규칙(`packages/adapters/runtimes/claude/src/mapper.ts`)으로 tool event와 승인 요청의 `input`을 가린다. `authorization`·`cookie`·`secret`·`password`·`api_key` 같은 키의 값과 `Bearer …`·`sk-ant-…` 모양의 값은 `[REDACTED]`가 된다. 문자열 안의 `api_key=값`은 값이 끝나는 곳이 분명할 때만 값만 가린다. 값이 한 단어이고 뒤에 공백·`&`·`;`·`|`·`)`나 문자열 끝이 오거나, 값 전체가 펼칠 것 없는 따옴표 문자열 하나일 때다. 그 밖의 경우(`password: 값`, escape, `$'…'`, 이어 붙인 따옴표, 다음 줄에 오는 값)는 문자열 전체를 가린다. 경로(`file_path`·`path`·`notebook_path`·`cwd`)는 키 이름으로 가리지 않는다. 사용자가 어떤 파일을 쓰는 요청인지 보고 승인해야 하기 때문이다. 경로 안에 `api_key=…` 같은 조각이 있으면 다른 문자열처럼 그 값만 가린다. 승인 답을 맞춰 보는 `input_hash`는 가리기 전의 실제 인자로 계산한다.
* **로그 마스킹:** worker와 egress-proxy의 stdout 로그도 API와 같은 규칙(`packages/observability/src/redaction.ts`)으로 가린다. `authorization`·`token`·`secret`·`password`·`credential`·`api_key` 같은 키의 값, `Bearer …`·`sk-…`·`gh?_…`·`AKIA…` 모양의 값, `token=`·`password:` 같은 조각이 든 문자열은 `[REDACTED]`가 된다. URL의 login(`https://user:pass@host`)은 그 부분만 가린다. worker는 여기에 더해 위의 비밀 값을 `<redacted>`로 바꾼다. egress-proxy 이미지는 workspace 의존성을 싣지 않으므로 같은 파일의 사본(`apps/egress-proxy/src/redaction.ts`)을 쓰고, unit test가 두 파일이 같은지 확인한다. worker 로그 줄은 `{timestamp, level, event, ...fields}`이고, fields가 `timestamp`·`level`·`event`를 덮지 못한다. worker 로그 수준은 scheduler의 `LOG_LEVEL`을 따른다. scheduler가 worker 컨테이너를 만들 때 자기 값을 env로 넘긴다. 이 값은 격리 계약 stamp에 들어가지 않으므로, 값을 바꾼 뒤 scheduler가 재시작하면서 adopt한 컨테이너는 만들어질 때의 수준을 그대로 쓴다. 새 수준은 다음에 새로 뜨는 worker부터 적용된다.
* **compose:** `api`는 `EGRESS_AUTHORIZER_PORT=3100`을 publish하지 않는다. 어느 worker allowlist에도 없으므로 compose 네트워크의 `egress-proxy`만 부른다. `EGRESS_AUTHORIZER_TOKEN`의 compose 기본값은 로컬 스택 전용이므로 다른 곳에서는 `../.env`로 바꾼다. host에서 띄운 API를 쓸 때는 `EGRESS_AUTHORIZER_URL=http://host.docker.internal:3100`을 준다. 두 값 중 하나만 있으면 API와 proxy 모두 기동을 거부한다. 둘 다 없으면 경고만 내고 뜨지만, 그 상태의 worker는 provider에도 저장소에도 닿지 못한다.

## 운영자 카탈로그 (Agent Profile · repository)

API는 기동 시 `PLATFORM_CONFIG_DIR`(기본: 저장소의 `config/`)에서 `profiles.yaml`과 `repositories.yaml`을 한 번 읽는다. 파일이 없거나 schema에 맞지 않거나 자격 증명 참조가 풀리지 않으면 파일·경로를 적은 메시지와 함께 기동하지 않는다. 옛 `SESSION_CATALOG_JSON`은 더 읽지 않으며 설정돼 있으면 기동을 거부한다. 저장소의 `config/`는 실제 Messages API용 카탈로그다([real-claude.md](../real-claude.md)). `config/fake-model/`은 key 없이 도는 fake 카탈로그이고, `--fake-model` overlay(`infra/compose.fake-model.yml`)가 `PLATFORM_CONFIG_DIR`를 그 디렉터리로 바꾼다([quickstart.md](../quickstart.md)).

- profile의 `provider.auth`에는 값 대신 참조를 하나만 적는다: API 프로세스 환경 변수 `value_env`, 또는 Secrets Manager `secret_id`(`AWS_ENDPOINT_URL_SECRETS_MANAGER`로 endpoint 지정, `AWS_ENDPOINT_URL`은 따르지 않는다). 값은 기동 시 한 번 해석되고 worker에는 가지 않는다. egress proxy의 credential route가 요청마다 authorizer에 물어 upstream 요청에 붙인다(위 절).
- profile의 `models`는 세션이 `POST /v1/sessions`의 `model`로 고를 수 있는 모델 목록이다. `model`은 기본값이고 늘 고를 수 있다. 목록에 없는 모델로 만들면 `422 UNSUPPORTED_CAPABILITY`이고 세션은 생기지 않는다. 세션은 고른 모델로 바꾼 profile의 지문에 묶이므로, 목록에 모델을 더해도 기존 세션은 그대로 돈다. 세션이 쓰는 모델을 목록에서 빼면 그 세션은 아래와 같이 `CATALOG_MISMATCH`가 된다. provider·`billing`·tools는 profile 단위라 모델을 골라도 바뀌지 않고, 비용은 응답이 밝힌 모델 가격으로 매겨져 세션 상한에 그대로 걸린다.
- `repositories.<id>.profiles`가 그 저장소에서 돌 수 있는 profile allowlist다. `(profile, repository)` 쌍이 신뢰 단위이며, 목록에 없는 쌍이나 모르는 id로 `POST /v1/sessions`를 부르면 `422`다.
- 이미 만든 세션의 쌍이 빠졌거나, id가 다른 URL·branch를 가리키게 되거나, 같은 profile id의 설정(model·tools·permission_mode·endpoint·runtime version·project_settings·자격 증명 참조 위치)이 세션을 만들 때와 달라지면, 세션 상세의 `attention`이 `CATALOG_MISMATCH`가 되고 그 세션으로 뜬 worker의 첫 claim이 `409 CATALOG_MISMATCH`를 받는다. 그 자리에서 대기 중이던 turn은 `failed`(`terminal_reason: catalog_mismatch`), 해당 receipt는 `CATALOG_MISMATCH`, 세션은 `failed`가 되고 status 이벤트에 같은 코드가 남는다. worker는 claim timeout을 기다리지 않고 바로 나가며, 다음 scheduler pass가 슬롯을 돌려받아 다른 세션을 띄운다. 메시지에는 저장소 id만 적히고 URL은 나오지 않는다. `resuming` 중인 세션이면 resume이 `CATALOG_MISMATCH`로 실패해 `recovery_required`로 가고, 대기 중인 입력은 복구 결정을 위해 남는다.
- **카탈로그를 되돌려도 저절로 다시 실행되지는 않는다.** 되돌리면 `attention`이 사라지고, 그 세션에 새 메시지를 보내면 새 generation으로 다시 뜬다. 실패한 turn은 재시도되지 않으므로 필요한 입력은 다시 보낸다. 되돌리지 않은 채 메시지를 보내면 그 입력도 첫 claim에서 곧바로 같은 코드로 실패한다(추가 메시지를 422로 막지는 않는다 — 받은 입력은 receipt로 결말을 알린다).
- **이 즉시 실패는 권위 있는 카탈로그만 쓴다.** 각 API는 기동 시 읽은 자기 카탈로그로 판단한다. 그래서 카탈로그가 다른 replica가 섞인 rolling update 동안에는 요청을 받은 replica에 따라, 다른 replica라면 돌릴 세션이 실패할 수 있다. 이를 막으려고 DB에 **활성 catalog revision**(`catalog_authority`, 행 하나)을 둔다. 기동 로그 `Session catalog loaded`의 `revision`이 활성 revision과 같은 replica만 세션을 실패시킨다. 다른 replica는 아무것도 쓰지 않고 claim에 `404 NOT_FOUND`(잡을 세션 없음)로 답한다. worker는 claim timeout 뒤 나가고, launch 실패 횟수·격리가 안전망으로 남는다. 활성 revision은 API가 스스로 정하지 않고 운영자가 compare-and-swap으로만 바꾼다. API 기동은 이 행을 읽지 않고, 불일치 경로에서만 읽는다.
  - **한 replica(compose 기본):** 행이 없으면 모든 API가 권위 있는 것으로 본다. 활성화하지 않아도 위 동작(첫 claim에 즉시 실패)은 그대로다.
  - **둘 이상 띄우기 전:** 지금 카탈로그의 revision을 활성화한다: `bun run catalog-authority activate <revision> --expected none`. compose 밖이라면 API 이미지 안에서 `DATABASE_URL`을 주고 `bun run apps/control-host/src/api/catalog-authority.ts …`로 같은 명령을 쓴다. 활성화한 뒤로는 행을 지우지 않는다.
  - **카탈로그 변경:** 활성화를 롤아웃의 첫 단계로 한다.
    1. 새 카탈로그로 replica 하나를 먼저 올리고, 기동 로그에서 새 revision을 읽는다.
    2. `bun run catalog-authority activate <새 revision> --expected <옛 revision>`으로 넘긴다. 이때부터 옛 replica는 권위가 없어 어떤 세션도 즉시 실패시키지 않는다. 롤아웃 동안 옛 replica가 비권위인 것은 의도된 안전 방향이다(권위 없는 쪽은 실패를 쓰지 않을 뿐 세션을 잃지 않는다).
    3. 나머지 replica를 올린다.
    - 새로 **추가**한 쌍으로 세션을 만드는 것은 2 뒤에 한다. 그 전에는 옛 revision이 활성이라, 그 쌍을 모르는 옛 replica가 새 replica에서 만든 세션을 실패시킬 수 있다.
    - 쌍을 **빼는** 변경은 2부터 새 replica가 빠진 쌍의 세션을 즉시 실패시킨다.
  - **롤백:** 같은 순서를 거꾸로 밟는다. 옛 카탈로그 replica 하나를 올린 뒤 `activate <옛 revision> --expected <새 revision>`을 실행하고 나머지를 되돌린다. `--expected`가 지금 값과 다르면 아무것도 바꾸지 않고 `conflict`와 지금 값을 출력하며 1로 끝난다. 지금 값은 `bun run catalog-authority show`로 본다.
  - **판단 기록:** 권위 없는 replica가 빠진 쌍의 세션을 claim까지 거절하지는 않는다. 쌍을 모르는 replica는 원래 그 세션을 claim하지 않는다. 쌍을 아는 옛 replica는 옛 카탈로그를 믿으므로 롤아웃 동안 한 번 더 돌릴 수 있다. 쌍을 빼는 일이 보안 경계라면(그 저장소에서 더는 돌면 안 되는 경우) 옛 replica를 먼저 내린 뒤 뺀다.
- 비공개 저장소는 `repositories.<id>.auth`에 로그인을 같은 방식의 참조로 적는다. `kind: basic`(`username` 필요) 또는 `kind: bearer`이고, `value_env`·`secret_id` 중 하나를 쓴다. worker는 이 값을 받지 않고 proxy의 저장소 route로 clone한다. 저장소 host는 Gitea든 GitHub든 같은 방식이다. GitHub는 아래 절을 따른다.
- 두 자격 증명 모두 8바이트보다 짧으면 API가 기동을 거부한다. proxy는 upstream 응답에 주입한 값이 되비치는지 검사하는데, 스트림 본문에서는 8바이트 이상인 값만 검사하기 때문이다.
- endpoint·저장소 URL은 `http://`·`https://`만 받는다(worker가 밖으로 나가는 길은 HTTP(S) egress proxy뿐이다). 자격 증명(userinfo, query string)이 들어 있으면 거절한다.
- profile마다 `sha256:` fingerprint(설정과 참조의 정규 JSON 해시, 값 제외)가 worker claim의 `profile_fingerprint`로 가고, 카탈로그 전체의 revision은 기동 로그 `Session catalog loaded`에 남는다. 같은 참조 뒤의 값만 회전하면 fingerprint는 바뀌지 않는다.
- 세션은 만들 때의 profile fingerprint를 저장하고, claim은 카탈로그의 같은 id가 그 fingerprint로 해시될 때만 세션을 묶는다. 설정을 바꾸려면 **새 profile id**를 등록하고 새 세션을 그 id로 만든다. 기존 id를 고치면 그 id로 만든 세션은 모두 위의 `CATALOG_MISMATCH`가 되고, 되돌리면 다시 돈다. 자격 증명 값은 claim 때 카탈로그에서 읽으므로 같은 참조 뒤의 값 회전(그리고 API 재기동)은 기존 세션을 막지 않는다. 이 컬럼 전에 만든 세션은 fingerprint가 비어 있고 다음 claim이 그때의 fingerprint로 고정한다.

### GitHub 저장소

github.com과 GitHub Enterprise Server(GHES)의 저장소도 Gitea와 같은 저장소 route로 clone한다. 인증은 GitHub App이 기본이고 fine-grained PAT도 쓸 수 있다. 둘 다 worker에는 가지 않는다.

#### GitHub App (기본)

API가 App의 private key로 JWT를 서명해 설치 토큰을 받고, 그 토큰을 proxy의 저장소 route에 내준다. 토큰은 1시간짜리라 API가 갱신한다.

- **App 만들기:** 조직(또는 계정) Settings → Developer settings → GitHub Apps → New GitHub App. Webhook은 끈다(지금은 쓰지 않는다). Repository permissions는 **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read-only**(자동)다. clone은 Contents read만 쓰지만, push·PR(아래 절)이 같은 App을 쓰므로 처음부터 준다. 토큰을 발급할 때마다 그 요청이 쓰는 권한만 다시 좁히므로(아래) clone 토큰에는 쓰기 권한이 없다. 만든 뒤 페이지 위쪽의 **App ID**를 적어 둔다.
- **설치:** App 페이지 → Install App → 저장소 owner를 고르고 **Only select repositories**로 쓸 저장소만 고른다. 설치 뒤 주소 `…/settings/installations/<숫자>`의 숫자가 **installation id**다.
- **private key:** App 페이지 → Private keys → Generate a private key로 PEM 파일을 받는다. 키는 API만 읽는다. 둘 중 하나로 둔다.
  - Secrets Manager: PEM 본문을 secret 값으로 넣고 카탈로그에 `secret_id`를 적는다(`aws secretsmanager create-secret --name <id> --secret-string file://<pem 파일>`).
  - 환경 변수: PEM 파일을 `chmod 600`으로 두고 API를 띄우는 셸에서 `export GITHUB_APP_KEY="$(cat <pem 파일>)"`로 넘긴다. 한 줄로 넣어야 하는 곳에서는 줄바꿈을 `\n`으로 적어도 된다. compose의 `api`에는 overlay로 `environment: { GITHUB_APP_KEY: ${GITHUB_APP_KEY:?} }`를 더한다.
  - 내려받은 PEM 파일은 위 둘 중 하나에 넣은 뒤 지운다. 키를 바꾸면 같은 참조 뒤의 값만 바꾸고 API를 재기동한다(binding·revision은 그대로다).
- **카탈로그:**

  ```yaml
  repositories:
    app:
      url: https://github.com/<owner>/<repo>.git     # GHES: https://<ghes-host>/<owner>/<repo>.git
      branch: main
      profiles: [claude-coding-real]
      auth:
        kind: github_app
        app_id: 123456
        installation_id: 7890123
        secret_id: agent-platform/github-app-key     # 또는 value_env: GITHUB_APP_KEY
        api_base: https://api.github.com             # 생략하면 이 값. GHES: https://<ghes-host>/api/v3
  ```

  URL은 `/<owner>/<repo>` 모양이어야 한다(토큰을 그 저장소 이름으로 좁히기 때문이다). `api_base`는 https만 받는다. 사설 이름·주소의 host(로컬 fake)만 http를 허용한다. API는 기동할 때 키를 RSA private key로 읽어 보고, 읽히지 않으면 `repositories.<id>.auth.<참조>: … is not an RSA private key PEM`으로 기동을 거부한다(값은 출력하지 않는다). `app_id`·`installation_id`·`api_base`·참조 위치를 바꾸면 그 저장소의 binding이 바뀌어 이미 만든 세션은 `CATALOG_MISMATCH`가 된다.
- **토큰:** 저장소 route가 요청마다 API에 물으면 API는 `POST {api_base}/app/installations/{installation_id}/access_tokens`에 `repositories: [<repo>]`, `permissions: { contents: read }`를 보내 그 저장소 하나·읽기 권한으로 좁힌 토큰을 받는다. 토큰은 저장소·권한별로 API 프로세스 메모리에 두고 `expires_at` 10분 전부터 새로 받는다. 같은 토큰을 동시에 묻는 요청은 발급 한 번을 같이 기다린다. 진행 중인 clone은 시작할 때의 토큰으로 끝까지 받는다. JWT는 `@octokit/auth-app`이 만든다(iat는 30초 앞당기고 수명은 10분).
- **실패:** 발급이 실패하면(키·installation이 틀림, GitHub 장애, App 설치 해제) 저장소 route는 `503`으로 닫힌다. 남은 토큰이 아직 유효해도 갱신 시점이 지났으면 쓰지 않는다. clone은 시작 단계에서 실패해 세션 attention이 `STARTUP_FAILED`다. API 로그에는 `GitHub request failed`(`request: installation token request`, `status`, `error`)와 egress authorizer의 `Egress authorization refused`(`status: 503`, `code: BACKEND_UNAVAILABLE`)가 남는다. 토큰·JWT·키는 로그와 오류 메시지에 나오지 않는다. status가 401이면 App ID·키 짝, 404면 installation id와 그 설치에 저장소가 들어 있는지, 422면 저장소 이름을 확인한다.
- **allowlist:** 토큰 발급은 API가 직접 한다(`api.github.com:443` 또는 GHES의 `<ghes-host>:443`로 API 컨테이너의 outbound가 열려 있어야 한다). clone은 아래 PAT와 같이 proxy의 `EGRESS_CREDENTIAL_ALLOWLIST`에 `github.com:443`(GHES는 `<ghes-host>:443`)을 더한다.

#### fine-grained PAT

- **PAT 발급:** GitHub Settings → Developer settings → Fine-grained personal access tokens. Resource owner는 저장소의 owner(조직이면 조직이 승인해야 할 수 있다), Repository access는 `Only select repositories`로 그 저장소만 고른다. Repository permissions는 **Contents: Read-only** 하나다(Metadata: Read-only는 자동으로 붙는다). 만료일을 두고, 만료 전에 같은 참조 뒤의 값만 바꾼 뒤 API를 재기동한다(fingerprint·revision은 그대로다). 승인된 세션 결과를 push하려면(아래 [승인된 요청의 push](#승인된-요청의-push) 절) **Contents: Read and write**로 준다. 그 PAT는 API만 쓰고 worker에는 가지 않는다. push를 쓰지 않으면 Read-only로 둔다.
- **카탈로그:** URL은 https clone URL 그대로 `.git`까지 적는다. GHES는 host만 다르다. 로그인 이름은 `x-access-token`이고 PAT를 비밀번호 자리에 둔다. 공개 저장소는 `auth` 없이 등록해도 clone된다.

  ```yaml
  repositories:
    app:
      url: https://github.com/<owner>/<repo>.git   # GHES: https://<ghes-host>/<owner>/<repo>.git
      branch: main
      profiles: [claude-coding-real]
      auth:
        kind: basic
        username: x-access-token
        value_env: APP_GITHUB_PAT                  # 또는 secret_id
  ```

  `value_env`는 API 프로세스의 환경 변수다. compose의 `api`는 정해진 변수만 넘기므로 overlay에 `environment: { APP_GITHUB_PAT: ${APP_GITHUB_PAT:?} }`를 더한다.
- **allowlist:** `github.com:443`(GHES는 `<ghes-host>:443`)을 egress proxy의 `EGRESS_CREDENTIAL_ALLOWLIST`에 더한다. compose 기본값은 `api.anthropic.com:443`이므로 `EGRESS_CREDENTIAL_ALLOWLIST=api.anthropic.com:443,github.com:443`처럼 기존 값을 함께 적는다. 사설 주소의 GHES는 `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST`에 둔다. forward 목록(`EGRESS_ALLOWLIST`)에는 넣지 않는다. 넣으면 proxy가 기동을 거부하고, 넣지 않았으므로 worker의 도구(Bash의 `git`·`curl`, npm의 git 의존성)는 GitHub에 직접 닿지 못한다. 2026-10-13 로컬 스택 실측에서 worker 안의 `git ls-remote https://github.com/octocat/Hello-World.git`은 `CONNECT tunnel failed, response 403`으로 끝났고, proxy에는 `Egress denied`(`destination is not allowlisted`)가 남았다.
- **redirect:** route는 3xx를 따라가지도 전달하지도 않고 502 `upstream redirected`로 끝낸다. clone은 `git clone failed (exit 128): remote: upstream redirected`로 실패하고 세션 attention은 `STARTUP_FAILED`다. GitHub가 git 요청에 301을 주는 경우로 확인한 것은 `http://` URL(→ `https://`)이다. 이름을 바꾼 저장소(`vuejs/vue-next` → `vuejs/core`)와 `.git`을 뺀 URL은 2026-10-13 실측에서 redirect 없이 200이었다. proxy 로그에 `Credential route`가 `status: 301`로 남으면 카탈로그 URL을 응답이 가리키는 주소로 고친다.
- **401:** 로그인 없이 읽을 수 없는 저장소(없는 저장소, `auth`를 빠뜨린 비공개 저장소)에 GitHub는 401을 준다. proxy 로그는 `Credential route`의 `status: 401`이고, clone은 `fatal: could not read Username for 'http://egress-proxy:3129': terminal prompts disabled`로 실패한다(attention `STARTUP_FAILED`, 2026-10-13 실측). 틀리거나 권한이 모자란 PAT의 응답은 아직 재지 않았다. 아래 절차에서 status를 확인한다.
- **확인:** clone이 되면 proxy 로그에 세션 id와 함께 `"message":"Credential route"`, `"purpose":"repository"`, `"host":"github.com"`, `"status":200` 줄이 남는다(실측에서 clone 한 번에 세 줄). worker의 작업 트리에서 `git remote get-url origin`은 카탈로그 URL이고 로그인을 담지 않는다.
- **LFS·submodule:** 저장소 route는 upload-pack만 다룬다. Git LFS 객체와 submodule은 받지 않는다.

비공개 저장소와 PAT로 확인하는 절차다. `scripts/local.sh up --fake-model`로 띄운 스택에 카탈로그 overlay를 겹친다. PAT 값은 셸에서 `read -rs`로 받아 화면과 파일에 남기지 않는다.

1. 위 형식으로 `repositories.yaml`과 `config/fake-model/profiles.yaml` 사본을 디렉터리 하나에 둔다. 저장소의 `profiles`는 `[claude-coding-local]`이다.
2. overlay를 만든다. `api`에 `volumes: ["<그 디렉터리>:/app/config/fake-model:ro"]`과 `environment: { APP_GITHUB_PAT: ${APP_GITHUB_PAT:?} }`를 준다(`--fake-model` overlay가 `PLATFORM_CONFIG_DIR`를 `/app/config/fake-model`로 고정하므로 그 자리에 mount한다).
3. `read -rs APP_GITHUB_PAT; export APP_GITHUB_PAT EGRESS_CREDENTIAL_ALLOWLIST=api.anthropic.com:443,github.com:443 COMPOSE_FILE="compose.yaml:<overlay>"` 뒤 `scripts/local.sh up --fake-model`.
4. API 기동 로그 `Session catalog loaded`의 `repositories` 수를 보고, quickstart 2·3장처럼 `repository_id`를 그 저장소로 바꿔 세션을 만든다.
5. 세션이 `needs_input`이나 `completed`에 닿으면 `docker compose logs egress-proxy | grep '"purpose":"repository"'`에서 `status: 200`을 확인한다. `STARTUP_FAILED`면 위의 401·redirect 항목을 본다.
6. `scripts/local.sh down`(같은 환경 변수로)으로 내리고 `unset APP_GITHUB_PAT`.

### 세션 결과의 push 승인

세션의 결과는 worker가 아니라 플랫폼(API)이 push하고, 사람이 승인한 뒤에만 한다. 이 절은 요청과 승인이고, 승인된 요청의 push는 다음 절이다. API 사용법은 [api-guide 10절](../api-guide.md#10-세션-결과의-push-요청과-승인거부)에 있다.

- **고정하는 것:** 요청(`POST /v1/sessions/{id}/push-requests`, `sessions:write`)은 그때 세션의 checkpoint pointer가 가리키는 revision과, 검증된 manifest가 적은 `git_commit`을 고정한다. 저장소는 세션의 `repository_id`, 브랜치는 `agent/<session-id>`다. 요청자는 이 중 아무것도 고를 수 없다. 브랜치 규칙은 DB CHECK(`push_requests_target_branch_check`)도 지킨다. manifest가 검증되지 않으면 더 오래된 checkpoint로 대신하지 않고 거절한다.
- **결정하는 사람:** 결정(`POST .../push-requests/{push_request_id}/decision`)에는 `sessions:approve`가 필요하다. 이 scope는 API의 scope 표가 아니라 push 서비스가 검사한다. 그래야 거절도 receipt로 남는다. 결정할 수 있는 principal은 API key와 로그인한 사용자뿐이다. 다른 종류(chat installation, 나중에 생길 에이전트 전용 key)는 목록에 넣기 전까지 거절된다. API key는 사람과 묶여 있지 않으므로 `sessions:approve` key는 사람만 갖게 발급한다. 자동화(CI 등)에는 주지 않는다.
- **에이전트가 스스로 승인하지 못하는 이유:** worker가 가진 자격(launch nonce, session token)은 `/internal/worker` route에서만 통하고 `/v1`에서는 401이다. `AUTH_MODE=none`은 누구든 `X-Owner-Id`로 owner를 자칭할 수 있으므로, 이 모드에서는 push 요청 route가 모두 403(`refusal: unverified_principal`)이고 아무것도 기록하지 않는다.
- **승인하는 commit:** 결정 body의 `git_commit`이 고정된 commit과 같아야 승인된다. 요청 뒤에 세션이 다시 checkpoint를 남겼으면(pointer revision이 다르면) 승인을 거절하고 요청은 `requested`에 남는다. 그 요청은 거부하고 새로 요청한다. 거부에는 이 검사가 없다.
- **상태:** `requested` → `approved` | `rejected`(사람), `approved` → `pushing` → `pushed` | `failed`(플랫폼, 다음 절). 세션마다 열린 요청(`requested`·`approved`·`pushing`)은 하나다.
- **보존:** checkpoint GC는 열린 요청이 고정한 revision과 그 아래 fallback window를 지우지 않는다. 세션이 계속 checkpoint를 남겨 그 revision이 pointer의 window를 벗어나도, push할 manifest와 workspace bundle은 남는다.
- **감사:** 요청·결정·거절된 시도마다 receipt가 남는다. operation은 `request_push`·`decide_push`이고 push 결과는 `push`다. `actor`는 누가 했는지, `result`는 `{push_request_id, decision, verdict, refusal, repository_id, checkpoint_revision, git_commit, target_branch}`다. 거절이면 status가 `failed`이고 `error`에 코드가 있다. 비밀 값은 담지 않는다. 인증되지 않은 시도(401)와 `AUTH_MODE=none`의 시도는 receipt 없이 요청 로그에만 남는다.

### 승인된 요청의 push

API 프로세스가 3초마다 `approved` 요청을 하나씩 잡아 push한다. replica가 여럿이면 같은 행을 둘이 잡지 않는다(`FOR UPDATE SKIP LOCKED`). 승인 뒤 보통 몇 초 안에 요청이 `pushing`을 거쳐 `pushed`나 `failed`가 된다. `requested`·`rejected`·이미 끝난 요청은 잡지 않으므로 push되지 않는다.

- **무엇을 어디로:** 요청이 고정한 commit 하나를, 요청이 고정한 저장소의 `refs/heads/agent/<session-id>`에 push한다. 다른 ref나 tag는 보내지 않는다. force push는 없다. 원격 브랜치가 이미 있고 그 commit이 push할 commit의 조상이 아니면 `non_fast_forward`로 거절한다. 같은 commit이 이미 있으면 그대로 `pushed`다.
- **거절하는 대상:** 브랜치가 `agent/<session-id>`가 아니면 `target_refused`, 카탈로그 `branch`이거나 원격의 기본 브랜치(GitHub API의 `default_branch`, 원격 `HEAD`가 가리키는 브랜치)면 `default_branch`다.
- **고정한 저장소:** 요청은 카탈로그 항목의 binding(URL·branch·auth의 종류와 참조 위치의 해시, 비밀 값은 넣지 않음)을 함께 저장한다. push 때 다시 계산해 다르면(URL을 바꿈, auth를 바꿈, 항목을 지움) `catalog_changed`로 거절하고 원격에는 아무 요청도 보내지 않는다. 그 세션은 새로 요청해 다시 승인받는다. 같은 참조 뒤의 비밀 값만 바꾸는 키·PAT 교체는 binding을 바꾸지 않는다.
- **자격 증명:** `github_app`은 `contents: write`, 그 저장소 하나로 좁힌 설치 토큰을 새로 받는다(clone용 읽기 토큰과 따로 캐시한다). github.com의 `basic`(PAT)과 forge가 없는 `basic`·`bearer`(Gitea, GHES PAT)는 카탈로그 값을 그대로 쓴다. `auth`가 없는 저장소는 `no_push_credential`로 거절한다. 값은 git 프로세스의 환경 변수(`GIT_CONFIG_COUNT`)로 `http.<저장소 URL>.extraHeader`에만 들어간다. 명령줄 인자, URL, 저장소 config, 디스크 어디에도 쓰지 않고, redirect는 따라가지 않는다.
- **checkpoint에서 꺼내기:** 고정한 revision의 manifest와 bundle 체인을 restore처럼 처음부터 다시 검증하고(digest와 git 검증기), `baseBundles` 순서로 임시 bare 저장소에 fsck를 켜고 fetch한다. 이 저장소는 template가 없어 hook이 없고, checkout이 없어 filter·attribute·submodule이 돌지 않으며, 사용자·시스템 git config를 읽지 않는다. 끝나면 임시 디렉터리를 지운다.
- **lease:** `pushing`은 15분 lease를 가진다. push의 git은 claim부터 12분(lease의 80%)이 지나면 끊기고, 그 뒤에는 새 git을 시작하지 않는다. 그래서 살아 있는 시도가 lease를 넘겨 다른 시도와 겹쳐 쓰지 않는다. git 프로세스마다 checkpoint 검증과 같은 메모리 상한(`CHECKPOINT_GIT_MEMORY_MB`)과 파일 크기·CPU 상한이 걸린다(Linux의 `prlimit`). API가 push 도중 죽으면 lease가 끝난 뒤 다른 replica(또는 재기동한 API)가 같은 요청을 다시 잡는다. 같은 commit이 이미 원격에 있으면 `pushed`로 끝난다. 세 번 잡혀도 끝나지 않으면 `lease_expired`로 `failed`가 되고, 세션은 새 요청을 만들 수 있다. 늦게 깨어난 이전 시도는 결과를 덮어쓰지 못한다.
- **결과:** `GET /v1/sessions/{id}/push-requests/{push_request_id}`의 `push_receipt_id`가 `push` receipt를 가리킨다. 그 `result`에는 위 필드에 더해 `remote_url`, `remote_ref`(`refs/heads/agent/<session-id>`), `previous_commit`(원격 ref가 전에 가리키던 commit, 새로 만들었으면 null), `approved_by`(결정한 actor)가 있다. 실패면 `refusal`과 `error.code`가 있다: `catalog_changed`(`CATALOG_MISMATCH`), `target_refused`·`default_branch`·`no_push_credential`(`FORBIDDEN`), `non_fast_forward`(`REVISION_CONFLICT`), `checkpoint_unavailable`(`CHECKPOINT_UNAVAILABLE`), `lease_expired`(`LEASE_EXPIRED`), `push_failed`(`BACKEND_UNAVAILABLE`, 토큰 발급 실패·원격 거절·네트워크). 원격이 보낸 메시지는 receipt에 넣지 않는다. API 로그의 `Push refused`·`Push failed`·`Push request finished` 줄에 `push_request_id`와 사유가 있다.
- **필요한 권한:** GitHub App은 Repository permissions **Contents: Read and write**(위 App 절). fine-grained PAT는 **Contents: Read and write**. API 컨테이너에서 저장소 host로 나가는 outbound가 열려 있어야 한다(clone은 proxy를 거치지만 push는 API가 직접 한다).
- **기본 브랜치 보호(권장):** 코드가 기본 브랜치를 거부하지만 GitHub에서도 한 번 더 막는다. 저장소 Settings → Rules → Rulesets → New branch ruleset에서 Target을 `Include default branch`로 두고 **Restrict updates**, **Restrict deletions**, **Block force pushes**를 켠다. Bypass list에는 App을 넣지 않는다. 사람의 리뷰를 거친 머지만 받으려면 **Require a pull request before merging**도 켠다. `agent/*` 브랜치에는 force push 금지(**Block force pushes**)만 거는 ruleset을 따로 두면 플랫폼이 아닌 누군가가 그 브랜치를 되돌리는 일도 막는다.
- **push된 commit의 CI(주의):** push되는 commit의 내용은 에이전트가 쓴 것이다. 사람이 그 commit을 승인하지만, 저장소가 `agent/*` push에 CI를 돌리면 에이전트가 고친 `.github/workflows/` 파일도 그대로 실행된다. 그 workflow는 저장소의 Actions secret과 `GITHUB_TOKEN` 권한으로 돈다. 그래서 승인할 때 workflow 파일 변경을 따로 보고, 위 ruleset으로 기본 브랜치를 막으며, App이나 PAT에는 `Workflows` 권한을 주지 않는다. 이 권한이 없으면 GitHub이 workflow 파일을 바꾸는 push를 거절하므로 그런 commit은 `push_failed`로 끝난다. `agent/*` push에서 CI가 필요 없으면 기존 workflow의 `on.push.branches-ignore`에 `agent/**`를 넣는다. 이 설정은 바뀌지 않은 workflow에만 효과가 있으므로 `Workflows` 권한을 빼는 것과 함께 쓴다.

### push한 브랜치의 PR과 코멘트

`pushed`가 된 요청의 `agent/<session-id>` 브랜치로 사람이 PR을 열고, 그 PR에 코멘트를 달거나 고칠 수 있다. 둘 다 API 호출로 한 번씩 하며, 플랫폼이 세션 이벤트마다 스스로 코멘트를 달지는 않는다. PR 승인·머지·리뷰어 지정·라벨은 하지 않는다.

- **열기:** `POST /v1/sessions/{id}/push-requests/{push_request_id}/pull-request`, body `{title?, body?}`. head는 요청의 `agent/<session-id>`, base는 카탈로그 항목의 `branch`다. 요청이 `pushed`가 아니면 409 `PUSH_NOT_PUSHED`, 카탈로그 항목의 binding이 요청 때와 다르면 push와 같이 409 `CATALOG_MISMATCH`다. 요청 하나에 PR은 하나다. 이미 기록된 PR이 있거나 GitHub에 그 브랜치의 열린 PR이 있으면 새로 열지 않고 그 PR을 200(`created: false`)으로 돌려준다. 같은 세션의 다음 push 요청은 같은 브랜치를 갱신하므로 열린 PR도 같고, 그 요청으로도 코멘트를 달 수 있다. PR 행은 그 PR을 연 push 요청에 묶인다. 그 요청의 호출은 PR이 닫혀도 기록된 PR을 그대로 돌려주고, 다른 push 요청의 호출은 GitHub에서 그 브랜치의 열린 PR을 다시 찾아 없으면(사람이 닫았으면) 새 PR을 연다.
- **코멘트:** `POST .../pull-request/comments`, body `{body, marker?}`(`marker` 기본값 `status`). 코멘트 끝에 `<!-- agent-platform:<session-id>:<marker> -->`를 붙이고, 플랫폼이 쓴(App 또는 PAT 주인이 작성자인) 같은 marker의 코멘트가 이미 있으면(오래된 순 처음 1000개 안에서) 새로 달지 않고 그 코멘트를 고친다. 다른 사람이 marker를 복사해 둔 코멘트는 건드리지 않는다. PR을 먼저 열지 않았으면 409 `PULL_REQUEST_MISSING`이다.
- **누가:** push 결정과 같은 규칙이다. `sessions:approve`를 가진 API key나 로그인한 사용자만 부르고, scope는 서비스가 검사해 거절도 receipt로 남는다. worker 자격은 `/v1`에서 401이고 `AUTH_MODE=none`에서는 403(`unverified_principal`)이며 기록하지 않는다.
- **본문 정리:** 제목·본문·코멘트는 GitHub에 보내기 전에 정리한다. 각 줄을 로그 마스킹과 같은 규칙(`sanitizeText`)에 넣어 비밀처럼 보이는 줄(`ghp_…`, `token:` 같은 줄)은 `[REDACTED]` 한 줄로 바꾼다. `@멘션`, 다른 저장소 참조(`owner/repo#N`), closing keyword(`Closes #N`, `fixes owner/repo#N`, `resolves <URL>` 등), HTML 주석(`<!--`)은 zero-width space를 끼워 알림·링크·자동 닫기·숨김이 일어나지 않게 한다. 제목은 한 줄 256자, 본문과 코멘트는 GitHub의 65536자 안으로 자르고 `…(truncated)`를 붙인다. PR 본문 끝에는 세션 id와 commit을 적은 줄이 붙는다.
- **자격 증명:** `github_app`은 그 저장소 하나와 `pull_requests: write`로 좁힌 설치 토큰을 따로 받는다(clone의 `contents: read`, push의 `contents: write` 토큰과 캐시 key가 다르다). PR 조회·생성과 코멘트 목록·작성·수정 모두 이 권한 하나로 된다. github.com의 PAT는 그 값을 그대로 쓴다. Gitea와 GHES PAT처럼 GitHub forge가 없는 저장소는 403 `FORBIDDEN`(`no_forge`)이다.
- **필요한 권한:** GitHub App은 Repository permissions **Pull requests: Read and write**(위 App 절, Contents와 함께). fine-grained PAT는 **Pull requests: Read and write**를 더한다. `Issues`·`Workflows` 권한은 필요 없으니 주지 않는다. API 컨테이너에서 `api_base` host로 나가는 outbound가 열려 있어야 한다.
- **rate limit:** REST 호출은 `@octokit/core`에 retry·throttling plugin을 붙여 한다. 429와 secondary rate limit 403은 GitHub가 준 `retry-after`(또는 `x-ratelimit-reset`)만큼 기다렸다 다시 보내고, 재시도는 2번까지, 기다릴 시간이 60초를 넘으면 기다리지 않는다. 5xx도 2번까지 다시 보낸다. 쓰기 호출 사이에는 plugin이 1~3초 간격을 둔다. 끝내 실패하면 503 `BACKEND_UNAVAILABLE`(`forge_failed`)이고 API 로그에 `GitHub rate limit`(`limit`, `request`, `retry_after_seconds`, `retrying`)과 `GitHub request failed`(`request`, `status`)가 남는다. 토큰과 응답 본문은 로그에 쓰지 않는다.
- **감사:** 열기·코멘트·거절된 시도마다 receipt가 남는다. operation은 `open_pull_request`·`comment_pull_request`, target은 `{session_id, request_id: <push_request_id>}`, `result`는 `{push_request_id, verdict, refusal, repository_id, number, url, head, base, created}`이고 코멘트는 `{comment_id, comment_url, marker}`를 더한다. 응답의 `receipt_id`, 거절이면 `error.details.receipt_id`로 `GET /v1/receipts/{id}`에서 읽는다. PR 번호·URL은 `pull_requests` 테이블에 push 요청과 함께 남는다.

### 자율 모드: `bypassPermissions`·`auto`

profile의 `permission_mode`는 `default`·`acceptEdits`·`dontAsk`·`plan`·`bypassPermissions`·`auto` 중 하나다. 뒤의 둘이 자율 모드로, 도구 호출을 사람의 승인 없이 실행한다.

- `bypassPermissions`: 파일 쓰기·Bash·`git commit`을 포함해 모든 도구 호출을 그대로 실행한다. 권한 pending-request를 만들지 않는다.
- `auto`: 엔진이 원래 물었을 도구 호출(예: Bash)마다 모델 분류기가 허용·거부를 정한다. 분류기 호출도 같은 provider route로 나가므로 세션 비용에 잡힌다(2026-10-13 실측: Bash 호출 하나에 분류기 요청 하나, 첫 요청 약 0.11달러, 이후 약 0.009달러). 분류기를 쓸 수 없으면 엔진은 그 호출을 거부한다(fail closed).

- **지정하는 곳은 카탈로그뿐이다.** 세션 생성 요청은 profile id만 고르고 모드를 바꿀 수 없다. 모드는 fingerprint에 들어가므로, 같은 id의 모드를 바꾸면 그 id로 만든 세션은 새 모드로 돌지 않고 `CATALOG_MISMATCH`가 된다. 자율 모드는 새 profile id로 등록하고 `repositories.<id>.profiles`에 더한다. 저장소의 예시 카탈로그(`config/`, `config/fake-model/`)에는 자율 모드 profile이 없다.
- **설치가 허용해야 뜬다.** 카탈로그에 이 모드의 profile이 있으면 API 환경 변수 `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS=true`가 없는 한 기동하지 않고, 오류 메시지에 profile id와 이 변수 이름을 적는다. 값은 정확히 `true`만 받는다. 허용된 채로 뜨면 기동 로그에 `Profiles run tools without asking for approval`(대상 profile id 목록) 경고가 남는다. 카탈로그는 설치 사이를 옮겨 다니므로, 이 설치의 격리를 보증하는 일은 카탈로그가 아니라 설치 설정이 맡는다. compose 설치(`infra/compose.local.yml`)는 셸이나 저장소 `.env`의 같은 이름 변수를 API에 넘기고, 없으면 `false`다.
- **남는 경계.** 사람 승인이 빠지면 남는 것은 세션마다 하나인 worker 컨테이너(root 아님), egress proxy 허용 목록(Messages API·저장소 route·object store route만), profile `tools` 목록, 세션 비용 상한(`SESSION_COST_LIMIT_USD`, turn의 `maxBudgetUsd`)이다. `tools` 목록은 이 모드에서도 PreToolUse hook이 강제하고, 비용 상한과 checkpoint 중 도구 차단도 그대로다. 이 넷 중 하나라도 없는 설치(예: worker를 host 네트워크로 띄우는 경우)에서는 켜지 않는다. 저장소 자격 증명은 worker에 가지 않으므로([위 절](#provider-키와-저장소-자격-증명은-worker에-가지-않는다)) 자율 세션도 push할 수 없고, 바뀐 내용은 checkpoint로만 나간다.
- **감사.** 세션 목록·상세의 `runtime.permission_mode`가 그 세션이 도는 모드다. worker의 claim 로그에도 `permission_mode`가 남는다. 모드는 세션에 고정되므로 receipt에는 따로 싣지 않는다.
- 실제 모델로 확인하는 방법은 [real-claude.md](../real-claude.md#자율-모드-세션)에 있다.

### 저장소의 예시 카탈로그

저장소의 `config/`는 로컬 예시다: `https://api.anthropic.com`을 endpoint로, API 프로세스의 `ANTHROPIC_API_KEY`를 `value_env`로, compose Gitea의 `sample-app`을 저장소로 쓴다. `config/fake-model/`은 외부 계정 없이 도는 예시다: compose `fake-messages`(fake Messages API)를 endpoint로, compose `secrets`(API 전용 LocalStack Secrets Manager, worker egress allowlist에 없음, `infra/compose.fake-model.yml`을 얹을 때만 뜬다)에 심어 둔 placeholder 키를 `secret_id`로 쓴다. Gitea의 `agent/sample-app`은 compose `gitea-init`(`infra/gitea/init-sample-repo.sh`)이 `apps` profile 기동 때 만든다(public, 이미 있으면 건너뜀).

```bash
docker compose -f infra/docker-compose.yml up -d secrets
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:4567 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
AUTH_MODE=none PORT=3000 CHECKPOINT_OBJECT_STORE=disabled \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/control-host start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

## checkpoint object store

API는 checkpoint object store 설정을 기동 시 요구한다 — `S3_BUCKET`·`AWS_REGION`(+ 선택 `AWS_ENDPOINT_URL`)이 없으면 기동하지 않는다. `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`는 둘 다 주거나 둘 다 뺀다. 하나만 있으면 기동하지 않는다. 둘 다 빼면 AWS SDK 기본 credential chain이 서명한다. EKS에서는 api ServiceAccount의 IRSA role이 그 자리에 오고, chart는 `secrets.objectStoreKeys: false`로 이 경로를 쓴다. chain이 아무 credential도 찾지 못하면 요청은 서명 없이 나가지 않고 실패한다. 이 credential은 워커의 object store route 요청을 서명하는 데도 쓰인다. object store 없이 띄우려면 `CHECKPOINT_OBJECT_STORE=disabled`를 명시한다: 모든 checkpoint가 거절되고 워커 checkpoint 프로토콜은 409 `CHECKPOINT_UNAVAILABLE`로 답하며 기동 로그에 경고가 남는다. 빠진 bucket이 checkpoint 없는 finalize 뒤에 숨지 않도록 침묵 기본값을 두지 않았다. compose `apps` profile은 localstack 값을 기본으로 넣는다.

checkpoint 객체는 기본적으로 **version으로 고정되고 legal hold로 잠긴다**(`CHECKPOINT_OBJECT_PROTECTION=locked`). manifest의 모든 ref와 finalize의 `manifest_version`은 워커의 `putImmutable`이 돌려준 S3 VersionId를 싣는다. finalize는 그 version을 읽어 검증한 뒤 manifest·transcript part·bundle·untracked 파일의 각 version에 legal hold를 걸고 나서야 pointer를 올린다. 다음 checkpoint는 직전 committed manifest와 `path`·`sha256`·실행 비트가 모두 같은 untracked 파일이면 그 manifest가 이미 검증하고 hold한 version ref를 그대로 싣고 PUT하지 않는다. finalize는 직전 pointer가 증명한 정확한 artifact tuple만 다른 publish 디렉터리에서 가져오는 것을 허용하며, restore plan과 GC도 새 manifest가 가리키는 그 version을 그대로 따라간다. pointer(`checkpoints.manifest_version`)와 restore plan도 같은 version을 들고 간다. 그래서 커밋 뒤 같은 key를 덮어쓰거나 지우거나 delete marker 뒤에 다시 올려도 복원 대상은 바뀌지 않고, hold가 걸린 version은 hold를 푸는 권한 없이는 지울 수 없다. hold 해제는 아래 checkpoint GC의 몫이다. hold를 걸 수 있는 권한은 풀 수도 있으므로 워커에게 주면 안 된다. 워커는 object store 자격 증명을 받지 않고, proxy의 object store route는 legal hold·retention 요청을 403으로 거절한다([위 절](#provider-키와-저장소-자격-증명은-worker에-가지-않는다)). API는 기동 시 bucket의 versioning이 `Enabled`이고 Object Lock 설정이 있는지 확인하고, 아니면 기동하지 않는다. **versioning이 꺼진 bucket에서는 `CHECKPOINT_OBJECT_PROTECTION=unversioned`를 명시해야 한다. 이 저하된 모드는 key로만 읽고(manifest의 version은 무시하고 restore plan에서도 뺀다) hold를 걸지 않으므로, 커밋 뒤의 삭제·덮어쓰기를 막지 못하고 복원 때 digest 불일치로 발견할 뿐이다. 이 모드에서는 이전 untracked ref도 재사용하지 않고 다시 PUT한다.** 기동 로그에 경고가 남는다. `unversioned`에서 `locked`로 바꾸면, `unversioned`로 커밋된 checkpoint는 첫 restore 때 version 단위로 다시 해시하고 hold를 건 뒤에 내준다. pointer에 version이 없는 checkpoint는 `CHECKPOINT_UNAVAILABLE`이 된다. compose의 localstack init은 `claude-sessions`를 Object Lock으로 만들고, 예전 volume에 남은 bucket에는 versioning과 Object Lock 설정을 켠다(그 전에 올라간 객체는 version이 없어 locked API가 거부한다).

capture 성공 로그 `worker.checkpoint.published`는 `untracked`·`untracked_bytes`·`untracked_changed`·`untracked_unchanged`·`untracked_uploads`와 `manifest_bytes`를 남긴다. 성공·거절·실패마다 별도로 `worker.checkpoint.result` 하나가 `operation=checkpoint_capture`, `outcome`, `reason_code`, 전체 `duration_ms`, 단계별 `durations_ms`, 실제 PUT 호출 `put_count`, 새로 저장된 `uploaded_bytes`, `manifest_bytes`, 이전 ref나 duplicate를 쓴 `reused_count`, 다른 bytes와 맞선 `conflict_count`를 남긴다. 이 결과 event에는 manifest/object key나 body를 넣지 않는다. manifest delta나 packing은 없다. 현재 manifest는 복원에 필요한 전체 ref를 계속 싣기 때문에 untracked PUT과 저장량은 줄지만 manifest 크기는 줄지 않으며, `manifest_bytes` 계측으로 별도 변경의 효과와 필요성을 판단한다.

**checkpoint 객체의 저장 시 암호화**는 bucket 기본 암호화 SSE-S3(`AES256`)에 맡긴다. 워커의 checkpoint 쓰기는 암호화 헤더를 싣지 않으므로 bucket 기본값이 곧 모든 객체의 암호화다. API는 object store가 켜져 있으면 보호 모드와 무관하게 기동 시 `GetBucketEncryption`을 읽고, 기본 규칙이 `AES256`이 아니면(설정 없음, `aws:kms` 포함) 기동하지 않는다. SSE-KMS를 받지 않는 이유는 워커 credential마다 KMS 키 권한이 붙어야 하기 때문이다. 다른 설정으로 띄워야 하면 `CHECKPOINT_OBJECT_ENCRYPTION_CHECK=warn`을 명시한다. 그러면 기동 로그에 경고만 남는다. API credential에는 `s3:GetEncryptionConfiguration`이 필요하다. compose의 localstack init은 `claude-sessions`에 `AES256` 기본 암호화를 건다. `scripts/restore.sh`는 자기 LocalStack에 bucket을 만들 때 같은 설정을 걸고, 그 밖의 대상 bucket은 `AES256`이 아니면 거부한다.

**비워진 bucket**. object store가 켜져 있으면 API는 기동 때 DB에 `collected_at IS NULL`인 checkpoint 행이 있는지 본다. 있으면 `ListObjectVersions`로 bucket에 object version이 하나라도 남았는지 확인하고, 하나도 없으면(delete marker만 남은 경우 포함) 원인과 복구 명령(`scripts/local.sh reset`)을 적은 오류로 기동하지 않는다. 로컬 LocalStack은 S3를 메모리에만 두므로, raw `docker compose down`이나 Docker 재시작 뒤 postgres의 행만 남는 경우를 잡는 빠른 검사다. version별 무결성은 여전히 백업과 `scripts/verify-restore.sh`가 본다. API credential에는 `s3:ListBucketVersions`가 필요하다.

**checkpoint GC**는 `bun run apps/control-host/src/api/checkpoint-gc.ts`로 도는 one-shot이다. reconciler처럼 한 pass만 돌고 끝나며, api 이미지와 API의 object store 환경 변수에 `DATABASE_URL`을 더해 실행한다. `CHECKPOINT_GC_DRY_RUN=true`를 주면 지울 개수만 세고 아무것도 지우지 않는다.

compose 설치에는 GC를 주기적으로 도는 서비스가 없다. 운영자가 **주 1회**, 사용이 적은 시간에 돌린다. Kubernetes 설치에서는 chart의 CronJob(`checkpointGc.schedule`, 기본 `0 4 * * 0`, `concurrencyPolicy: Forbid`)이 api ServiceAccount로 돌고, `checkpointGc.dryRun: true`면 개수만 센다. 바로 한 번 돌리려면 `kubectl -n agent-platform create job --from=cronjob/agent-platform-checkpoint-gc checkpoint-gc-manual`을 쓴다. compose 설치에서는 떠 있는 api 컨테이너 안에서 실행한다. 이 컨테이너에는 필요한 환경 변수가 이미 들어 있다.

```bash
docker compose exec -T -e CHECKPOINT_GC_DRY_RUN=true api bun run apps/control-host/src/api/checkpoint-gc.ts   # 지울 개수만 본다
docker compose exec -T api bun run apps/control-host/src/api/checkpoint-gc.ts                                 # exit 0이면 끝
```

cron에 걸려면 `0 4 * * 0 cd <checkout> && docker compose exec -T api bun run apps/control-host/src/api/checkpoint-gc.ts`처럼 저장소 루트에서 부른다. 세션 하나라도 실패하면 exit 1이고, 로그에 `Checkpoint GC failed for a session`이 남는다. 백업과 겹치면 안 된다(아래). 백업은 api가 멈춰 있어야 시작하므로, api 컨테이너에서 도는 GC는 백업 중에 시작될 수 없다. 다만 GC가 도는 도중에 api를 멈추고 백업을 시작하면 겹칠 수 있다. 백업은 GC가 끝난 뒤에 받는다. test-ops 설치의 명령은 [test-ops.md](test-ops.md)의 점검표에 있다.

**한계: checkpoint 바이트는 저장량에 세지 않는다.** `STORAGE_LIMIT_BYTES`는 보관한 입력 메시지 바이트만 센다([설치 상한](configuration.md#설치-상한)). checkpoint가 S3에 쓰는 바이트와 legal hold가 걸린 version은 계측하지도 제한하지도 않는다. `locked`에서는 모든 version에 hold가 걸려 있어, GC가 hold를 풀고 지우기 전까지는 bucket lifecycle 규칙으로도 줄지 않는다. 저장량은 주 1회 GC와 bucket 크기 관찰로 관리한다.

회수 범위는 세션마다 두 곳이다. `sessions/<id>/checkpoints/<rev>/<attempt>/` 아래의 version(manifest·bundle·untracked 파일), 그리고 `sessions/<id>/transcripts/generation-<n>/` 아래의 transcript part version이다. 그 밖의 key는 건드리지 않는다. version 하나를 지우는 조건은 아래 두 가지가 모두 맞을 때다.

- 어떤 restore도 그 version을 읽지 않는다. pointer, pointer 아래 parent 체인의 `maxRestoreFallbacks`(3)개 revision, 세션이 마지막으로 폴백 복원한 base 가운데 어느 manifest도 그 version을 가리키지 않는다.
- 더 이상 finalize가 그 version을 커밋할 수 없다. checkpoint 디렉터리는 revision이 pointer 이하이거나, attempt가 fence를 잃었을 때다(`exited`/`lost` 상태이거나 epoch·generation·auth revision이 세션과 다르다). transcript part는 key의 generation이 세션의 `execution_generation`보다 작을 때다. 그 generation의 attempt는 모두 fence를 잃었다.

그래서 죽은 generation이 마지막 checkpoint 뒤에 쓴 tail, 폴백으로 버려진 history에만 있던 part, window 밖으로 밀려난 revision에만 있던 part가 회수된다. 살아 있는 generation의 part와, 보존 revision이 상속한 이전 generation의 part는 남는다. 병합으로 대체된 합본도 그 generation이 끝난 뒤 같은 규칙으로 회수된다.

finalize는 두 가지를 거부한다. 첫째, manifest가 자기 publish 디렉터리 밖의 checkpoint 디렉터리 객체를 가리키는 경우다. 둘째(`locked`만), 자기 attempt의 generation이 아닌 transcript part 중 후보가 딛고 선 checkpoint가 가리키지 않는 것을 가리키는 경우다. 딛고 선 checkpoint는 pointer(후보는 그다음 revision으로만 커밋된다)이거나, 폴백 복원한 attempt라면 pointer의 parent다. 둘 다 GC가 보존한다. 그래서 hold → GC → pointer CAS 순서로 경쟁해도, 커밋될 checkpoint의 version은 GC가 회수할 수 없는 곳에 있다. 지울 때는 legal hold를 먼저 풀고 그 version을 지운다. 지운 revision의 `checkpoints` 행에는 먼저 `collected_at`을 적는다. backup은 이 행을 건너뛰므로, GC를 backup과 동시에 돌리지 않는다.

**`versions_held=false`인 pointer**(`unversioned`로 커밋된 checkpoint)는 그 manifest가 가리키는 **key의 모든 version**을 보존한다. 이런 checkpoint는 restore가 key로 다시 해시하고 hold를 걸기 때문이다. 보존 대상 manifest를 읽지 못하거나 digest가 맞지 않는 세션은 통째로 건너뛴다.

**`unversioned`와 `CHECKPOINT_OBJECT_STORE=disabled` 배포**에서는 hold도 version 고정도 없으므로 GC가 아무것도 하지 않고, 로그만 남긴 뒤 0으로 끝난다.

## API 인증과 권한

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest와 scope만 저장한다. `--scopes`는 필수이며 `sessions:read`·`sessions:write`·`sessions:approve`·`sessions:control`·`sessions:recover` 중에서 고른다. `/v1` 요청은 `apps/control-host/src/api/openapi.ts`의 route 선언에서 파생된 `API_ROUTE_SCOPES`가 요구하는 scope를 검사하고, 없으면 body나 세션을 읽기 전에 `403 FORBIDDEN`이다. `sessions:recover`(recovery-decisions)는 별도 scope라 `sessions:write`나 `sessions:control`에 포함되지 않는다. cookie 사용자는 role로 scope를 받는다(owner 전부, member는 recover 제외). scope 도입 전에 발급된 키(scope NULL)는 아무 scope도 없으므로 다시 발급한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/control-host keys create local-owner --scopes sessions:read,sessions:write
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
  bun run --cwd apps/control-host start
curl -H 'Authorization: Bearer <issued-key>' http://127.0.0.1:3000/v1
```

웹 콘솔은 같은 `/v1`을 cookie 세션으로 호출한다. 처음 한 번 `POST /v1/auth/bootstrap`이 첫 owner와 기본 workspace를 만드는데, `BOOTSTRAP_TOKEN`이 일치하고 live owner가 없을 때만 통과한다. 토큰을 먼저 보므로 틀린 토큰은 owner 유무와 관계없이 `401`이고, 맞는 토큰인데 live owner가 있으면 `409 BOOTSTRAP_DONE`이다. `BOOTSTRAP_TOKEN`을 주지 않으면 API가 기동 시 하나를 생성해 stderr에 `BOOTSTRAP_TOKEN=…` 한 줄로 출력한다(live owner가 없을 때만, 구조화 로그는 토큰 필드를 가리므로 거기엔 없다). 로그인은 `POST /v1/auth/login`(email·password, argon2id)이며 `__Host-ap_session` cookie(`HttpOnly; Secure; SameSite=Lax; Path=/`, Domain 없음, 14일 sliding)를 세운다. `__Host-` 접두사라 형제 서브도메인이 같은 이름의 cookie를 심어 가리지 못한다. 미들웨어는 `Authorization` 헤더가 있으면 그것만 평가하고(잘못되거나 비었거나 Bearer가 아닌 헤더를 cookie로 대체하지 않음) 헤더가 없을 때만 cookie를 본다. cookie principal의 상태 변경 요청은 `X-Requested-With: agent-platform-web` 헤더가 없으면 `403`이다(bearer 경로에는 적용되지 않음). login은 cookie를 세우므로 호출자와 무관하게 같은 헤더가 필요하다(없거나 cross-site면 `403`, login CSRF로 피해자를 공격자 계정에 로그인시키는 것을 막는다). 사용자당 live 세션은 10개까지이고, login이 그 사용자의 만료·폐기된 row를 지우고 가장 오래된 세션부터 밀어낸다. 로그인 실패는 email당 5회/15분 뒤 `429`. 주소를 바꿔 가며 시도해도 비밀번호 검증(argon2id)은 프로세스당 동시 4개·대기 64개까지만 받고 넘치면 조회 전에 `429`(`Retry-After: 1`)로 끊는다. IP 단위·replica 공통 제한은 ingress가 맡는다. `GET /v1/auth/me`가 선택된 principal·user·workspace와, 그 역할이 지금 워크스페이스에서 가진 관리 action 목록(`permissions`, 역할 표 그대로. 웹은 이것으로 화면 전체를 못 쓰는 메뉴를 숨긴다. API key는 빈 목록)을 돌려준다. `AUTH_MODE=none`에서는 cookie 경로가 꺼지고 `X-Owner-Id`만 본다. 기동 로그(stderr)를 설치자가 아닌 사람도 읽는 배포에서는 `BOOTSTRAP_TOKEN`을 직접 넣어 자동 생성 경로를 쓰지 않는다 — 자동 생성 토큰은 첫 owner가 생길 때까지 그 로그를 읽는 누구에게나 bootstrap 권한을 준다. 설정한 값은 32~256자여야 하며 벗어나면 API가 기동하지 않는다. 빈 값(`BOOTSTRAP_TOKEN=`)도 설정 실패로 보고 기동하지 않는다.

```bash
curl -s -X POST http://127.0.0.1:3000/v1/auth/bootstrap -H 'Content-Type: application/json' \
  -d '{"bootstrap_token":"<token>","email":"owner@example.com","password":"<12+ chars>","display_name":"Owner","workspace_name":"Acme","workspace_slug":"acme"}'
curl -s -c jar -X POST http://127.0.0.1:3000/v1/auth/login -H 'Content-Type: application/json' \
  -H 'X-Requested-With: agent-platform-web' \
  -d '{"email":"owner@example.com","password":"<12+ chars>"}'
curl -s -b jar http://127.0.0.1:3000/v1/auth/me
curl -s -b jar -X POST http://127.0.0.1:3000/v1/auth/logout -H 'X-Requested-With: agent-platform-web' -i
```

### 계정 복구

이메일 발송은 없다. 비밀번호를 잃은 사용자는 owner에게 재설정 토큰을 받는다. owner가 cookie 세션으로 `POST /v1/workspaces/{id}/members/{userId}/password-reset`에 `{current_password}`를 보내면 1회용 토큰(`apr_…`, 만료 1시간)이 응답에 한 번만 온다(`Cache-Control: no-store`). 현재 비밀번호를 다시 받는 것은 owner cookie를 탈취한 사람이 그것만으로 다른 계정을 가져가지 못하게 하기 위해서다. 틀린 비밀번호는 `403`이고 login과 같은 email당 실패 창(5회/15분 뒤 `429`)에 쌓인다. owner는 자기 자신에게 발급할 수 없고(`403`), 다른 workspace의 owner를 겸하는 사용자에게도 발급하지 않는다(`403`). 발급마다 `issue_password_reset` receipt가 남고, `result.target_role`로 대상이 owner였는지 구분된다. DB(`password_resets`)에는 sha256만 남고, 같은 사용자에게 다시 발급하면 앞의 토큰은 폐기된다. 계정이나 membership이 비활성인 사용자에게는 발급하지 않는다(`404`). 발급 뒤 비활성이 되면 그 토큰도 쓸 수 없다. owner는 토큰을 직접 전달하고, 사용자는 `POST /v1/auth/password-reset`에 `{token, password}`로 새 비밀번호를 정한다. 토큰을 URL에 두지 않는 것은 access log나 프록시가 경로를 남기기 때문이다. 성공하면 같은 transaction에서 비밀번호가 바뀌고, 그 사용자의 live web session이 모두 폐기되며, `reset_password` receipt(`target_ref`는 `{user_id, workspace_id}`)가 남는다. 쓴 토큰, 만료된 토큰, 폐기된 토큰은 `401`이다.

유일한 owner를 잃었을 때(계정 `disabled_at` 또는 owner membership `disabled_at`, 둘 중 하나라도 있으면 live owner가 아니다)는 새 `BOOTSTRAP_TOKEN`으로 API를 재시작하고 같은 `POST /v1/auth/bootstrap`을 부른다. 이미 사용자가 있는 설치에서는 새 workspace를 만들지 않는다(`workspace_name`·`workspace_slug`는 무시). 대신 기존 workspace에 그 email의 owner를 추가하거나 복원한다. 기존 계정이면 비밀번호를 바꾸고 계정·membership 비활성을 풀고 role을 owner로 둔다. workspace의 live web session은 모두 폐기되고 `recover_owner` receipt(`target_ref`는 workspace resource)가 남는다. 한 번 쓴 `BOOTSTRAP_TOKEN`은 sha256으로 `bootstrap_token_uses`에 기록되어, 재시작해도 다시 통과하지 않는다(`401`). 설치 때 쓴 값이 env에 남아 있어도 복구 경로를 다시 열지 못한다. API는 기동할 때 live owner가 있으면 설정된 `BOOTSTRAP_TOKEN`도 쓴 것으로 기록한다. owner가 살아 있는 동안 설정된 값은 복구용 새 토큰이 아니기 때문이다. 이 기록이 생기기 전에 설치한 배포도 업그레이드 뒤 첫 기동에서 설치 토큰이 막힌다. 기동 때 DB에 닿지 못하면 경고 로그를 남기고 30초마다 다시 확인한다. live owner가 있는 동안 맞는 토큰으로 bootstrap을 부르면 그 토큰도 쓴 것으로 기록된다. 쓴 토큰은 틀린 토큰과 같은 `401`을 받고, 사유는 API 로그에만 남는다.

두 공개 route(`bootstrap`·`password-reset`)에는 실패 창이 없다. 토큰은 256bit(`BOOTSTRAP_TOKEN`은 32자 이상)라 실패 횟수 제한이 추측을 막는 효과는 거의 없다. 토큰은 주소처럼 사람에 묶이지 않으므로 창을 두면 설치 전체에 하나가 되고, 누구나 틀린 요청으로 그 창을 채워 정상 복구를 `429`로 막을 수 있다. 비밀번호 hash는 login과 같은 동시 4개·대기 64개 gate를 쓰고, 넘치면 `429`(`Retry-After: 1`)다. IP 단위·replica 공통 제한은 login처럼 ingress가 맡는다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/members/$USER_ID/password-reset" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: agent-platform-web' \
  -d '{"current_password":"<owner password>"}'
curl -s -X POST http://127.0.0.1:3000/v1/auth/password-reset -H 'Content-Type: application/json' \
  -d '{"token":"<apr_…>","password":"<12+ chars>"}'
```

### Google 로그인

로그인 수단은 `login_methods` 테이블에 사용자별로 둔다. 비밀번호는 `kind=password` 행 하나이고(bootstrap과 migration 0138이 만든다), Google 계정은 `kind=google` 행의 (issuer, subject)로 찾는다. 이메일로는 찾지 않는다. Google로만 들어온 사용자는 `users.password_hash`가 NULL이고, 비밀번호 로그인은 틀린 비밀번호와 같은 `401`, owner의 재설정 링크 발급은 `404`다.

설정은 env 하나로 전역에 둔다. 셋 다 비어 있으면 Google 로그인은 꺼지고 두 route가 `404`다. 일부만 있거나 값이 틀리면 API가 기동하지 않고 `/readyz`도 `503`이다.

| env | 뜻 |
|---|---|
| `GOOGLE_OIDC_CLIENT_ID`·`GOOGLE_OIDC_CLIENT_SECRET` | Google Cloud의 OAuth client(웹 애플리케이션) |
| `GOOGLE_OIDC_REDIRECT_URI` | Google에 등록한 승인된 리디렉션 URI. 웹의 콜백 화면 주소다 |
| `GOOGLE_OIDC_ISSUER` | 기본 `https://accounts.google.com`. 시험용 IdP를 가리킬 때만 바꾼다 |
| `GOOGLE_OIDC_ALLOWED_DOMAINS` | 쉼표 목록. 있으면 id_token의 `hd`와 이메일 도메인이 목록에 있는 Google Workspace 계정만 받는다(`403`). 개인 Gmail은 `hd`가 없어 막힌다 |
| `GOOGLE_OIDC_JIT` | `off`(기본) 또는 `member`. `member`는 허용 도메인 계정을 초대 없이 member로 만든다. 허용 도메인 없이 켜면 기동하지 않는다 |

로그인 화면은 공개 `GET /v1/auth/login-methods`(`{"methods":["password","google"]}`, Google을 설정하지 않으면 `password`만)로 고를 수 있는 수단을 받는다. 흐름: 웹이 `POST /v1/auth/google/start`(`X-Requested-With` 필요)로 `authorization_url`을 받아 연다. 응답은 state·nonce·PKCE verifier를 담은 `__Host-ap_google_login` cookie(10분)를 세운다. Google이 리디렉션 URI로 `code`·`state`를 돌려주면 웹이 그대로 `POST /v1/auth/google/callback`에 보낸다. API가 code를 교환하고 id_token의 서명(JWKS)·iss·aud·exp·nonce·`email_verified`를 확인한 뒤 첫 진입 규칙을 위에서부터 적용한다.

1. 이미 연결된 (issuer, subject) → 그 사용자로 로그인. 계정이나 멤버십이 비활성이면 거절.
2. 그 이메일의 계정이 이미 있으면 → `409 LOGIN_LINK_REQUIRED`("기존 계정으로 로그인한 뒤 설정에서 Google을 연결"). 초대나 JIT가 있어도 이메일로 합치지 않는다. 이 응답은 Google이 지금 그 이메일의 주인임을 보증하는 계정(이메일 도메인이 `hd`와 같거나 `gmail.com`)만 받고, 그 밖의 계정과 비활성 계정은 5번과 같은 `401`을 받아 계정이 있는지 알 수 없다.
3. 그 이메일 앞으로 살아 있는 초대 → 비밀번호 없는 계정을 만들고 초대를 수락한다(초대의 workspace·role). 단, Google이 지금도 그 주소의 주인을 보증하는 계정만이다: 이메일 도메인이 계정의 Workspace 도메인(`hd`)과 같거나 `gmail.com`인 경우. 그 밖의 주소는 가입할 때 한 번 확인된 것이라 주소 주인이 바뀌었을 수 있어, 초대를 받지 못하고 5번으로 간다. 만료는 초대 행을 잠근 뒤 DB 시각으로 다시 본다.
4. JIT가 켜져 있으면 → 설치의 workspace에 member로 만든다.
5. 그 밖에는 `401 UNAUTHORIZED` "Google sign-in was not accepted". 토큰 검증 실패와 같은 응답이라 계정이 있는지 드러나지 않는다.

성공하면 비밀번호 login과 같은 `__Host-ap_session` cookie와 login 응답을 준다. 설계의 규칙 순서(초대·JIT가 같은 이메일 안내보다 앞)와 달리 2번을 먼저 보는 것은, 같은 이메일의 계정이 있으면 새 계정을 만들 수 없어 초대·JIT가 결국 이메일로 합치는 것이 되기 때문이다. 로그인한 사용자가 설정에서 Google을 연결하는 API와 콜백 화면은 아직 없다(웹 로그인 화면 작업에서 만든다).

실제 Google 연결 확인 절차(사람이 한다):

1. Google Cloud Console → API 및 서비스 → OAuth 동의 화면을 만들고(내부 또는 외부, 범위 `openid`·`email`·`profile`), 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)를 만든다. 승인된 리디렉션 URI에 `GOOGLE_OIDC_REDIRECT_URI`로 쓸 주소(예: `https://<host>/auth/google/callback`)를 넣는다.
2. client id·secret을 위 env로 API에 준다(compose는 `infra/compose.core.yml`이 같은 이름으로 넘긴다). 값은 로그나 티켓에 붙이지 않는다.
3. 기동 뒤 `curl -s <api>/readyz`가 `200`인지 본다.
4. 콜백 화면이 생기기 전에는 아래로 확인한다. 받은 `authorization_url`을 브라우저로 열고 Google 계정으로 동의하면, 브라우저가 리디렉션 URI로 이동한다(화면이 없어도 주소창에 `code`·`state`가 남는다). 그 둘을 10분 안에 같은 cookie jar로 보낸다. 주소창의 `code`는 percent-encoding되어 있으므로(`4%2F0A…`) URL decode한 값(`4/0A…`)을 보낸다. 그대로 보내면 Google이 code를 거절해 `401`이 된다.

```bash
curl -s -c jar -b jar -X POST https://<host>/v1/auth/google/start -H 'X-Requested-With: agent-platform-web'
# 브라우저로 authorization_url을 열고 동의한 뒤, 이동한 주소의 code(URL decode)·state를 옮긴다
curl -s -c jar -b jar -X POST https://<host>/v1/auth/google/callback -H 'X-Requested-With: agent-platform-web' \
  -H 'Content-Type: application/json' -d '{"code":"<code>","state":"<state>"}'
curl -s -b jar https://<host>/v1/auth/me
```

   기대값: 허용 도메인 목록이 있고 그 밖의 계정이면 규칙보다 먼저 `403`. 그 밖에는 Google이 주소를 보증하는 계정(이메일 도메인이 `hd`와 같거나 `gmail.com`)일 때 초대한 이메일이면 `200`과 그 초대의 role, owner 이메일이면 `409 LOGIN_LINK_REQUIRED`이고, 보증되지 않는 주소는 둘 다 `401`이다. `__Host-` cookie는 `Secure`라 curl은 HTTPS나 `localhost`·`127.0.0.1`에서만 jar에 남긴다. 다른 호스트의 `http://` 주소로는 흐름이 이어지지 않는다.

시험용 IdP: `bun packages/testkit/src/mock-oidc-main.ts`(`MOCK_OIDC_PORT`·`MOCK_OIDC_CLIENT_ID`·`MOCK_OIDC_CLIENT_SECRET`·`MOCK_OIDC_ISSUER`·`MOCK_OIDC_PUBLIC_URL`)가 Google 대신 discovery·JWKS·authorize·token을 낸다. authorize는 바로 동의하고, 로그인할 계정은 authorization URL에 붙인 `login_hint`(id_token claim JSON의 base64url)로 고른다. 통합 테스트(`google-login.integration.test.ts`)가 같은 IdP로 다섯 규칙을 고정한다. 테스트 이름의 규칙 번호(2 초대, 3 JIT, 4 같은 이메일)는 위 목록의 순서와 다르다. 위 목록이 실제 적용 순서다.

### workspace key, 개인 key, 오프보딩

`keys create <owner_id>`로 만든 기존 key는 모두 service key다. 응답과 partition은 이전과 같다. `keys create --workspace <workspace_id> --scopes …`로 만든 key는 그 workspace를 partition으로 쓰므로 웹에서 만든 세션을 API에서도 같은 목록으로 본다. `--personal <user_id>`를 더하면 그 멤버의 개인 key가 된다. 이 key는 key scope와 만든 사람의 지금 역할이 허용하는 scope의 교집합만 갖는다(`/v1/auth/me`의 `scopes`도 그 교집합을 보여 준다). 만든 사람의 계정이나 그 workspace의 membership이 비활성이 되면 다음 요청부터 `401`을 받는다. service key는 사람과 무관하게 계속 동작한다. 이 판정은 요청마다 DB를 다시 읽어서 한다. API key는 scope와 관계없이 관리 action(인수 목록·세션 인수·key 발급 등)을 할 수 없다(`403`). 관리 action은 사람의 cookie 세션으로만 한다. 누가 무엇을 하는지는 아래 역할 표를 따른다.

누가 했는지는 새로 쓰는 행에 남는다. cookie로 만든 세션은 `sessions.workspace_id`·`created_by_user_id`를, key로 만든 세션은 `created_by_api_key_id`를 기록한다(개인 key는 만든 사람도 함께 기록한다). turn은 `actor_id`를, receipt는 `actor`를 남긴다. service key는 key만 기록하고 사람은 기록하지 않는다. 0136 migration은 사람을 추측하지 않는다. `owner_id`가 workspace id인 세션만 `workspace_id`를 채우고(채운 수는 migration NOTICE로 나온다), 나머지 actor 컬럼은 기존 행에서 비워 둔다.

멤버를 내보내는 것은 owner의 cookie 세션으로 `POST /v1/members/{user_id}/disable`이다(`member.manage` 판정, API key는 `403`). 본문은 `{}` 또는 `{"reason": "…"}`(UTF-8 1KiB까지, 넘으면 `413`)이다. 자기 자신과 마지막 live owner는 비활성으로 만들 수 없다(`409 LAST_OWNER`). 한 transaction 안에서 membership을 비활성화하고, 그 사용자의 web session 전부와 그 workspace에서 만든 개인 key를 폐기하고, 그 workspace에 연결된 Slack 계정을 `revoked`로 바꾼다(열린 SSE는 keepalive 주기 안에 끊긴다). service key는 건드리지 않는다. 그 사람이 요청한 닫히지 않은 세션에는 인수 대기 표시를 한다. 인수 대기 세션은 돌고 있던 turn까지만 마치고 다음 turn을 배정받지 않는다. 새 launch·claim도 받지 않고, 새 메시지는 `409 TAKEOVER_REQUIRED`로 거절된다. owner가 `GET /v1/takeovers`로 목록을 보고 `POST /v1/sessions/{id}/takeover`로 인수하면, 그 owner가 세션의 요청자가 되고 `takeover` receipt가 남는다. 세션이 인수하는 owner에게 보이지 않는 공유 범위면 `{"justification"}`이 필요하다(아래 세션 공유 범위 절).

`POST /v1/members/{user_id}/enable`은 membership을 되살린다. 폐기한 web session과 개인 key, 회수한 Slack 연결은 되살리지 않는다(Slack은 다시 연결한다). 사용자는 다시 로그인하고 key도 새로 받는다. 아직 아무도 인수하지 않은 세션은 인수 대기 표시를 지워 그 사람에게 돌려준다. Google로만 만든(비밀번호 없는) 계정도 이렇게 되살리면 연결된 Google 로그인으로 다시 들어온다. 이런 계정은 다시 초대하지 말고 enable한다. 초대 수락은 새 계정이거나 비밀번호로 확인한 계정만 받기 때문이다.

계정 정지는 `POST /v1/users/{user_id}/disable`·`/enable`이다. 대상의 live membership이 모두 호출한 owner의 workspace 안에 있을 때만 허용하고, owner가 아닌 workspace에도 속한 계정은 `403`이다. 정지된 계정은 어느 workspace로도 로그인하지 못하고, 정지할 때 멤버 비활성과 같은 폐기(web session, 모든 workspace의 개인 key와 Slack 연결, 인수 대기 표시)가 일어난다. 정지 해제도 cookie와 key를 되살리지 않는다.

네 동작은 모두 바뀐 경우에만 receipt를 남긴다(`disable_member`·`enable_member`·`disable_user`·`enable_user`). `target_ref`는 `{user_id, workspace_id}`, `actor`는 호출한 owner, `result`는 `reason`과 폐기·반환한 개수다. 이미 그 상태면 아무것도 쓰지 않고 응답의 `receipt_id`가 `null`이다. 외부 디렉터리(SCIM 등)와의 동기화는 없다. 사내 SSO에서 사람을 내보내도 여기에는 반영되지 않으므로 이 API를 따로 불러야 한다.

```bash
bun run keys create --workspace "$WORKSPACE_ID" --scopes sessions:read,sessions:write
bun run keys create --workspace "$WORKSPACE_ID" --scopes sessions:read,sessions:write --personal "$USER_ID"
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/members/$USER_ID/disable" -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' -d '{"reason":"left the team"}'
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/members/$USER_ID/enable" -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' -d '{}'
curl -s -b jar http://127.0.0.1:3000/v1/takeovers
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/takeover" -H 'X-Requested-With: agent-platform-web'
```

### Slack 계정 연결

웹에 로그인한 사람은 자기 Slack 계정을 Sign in with Slack(OpenID Connect)으로 연결한다. 연결은 `linked_accounts`에 `(provider, external_tenant, external_user_id) → user`로 남는다. Slack 쪽 입력은 처리 시점에 이 행을 다시 읽어 사람을 정한다. 연결·해제는 그 사람의 web session으로만 한다. API key는 개인 key라도 `403`이다(`account.link`, owner·admin·member).

| 변수 | 기본값 | 허용 범위 |
|---|---|---|
| `SLACK_OIDC_CLIENT_ID` · `SLACK_OIDC_CLIENT_SECRET` · `SLACK_OIDC_REDIRECT_URI` | 없음(연결을 끔. 시작 요청은 `503`) | 셋을 함께 설정한다. 일부만 설정하면 기동하지 않는다. redirect URI는 절대 http(s) URL이다 |
| `SLACK_OIDC_ISSUER` | `https://slack.com` | 절대 http(s) URL. mock IdP(`infra/compose.mock-slack.yml`)에만 쓴다 |

흐름은 다음과 같다.

1. `POST /v1/linked-accounts/slack/start`가 `authorize_url`을 돌려주고, state·nonce를 HttpOnly cookie `ap_slack_link`(path `/v1/linked-accounts/slack`, 10분)에 둔다. 워크스페이스에 확인된 Slack 설치(`slack_installations`)가 없으면 `409 SLACK_NOT_INSTALLED`다. 설치가 하나면 그 team을 `team` 파라미터로 고정한다.
2. Slack이 `SLACK_OIDC_REDIRECT_URI`로 `code`·`state`를 붙여 돌려보낸다. 이 주소는 웹 화면이며, 화면이 둘을 `POST /v1/linked-accounts/slack/callback`에 `{code, state}`로 넘긴다. cookie는 이때 한 번 쓰고 지운다. 만료·불일치·IdP 거절은 모두 `400`(다시 시작 안내)이다.
3. API가 `code`를 id_token으로 바꾸고 서명(JWKS, RS256)·`iss`·`aud`·`nonce`를 검증한 뒤 `https://slack.com/team_id`·`https://slack.com/user_id`로 연결한다. 설치된 team이 아니면 `409 LINK_TEAM_MISMATCH`, 그 Slack 계정이 다른 사람에게 연결돼 있으면 `409 LINK_TAKEN`, 같은 team에 이미 내 연결이 있으면 `409 LINK_EXISTS`다. 성공하면 `201`과 `link_account` receipt가 남는다.
4. `GET /v1/linked-accounts`로 내 연결을 보고, `DELETE /v1/linked-accounts/{id}`로 해제한다(`unlink_account` receipt). 해제한 뒤에는 이미 대기 중인 입력도 처리 시점 재판정에서 거절된다.

상태는 `active`·`stale`·`revoked`다. 해제와 오프보딩은 `revoked`(사유 `unlinked`·`offboarded`)로 바꾸고 `revision`을 올린다. Slack 비활성화 이벤트는 `stale`로 바꾼다(저장소 함수 `markStale`. 이벤트 수신은 Slack ingress가 붙인다). 같은 계정으로 다시 연결하면 `active`로 돌아오고 `revision`이 오른다. 대기 중인 입력의 `subject.linked_account`는 `{id, revision}`을 담는다. 재판정에서 행이 없거나 해제됐으면 `unlinked`, 오프보딩이면 `disabled`, `stale`이거나 revision이 다르면 `stale_link`로 거절한다. 사람 계정이 없는 Slack 사용자가 웹을 열면 `/v1/linked-accounts` 아래의 `401`이 "웹에 로그인한 뒤… owner·admin에게 초대를 요청하세요"를 안내한다.

Enterprise Grid: id_token의 `https://slack.com/team_id`가 workspace id인지 org id인지는 실제 Grid 설치로만 확인할 수 있다. 지금은 workspace id로 보고 `slack_installations.team_id`와 비교한다. Grid에서 org id가 오면 `LINK_TEAM_MISMATCH`로 거절된다(안전한 쪽). 아래 확인 순서 6에서 판정한다.

**실제 Slack으로 확인하는 절차** (사람이 한다. 자동 테스트와 로컬 확인은 mock IdP를 쓴다)

0. 콘솔을 https origin 하나로 연다. Slack은 https redirect URI만 받고, `ap_slack_link` cookie는 `Secure`라 시작(`/v1/linked-accounts/slack/start`)과 callback이 같은 https origin에서 불려야 cookie가 따라간다. 로컬 스택이면 API 포트를 tailnet 안에만 https로 내보낸다: `tailscale serve --bg --https=<port> http://127.0.0.1:<API_PORT>` → `<CONSOLE_URL>` = `https://<host>.ts.net:<port>`. 웹 콘솔은 API와 같은 origin에서 나오므로 이 주소 하나로 로그인·연결·callback이 모두 된다. funnel(인터넷 공개)은 쓰지 않는다. 끝나면 `tailscale serve --https=<port> off`. 콘솔의 POST는 `Origin`과 `Host`가 같아야 통과하므로(`auth.ts` `browserRequestViolation`), 앞단 프록시는 원래 `Host`를 그대로 넘겨야 한다.
1. 그 Slack 워크스페이스에 설치된 Slack 앱이 있어야 한다. 콘솔에서 앱을 자동으로 만들고 설치하는 흐름은 다음 버전에 들어온다. 지금은 있는 앱의 **OAuth & Permissions → Redirect URLs**에 웹의 연결 화면 주소 `<CONSOLE_URL>/settings/linked-accounts/slack`을 넣는다. 이 값이 `SLACK_OIDC_REDIRECT_URI`와 글자까지 같아야 한다.
2. 앱의 user scope는 `openid`·`profile`이다(email은 쓰지 않는다). 설치 등록(4)이 bot을 확인하므로 bot scope `users:read`가 있어야 한다.
3. **Basic Information**의 Client ID·Client Secret과 1의 주소를 repo 밖 파일 `~/.config/agent-platform/slack-dev.env`(권한 `0600`)에 `SLACK_OIDC_CLIENT_ID=…`·`SLACK_OIDC_CLIENT_SECRET=…`·`SLACK_OIDC_REDIRECT_URI=…` 세 줄로 둔다. 띄우는 셸에서 `set -a; . ~/.config/agent-platform/slack-dev.env; set +a`로 읽은 뒤 `scripts/local.sh up`(이미 떠 있으면 `docker compose --profile apps up -d --no-deps --force-recreate api`)을 실행한다. compose는 셸 env로 `SLACK_OIDC_*`를 채운다. `SLACK_OIDC_ISSUER`는 비워 둔다. mock overlay는 겹치지 않는다.
4. 설치를 등록한다. **OAuth & Permissions**의 Bot User OAuth Token을 셸 env `SLACK_BOT_TOKEN`에만 넣고(인자로 넘기지 않는다), **Basic Information**의 App ID로 CLI를 실행한다. CLI가 `auth.test`·`bots.info`로 team·bot 사용자·앱을 확인하고 `slack_installations`에 `verified` 행을 남긴다. 출력은 JSON 한 줄이고 token은 어디에도 쓰지 않는다.

   ```bash
   read -rs SLACK_BOT_TOKEN && export SLACK_BOT_TOKEN
   # The root script runs the CLI in the compose api container; -e passes only the variable's name.
   bun run slack-install register --workspace "$WORKSPACE_ID" --app-id <APP_ID>
   unset SLACK_BOT_TOKEN
   ```

   | 종료 코드 | 뜻 |
   |---|---|
   | `0` | `verified`. 다시 실행하면 같은 행을 다시 확인한다(`registration: existing`) |
   | `2` | 인자·env가 잘못됐다(`SLACK_BOT_TOKEN`·`DATABASE_URL` 없음, `SLACK_API_URL`이 https가 아님. http는 `localhost`·`127.0.0.1`·`[::1]`·`mock-slack`만) |
   | `3` | `slack_auth_failed`: token 거절(`invalid_auth` 등), bot token이 아님, Slack 불통, Slack id 모양이 아님 |
   | `4` | `workspace_conflict`: 그 앱·team이 다른 워크스페이스의 것이다(거기서 해제됐어도 같다) |
   | `5` | `revoked`: 등록과 확인 사이에 해제됐다. 다시 실행하면 같은 행을 다시 연다 |
   | `6` | `workspace_not_found`: `--workspace`의 워크스페이스가 없다 |
   | `7` | `app_mismatch`: token이 `--app-id`와 다른 앱의 것이다(`bots.info`로 대조) |
   | `1` | 그 밖의 오류(DB 등) |

   `4`에서 그 행이 다른 워크스페이스에서 해제(`revoked`)된 것이면 메시지가 그렇게 말한다. 해제된 행도 원래 워크스페이스만 다시 등록할 수 있다. `SLACK_API_URL`(기본 `https://slack.com/api`)은 mock IdP를 쓸 때만 바꾼다. Kubernetes에는 아직 `:k8s` 스크립트가 없다. `kubectl exec -it <api pod> -c api -- bash`로 들어가(`sh`는 `read -s`가 없다) 그 안에서 `read -rs SLACK_BOT_TOKEN`으로 넣고 `bun run apps/control-host/src/api/slack-install.ts register …`를 실행한다. token을 `kubectl` 인자(`env SLACK_BOT_TOKEN=…` 등)에 쓰지 않는다.
   설치가 `verified`가 되면 그 앱을 에이전트에 연결한다: 에이전트를 만든 뒤 `POST /v1/agents/{id}/identities`(`provider: slack_bot`, `app_id`, `team_id`, bot token의 `credential_ref`)를 보낸다(아래 "에이전트의 Slack 앱 연결"). 연결이 없으면 그 앱으로 온 이벤트는 `unidentified`로 버려진다. 계정 연결(5)에는 필요 없다.
5. owner로 `<CONSOLE_URL>`에 로그인하고 **연동 계정** 화면에서 Slack 연결 → Slack 동의 → 콜백 순으로 연결한다. `GET /v1/linked-accounts`에 `active` 행(`external_tenant` = 그 team id)과 `link_account` receipt가 보이는지 확인한다.
6. 다른 워크스페이스 계정으로 시도해 `LINK_TEAM_MISMATCH`, 다른 웹 사용자로 같은 Slack 계정을 시도해 `LINK_TAKEN`을 확인한다. Grid 설치라면 연결이 되는지 보고, 됐으면 `linked_accounts.external_tenant`를 `slack_installations.team_id`와 비교해 P5를 판정한다. `LINK_TEAM_MISMATCH`로 거절되면 id_token의 team이 org id라는 뜻이다.
7. 해제한 뒤 `GET /v1/linked-accounts`가 비고 `unlink_account` receipt가 남는지, 연결한 멤버를 `POST /v1/members/{user_id}/disable`로 비활성화하면 receipt `result.revoked_linked_accounts`가 1이고 목록에서 사라지는지 확인한다.

```bash
# Secure cookies only travel over https: use the console origin from step 0.
curl -s -b jar -c jar -X POST "$CONSOLE_URL/v1/linked-accounts/slack/start" -H 'X-Requested-With: agent-platform-web'
curl -s -b jar -c jar -X POST "$CONSOLE_URL/v1/linked-accounts/slack/callback" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' -d '{"code":"<code>","state":"<state>"}'
curl -s -b jar "$CONSOLE_URL/v1/linked-accounts"
curl -s -b jar -X DELETE "$CONSOLE_URL/v1/linked-accounts/$LINKED_ACCOUNT_ID" -H 'X-Requested-With: agent-platform-web'
```

로컬에서는 `infra/compose.mock-slack.yml`을 겹쳐 띄우면 Slack 앱 없이 같은 흐름을 돌릴 수 있다. mock은 동의를 자동으로 하고 `MOCK_SLACK_TEAM_ID`·`MOCK_SLACK_USER_ID`(기본 `T0MOCK`·`U0MOCK`)를 돌려준다. `authorize_url`에 `mock_team`·`mock_user`를 붙이면 그 계정을 돌려준다. 설치 등록 CLI가 부르는 `auth.test`·`bots.info`도 답한다: bot token `mock-bot-token`이면 team `MOCK_SLACK_TEAM_ID`, app `A0MOCK`, bot 사용자 `U0MOCKBOT`. 그때는 `SLACK_API_URL=http://mock-slack:4020/api`로 CLI를 실행한다. 실제 배포에는 절대 겹치지 않는다. API가 mock이 서명한 것을 믿게 된다.

### 역할, 에이전트 관리자, 권한별 API key

workspace 역할은 owner·admin·member 셋이다. admin은 owner와 같은 관리 권한을 갖되 세 가지가 다르다: 감사 보존 기간을 바꾸지 못하고, 보관한 에이전트를 되살리지 못하고, 세션 복구 결정(`sessions:recover`)을 하지 못한다. admin은 owner를 초대하거나 owner의 역할을 바꾸거나 누구를 owner로 올리지 못한다(`403 OWNER_PROTECTED`).

에이전트 관리자는 `agent_admins`의 행이다. 에이전트를 만든 사람이 그 에이전트의 관리자가 된다. 0142 migration은 기존 에이전트의 `created_by`가 아직 그 workspace의 멤버이면 그 사람을 관리자로 채운다. 에이전트 관리자는 member여도 그 에이전트의 정의 수정·release·활성화·보관, 자격 참조 연결, 관리자 지정, Slack 설정, 그 에이전트 전용 서비스 key 발급을 할 수 있다. 다른 에이전트와 workspace 전체 목록은 못 한다. 관리자 지정·해제와 팀을 관리자로 두는 방법은 아래 "팀과 에이전트 관리자 지정"에 있다.

key는 웹(cookie 세션)에서 `POST /v1/api-keys`로 발급한다.

| key | 누가 발급 | 무엇을 하나 |
|---|---|---|
| 개인 key (`kind: personal`) | 모든 멤버, 자기 것만 | 만든 사람의 지금 역할 안에서 그 사람으로 동작한다. 그 사람이 비활성화되면 `401` |
| 서비스 key (`kind: service`) | owner·admin | workspace의 서비스로 동작한다. 발급자가 떠나도 계속 동작한다 |
| 에이전트 전용 서비스 key (`agent_id`) | owner·admin·그 에이전트 관리자 | 그 에이전트의 세션 생성·조회만. `sessions:approve`는 갖지 못한다 |

- 요청한 `scopes`가 발급자의 지금 scope를 넘으면 `403 SCOPE_NOT_GRANTABLE`이다. admin은 `sessions:recover`가 든 key를 만들 수 없다. 에이전트 전용 key에 `sessions:approve`를 넣어도 같은 오류다.
- 권한이 없으면 `403 FORBIDDEN`이고 `error.details.reason_code`에 판정 이유(`role`, `agent_ceiling` 등)가 있다.
- 에이전트 전용 key로 세션을 만들려면 `POST /v1/sessions`에 그 에이전트의 `agent_release_id`를 넣는다. `profile_id`는 그 release의 실행 프로필이어야 한다(`409 RELEASE_PROFILE_MISMATCH`). release를 넣지 않은 세션이나 다른 에이전트의 세션은 `403`(`agent_ceiling`)이다. 세션 목록과 receipt 조회도 에이전트를 가리지 못해 `403`이다. 실행은 아직 `profile_id`를 따르고, release의 지시문과 도구 정책은 세션에 고정만 된다.
- 목록(`GET /v1/api-keys`)은 자기 개인 key와 자기가 관리하는 서비스 key만 보인다. 비밀값은 발급 응답에서 한 번만 나온다.
- 폐기는 `DELETE /v1/api-keys/{id}`이고 발급과 같은 권한이 든다. 남의 개인 key는 `404`다. 이미 폐기한 key는 아무것도 바꾸지 않고 `receipt_id: null`을 돌려준다.
- 발급·폐기는 `create_api_key`·`revoke_api_key` receipt와 `api_key.manage`·`api_key.manage_own` 판정 행을 남긴다. receipt에는 key의 종류·에이전트·scope만 있고 비밀값은 없다.

```bash
curl -s -b jar -X POST http://127.0.0.1:3000/v1/api-keys \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"kind":"service","agent_id":"<agent_id>","scopes":["sessions:read","sessions:write"]}'
```

운영자 CLI(`keys create`)는 그대로 있고 이 판정을 거치지 않는다. 운영자가 쓰는 길이다.

### 팀과 에이전트 관리자 지정

팀은 workspace 안의 사람 묶음이다(`member_teams`, 구성원은 `member_team_members`). 팀을 에이전트 관리자로 지정하면(`agent_admin_teams`) 그 팀 구성원 모두가 그 에이전트의 관리자다. 팀(부서) 배치와는 별개이고 배치는 접근에 쓰이지 않는다.

- 팀을 만들고, 이름을 바꾸고, 지우고, 구성원을 넣고 빼는 것은 owner·admin만 한다(`team.manage`). 에이전트 관리자와 팀 구성원도 못 한다(`403`, `reason_code: role`). 팀 목록·상세도 같은 권한이다.
- 구성원 추가는 초대가 아니다. 수락 없이 바로 구성원이 된다. 비활성 멤버는 넣을 수 없다(`404`). 추가·제거마다 그 사람을 대상(`target_ref.user_id`)으로 한 `add_team_member`·`remove_team_member` receipt가 남고 `result`에 팀 id와 이름이 있다. 지금은 이 receipt가 추가 알림의 기록이고, 화면·Slack 알림은 아직 없다.
- 구성원은 판정 때마다 읽는다. 팀에서 빠지거나 팀이 지워지면 그 팀으로 얻은 관리 권한이 다음 요청부터 `403`이다. 비활성 멤버는 팀에 있어도 아무 권한이 없다. 다만 비활성화는 팀 구성원 자격과 에이전트 관리자 지정을 지우지 않으므로, 다시 초대해 활성화하면 그 권한이 그대로 돌아온다. 돌려주지 않으려면 비활성화할 때 팀에서도 빼고 관리자 지정도 해제한다. 팀을 지우면 그 팀의 에이전트 관리자 지정도 함께 지워진다.
- 에이전트 관리자 지정·해제는 owner·admin과 그 에이전트의 관리자가 한다(`agent.admin.manage`). 사람이나 팀 하나를 고른다.
- 에이전트 관리자는 `GET /v1/administered-agents`로 자기가 지금 관리하는 에이전트(직접 지정과 팀 경유)를 본다. 여기서 얻은 `agent_id`로 그 에이전트 전용 key를 발급한다.

| 요청 | 하는 일 |
|---|---|
| `POST /v1/teams` `{"name"}` | 팀 만들기. 살아 있는 팀 이름이 겹치면 `409 ALREADY_EXISTS` |
| `GET /v1/teams`, `GET /v1/teams/{team_id}` | 목록, 구성원을 포함한 상세 |
| `PATCH /v1/teams/{team_id}` `{"name"}` | 이름 변경 |
| `DELETE /v1/teams/{team_id}` | 팀 삭제 |
| `POST /v1/teams/{team_id}/members` `{"user_id"}` | 구성원 추가 |
| `DELETE /v1/teams/{team_id}/members/{user_id}` | 구성원 제거 |
| `GET /v1/agents/{id}/admins` | 에이전트의 관리자(사람·팀) |
| `POST /v1/agents/{id}/admins` `{"user_id"}` 또는 `{"team_id"}` | 관리자 지정 |
| `DELETE /v1/agents/{id}/admins/users/{user_id}`, `…/admins/teams/{team_id}` | 관리자 해제 |
| `GET /v1/administered-agents` | 내가 관리하는 에이전트 |

바꾼 것이 없으면(이미 구성원, 이미 관리자, 같은 이름) `receipt_id`가 `null`이다. 판정은 `team.manage`·`agent.admin.manage` 행으로 `authz_decisions`에 남는다.

```bash
curl -s -b jar -X POST http://127.0.0.1:3000/v1/teams \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' -d '{"name":"리서치봇 관리팀"}'
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/teams/$TEAM_ID/members" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' -d "{\"user_id\":\"$USER_ID\"}"
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/agents/$AGENT_ID/admins" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' -d "{\"team_id\":\"$TEAM_ID\"}"
```

### 세션 공유 범위와 감사 열람

세션마다 누가 보는지(공유 범위)가 있다. 범위는 넷이다.

| 범위 | 보는 사람 |
|---|---|
| `private` | 만든 사람만 |
| `people` | 만든 사람과 지정한 멤버 |
| `team` | 만든 사람과 지정한 팀의 지금 구성원 |
| `workspace` | workspace 멤버 모두(기본값) |

- 판정 순서는 workspace 일치 → 공유 범위 → key scope → agent_id → (`session.approve`만) 답할 사람인가다. 범위 밖이면 owner·admin도 목록·검색(`?status=`)·상세·turn·SSE·usage·pending·receipt·메시지·응답·interrupt·종료 어디서나 `404`다. 있는지조차 알리지 않는다.
- 팀 범위는 판정 때마다 지금 구성원을 읽는다. 팀에서 빠지거나 팀이 지워지면 다음 요청부터 `404`다.
- service key는 멤버가 아니다. `workspace` 범위의 세션과 자기가 만든 세션만 본다. key가 만든 세션에서는 그 key가 만든 사람 자리에 선다.
- 범위를 좁히면 그 세션의 열린 SSE가 바로 깨어나 다시 판정되고, 더는 볼 수 없는 연결은 끊긴다(로그 `SSE stream closed`, `reason: not_visible`). 다시 연결하면 `404`다.
- 아직 한 번도 바꾸지 않은 세션은 `session_shares` 행 없이 `workspace`로 읽힌다(`revision` 0).

보는 것과 대신 답하는 것은 다르다. 권한 요청·질문에 답하고 push·PR을 결정하는 것(`session.approve`)은 세션을 볼 수 있는 사람 가운데 만든 사람(key가 만든 세션이면 그 key), 그 에이전트의 관리자, owner·admin만 한다. 공유로 보기만 하는 사람(member, 남이 만든 세션을 보는 service key)은 `403`(`reason_code: role`, "holds sessions:approve but may not use it on this session")이고 요청은 열린 채 세션은 `needs_input`에 머문다. 볼 수 없는 사람은 지금처럼 `404`다. 개인 key는 만든 사람으로, 그 사람의 지금 역할로 판정한다. workspace가 없는 호출자(legacy key, `AUTH_MODE=none`)는 곁에 대신 답할 멤버가 없으므로 지금처럼 답한다. `GET /v1/sessions/{id}/pending-requests`의 `answerable`이 같은 판정을 미리 알려 준다. 이 미리보기는 판정 행을 남기지 않는다.

범위를 바꾸는 것(`session.share`)은 사람의 세션이면 만든 사람만, key가 만든 세션이면 owner·admin과 그 에이전트의 관리자만 한다. 세션을 볼 수 있지만 바꿀 수 없는 사람은 `403`, 볼 수 없는 사람은 `404`다. API key는 바꾸지 못한다. 바꾼 경우에만 `share_session` receipt(`result.scope`)와 판정 행이 남는다.

owner·admin은 범위 밖 세션을 두 길로만 다룬다. 둘 다 사유(`justification`, 1000자까지)가 필요하고, 사유는 `authz_decisions.justification`에 남는다.

- **감사 열람** `POST /v1/sessions/{id}/audit-read` `{"justification"}`: 세션 상세와 turn 한 페이지(`cursor`·`limit`)를 돌려준다. 읽을 때마다 `session.audit_read` 행이 하나씩 남는다. 읽기만 한다. 열람한 뒤에도 그 세션의 다른 표면(메시지·응답·종료 등)은 여전히 `404`다. 사유가 없으면 `400`, member는 `404`(범위 밖) 또는 `403`(`reason_code: role`)이다.
- **관리 종료** `POST /v1/admin/sessions/{id}/terminate` `{"expected_revision","justification"}`: 범위와 관계없이 세션을 멈춘다. 사유는 판정 행과 stop 이벤트의 reason에 남는다. 사유가 없으면 `400`이다. 같은 세션에 일반 `POST /v1/sessions/{id}/terminate`를 보내면 `404`이고 거절도 판정 행(`not_found`)으로 남는다.
- **관리 복구** `POST /v1/admin/sessions/{id}/recovery-decisions`: 결과를 모르는 세션의 복구 결정을 owner만 범위와 관계없이 내린다. 본문은 일반 복구 결정과 같고, 그 `reason`이 사유다. 공백뿐인 사유는 사유가 없는 것과 같아 `404`다.

세션 관리 목록 `GET /v1/admin/sessions`는 owner·admin이 범위와 관계없이 workspace의 세션을 최근 것부터 200개 본다. 항목은 메타데이터뿐이다: `session_id`, `created_by_user_id`, `created_by_api_key_id`, `agent_release_id`, `status`, `admission_state`, `share_scope`, `created_at`, `takeover_required_at`. 메시지·제목·요약은 없다.

나간 멤버의 세션 인수(`POST /v1/sessions/{id}/takeover`)도 그 세션이 인수하는 사람에게 보이지 않는 범위면 사유가 필요하다. 본문 없이 보내면 `403`(`reason_code: justification_required`)이고, `{"justification"}`을 보내면 인수되고 `takeover` receipt의 `result.justification`에 사유가 남는다. 인수한 사람은 만든 사람 자리에 서므로 그 세션을 보고 범위도 바꿀 수 있다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/share" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d "{\"scope\":\"team\",\"team_ids\":[\"$TEAM_ID\"]}"
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/sessions/$SESSION_ID/audit-read" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"justification":"장애 조사 INC-42"}'
curl -s -b jar http://127.0.0.1:3000/v1/admin/sessions
```

아직 없는 것: Slack DM 세션을 `private`로 시작하는 경로(DM 세션 생성 경로가 아직 없다), `private` 세션의 채널 연결 거절(채널 연결 경로가 아직 없다), 세션 삭제.

### 자격 연결

에이전트 정의(card)는 쓸 자격 증명의 이름만 `capabilities.credential_refs`에 적는다(예: `["notion_token"]`, 소문자·숫자·`._:/-` 128자까지, 32개까지). 값은 플랫폼에 들어오지 않는다. 그 이름을 이 에이전트가 써도 된다는 연결은 `credential_bindings`의 행이고, owner·admin·그 에이전트 관리자가 cookie 세션으로만 만든다(`credential.bind`). API key와 그 에이전트를 관리하지 않는 member는 `403`(`reason_code: role`)이다.

| 요청 | 하는 일 |
|---|---|
| `GET /v1/agents/{id}/credential-bindings` | 살아 있는 연결과 각 이름을 쓰는 실행 중 세션 수(`running_sessions`, 닫히지 않은 세션) |
| `POST /v1/agents/{id}/credential-bindings` `{"credential_ref":"…"}` | 연결. 이미 있으면 같은 행과 `created: false`, `receipt_id: null` |
| `DELETE /v1/agents/{id}/credential-bindings/{binding_id}` | 해제. 응답의 `running_sessions`와 `revoke_notice` |

- 연결은 두 번 다시 검사한다. 활성화(`POST /v1/agents/{id}/activate`)는 release의 이름 중 연결되지 않은 것이 있으면 `409 CREDENTIAL_UNBOUND`이고 `error.details.missing`에 그 이름들이 있다. 새 세션(`POST /v1/sessions`에 `agent_release_id`)도 같은 검사를 판정(`session.submit`, `reason_code: credential_unbound`)에서 한 번 더 한다. 활성화 뒤에 해제했을 때를 막는 자리다. 세션을 받는 transaction은 그 에이전트의 살아 있는 연결 행을 잠그고 다시 읽는다. 그래서 동시에 온 해제는 세션이 들어간 뒤에 끝나고 실행 중 세션 수에 그 세션을 센다. 해제 전에 받은 세션을 같은 `Idempotency-Key`로 다시 보내면 원래 응답(`201`)이 돌아온다.
- 세션 거절은 요청자에게 이름을 보여 주지 않는다. `error.details`는 안내 문구(`guidance`), 그 에이전트의 관리자 목록(`admins`, 관리자가 없으면 owner·admin), 연락 링크(`admin_link`, `mailto:`)다.
- 해제는 실행 중인 세션을 멈추지 않는다. 그 세션은 끝날 때까지 자격을 쓰고, 다음 세션부터 막힌다. 바로 막으려면 외부 서비스에서 그 자격을 폐기한다. 해제 응답의 `revoke_notice`가 같은 말을 한다.
- 에이전트 신원에 묶인 이름은 다른 에이전트에 연결하지 못한다(`409 CREDENTIAL_REF_IN_USE`). 거꾸로도 같다. 한 이름에 대한 두 경로는 같은 advisory lock과 trigger(`credential_bindings_exclusive_target`)로 막는다.
- 연결·해제는 `bind_credential`·`unbind_credential` receipt와 `credential.bind` 판정 행을 남긴다. receipt `result`에는 이름(`credential_ref`)만 있다.

```bash
curl -s -b jar -X POST http://127.0.0.1:3000/v1/agents/<agent_id>/credential-bindings \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"credential_ref":"notion_token"}'
```

### 에이전트의 Slack 앱 연결

에이전트마다 자기 Slack 앱(bot)을 갖는다. "이 Slack 앱은 이 에이전트다"는 `agent_identities`의 행이다. 행은 확인된 Slack 설치(`slack_installations`) 하나를 가리키고, 연결할 때 설치가 답한 bot user id와 bot token의 이름(`credential_ref`, 값이 아니다)을 담는다. 설치 하나에는 살아 있는 연결이 하나뿐이다. 그래서 Slack 이벤트의 `(api_app_id, team_id)`만으로 에이전트가 하나로 정해진다.

- 연결: `POST /v1/agents/{id}/identities` `{provider: "slack_bot", app_id, team_id, credential_ref}` → `201`과 `link_agent_identity` receipt. owner·admin·그 에이전트 관리자가 한다(`binding.manage`). 권한이 없으면 `403`이고 `details.reason_code`가 있다.
- 거절: 설치가 없거나 아직 확인 전이거나 회수됐으면 `409 SLACK_NOT_INSTALLED`, 그 앱이 다른 에이전트에 연결돼 있으면 `409 AGENT_IDENTITY_TAKEN`, 이미 이 에이전트에 연결돼 있으면 `409 ALREADY_EXISTS`. 보관된 에이전트는 `404`다.
- `credential_ref`는 그 신원만 쓴다. 에이전트에 연결된 이름이나 다른 신원의 이름이면 `409 CREDENTIAL_REF_IN_USE`다. 신원을 회수하면 이름이 풀린다(위 "자격 연결"과 같은 `credential_bindings` 행).
- 목록: `GET /v1/agents/{id}/identities`(살아 있는 것 먼저, 최근 것 먼저, 50개).
- 회수: `DELETE /v1/agents/{id}/identities/{identity_id}` → `revoked`, `revision` +1, `revoke_agent_identity` receipt. 이미 회수한 것은 아무것도 바꾸지 않고 `receipt_id: null`이다. 행은 지우거나 되살리지 않는다. 다시 연결하면 새 행이 생긴다. 그 설치에 있던 이 에이전트의 채널 설정(아래 "에이전트의 Slack 채널 설정")도 함께 회수된다. 같은 앱을 다른 에이전트에 연결하면 채널 설정은 빈 상태에서 시작한다.

Slack ingress는 이벤트를 받을 때 `agentForSlackEvent(store, {appId, teamId, agentId?})`(`@werft-ai/platform`, 저장소 쪽은 `resolveSlackEventAgent`)로 에이전트를 정한다. `resolved`면 `{workspaceId, agentId, identity: {id, revision}, botUserId, credentialRef}`이고, 아니면 `dropped`와 이유다. 버려진 이벤트는 받았다고만 답하고 아무것도 실행하지 않는다.

| 이유 | 뜻 |
|---|---|
| `not_installed` | 그 team에 그 앱의 설치가 없다(다른 앱으로 온 이벤트) |
| `installation_unverified` · `installation_revoked` | 설치가 확인 전이거나 해제됐다 |
| `unidentified` | 설치에 연결된 에이전트가 없다 |
| `identity_revoked` | 연결이 회수됐다 |
| `bot_mismatch` | 재설치로 bot이 바뀌었다. 다시 연결해야 한다 |
| `agent_mismatch` | 이벤트가 다른 에이전트 앞으로 왔다 |
| `agent_archived` | 에이전트가 보관됐다 |

Slack 앱 만들기와 OAuth 설치 흐름은 아직 없다. 운영자가 앱을 설치한 뒤 설치 행은 `bun run slack-install register`(위 Slack 계정 연결 절차 4)로 만든다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/agents/$AGENT_ID/identities" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"provider":"slack_bot","app_id":"A0APP","team_id":"T0TEAM","credential_ref":"slack/research-bot-token"}'
```

### Slack 비밀값과 master key

플랫폼이 Slack을 부를 때 쓰는 비밀값은 Postgres `secret_values`에 암호문으로만 둔다. App Configuration Token, 앱별 signing secret·client secret·bot token이 여기에 들어간다. 암호는 AES-256-GCM이고, 암호문은 `id|workspace_id|owner_ref|purpose|secret_version|key_version`에 묶인다. 그래서 다른 행, 다른 workspace, 다른 앱으로 옮긴 암호문은 복호화되지 않는다. 키(master key)는 API 프로세스만 갖는다.

**master key**

- 32바이트를 16진수 64자로 쓴다. `openssl rand -hex 32`로 만든다.
- catalog 디렉터리(`PLATFORM_CONFIG_DIR`)에 `platform.yaml`이 있으면 그 참조를 읽는다. 다른 catalog 자격 증명처럼 `value_env`와 `secret_id` 중 하나만 쓴다.

  ```yaml
  platform:
    secret_key:
      secret_id: agent-platform/secret-key   # 또는 value_env: PLATFORM_SECRET_KEY
  ```

- `platform.yaml`이 없으면 `PLATFORM_SECRET_KEY` 환경 변수를 읽는다. 비어 있으면 저장소를 끈다. 이때 기동 로그에 `Secret store is off` 경고가 남고, 아래 API는 `503`으로 답한다.
- 64 hex가 아니면 API가 뜨지 않는다. `platform.yaml`이 있는데 값을 읽지 못해도 뜨지 않는다. 오류에는 변수 이름이나 secret id만 나오고 값은 나오지 않는다.
- compose는 이 키를 `api`에만 넘긴다. Helm도 api Deployment에만 Secret의 `PLATFORM_SECRET_KEY`를 optional로 넘긴다. scheduler와 worker는 받지 않는다(`deploy/helm/render-check.ts`가 검사한다).
- 키를 잃으면 저장된 값을 읽을 수 없다. 새 키로 띄운 뒤 config token을 다시 넣고, 자동 생성한 앱은 다시 만든다. 키 회전 도구는 아직 없고 `key_version`은 1이다.

로컬 스택에서는 키를 macOS Keychain에 두고 기동할 때마다 꺼낸다. 처음 한 번만 1–3을 한다.

1. `openssl rand -hex 32 | pbcopy`
2. `security add-generic-password -a "$USER" -s agent-platform-secret-key -w`를 실행하고 프롬프트에 붙여 넣는다.
3. `pbcopy </dev/null`로 클립보드를 비운다.
4. 기동할 때마다 `PLATFORM_SECRET_KEY`를 Keychain 항목 `agent-platform-secret-key`에서 export한 뒤 `scripts/local.sh up`을 실행한다.

   ```bash
   export PLATFORM_SECRET_KEY="$(security find-generic-password -a "$USER" -s agent-platform-secret-key -w)"
   scripts/local.sh up
   ```

**App Configuration Token API**

owner·admin이 콘솔 세션(cookie)으로만 쓴다. 값은 돌려주지 않는다.

| 요청 | 하는 일 |
|---|---|
| `GET /v1/workspaces/{id}/slack/config-token` | `{configured, last4, updated_at, updated_by}`. 값은 없다 |
| `PUT /v1/workspaces/{id}/slack/config-token` `{"value":"…"}` | 저장하거나 교체한다. 교체하면 같은 행의 `secret_version`이 오른다. 응답은 GET과 같은 요약과 `receipt_id` |
| `DELETE /v1/workspaces/{id}/slack/config-token` | 지운다. 설정된 값이 없으면 `404` |

- 쓰기에는 `X-Requested-With` 헤더가 필요하다. 없거나 다른 사이트에서 온 요청은 `403`이다(`csrfViolation`).
- member는 `403`이다. API key는 역할과 관계없이 `403`이다(`reason_code: web_session_required` 또는 `role`). 다른 workspace의 경로는 `404`다.
- `value`는 공백 없는 출력 가능 ASCII 8–4096자다. 어긋나면 `400 Request body is invalid`이고, 응답에도 로그에도 값은 남지 않는다.
- 저장·교체는 `set_slack_secret`, 삭제는 `delete_slack_secret` receipt를 남긴다. `result`는 `{purpose, last4}`뿐이다. 쓰는 transaction 안에서 쓰는 사람의 역할을 다시 읽는다.
- 앱별 비밀값은 사람이 넣지 않는다. 플랫폼이 만든 앱의 signing secret·client secret·bot token은 서버가 Slack 응답에서 바로 저장하고, API로 덮어쓸 수 없다. signing secret을 아는 관리자는 서명된 가짜 이벤트를 보내 아무 member로 행세할 수 있기 때문이다. 손으로 만든 앱(kind `manual`)만 그 앱의 값을 넣는 경로가 열린다(앱 목록과 함께 다음 버전).

값은 repo 밖 파일에 두고 셸에서 읽어 보낸다. 값이 명령 인자나 셸 기록에 남지 않게 한다.

```bash
printf '{"value":"%s"}' "$(cat ~/.config/agent-platform/slack-config-token)" |
  curl -s -b jar -X PUT "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/slack/config-token" \
    -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' --data-binary @-
```

### 에이전트의 Slack 채널 설정

에이전트가 어느 채널에서 답하는지는 `surface_bindings`의 행이다. 행은 에이전트 앱 설치의 채널 하나를 가리킨다. DM은 설치마다 행 하나가 모든 DM을 맡고, 채널 id가 없다(`surface_kind: dm`). 채널 이름은 저장하지 않는다.

- 설정: `PUT /v1/agents/{id}/slack-bindings` `{channel_id, channel_kind, mode, home?, ceiling?}` → `200`, 행 전체와 `set_surface_binding` receipt. 같은 채널의 행을 통째로 바꾸고, 처음이면 만든다. DM은 `{"channel_id": null, "channel_kind": "dm", ...}`이다.
  - `mode`: `off`(그 채널은 아무것도 받지 않는다) 또는 `mention`. `ambient`는 `400`이다.
  - `home: true`: 이 채널이 에이전트의 home이 되고, 이전 home은 꺼진다. 에이전트당 home은 하나다. DM은 home이 될 수 없다(`400`).
  - `ceiling`: 채널 상한 `{actions, disclosure}`. 빠지면 기본값(Slack 동작 넷 전부, `full`)이다. 행마다 칸으로 저장한다.
  - 에이전트에 살아 있는 Slack 앱 연결이 없으면 `409 SLACK_NOT_INSTALLED`, 같은 채널이나 home을 동시에 바꿨으면 `409 REVISION_CONFLICT`다.
  - Slack을 부르지 않는다. bot이 채널에 들어가지 않아도 행은 저장된다.
- 목록: `GET /v1/agents/{id}/slack-bindings`(home 먼저, 오래된 것 먼저, 500개). 각 행은 `external_surface_id`(채널 id), `surface_kind`, `mode`, `home`, `ceiling`, `status`, `revision`을 담는다.
- 권한: owner·admin·그 에이전트 관리자(`binding.manage`). member와 다른 에이전트의 관리자는 `403`이다. owner·admin이 없는 에이전트를 가리키면 `404`다. API key는 쓸 수 없다.

```bash
curl -s -b jar -X PUT "http://127.0.0.1:3000/v1/agents/$AGENT_ID/slack-bindings" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"channel_id":"C0OPS","channel_kind":"public_channel","mode":"mention","home":true}'
```

### Slack 멘션·승인 판정과 guest 설정

Slack 채널은 멘션·스레드 답글·승인 버튼마다 `authorizeSlackInput(deps, input)`(`@werft-ai/platform`) 하나를 부른다. 이 함수가 판정을 끝까지 한다: 에이전트 해석(`agentForSlackEvent`), 말하거나 누른 Slack 계정의 연결 해석(`resolveLinkedSubject`), `authorize`, 거절 안내 문구. 승인 버튼은 요청자가 아니라 **누른 사람**의 Slack user로 같은 함수를 부른다(`action: "session.approve"`). 누른 사람이 그 세션에 답할 사람(만든 사람, 에이전트 관리자, owner·admin)이 아니면 `role`로 거절되고 "이 요청을 승인할 권한이 없어요" 안내가 간다.

- 입력: `event`(`appId`·`teamId`, URL이 가리키는 `agentId`), `user`(Slack user 객체의 `id`·`team_id`·`is_restricted`·`is_ultra_restricted`·`is_stranger`·`is_external`), `action`(`session.read`·`submit`·`control`·`approve`), `channel`(이벤트의 채널 `id`와 DM인지 `dm`), `resource`(새 대화는 `surface_binding`, 이어 쓰기·버튼은 `session`), `connectUrl`(웹의 Slack 연결 화면).
- 결과: `dropped`(이유는 위 표)이거나 `decided`와 `decision`·`actorUserId`(진행할 때만)·`notice`(그 사람에게만 스레드마다 한 번 보일 문구, 없으면 `null`).
- 채널 상한은 저장된 binding(위 "에이전트의 Slack 채널 설정")에서 읽는다. DM은 설치의 DM 행을 읽는다. 행이 없거나 `mode: off`이거나 회수됐으면 그 채널의 상한은 비어 있고 `surface_ceiling`으로 거절한다(버리지 않고 판정을 남긴다). 상한은 좁히기만 한다: 결과 권한은 사람의 역할, installation 상한(`session.read`·`submit`·`control`·`approve`), 채널 상한의 교집합이다. 복구·공유 범위 변경·감사 열람·관리 목록·삭제는 Slack에서 할 수 없다.

판정 순서와 안내 문구는 다음과 같다. 위에서 먼저 걸리는 것이 이유가 된다.

| 순서 | 이유 코드 | 사용자가 보는 것 |
|---|---|---|
| Slack Connect 외부 사용자(`is_stranger`·`is_external`, 또는 설치와 다른 `team_id`). guest 설정과 상관없다 | `external_user` | 이 에이전트는 이 워크스페이스 멤버만 쓸 수 있어요 |
| guest(`is_restricted`, 단일 채널 guest는 `is_ultra_restricted`도)인데 설정이 꺼져 있다 | `guest_disabled` | 이 워크스페이스는 guest의 에이전트 사용을 허용하지 않아요 |
| 연결이 없거나 해제됐다 | `unlinked` | 웹에서 Slack 계정을 연결해 주세요 + 연결 링크 |
| 연결이 stale이거나 해석 뒤 바뀌었다 | `stale_link` | 같은 문구와 연결 링크 |
| 사람이 비활성(오프보딩)이다 | `disabled` | 이 채널에서 이 에이전트에게 요청할 권한이 없어요 |
| 역할·installation·채널 상한에 없다 | `role` · `surface_ceiling` | 같은 문구. 승인 버튼이면 "이 요청을 승인할 권한이 없어요" |
| 세션이 이 앱의 에이전트 것이 아니다(같은 workspace의 다른 에이전트 세션, 또는 에이전트를 알 수 없는 대상) | `agent_ceiling` | 같은 문구 |
| 세션이 이 워크스페이스에 없다 | `not_found` | 이 세션은 공유 범위 밖이라 요청할 수 없어요. 세션을 만든 사람에게 공유를 요청하세요 |
| 새 세션의 자격 연결이 없다 | `credential_unbound` | 연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요 |

공개 상한이 요약까지(`disclosure: "summary"`)인 채널의 읽기는 거절이 아니라 `redact`(`reason_code: surface_ceiling`, `redact: {view: "summary"}`)다. 채널은 본문 대신 요약과 웹 링크를 보이고, 웹은 링크를 연 사람을 다시 판정한다. 같은 채널의 요청·승인은 좁아지지 않는다. Slack 입력과 승인은 허용도 모두 `authz_decisions`에 남고, 거절과 redact도 남는다. 이 기록을 쓰지 못하면 허용과 redact 모두 `error`로 거절한다(안내는 "지금은 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요"). 판정 행의 `policy_version`은 `m15`다.

guest 사용 설정은 `workspace.settings.slack_guest_enabled`(기본 `false`)다. owner·admin이 cookie 세션으로 바꾼다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/slack-guest" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"slack_guest_enabled":true}'
```

member는 `403`(`details.reason_code: role`), 다른 workspace는 `404`다. 켜도 guest는 Slack 계정을 연결해야 쓴다. Slack은 에이전트 기능(`agent_view`)을 켠 앱을 guest에게 막으므로, 이 설정은 그 기능을 끈 앱에만 의미가 있다. 이 경우 guest는 이 안내 대신 Slack의 차단 화면을 본다.

### 판정 감사와 보존 기간

권한 판정(`authorize`)은 기록할 것을 `authz_decisions`에 한 행씩 남긴다. 거절(`deny`)·`redact`·`require_approval`은 모두 남는다. 허용은 관리 action(`workspace.manage`·`audit_retention.manage`·`member.manage`·`team.manage`·`api_key.manage`·`api_key.manage_own`·`agent.create`·`agent.manage`·`agent.restore`·`agent.admin.manage`·`credential.bind`·`binding.manage`·`routine.manage`·`account.link`), 승인(`session.approve`), Slack 입력(Slack 표면의 `session.submit`)만 남는다. route edge의 scope 부족 403도 같은 판정을 거쳐 남는다. 행의 `request_id`는 응답의 `X-Request-Id`이고, 그 요청이 만든 receipt의 `receipts.request_id`와 같다. 그래서 "누가 시켰나"는 receipt에서 `request_id`로 판정 행을 찾아 답한다.

```sql
SELECT d.at, d.principal_kind, d.principal_id, d.actor_user_id, d.action, d.outcome, d.reason_code, r.id AS receipt_id, r.operation
FROM authz_decisions d LEFT JOIN receipts r ON r.request_id = d.request_id
WHERE d.request_id = '<X-Request-Id>';
```

행은 고칠 수 없다(UPDATE는 trigger가 거절한다). 기록해야 하는 허용을 기록하지 못하면(DB 오류) 그 요청은 거절된다. 거절은 기록에 실패해도 원래 사유(`404`·`403`)를 그대로 돌려준다.

보존 기간은 워크스페이스마다 `settings.audit_retention_days`이고 기본 90일이다. owner만 cookie 세션으로 바꾼다(`audit_retention.manage`). 30일 미만이나 3650일 초과는 `400`이고, admin·member·API key는 `403`이다. 지금 값은 `GET /v1/auth/me`의 `workspace.settings`에서 읽는다. 보존 기간이 지난 행은 reconciler pass마다 오래된 것부터 `RECONCILER_BATCH_SIZE`개씩 지운다(`RECONCILER_DRY_RUN=true`면 세기만 한다). 워크스페이스가 없는 행(workspace에 묶이지 않은 legacy key)은 기본 90일을 따른다.

```bash
curl -s -b jar -X POST "http://127.0.0.1:3000/v1/workspaces/$WORKSPACE_ID/audit-retention" \
  -H 'X-Requested-With: agent-platform-web' -H 'Content-Type: application/json' \
  -d '{"audit_retention_days":60}'
```

### 세션 실행 권한 회수와 복구

API key 폐기(`keys revoke`)는 그 key로 오는 요청과 열려 있던 SSE만 끊고, 이미 돌고 있는 세션의 worker는 건드리지 않는다. 한 세션의 실행을 거두려면 grants CLI를 쓴다. Grant 관리 API나 UI는 없다. keys CLI와 같은 곳(API 이미지 안, 같은 DB)에서 실행하고, `--reason`은 필수다. 이유는 세션 이벤트(`execution_revoked`·`execution_restored`)에 운영자 행위로 남는다.

```bash
# compose(apps profile): api 컨테이너 안에서 실행한다
bun run grants revoke <session_id> --reason "leaked credential"
bun run grants restore <session_id> --reason "rotated; safe to resume"
# host에서 도는 API라면
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/control-host grants revoke <session_id> --reason "…"
```

**revoke**는 한 transaction에서 다음을 한다. 다른 세션과 owner 계정은 건드리지 않는다.
- 세션의 auth_revision과 epoch를 올린다. 현재 binding의 fenced write는 무엇으로 인증했든 여기서부터 실패한다.
- 세션의 worker token을 폐기한다. worker의 다음 요청은 401이다.
- 현재 generation의 kill intent를 terminate와 같은 방식으로 남긴다.
- dispatch를 막는다. owner의 resume과 start_fresh도 403이다.

receipt는 execution이 사라진 것이 관측될 때까지 `accepted`로 남고, terminate 기한을 넘기면 `unknown`이 된다. 기한을 넘긴 receipt가 밀려 있으면 scheduler와 reconciler pass가 오래된 것부터 한 batch씩 마감하므로 몇 pass 늦어질 수 있다.

**restore**는 차단만 푼다. 올라간 auth_revision, 폐기된 token, 세션이 도달한 admission 상태(stopped 또는 recovery_required)는 그대로다. 이어서 하려면 terminate 뒤처럼 owner가 resume하거나 운영자가 recovery를 결정한다. 회수한 execution이 아직 살아 있을 수 있으면 restore는 거부된다. scheduler가 kill을 끝내고 execution이 사라진 것이 관측된 뒤 다시 실행한다.

결과는 아래 표의 한 줄이다. 성공이면 stdout에 쓰고 exit 0, 거부면 stderr에 쓰고 exit 1이다. 같은 명령을 다시 실행해도 안전하다. 인자 오류나 DB 오류는 표에 없는 여러 줄 오류(stack 포함)로 stderr에 나오고 exit 1이다.

| 줄 | exit | 뜻 |
|---|---|---|
| `revoked <id> owner=… auth_revision=… execution=<id\|none> credentials_revoked=<n> receipt=… receipt_status=<accepted\|succeeded>` | 0 | 회수했다. `receipt_status`는 kill을 기다릴 execution이 있으면 `accepted`, 없으면 곧바로 `succeeded`다 |
| `already_revoked <id> revoked_at=… reason="…"` | 0 | 이미 회수된 세션이다. 아무것도 바꾸지 않는다 |
| `restored <id> owner=…` | 0 | 차단을 풀었다 |
| `not_revoked <id>` | 0 | 지금 회수된 상태가 아니다(이미 복구된 세션 포함). 아무것도 바꾸지 않는다 |
| `session <id>: execution <id> has not been observed gone; restore once it has` | 1 | restore 거부. 잠시 뒤 다시 실행한다 |
| `session <id> not found` | 1 | 그런 세션이 없다 |
| `session <id> is closed` | 1 | 닫힌 세션은 회수할 것이 없다 |
| `session <id> runs on a legacy pod binding with no kill path` | 1 | legacy binding이라 kill 경로가 없다 |

`session_id`는 UUID여야 한다. 인자가 틀리거나 `--reason`이 비어 있으면 DB에 연결하기 전에 사용법이 담긴 오류로 끝난다. `DATABASE_URL`이 없어도 인자 검사가 먼저다.


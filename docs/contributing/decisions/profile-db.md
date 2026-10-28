# 결정: 실행 프로필을 DB 하나로 관리한다

- 상태: 설계 확정, 구현 전(PD-2~PD-5가 이 문서를 계약으로 쓴다)
- 기준 커밋: `origin/main` `77b91d84`. 아래 `파일:줄`은 모두 이 커밋 기준이다.
- 오너 원문(2026-10-28): "설치 설정 파일을 고친 뒤 다시 배포해야하는 프로필 개념은 없애고 그냥 db 에서 관리하는 프로필 개념으로 통일하는게 낫지않아?", "DB 단일 관리로 통합하고 싶어 순차적으로 진행해도 좋아"

## 무엇을 골랐나

"프로필"은 DB에만 있는 하나의 개념이 된다. 종류는 둘이고, 둘 다 바뀌지 않는 버전이다.

| 종류 | 테이블 | 누가 만드나 | 하는 일 |
|---|---|---|---|
| 설치 상한 프로필(지금의 운영자 프로필) | `installation_profiles` (새 테이블) | 운영자(설치 owner) | 이 설치에서 쓸 수 있는 모델·도구·권한 모드·저장소의 상한 |
| 워크스페이스 프로필 | `workspace_profiles` (0174, 그대로) | 워크스페이스 owner·admin | 상한 하나를 바탕으로 좁힌 판 |

설치 설정 파일에는 프로필이 아닌 것만 남는다: provider 연결(endpoint·자격 증명 참조·billing, 새 파일 `connections.yaml`), 저장소(`repositories.yaml`), 그리고 위험 기능을 여는 환경 변수(`PLATFORM_ALLOW_UNATTENDED_PERMISSIONS`). 이것들은 비밀 값이나 설치의 격리를 다루므로 원래 설치 작업이다. 상한을 넓히거나 좁히는 일, 새 상한을 만드는 일은 더 이상 재배포가 필요 없다.

팀 단위 프로필은 이번에 만들지 않는다(이전 오너 결정 a안). [확장 지점](#확장-지점-팀-프로필)만 적어 둔다.

## 지금 구조 (바뀌는 것의 출발점)

- 운영자 프로필은 `PLATFORM_CONFIG_DIR`의 `profiles.yaml`(`apps/control-host/src/api/catalog-config.ts:37`)이다. API가 기동할 때 한 번 읽고(`catalog-config.ts:144-163`), 자격 증명 참조를 그 자리에서 값으로 푼다(`catalog-config.ts:165-194`). DB에는 없고 프로세스 메모리의 `SessionCatalog.profiles`에 있다(`packages/platform/src/sessions/catalog.ts:446-451`).
- 워크스페이스 프로필은 `workspace_profiles`(`packages/db/migrations/0174_workspace_profiles.sql:1-30`, `packages/db/src/schema.ts:3093-3145`)에 있다. 행은 `retired_at`·`retired_by` 말고는 바뀌지 않고(`catalog.ts:453-476`), id는 `ws_<slug>_<이름>_v<n>`이다(`packages/contracts/src/api/profiles.ts:103-112`).
- 워크스페이스 판은 바탕의 `model`·`models`·`tools`·`permission_mode`만 좁힐 수 있다(`packages/contracts/src/api/profile-derivation.ts:5-11`, `82-150`). 이 정책은 서버와 콘솔이 같이 쓰는 한 지점이다(`profile-derivation.ts:152-154`).
- release와 세션은 프로필 id와 지문(`profileFingerprint`, `catalog.ts:896-908`)을 고정한다. release id는 `runtime_profile_id`와 `profile_digest`를 해시한 값이다(`packages/platform/src/agents/release-ids.ts:61-75`, `152-153`). 세션(`schema.ts:881-887`), 시도(`schema.ts:1951-1952`), checkpoint(`schema.ts:1859-1860`)도 `profile_id`와 `profile_fingerprint`를 남긴다. 세션을 시작할 때 `profilePinned`로 지문을 다시 맞추고 다르면 `PROFILE_DIGEST_MISMATCH`다(`packages/platform/src/agents/agent-service.ts:50-86`).

그래서 이 전환에서 가장 지켜야 할 것은 **기존 id가 같은 지문을 내는 것**이다. 지문이 하나라도 달라지면 그 id의 release·세션이 모두 멈춘다.

## 1. 데이터 모델

### `installation_profiles` (PD-2가 만든다)

| 열 | 타입 | 규칙 |
|---|---|---|
| `id` | text PK | 가져온 것은 YAML id 그대로(`claude-coding-real` 등). 콘솔에서 만든 것은 `op_<name>_v<n>`. `CHECK (id NOT LIKE 'ws\_%')` |
| `name` | text NOT NULL | 버전 계열 이름. 가져온 것은 YAML id |
| `version` | integer NOT NULL | `>= 1`. 가져온 것은 1. `UNIQUE (name, version)` |
| `origin` | text NOT NULL | `CHECK IN ('catalog', 'console')`. YAML에서 가져왔는지, 콘솔에서 만들었는지 |
| `definition` | jsonb NOT NULL | `catalogProfileConfigSchema`(`catalog.ts:178-217`)로 파싱한 프로필 항목 그대로. provider는 endpoint·`auth.kind`·참조 이름(`value_env`/`secret_id`)·billing만 있고 값은 없다 |
| `permission_mode` | text NOT NULL | 6개 값 CHECK(0174와 같은 목록) + `CHECK (permission_mode = definition->>'permission_mode')`. DB 수준에서 모드로 거르고 막기 위한 열 |
| `fingerprint` | text NOT NULL | 쓸 때 계산한 `profileFingerprint`. 읽을 때 다시 계산해 다르면 그 행은 아무것도 돌리지 않는다 |
| `repository_ids` | jsonb NOT NULL | 이 상한이 돌 수 있는 저장소 id 목록(지금의 `repositories.<id>.profiles`를 뒤집은 것) |
| `previous_id` | text | 이 버전이 대신하는 앞 버전 id. 계열을 잇는 데만 쓴다 |
| `created_by` | uuid FK users | 가져온 행은 NULL |
| `created_at` | timestamptz NOT NULL default now() | |
| `retired_at`, `retired_by` | timestamptz, uuid FK users | 0174와 같은 짝 CHECK |

- **행은 바뀌지 않는다.** 바뀌는 것은 `retired_at`·`retired_by`뿐이다. 상한을 고치면 같은 `name`의 다음 버전이 새 id로 생긴다(오너 결정 2). 기존 워크스페이스 판과 release는 옛 id를 그대로 가리키므로 멈추지 않는다. 지금은 YAML을 제자리에서 고치면 그 id의 세션이 모두 `CATALOG_MISMATCH`가 되는데(`docs/operator/api-server.md:88`), 이 경로가 없어진다.
- **`definition`을 프로필 항목 그대로 두는 이유.** DB 행을 `SessionCatalogConfig`의 한 항목으로 되돌린 뒤 지금의 `sessionCatalogView`(`catalog.ts:1170-1194`)와 `resolveSessionCatalog`(`catalog.ts:1202-1238`)를 그대로 통과시킨다. YAML에서 읽은 것과 DB에서 읽은 것이 같은 함수를 지나므로 같은 입력이면 같은 지문이 나온다. 열을 나눠 다시 조립하면 키 하나(`repository` 생략 규칙, `catalog.ts:420-421`, `1185`)만 어긋나도 지문이 달라진다.
- **`ws_`와 `op_`는 서로의 이름 공간이다.** YAML에 `ws_`로 시작하는 id가 있으면 지금처럼 기동을 거부한다(`catalog.ts:348-355`). PD-2는 같은 자리에서 `op_`도 거부한다.

### `workspace_profiles` (바꾸지 않는다)

0174의 열·제약·id 규칙을 그대로 둔다. `base_profile_id`는 이제 `installation_profiles.id`를 가리킨다. FK는 걸지 않는다. 바탕이 없을 때의 상태(`base_missing`, `catalog.ts:676-679`)를 지금처럼 읽고, 옛 이미지가 이 테이블을 읽는 방식(`packages/db/src/workspace-profiles.ts:86-92`)을 건드리지 않기 위해서다.

### 한 테이블로 합치지 않은 이유

두 종류를 `workspace_profiles` 하나에 넣으면 0174의 `ws_` CHECK와 `workspace_id`·`created_by` NOT NULL(`0174_workspace_profiles.sql:3`, `15`, `20`)을 풀어야 한다. 그리고 옛 이미지의 `listAll`은 테이블 전체를 워크스페이스 판으로 읽는다(`packages/db/src/workspace-profiles.ts:86-92`). 롤백한 이미지가 상한 행을 워크스페이스 판으로 잘못 읽게 된다. 그래서 테이블은 둘, API·콘솔의 개념은 하나(`GET /v1/profiles`의 한 목록)로 둔다.

### 연결(`connections.yaml`)

```yaml
connections:
  anthropic-main:
    kind: anthropic
    endpoint: https://api.anthropic.com
    auth:
      kind: api_key
      value_env: ANTHROPIC_API_KEY
```

- 항목 하나는 지금 프로필의 `provider` 값 하나와 같은 모양이다(`catalog.ts:116-133`).
- DB 행의 `definition.provider`는 어떤 연결과 정확히 같아야 돈다(canonical JSON 비교). 같은 연결이 없으면 그 행의 상태는 `connection_missing`이고 아무것도 돌리지 않는다.
- 자격 증명은 연결의 참조만 푼다. 지금 `catalogCredentialRefs`가 프로필에서 참조를 모으는 자리(`catalog-config.ts:176-189`)가 연결에서 모으게 된다. 그래서 DB 행이 새 `value_env`·`secret_id`나 새 endpoint를 들여올 길이 없다. 콘솔에서 상한을 만들 때는 `connection_id`만 고르고, 서버가 그 연결의 provider를 `definition`에 복사한다.
- `connections.yaml`이 없으면(PD-2~PD-4 기간의 기존 설치) `profiles.yaml` 각 항목의 provider를 그 프로필 id를 이름으로 한 연결로 본다. PD-5부터는 `connections.yaml`이 필수다.

## 2. 상한과 좁히기

### 층

1. **설치 설정(파일·env, 재배포 필요):** 연결, 저장소와 그 자격 증명, 설치 한도(`SESSION_COST_LIMIT_USD` 등), `PLATFORM_ALLOW_UNATTENDED_PERMISSIONS`.
2. **설치 상한 프로필(DB, 운영자):** 연결 하나 위에서 runtime·모델·도구·권한 모드·`project_settings`·저장소 모드·`repository_ids`를 정한다.
3. **워크스페이스 프로필(DB, 워크스페이스 owner·admin):** 상한 하나를 `WORKSPACE_PROFILE_POLICY`로 좁힌다. 규칙은 지금과 같다(`profile-derivation.ts:60-75`, `115-142`).

### 운영자는 누구인가 — 오너 확인 대기(기본값 적용)

- **기본값: 이 설치의 워크스페이스 owner, 로그인한 사람(cookie 세션)만.** 새 action `profile.installation.manage`를 `MANAGEMENT_ROLES`에 `["owner"]`로 둔다(`packages/platform/src/musterrolle/policy.ts:238-258`). 이 표의 action은 API key가 가질 수 없다(`policy.ts:236-237`). 서비스는 지금 워크스페이스 판을 쓸 때처럼 principal이 user인지 다시 본다(`packages/platform/src/sessions/workspace-profiles.ts:186-202`).
- 근거: 설치당 워크스페이스는 하나다. bootstrap은 첫 owner와 기본 워크스페이스를 만들고, 그 뒤로는 새 워크스페이스를 만들지 않는다(`packages/db/src/identity.ts:74-80`). 설치 전체에 걸린 것을 owner만 보게 한 선례도 있다(`usage.installation_read: ["owner"]`, `policy.ts:256`).
- 다른 안: (B) env `PLATFORM_OPERATOR_EMAILS`로 지정, (C) 별도 `installation_operators` 테이블. 설치에 워크스페이스가 둘 이상 생기는 날 다시 본다. 그때도 action 이름은 그대로 두고 판별만 바꾼다.

### 상한을 지키는 방법

| 조건 | 어떻게 지키나 | 코드 근거 |
|---|---|---|
| 워크스페이스 판은 상한보다 넓어질 수 없다 | 저장(`refusal`)과 실행(`baseHolds`)이 같은 정책을 쓴다. 상한이 DB로 와도 이 두 자리는 그대로다 | `workspace-profiles.ts:248-259`, `catalog.ts:685-694`, `profile-derivation.ts:152-154` |
| `bypassPermissions`는 env가 열어야 쓴다 | 저장: env가 `true`가 아니면 `bypassPermissions` 상한 저장은 `400`(`reason_code: unattended_not_allowed`). 실행: 프로필을 읽을 때 env가 꺼져 있으면 그 상한 행은 상태 `unattended_off`가 되어 해석 결과에서 빠진다. 지금 기동을 거부하는 검사(`catalog-config.ts:155-160`)를 "행을 빼고 기동 로그에 id를 적는다"로 바꾼다. DB에 행이 있다고 API가 뜨지 않으면 콘솔 한 번의 저장으로 설치가 멈추기 때문이다 | `catalog-config.ts:155-160`, `280`, `packages/contracts/src/api/session.ts:95-97` |
| 저장할 때만이 아니라 claim·egress에서도 막는다 | 모든 해석은 `catalogProfile` 하나를 지난다(release 생성 `agent-service.ts:308`, 세션 시작 `agent-service.ts:63-68`, gateway의 실행 쌍 `packages/platform/src/workers/worker-gateway.ts:577-606`). env·연결·지문 검사를 이 함수가 읽는 레지스트리의 적재 단계에 두므로, 이미 저장된 행과 핀된 release도 같은 검사를 받는다 | `catalog.ts:702-718` |
| `auto`는 env 없이 쓴다 | PR JeongJaeSoon/agent-platform#894 결정 그대로. 분류기가 호출마다 판정하고 쓸 수 없으면 거부한다 | `session.ts:89-97` |
| 연결·자격 증명은 DB로 바꿀 수 없다 | 위 [연결](#연결connectionsyaml) 절. 행의 provider가 연결과 같지 않으면 돌지 않고, 자격 증명은 연결의 참조로만 푼다 | `catalog-config.ts:176-194`, `catalog.ts:814-823` |
| `billing: none`은 사설 endpoint에서만 | 연결을 고칠 수 없으므로 billing도 연결에서 온다. `definition`을 같은 스키마로 파싱하므로 사설 주소 규칙도 그대로 걸린다 | `catalog.ts:207-216`, `809-811` |
| runtime은 worker 이미지가 가진 것만 | 저장과 적재 때 `installedRuntimes.assertProfiles`를 같이 부른다 | `catalog-config.ts:48`, `161` |

## 3. 이전 경로

### 가져오기(import)

- **언제:** API가 기동할 때 프로필을 읽기 전에 한 번. slack 역할은 가져오지 않고 읽기만 한다(`apps/control-host/src/slack/main.ts:138-143`).
- **무엇을:** `profiles.yaml`의 각 항목을 `installation_profiles` 행 하나로(`origin = 'catalog'`, `version = 1`, `name = id`). `repository_ids`는 `repositories.<id>.profiles`에 그 id를 적은 저장소들(`catalog.ts:370-386`)이다.
- **멱등 키는 `id`다.** `INSERT … ON CONFLICT (id) DO NOTHING`. 같은 YAML로 두 번, 세 번 돌려도 행 수와 내용이 같고, 새 행이 생길 때만 receipt를 남긴다. 여러 replica가 같이 떠도 advisory lock(`profiles:import`) 아래에서 차례로 돈다. bootstrap이 같은 방식을 쓴다(`identity.ts:78-79`).
- **이미 있는 id의 내용이 다르면 덮어쓰지 않는다.** 행은 불변이다. 기동 로그에 `Profile import conflict`(id, DB 지문, YAML 지문)를 남긴다. 확장 단계(PD-2)에서는 YAML이 정본이므로 해석은 YAML 값으로 하고, 전환 단계(PD-3) 뒤에는 DB가 정본이다. 전환 이미지를 올리기 전에 `bun run profiles import --check`가 충돌 0으로 끝나야 한다(PD-2가 만드는 CLI). 충돌을 풀어야 하면 `profiles import --replace <id>`로 그 id 행을 그 YAML 값으로 바꾸고 receipt를 남긴다. 이것만이 행을 바꾸는 예외이고, 지금 YAML을 제자리에서 고치는 일과 같은 무게(그 id의 세션이 새 지문을 따른다)라서 운영자 CLI로만 둔다.
- **그 뒤의 YAML:** 오너 확인 대기(기본값 적용). 기본값은 "빈 DB의 초기 시드"다. PD-5부터 `profiles.yaml`은 있으면 없는 id만 넣고, 이미 있는 id는 보지 않는다. 새 설치와 로컬 스택(`config/`, `config/fake-model/` 등)이 바로 뜨기 위해서다.

### 기존 id와 지문을 지키는 방법

| 무엇이 고정하나 | 왜 안 깨지나 |
|---|---|
| release id(`runtime_profile_id`·`profile_digest` 해시, `release-ids.ts:61-75`) | 가져온 행의 id는 YAML id 그대로다. 지문은 같은 `sessionCatalogView`·`resolveSessionCatalog`를 지나 같은 값이다 |
| 세션·시도·checkpoint의 `profile_id`·`profile_fingerprint`(`schema.ts:881-887`, `1951-1952`, `1859-1860`) | 위와 같다. v1 지문도 `profileFingerprintV1`이 같은 객체에서 계산하므로 같다(`catalog.ts:910-917`, `947-956`) |
| 워크스페이스 판의 `base_profile_id`·`base_fingerprint`(`0174:6-7`) | 바탕 id가 그대로이고, `baseHolds`는 지문과 좁히기를 둘 다 다시 보는데(`catalog.ts:685-694`) `definition`이 YAML 항목 그대로라 `models`도 빠지지 않는다 |
| 활성 catalog revision(`catalog_authority`, `schema.ts:2331-2340`) | `catalogRevision`(`catalog.ts:1043-1059`)은 `origin = 'catalog'` 행과 저장소로 지금과 같은 식으로 계산한다. 콘솔에서 만든 `op_` 행은 워크스페이스 판처럼 revision에 넣지 않는다(`api-server.md:92`의 규칙 8). 그래서 확장·전환 이미지가 섞여도 revision이 같고 권위 replica가 바뀌지 않는다 |

검증: PD-2는 `config/`, `config/fake-model/`, `config/fake-model-unattended/`, `config/local-model/`의 모든 프로필에 대해 "YAML 경로의 지문 == DB 경로의 지문"을 테스트한다. 이미 있는 main 지문 고정 테스트(`apps/control-host/src/api/catalog-config.test.ts:307-330`)가 DB 경로로도 같은 값을 내야 한다.

## 4. 감사

- **누가·언제:** 행 자체가 `created_by`·`created_at`·`retired_by`·`retired_at`을 가진다. 가져온 행은 `created_by`가 NULL이다.
- **무엇을:** 행이 바뀌지 않으므로 그 id의 행이 곧 그 시점의 내용이다. 이전 내용은 `previous_id`로 이어진 앞 버전에 그대로 있다.
- **receipt:** 지금 워크스페이스 판처럼(`packages/db/src/workspace-profiles.ts:45-72`) 쓰기와 같은 transaction에 남긴다.

| operation | actor | result |
|---|---|---|
| `import_installation_profile` | null(시스템, `policy.ts:43-51`이 actor 없음을 허용) | `profile_id`, `fingerprint`, `origin` |
| `replace_installation_profile` (`import --replace`) | null | `profile_id`, 옛·새 `fingerprint` |
| `create_installation_profile` | 운영자 | `profile_id`, `name`, `version`, `previous_id`, `fingerprint`, `permission_mode`, `connection_id` |
| `retire_installation_profile` | 운영자 | `profile_id` |
| `create_workspace_profile`, `retire_workspace_profile` | 그대로 | 그대로 |

receipt의 `owner_id`는 이 설치의 워크스페이스 id다(`receipts`, `schema.ts:1429-1448`). 프로필 행도 지우는 경로를 두지 않으므로, receipt가 없어지는 일이 생겨도 누가·언제·무엇은 행에 남는다.

## 5. 롤백: 확장 → 전환 → 정리

규칙 하나: **N단계 이미지는 N+1단계가 남기는 DB와 파일을 읽을 수 있어야 한다.** 그래서 한 단계를 되돌려도 앞 이미지가 그 상태를 읽고 계속 돈다. 마이그레이션은 추가만 하고 되돌리지 않는다.

| 단계 | PR | 이미지가 하는 일 | 되돌릴 때 앞 이미지가 멈추지 않는 이유 |
|---|---|---|---|
| 0. 지금 | — | YAML만 읽는다 | — |
| 1. 확장 | PD-2 | 테이블 추가, 기동 때 가져오기, DB 상한 행 **읽기**(`op_` 포함). 정본은 YAML(`origin = 'catalog'`), `op_` 행은 DB | 0단계 이미지는 새 테이블을 읽지 않고 YAML을 읽는다. 가져온 행과 YAML은 id·지문·revision이 같으므로 release·세션·워크스페이스 판이 같은 프로필로 풀린다. 이 단계에서는 `op_` 행을 만들 API가 없으므로 0단계 이미지가 모르는 프로필도 없다 |
| 2. 전환 | PD-3(API), PD-4(콘솔) | DB가 정본. 상한 쓰기 API. `connections.yaml`이 있으면 읽고, `profiles.yaml`은 없어도 뜬다(빈 DB 시드만) | 1단계 이미지는 DB의 `op_` 행을 읽을 줄 알므로(1단계가 읽기를 이미 가졌다) 콘솔에서 만든 상한과 그 위의 워크스페이스 판·release가 계속 돈다. 가져온 행은 YAML과 같다(전환 전 `import --check` 충돌 0). 운영자는 전환 기간에 `profiles.yaml`을 지우지 않는다 |
| 3. 정리 | PD-5 | `profiles.yaml` 읽기를 시드로만 줄이고 `connections.yaml`을 필수로. `repositories.<id>.profiles`를 시드로만 | 2단계 이미지는 이미 `connections.yaml`만 있는 설치에서 뜬다. 행과 revision은 그대로다. `profiles.yaml`은 정리 이미지가 안정된 뒤에 지운다 |

알려진 한계: 0단계 이미지로 되돌리면 `op_` 상한과 그 위 판으로 만든 세션은 0단계 이미지가 모르는 id라 첫 claim에서 `catalog_mismatch`가 되고 입력은 남는다. 0174 배포 때와 같은 한계이고 같은 규칙으로 막는다: 모든 replica가 1단계 이상이 된 뒤에 2단계를 올린다(`api-server.md:96`). 2단계에서 0단계로 한 번에 내리지 않는다.

## 6. API

| 메서드·경로 | 누가 읽고 쓰나 | 내용 |
|---|---|---|
| `GET /v1/profiles` (있음) | 구성원, read scope key | 한 목록. `source`는 `operator`·`workspace` 그대로(값을 바꾸면 기존 SDK가 깨진다). `source: operator` 항목에 `installation` 객체를 더한다: `name`, `version`, `origin`, `state`, `connection_id`, `created_at`, `retired_at`. 이 필드는 optional로 더한다(`profiles.ts:61-96`의 방식) |
| `POST /v1/installation-profiles` (새) | 운영자, cookie 세션만 | 본문: `name`, `connection_id`, `runtime_version`, `model`, `models`, `title_model?`, `tools`, `permission_mode`, `project_settings`, `repository_mode`, `repository_ids`, `previous_id?`. 응답: `{ profile, receipt_id }`(`profiles.ts:135-141`과 같은 모양). 오류: `400` `unknown_connection`·`runtime_not_installed`·`unattended_not_allowed`·`unknown_repository`·스키마 위반(`details.field`), `403` `role`, `409 REVISION_CONFLICT`(같은 이름 동시 저장) |
| `POST /v1/installation-profiles/{profile_id}/retire` (새) | 운영자, cookie 세션만 | 은퇴. 이미 은퇴했으면 `receipt_id: null` |
| `GET /v1/connections` (새) | 운영자 | `id`, `kind`, `billing`만. endpoint·참조 이름은 보이지 않는다(`profiles.ts:56-59`와 같은 원칙) |
| `POST /v1/workspace-profiles`, `…/retire` (있음) | 그대로 owner·admin | `base_profile_id`는 사용 가능한 상한 id 아무것이나. 은퇴한 상한은 바탕으로 고를 수 없다(`400 base_retired`) |

- 상태 값: 상한은 `usable`·`retired`·`connection_missing`·`unattended_off`·`definition_drift`(읽은 지문이 저장한 지문과 다름). 워크스페이스 판에는 `base_retired`(바탕이 은퇴함: 새 release·세션은 받지 않고, 이미 만든 release는 돈다)를 더한다. `workspaceProfileStateSchema`(`profiles.ts:25-30`)에 값을 더하는 것이라 같은 PR에서 web·SDK 생성물을 함께 갱신한다.
- 새 경로는 `apps/control-host/src/api/openapi.ts`(지금 프로필 경로는 `3404`, `3438`, `3469`), `route-error-coverage.ts:86-87`, `packages/core`의 응답 표, `packages/client` 생성물에 같이 들어간다.

## 7. 콘솔

지금은 `/profiles`(`apps/web/src/router.tsx:324-328`)와 `/profiles/$profileId`(`router.tsx:330-334`)뿐이고, "프로필 만들기"는 같은 페이지의 인라인 편집기를 연다(`apps/web/src/routes/profiles.tsx:174`, `222-230`). 운영자 섹션 설명은 "설치 설정 파일을 고친 뒤 다시 배포하세요"다(`apps/web/src/i18n/profiles.ts:12-13`).

- **`/profiles` 목록:** 한 표. 열은 이름, 버전, 종류(설치 상한·워크스페이스), 바탕(워크스페이스 판만), 기본 모델, 권한 모드, 상태. 종류 필터(전체·설치 상한·워크스페이스). 재배포 안내 문구는 지운다. "프로필 만들기"(owner·admin)와 "설치 상한 만들기"(운영자만) 버튼은 둘 다 아래 생성 페이지로 간다.
- **`/profiles/new` 전용 생성 페이지:** 쿼리 `?kind=workspace|installation&from=<id>&mode=version|remake`. 인라인 편집기의 `mode`(`apps/web/src/routes/profile-editor.tsx:42`)를 이 쿼리가 대신한다.
  1. 종류: 워크스페이스 프로필 / 설치 상한(운영자에게만 보인다).
  2. 바탕(워크스페이스) 또는 연결(설치 상한). 워크스페이스는 `usable` 상한만, `auto`를 허용하는 것을 먼저 보인다(지금 `profiles.tsx:101-102`의 순서).
  3. 값: 기본 모델과 모델 목록, 도구, 권한 모드. 워크스페이스 판은 `WORKSPACE_PROFILE_POLICY.choices`가 고를 수 있는 것을 정한다. 설치 상한에서 env가 꺼져 있으면 `bypassPermissions`는 비활성과 이유 한 줄, 고르면 위험 안내(PR JeongJaeSoon/agent-platform#894의 문구를 다시 쓴다).
  4. 검토: 바탕 또는 앞 버전과 달라진 칸만 보여 준다. 저장하면 새 프로필의 상세 페이지로 간다.
- **`/profiles/$profileId` 상세:** 설정 전체, 상태와 그 이유, 같은 `name`의 버전 목록, (상한이면) 이 상한을 바탕으로 한 워크스페이스 판, 만든 사람·시각·은퇴한 사람·시각. 버튼: 새 버전(`/profiles/new?from=<id>&mode=version`), 다시 만들기(바탕이 바뀐 판), 은퇴(확인 대화 상자).
- i18n ko·en·ja를 같이 고친다. release 탭과 새 에이전트 흐름의 프로필 선택은 목록 API를 그대로 읽으므로 화면 구조는 바꾸지 않는다.

## 8. 단계별 PR 계획

| PR | 범위 | 검증 |
|---|---|---|
| PD-2 마이그레이션·이전(확장) | migration(다음 번호, 작성 시점 `0187`)으로 `installation_profiles` 추가. 기동 때 가져오기(advisory lock, insert-if-absent, receipt). DB 행 → `SessionCatalogConfig` 항목 → 기존 해석 경로. `op_` 행 읽기와 env·연결·지문 검사. `op_` YAML id 거부. `profiles import --check` / `--replace` CLI | 실제 postgres 통합 테스트: 같은 카탈로그로 가져오기를 두 번 돌려 행 수·내용·receipt 수가 같다. 저장소의 네 카탈로그 전부 YAML 지문 == DB 지문, main 지문 고정 테스트를 DB 경로로도. 0단계 이미지와 섞인 상태(같은 DB)에서 revision이 같다. `bun run typecheck`, `bun test` |
| PD-3 API 전환 | DB 정본으로 해석(프로필 레지스트리 하나가 상한과 워크스페이스 판을 같이 refresh. gateway가 기동 때 한 번 만드는 운영자 실행 쌍(`worker-gateway.ts:535`)도 refresh를 따른다). `connections.yaml` 읽기. 쓰기 API·`profile.installation.manage`. 상태 값 추가. OpenAPI·SDK·core 응답 표 | 서비스 테스트: owner만 상한 저장, admin·member `403`, API key `403`, env 꺼짐에서 bypass 저장 `400`. gateway 테스트: env를 끈 채 다시 뜬 프로세스에서 이미 저장된 bypass 행·그 위 판의 claim이 거절된다. **운영자 상한 E2E**(`tests/e2e`, fake model): owner가 상한 v2를 만들고 admin이 그 위에 판을 만들어 세션이 돈다. 상한 v1의 기존 release는 계속 돈다. 1단계 이미지로 되돌려 같은 세션이 계속 도는지 |
| PD-4 콘솔 | 목록·상세·`/profiles/new`·i18n·stories | web 테스트, 390px 포함 화면 확인과 스크린샷, ui-review |
| PD-5 YAML 읽기 정리 | `profiles.yaml`을 빈 DB 시드로만, `connections.yaml` 필수, `repositories.<id>.profiles` 시드로만. `profiles.yaml`에서 `connections.yaml`을 만드는 CLI. 운영 문서(`docs/operator/api-server.md:80-96`, `240-250`), `apps/docs` | `profiles.yaml` 없이 기동, 같은 파일로 PD-4 이미지 기동(정리 → 전환 롤백). 로컬 스택 `scripts/local.sh up --fake-model`이 시드로 뜬다 |

각 PR의 첫 커밋 전에 이 문서의 해당 절을 다시 읽고, 계약과 다르게 가야 하면 이 문서를 먼저 고친다.

## 확장 지점: 팀 프로필

만들지 않는다(이전 오너 결정 a안). 나중에 만든다면 `workspace_profiles`에 `team_id`를 더하거나 같은 모양의 `team_profiles`를 두고, 바탕을 워크스페이스 판으로 삼아 같은 `ProfileDerivationPolicy`로 한 층 더 좁힌다(`profile-derivation.ts:31-53`은 바탕과 판의 쌍만 안다). 이 문서의 테이블·API는 그 층을 위한 열이나 값을 미리 두지 않는다.

## 대안

- **한 테이블에 두 종류.** [위](#한-테이블로-합치지-않은-이유)의 이유로 고르지 않았다.
- **상한은 설치 설정에 두고(`limits`) 프로필만 DB로.** 상한을 바꿀 때마다 재배포가 남는다. 오너가 없애려는 재배포가 바로 이것이라 고르지 않았다.
- **연결·자격 참조까지 전부 DB로.** 콘솔 쓰기 하나로 임의 endpoint와 API가 가진 다른 자격 증명 참조를 묶을 수 있다(`catalog.ts:814-823`가 그 값을 upstream 헤더에 싣는다). 고르지 않았다.
- **상한을 제자리에서 고치기.** 고칠 때마다 그 위의 판과 release가 멈춘다(`catalog.ts:685-694`). 오너 결정 2의 B안이다.

## 오너 결정 (모두 오너 확인 대기, 기본값 적용)

1. 운영자 판별: **A 워크스페이스 owner(기본)** / B env로 지정 / C 별도 테이블.
2. 상한을 바꾸는 방식: **A 불변 버전 + 은퇴(기본)** / B 제자리 변경.
3. 저장소 신뢰 쌍: **A 상한 행의 `repository_ids`로 DB에, 운영자만 고침(기본)** / B `repositories.yaml`에 남김(새 상한 계열마다 재배포).
4. 정리 단계 뒤 `profiles.yaml`: **A 빈 DB 초기 시드(기본)** / B 읽지 않음.

# test-ops 운영 runbook

test-ops는 내부 알파 인원이 함께 쓰는 상시 설치다. Linux 호스트 한 대에서 compose로 돈다. checkpoint object는 기본으로 같은 호스트의 LocalStack에 두고, 설정 하나로 AWS S3(도쿄)로 바꾼다(아래 "object store"). 배포·업그레이드·키 발급·백업·복원 훈련·재시작 복구는 모두 `scripts/test-ops.sh` 하나로 한다. 이 문서는 운영자용 절차다. 각 구성 요소가 어떻게 동작하는지는 [operations.md](operations.md), 백업 번들의 형식과 검사는 [backup-restore.md](backup-restore.md)를 본다.

지키는 규칙은 다음과 같다.

- **공개하지 않는다.** compose는 포트를 모두 `127.0.0.1`에만 연다. 사람은 SSH 터널이나 VPN으로 들어온다. 외부 사용자에게는 열지 않는다(알파는 내부 인원 한정, [94S-376](https://linear.app/94soon/issue/94S-376)).
- **설정은 저장소 밖 env 파일 하나에 둔다.** 스크립트는 그 파일을 `docker compose --env-file`로만 넘기고 셸에서 `source`하지 않는다. compose를 부를 때 호출 셸의 환경도 넘기지 않는다. 셸에 남은 `AWS_*` 같은 값이 env 파일보다 우선하는 일을 막기 위해서다.
- **release는 digest로 고정한다.** 이미지는 가변 tag로 부르지 않는다.

## object store

2026-09-25 사용자 결정으로 AWS 계정은 아직 쓰지 않는다. 그래서 기본값은 LocalStack이다. 배포할 때 `TEST_OPS_OBJECT_STORE`로 고른다.

| 값 | 저장소 | compose layer |
|---|---|---|
| `localstack`(기본) | 같은 호스트의 LocalStack. 로컬 스택과 같은 이미지·초기화 스크립트이고, bucket은 `claude-sessions`다 | `infra/compose.test-ops.localstack.yml` |
| `s3` | AWS S3 bucket. 아래 "AWS 준비"를 따른다 | `infra/compose.test-ops.s3.yml` |

`deploy`가 고른 값을 상태 디렉터리의 `installation` 파일에 적고, 그 뒤 명령은 이 값을 쓴다. 배포된 설치의 저장소를 바꾸는 것은 `reset` 뒤 새 `deploy`다. 세션은 옮겨지지 않는다. 실 AWS 계정으로 `s3` 경로를 검증하는 일은 외부 공개 전 게이트인 [94S-303](https://linear.app/94soon/issue/94S-303)에서 한다.

### LocalStack의 한계

- **LocalStack은 S3를 메모리에만 둔다.** LocalStack 컨테이너나 Docker, 호스트가 재시작되면 checkpoint object가 모두 사라진다. DB와 Gitea는 volume에 있으므로 남는다.
- 그러면 DB에는 미수거 checkpoint가 있는데 bucket에는 object version이 하나도 없는 상태가 된다. 이때 API가 기동을 거부한다([94S-422](https://linear.app/94soon/issue/94S-422) 가드, 로그 `Checkpoint bucket claude-sessions holds no object version, …`). 로그의 `scripts/local.sh reset` 안내는 로컬 스택용이고, test-ops에서는 아래 "재시작"의 `reseed`나 `reset`으로 푼다.
- 복구할 수 있는 것은 마지막 백업까지다. 백업 뒤에 생긴 checkpoint가 있으면 `reseed`가 거부하므로 `reset`밖에 없다. 초기화하면 세션·checkpoint·API key·Gitea 저장소가 모두 지워진다.
- 그래서 **장기 보관이 필요한 세션을 두지 않는다.** 사용자에게도 언제든 초기화될 수 있는 환경이라고 알린다.

## 호스트 요구 사항

| 항목 | 요구 | 확인 |
|---|---|---|
| OS | Linux(x86_64 또는 arm64) | |
| Docker Engine | 28 이상. worker 네트워크가 `gateway_mode_ipv4=isolated`를 쓴다 | `preflight`가 거부한다 |
| docker compose | v2.24.6 이상. 복원 훈련의 overlay가 include 위에 얹힌다 | `preflight`가 거부한다 |
| 디스크 | Docker 데이터 루트가 xfs이고 `prjquota`로 마운트돼 있어야 한다. worker workspace volume에 용량·inode 상한을 건다 | scheduler가 기동할 때 quota probe를 돌린다. 실패하면 scheduler가 unhealthy가 되고 `deploy`·`upgrade`가 멈춘다 |
| 도구 | git, jq, curl, 그리고 checkout에서 `bun install --frozen-lockfile`을 마친 bun 1.3.10 | S3 검사와 백업은 호스트에서 checkout의 S3 어댑터로 한다 |
| checkout | 배포할 release의 `source_commit`에 있고 로컬 변경이 없는 이 저장소 | `preflight`가 거부한다 |

compose 파일(`infra/compose.core.yml` + `infra/compose.test-ops.yml` + object store layer)과 postgres 초기 SQL, LocalStack 초기화 스크립트를 checkout에서 읽으므로, 업그레이드 사이에는 checkout을 배포한 commit에 그대로 둔다.

## AWS 준비(`s3`에서만)

`TEST_OPS_OBJECT_STORE=s3`로 배포할 때만 필요하다.

### bucket

도쿄 리전(`ap-northeast-1`)에 bucket을 하나 만든다. 설정은 셋이다: versioning, Object Lock(기본 retention 없음), 기본 암호화 SSE-S3(`AES256`). checkpoint는 legal hold로만 보호한다. 기본 retention을 걸면 checkpoint GC와 preflight의 삭제가 실패한다.

```bash
bucket=agent-platform-test-ops   # 전역에서 유일한 이름
aws s3api create-bucket --bucket "$bucket" --region ap-northeast-1 \
  --create-bucket-configuration LocationConstraint=ap-northeast-1 \
  --object-lock-enabled-for-bucket
aws s3api put-bucket-encryption --bucket "$bucket" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Object Lock을 켜면 versioning도 함께 켜진다.

### API용 IAM 사용자

자격 증명은 API 컨테이너에만 간다. worker는 egress proxy의 object store route를 지나며, 그 요청은 API가 세션 prefix 범위로 서명한다([94S-251](https://linear.app/94soon/issue/94S-251)). 복원 훈련도 같은 자격 증명으로 훈련용 bucket에 쓰므로 `<bucket>-drill-*`까지 허용한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetEncryptionConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::agent-platform-test-ops",
        "arn:aws:s3:::agent-platform-test-ops-drill-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectLegalHold",
        "s3:PutObjectLegalHold",
        "s3:DeleteObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::agent-platform-test-ops/*",
        "arn:aws:s3:::agent-platform-test-ops-drill-*/*"
      ]
    }
  ]
}
```

`If-None-Match` 조건부 쓰기에는 별도 action이 없다. checkpoint GC는 version id로 지우므로 `s3:DeleteObject`는 필요 없다. bucket 생성 권한은 주지 않는다. 훈련용 bucket은 운영자가 자기 AWS 권한으로 만든다.

## env 파일

`infra/test-ops.env.example`을 저장소 밖에 복사해 채운다. 파일은 운영자만 읽을 수 있어야 한다. group이나 other에 읽기·쓰기 권한이 있으면 스크립트가 거부한다.

```bash
sudo mkdir -p /etc/agent-platform
sudo install -m 600 -o "$USER" infra/test-ops.env.example /etc/agent-platform/test-ops.env
```

| 변수 | 값 |
|---|---|
| `EXECUTION_INSTALLATION_ID` | `test-ops`. scheduler가 띄운 worker 컨테이너와 egress proxy의 label이다. `local`(로컬 스택)이거나 이 daemon의 컨테이너가 이미 같은 값을 달고 있으면 `deploy`가 거부하고, 배포한 뒤에는 바꿀 수 없다 |
| `POSTGRES_PASSWORD` | 무작위 값. `DATABASE_URL`에 escape 없이 들어가므로 영문·숫자·`.` `_` `~` `-`만 쓴다. `preflight`가 다른 문자를 거부한다 |
| `EGRESS_AUTHORIZER_TOKEN` | 32자 이상 무작위 값. API와 egress proxy가 같은 값을 쓴다 |
| `ANTHROPIC_API_KEY` | 운영자 공유 provider key. API에만 간다(아래 "provider key") |
| `PLATFORM_CATALOG_DIR` | 카탈로그 디렉터리. 기본 예시는 `/etc/agent-platform/catalog`. checkout 안이면 거부한다 |
| `EGRESS_CREDENTIAL_ALLOWLIST` | `localstack`: `api.anthropic.com:443`. `s3`: `api.anthropic.com:443,<bucket>.s3.ap-northeast-1.amazonaws.com:443`. bucket 호스트가 없으면 worker가 checkpoint를 쓰지 못하므로 `preflight`가 거부한다. 이름에 `.`이 든 bucket은 `s3.ap-northeast-1.amazonaws.com:443`이다 |
| `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST` | `localstack`: `gitea:3000,localstack:4566`. `localstack:4566`이 없으면 worker가 checkpoint를 쓰지 못하므로 거부한다. `s3`: `gitea:3000`. 어느 쪽이든 다른 로컬 전용 서비스(`fake-messages`, `secrets`, `s3`에서는 `localstack`도)를 적으면 거부한다 |
| `EXECUTION_WORKSPACE_QUOTA` | `on`. 다른 값이면 거부한다 |

`s3`에서만 다음을 더 채운다. `localstack`에서는 비워 둔다. API는 LocalStack의 `claude-sessions` bucket에 LocalStack용 고정 key로 붙고, `S3_BUCKET`을 다른 값으로 두면 `preflight`가 거부한다.

| 변수 | 값 |
|---|---|
| `AWS_REGION` | `ap-northeast-1` |
| `S3_BUCKET` | 위 bucket 이름 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | 위 IAM 사용자의 key. API에만 간다 |

`compose.test-ops.yml`과 `compose.test-ops.s3.yml`은 위 값을 `${X:?}`로 요구하기만 한다. 하나라도 비면 compose가 렌더를 거부하고 core의 로컬 기본값으로 뜨는 일이 없다. 설치 상한(`EXECUTION_SLOT_LIMIT`, `SESSION_COST_LIMIT_USD` 등)은 넣지 않으면 core 기본값을 쓴다.

스크립트 자체의 설정은 셸 변수 넷이다. 기본값을 쓰면 아무것도 설정하지 않아도 된다.

| 변수 | 기본값 |
|---|---|
| `TEST_OPS_ENV_FILE` | `/etc/agent-platform/test-ops.env` |
| `TEST_OPS_STATE_DIR` | `/var/lib/agent-platform/test-ops`. 배포한 manifest(`current.json`), 이력(`history.log`), 업그레이드 승인, 백업, 복원 훈련 기록 |
| `TEST_OPS_PROJECT` | `agent-platform-test-ops`. 로컬 스택의 `agent-platform`이면 거부한다 |
| `TEST_OPS_OBJECT_STORE` | `localstack`. `deploy` 때만 읽는다. 그 뒤에 다른 값을 주면 거부한다 |

`deploy`는 project 이름, `EXECUTION_INSTALLATION_ID`, object store를 상태 디렉터리의 `installation` 파일에 적는다. 그 뒤의 명령은 하나라도 다르면 거부한다. `preflight`는 bucket을 건드리기 전에 이것부터 확인한다. 백업과 업그레이드가 멈추는 worker를 이 label로 찾기 때문이다. `deploy`·`upgrade`·`backup`·`restore-drill`·`reseed`·`reset`은 상태 디렉터리의 `lock`을 잡고 한 번에 하나만 돈다. 강제 종료된 실행이 lock을 남기면 그 pid가 없는 것을 확인하고 디렉터리를 지운다.

## 카탈로그

`PLATFORM_CATALOG_DIR`에 `profiles.yaml`과 `repositories.yaml`을 둔다. API 컨테이너(uid 1000)가 읽을 수 있게 파일은 `0644`로 둔다. 카탈로그에는 값이 아니라 참조만 적으므로 비밀이 없다. 형식은 `config/profiles.yaml`과 `config/repositories.yaml`의 주석을 따른다. test-ops에서는 provider를 실제 Messages API로, key를 `value_env: ANTHROPIC_API_KEY`로 적는다.

```yaml
# profiles.yaml
profiles:
  claude-coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read, Edit, Write, Glob, Grep, Bash]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.com
      auth:
        kind: api_key
        value_env: ANTHROPIC_API_KEY
    project_settings:
      claude_md: true
```

```yaml
# repositories.yaml
repositories:
  sample-app:
    url: http://gitea:3000/agent/sample-app.git
    branch: main
    profiles: [claude-coding]
```

카탈로그 revision은 디렉터리 안 모든 파일의 경로와 sha256을 묶은 값이다. release manifest에 적을 값은 다음으로 구한다.

```bash
bun run scripts/lib/test-ops.ts catalog-revision /etc/agent-platform/catalog
```

profile 설정을 제자리에서 바꾸면 그 profile로 만든 세션이 모두 `CATALOG_MISMATCH`로 멈춘다. 설정을 바꿀 때는 새 profile id를 만든다.

## release manifest

manifest는 JSON 파일 하나다. 예시는 `infra/test-ops.release.example.json`이다.

| 필드 | 값 |
|---|---|
| `source_commit` | compose 파일을 읽을 commit, 40자 hex |
| `images.control_host`, `images.worker`, `images.egress_proxy` | `<이름>@sha256:<64자 hex>`. tag만 적은 이미지, 짧은 digest는 거부한다 |
| `catalog_revision` | 위 `catalog-revision`의 출력 |

이미지 digest는 `v*` tag push로 돈 Images workflow(`.github/workflows/images.yml`)가 ghcr.io에 올린 값이다. run의 `staged-digest-*` artifact나 `docker buildx imagetools inspect ghcr.io/jeongjaesoon/agent-platform-worker:<tag>`로 읽는다. registry가 비공개면 호스트에서 `docker login ghcr.io`를 먼저 한다.

## 배포

빈 호스트에서 한 번 한다.

```bash
git clone https://github.com/JeongJaeSoon/agent-platform.git && cd agent-platform
git checkout <source_commit>
bun install --frozen-lockfile
# env 파일, 카탈로그, manifest를 준비한 뒤
scripts/test-ops.sh preflight release.json   # 먼저 따로 돌려 봐도 된다
scripts/test-ops.sh deploy release.json      # LocalStack
# AWS S3로 배포할 때:
# TEST_OPS_OBJECT_STORE=s3 scripts/test-ops.sh deploy release.json
```

`deploy`는 이미 배포된 release(`current.json`)가 있거나 같은 project의 컨테이너·volume·network가 남아 있으면 거부한다. 먼저 `preflight`를 돈다. preflight가 보는 것은 다음과 같다.

1. env 파일 권한, manifest 형식, checkout의 commit과 로컬 변경
2. Docker Engine 28 이상, compose v2.24.6 이상
3. 렌더된 compose: 로컬 전용 서비스가 없고(`localstack`에서는 LocalStack 하나만 허용), 무엇도 build하지 않고, 모든 이미지가 digest이고, 포트가 loopback이고, API가 `api-key` 인증과 `locked` object store로 뜨고, postgres 값이 URL-safe이고, API가 고른 저장소를 가리키고(`localstack`: `http://localstack:4566`과 `claude-sessions`, `s3`: endpoint 없음), credential allowlist에 그 저장소가 있고 다른 로컬 서비스가 없고, workspace quota가 켜져 있고, 카탈로그가 checkout 밖에서 manifest의 revision으로 mount되는지
4. `s3`에서만. bucket: API가 기동할 때 하는 검사(versioning, Object Lock, `AES256`)
5. `s3`에서만. API 자격 증명의 임시 객체 왕복: `test-ops-preflight/` 아래 scratch key에 create-only put(If-None-Match) → legal hold → hold 확인과 version 읽기 → hold 해제 → version 삭제. 실패하면 그 단계의 S3 action 이름을 출력한다. API의 기동 검사는 bucket 설정만 읽으므로 쓰기·hold·GC 권한은 이 단계가 증명한다

`localstack`에서는 4·5를 건너뛴다. LocalStack은 설치와 함께 뜨고, API가 기동할 때 bucket의 versioning·Object Lock·`AES256`을 검사하며 `deploy`는 그 healthcheck를 기다린다.

그다음 `up -d --wait`로 api·scheduler·reconciler와 그 의존 서비스를 띄우고 healthcheck를 기다린다. scheduler의 첫 pass가 network isolation과 workspace quota probe를 돈다. 실패하면 scheduler·api 로그 끝부분을 출력하고 멈춘다.

Gitea에는 저장소가 없다. 관리 계정과 저장소는 터널로 Gitea(3001)에 붙거나 컨테이너 안 CLI로 만든다.

```bash
docker exec -u git agent-platform-test-ops-gitea-1 gitea admin user create \
  --username agent --email agent@agent-platform.invalid --random-password --admin
```

## 접근

API(3000)와 Gitea 웹(3001)은 호스트 loopback에만 열려 있다. 사용자는 SSH 터널로 들어온다.

```bash
ssh -N -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 <user>@<test-ops-host>
curl -fsS http://127.0.0.1:3000/readyz
```

postgres(5432)도 loopback에만 열려 있다. 운영자만 호스트에서 쓴다.

## API key 발급과 폐기

```bash
scripts/test-ops.sh key create <owner_id> --scopes sessions:read,sessions:write
# stdout: 평문 key(한 번만 나온다), stderr: key_id
scripts/test-ops.sh key revoke <key_id>
```

평문 key는 사용자에게 직접 전하고 저장하지 않는다. 퇴사나 분실 때는 `revoke`한다. 세션 실행 권한 회수(`grants.ts`)와 카탈로그 권한(`catalog-authority.ts`)은 API 컨테이너 안에서 부른다. 인자는 각 파일의 usage를 따른다.

```bash
docker exec agent-platform-test-ops-api-1 bun run apps/control-host/src/api/grants.ts revoke <session_id> --reason <text>
```

## provider key

test-ops는 운영자의 Anthropic key 하나를 모든 세션이 같이 쓴다. [94S-376](https://linear.app/94soon/issue/94S-376) 결정상 내부 알파에서만 허용된다. 외부 사용자에게 test-ops를 열려면 BYOK가 먼저 있어야 한다.

- key는 env 파일의 `ANTHROPIC_API_KEY`에만 둔다. compose는 이 값을 API 컨테이너에만 넘기고, 카탈로그는 `value_env`로 이름만 가리킨다. worker는 key를 받지 않는다. egress proxy의 provider route가 요청마다 API에 물어 key를 붙인다.
- 비용은 세션별 `SESSION_COST_LIMIT_USD`(기본 25)로 막는다. Anthropic 콘솔에도 월 한도를 건다.
- 교체: 콘솔에서 새 key를 만든다 → env 파일 값을 바꾼다 → `scripts/test-ops.sh upgrade /var/lib/agent-platform/test-ops/current.json`으로 같은 release를 다시 적용한다(바뀐 설정만 컨테이너를 새로 만든다) → `/readyz`와 세션 한 턴을 확인한다 → 옛 key를 폐기한다. 참조 이름이 같으므로 profile fingerprint는 바뀌지 않고 진행 중인 세션도 그대로 이어진다.

env 파일의 다른 값을 바꿀 때도 같은 명령을 쓴다.

## 업그레이드

```bash
git fetch && git checkout <new source_commit> && bun install --frozen-lockfile
scripts/test-ops.sh upgrade release-new.json
```

`upgrade`는 새 manifest로 preflight를 돈 뒤 다음 규칙을 따른다.

- **worker 이미지가 바뀌고 `collected_at IS NULL`인 checkpoint가 하나라도 있으면 거부한다.** 복원은 SDK·CLI 버전이 정확히 같아야 하므로, 그 세션들은 다음 복원에서 `INCOMPATIBLE_CHECKPOINT`를 거쳐 `RESTORE_FAILED`가 된다([94S-387](https://linear.app/94soon/issue/94S-387)). 거부할 때 영향받는 세션 id를 모두 출력하고 `$TEST_OPS_STATE_DIR/upgrade-<시각>.sessions`에 적는다. 종료 코드는 3이다.
- 목록을 검토하고 사용자에게 알린 뒤, 정확히 그 id들을 담은 파일로 다시 부른다.

  ```bash
  scripts/test-ops.sh upgrade release-new.json --approve-sessions approved.txt
  ```

  승인 목록이 영향 목록과 하나라도 다르면 거부한다. worker 이미지가 바뀌면 writer를 멈추고(아래 "백업"과 같은 순서) 목록을 한 번 더 뽑는다. 그 사이 새 checkpoint가 생겨 목록이 바뀌었으면 원래 release를 다시 열고 거부한다. 진행하면 `approvals/<시각>-upgrade.json`에 시각·운영자·전후 worker 이미지·세션 목록을 남긴다.
- 영향받는 세션이 없으면 승인 없이 진행한다. worker 이미지가 같으면 writer도 멈추지 않고, 설정이나 이미지가 바뀐 컨테이너만 새로 만든다.
- 카탈로그 revision이 바뀌면 API를 다시 만든다. API는 카탈로그를 기동할 때 한 번만 읽는다.
- 끝나면 `current.json`을 새 manifest로 바꾸고 `history.log`에 한 줄 남긴다.
- 게이트를 통과한 순간(writer를 멈추기 전) 새 manifest를 `pending.json`에 적는다. 새 release가 뜨기 전에 실패하면(예: scheduler quota probe 실패) 설치가 멈춘 채로 남을 수 있고, 그때 `pending.json`이 남아 원인을 고친 뒤 같은 manifest로 `upgrade`를 다시 부를 때까지 `status` 말고 다른 명령은 모두 거부한다.

되돌리기는 이전 manifest로 `upgrade`하는 것이다. worker 이미지가 다시 바뀌므로 같은 규칙이 적용된다. 업그레이드 전에는 백업을 한 번 찍는다.

## 백업

```bash
scripts/test-ops.sh backup
```

1. 신규 접수를 멈춘다: api, scheduler, reconciler를 멈추고, scheduler가 띄운 worker 컨테이너(`agent-platform.installation=<id>` label)도 멈춘다. 진행 중이던 턴은 끊기고, 다시 열린 뒤 reconciler가 lease 만료로 회수한다.
2. `scripts/backup.sh`로 DB·checkpoint object·Gitea를 `$TEST_OPS_STATE_DIR/backups/backup-<시각>`에 묶는다. object는 `localstack`이면 설치의 LocalStack에서(`--object-store localstack`), `s3`면 API의 자격 증명으로 bucket에서(`--object-store env`) 읽는다. backup.sh가 writer가 남았는지 스스로 다시 보고, 남았으면 거부한다. 실패한 백업은 `.failed`로 남고 성공본 이름을 얻지 못한다.
3. 성공하든 실패하든 멈춘 서비스를 그대로(재생성 없이) 다시 연다. 다시 열지 못하면 백업이 성공했어도 명령은 실패로 끝난다. `status`로 확인하고 원인을 고친 뒤, `current.json`의 사본으로 `upgrade`를 부르면 같은 release로 다시 뜬다. `--stop`을 붙이면 다시 열지 않는다(아래 "재시작").

주기: 매일 한 번, 사용이 적은 시간에. 그리고 업그레이드 직전. `localstack`에서는 백업이 재시작 뒤 되살릴 수 있는 유일한 사본이므로 주기를 지킨다. 백업 디렉터리에는 Gitea 설정의 비밀과 DB 전체가 들어 있다. `0700`으로 두고, 호스트 밖 보관소에 암호화해 복사한다. checkpoint GC는 백업과 겹치면 안 된다. 백업 중에는 API가 멈춰 있으므로 GC를 부를 수 없다.

## 재시작

### 계획 재시작(`localstack`)

호스트 재부팅, Docker 업그레이드처럼 미리 아는 재시작은 다음 순서로 한다. LocalStack의 object를 백업에서 되살린다.

```bash
scripts/test-ops.sh backup --stop          # 백업하고 writer를 멈춘 채로 둔다
sudo reboot                                # 또는 Docker 재시작
scripts/test-ops.sh reseed /var/lib/agent-platform/test-ops/backups/backup-<시각>
```

`reseed`가 하는 일:

1. manifest의 project·bucket이 이 설치와 같고, 체크섬과 schema가 맞는지 본다.
2. writer를 멈춘 채 postgres와 LocalStack을 띄운다. LocalStack의 bucket이 비어 있어야 한다. 비어 있지 않으면 재시작이 없었다는 뜻이므로 거부한다.
3. `scripts/restore.sh`가 새 bucket을 채우는 방식 그대로 object를 올린다: create-only 업로드 뒤, 모든 미수거 checkpoint를 새 version으로 re-pin하고 legal hold를 건다. re-pin은 쓰기 전에 DB의 모든 미수거 checkpoint를 올린 바이트와 대조한다. 백업 뒤에 DB가 바뀌었으면 여기서 거부한다.
4. object 수가 백업과 같으면 설치를 다시 띄우고 `history.log`에 남긴다.

실패하면 writer를 멈춘 채로 둔다. 그때는 아래 `reset`밖에 없다. 재시작을 취소했다면 `reseed` 대신 `current.json`의 사본으로 `upgrade`를 불러 다시 연다.

### 예상하지 못한 재시작(`localstack`)

재시작 뒤에는 API가 뜨지 않는다(위 "LocalStack의 한계"). 마지막 백업 뒤에 새 checkpoint가 없었다면 그 백업으로 `reseed`가 통한다. 거부되면 초기화한다.

### 초기화

```bash
scripts/test-ops.sh reset --yes
scripts/test-ops.sh deploy /var/lib/agent-platform/test-ops/reset-<시각>.json
```

`reset`은 이 설치의 컨테이너와 volume(DB, Gitea, LocalStack), scheduler가 만든 worker 컨테이너·네트워크·workspace volume을 모두 지운다. 배포했던 manifest는 `reset-<시각>.json`으로 남긴다. API key도 DB와 함께 지워지므로 다시 발급하고, Gitea 관리 계정과 저장소도 다시 만든다. 저장소를 바꾸려면 두 번째 줄에서 `TEST_OPS_OBJECT_STORE`를 준다.

### `s3`

AWS S3의 object는 재시작에 사라지지 않는다. 재시작 뒤에는 `current.json`의 사본으로 `upgrade`를 불러 멈춘 서비스를 다시 띄운다.

## 복원 훈련

`localstack`에서는 백업을 새 project와 그 project의 LocalStack에 복원한다. bucket은 만들지 않는다.

```bash
scripts/test-ops.sh restore-drill /var/lib/agent-platform/test-ops/backups/backup-<시각>
```

`s3`에서는 훈련을 새 project와 **새로 만든 빈 bucket**에만 복원한다. 복원 대상 bucket이 백업의 원본 bucket 이름이거나 object version·delete marker가 하나라도 있으면 `scripts/restore.sh`가 거부한다(종료 코드 4). 훈련마다 bucket을 새로 만든다. 설정은 운영 bucket과 같다.

```bash
drill=agent-platform-test-ops-drill-$(date -u +%Y%m%d)
aws s3api create-bucket --bucket "$drill" --region ap-northeast-1 \
  --create-bucket-configuration LocationConstraint=ap-northeast-1 --object-lock-enabled-for-bucket
aws s3api put-bucket-encryption --bucket "$drill" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

scripts/test-ops.sh restore-drill /var/lib/agent-platform/test-ops/backups/backup-<시각> --bucket "$drill"
```

`restore-drill`은 `<project>-drill-<시각>-<무작위>` project에 postgres·LocalStack·Gitea를 25432–25435 포트(`--port-base`로 바꾼다. `s3`에서는 LocalStack 없이)로 띄워 복원하고, `scripts/verify-restore.sh`로 모든 checkpoint pointer를 version 단위로 대조한다. 출력은 `restore-drills/<project>.log`에 남고, 판정(passed/FAILED)은 `history.log`에 한 줄 남는다. 끝나면 훈련 project를 지운다. 들여다보려면 `--keep`을 붙인다. migrate는 배포한 control-host 이미지로 돈다.

주기: 한 달에 한 번, 그리고 업그레이드 뒤 첫 백업마다. `s3`에서 훈련 bucket의 object에는 legal hold가 걸려 있다. bucket을 지우려면 version마다 hold를 풀고(`aws s3api put-object-legal-hold --legal-hold Status=OFF --version-id …`) version을 지운 뒤 bucket을 지운다.

## 감시 지점

```bash
scripts/test-ops.sh status
```

컨테이너 상태, 배포된 manifest, object store, `/readyz`, scheduler·reconciler `--health`, 미수거 checkpoint가 있는 세션 수, Docker 데이터 루트의 디스크 사용량을 한 번에 보여 준다. 따로 볼 때는 다음을 본다.

| 지점 | 보는 법 | 정상 |
|---|---|---|
| API | `curl -fsS http://127.0.0.1:3000/readyz` | `"status":"ready"` |
| scheduler | `docker exec agent-platform-test-ops-scheduler-1 cat /tmp/scheduler-status.json`, 또는 컨테이너 health | 최근 성공 pass, healthy |
| reconciler | `docker exec agent-platform-test-ops-reconciler-1 cat /tmp/reconciler-status.json` | 같음 |
| 디스크 | `df -h "$(docker info -f '{{.DockerRootDir}}')"`, `xfs_quota -x -c 'report -p'` | 여유 20% 이상 |
| checkpoint GC | `docker exec -e CHECKPOINT_GC_DRY_RUN=1 agent-platform-test-ops-api-1 bun run apps/control-host/src/api/checkpoint-gc.ts`로 먼저 확인하고 `-e` 없이 실행한다. 주 1회. 백업과 겹치지 않게 | exit 0 |
| LocalStack(`localstack`) | `docker inspect -f '{{.State.StartedAt}}' agent-platform-test-ops-localstack-1` | 마지막 백업보다 먼저 시작했다. 백업 뒤에 재시작했다면 object가 없다 |
| S3(`s3`) | AWS 콘솔의 bucket 크기와 요청 오류 | |

찾아볼 로그 이벤트(`docker compose logs`나 `docker logs <컨테이너>`):

- api: `Refusing to start: …`(설정·상한 오류), `Checkpoint bucket … holds no object version`(LocalStack이 재시작돼 object를 잃었다. 위 "재시작"), `Unhandled API request error`, `Egress authorization failed`
- scheduler: `Workspace quota preflight failed; …`, `Network isolation preflight failed; …`, `Database connection lost; …`, `Worker workspaces have no disk or inode quota`(quota가 꺼진 채 떴다는 뜻이다)
- checkpoint GC: `Checkpoint GC failed for a session`

OpenTelemetry 지표는 알파 뒤다. 알파의 관측은 위 상태 파일, DB 쿼리, 구조화 로그다.

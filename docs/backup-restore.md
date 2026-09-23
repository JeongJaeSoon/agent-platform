# 백업과 복원 (compose 설치)

`scripts/backup.sh`가 한 compose 설치(PostgreSQL·LocalStack S3·Gitea)를 디렉터리 하나로 묶고, `scripts/restore.sh`가 그것을 **새 compose project**에 풀며, `scripts/verify-restore.sh`가 복원된 checkpoint pointer가 가리키는 object의 sha256을 대조한다. 원본 설치의 volume·환경 파일은 어느 스크립트도 쓰지 않는다(README 규칙).

호스트에 필요한 것: docker + compose v2.24 이상(`!override` 병합), git, jq, `sha256sum` 또는 `shasum`, 그리고 `bun install`을 마친 이 저장소 checkout(restore의 `migrate` 서비스가 checkout을 마운트하고, verify가 `bun run scripts/lib/decode-manifest.ts`로 production codec을 부른다). pg_dump·psql·awslocal은 컨테이너 안에서 실행한다.

## 백업

```bash
scripts/backup.sh                       # project agent-platform → backups/backup-<ts>/
scripts/backup.sh --project ap125 --out /somewhere --bucket claude-sessions
```

```
backup-20260923T101500Z/
├── db.sql          pg_dump --no-owner --no-privileges (schema·data·drizzle journal)
├── objects/        bucket의 모든 object, key가 곧 경로
├── repos/<owner>/<repo>.bundle   Gitea bare repo마다 git bundle create --all (wiki 포함)
├── gitea/gitea.db  sqlite 온라인 백업(.backup), gitea/app.ini
├── manifest.json   아래 참조
└── SHA256SUMS      위 파일 전부
```

`manifest.json`:

| 필드 | 내용 |
|---|---|
| `version` | 백업 형식 버전(현재 1). restore는 같은 값만 받는다 |
| `source` | compose project 이름, 백업을 만든 checkout commit과 dirty 여부 |
| `schema.applied[]` | DB의 `drizzle.__drizzle_migrations` 행(`hash`, `when`) 순서대로. `head_tag`는 마지막 행에 해당하는 journal tag |
| `images.<service>` | 실행 중인 컨테이너의 image·image id·registry digest. api/worker/scheduler 컨테이너가 없으면 `status: "not_built"`로 남긴다(94S-125 이미지 뒤 채워짐). 나중에 만든 이미지를 이 값에 소급 기록하지 않는다 |
| `objects` | bucket 이름과 object 수 |
| `repos` | bundle로 담은 repo와 빈 repo(ref가 없어 bundle 불가) 각각의 이름·symbolic HEAD. 복원 시 HEAD를 그대로 되돌리고 임시 origin은 제거한다 |

주의:

- `pg_dump`는 자체로 일관되지만 object·repo는 그 뒤에 복사한다. 백업 중 checkpoint가 커밋되면 pointer만 있고 object가 없는 행이 생길 수 있으니 api·scheduler·worker를 멈추고 받는다. 스크립트는 실행 중이면 경고만 한다.
- `gitea/app.ini`에는 Gitea의 SECRET_KEY·INTERNAL_TOKEN이, `db.sql`에는 api key 해시가 들어 있다. 디렉터리는 `umask 077`로 만들어지며 보관 위치는 백업 소유자가 책임진다.
- Gitea는 백업 중 계속 떠 있다. sqlite 스냅샷과 repo 디렉터리 목록을 비교해 그 사이 repo가 생기거나 이름이 바뀌었으면 백업을 실패시킨다.
- LFS·attachments·avatars·indexer는 담지 않는다. 지금 설치는 저장소 데이터만 쓰며 필요해지면 `gitea dump`로 바꾼다.

## 복원

```bash
scripts/restore.sh backups/backup-20260923T101500Z --into ap-restore-1 --port-base 25432
scripts/restore.sh <dir> --into <project> --check-only   # 검사만, 아무것도 띄우지 않음
```

순서와 거부 조건:

1. `SHA256SUMS` 검증. 불일치면 exit 1.
2. **schema 검사** — manifest의 `schema.applied`가 이 checkout `packages/db/migrations`의 journal(각 SQL 파일 sha256, journal 순서)과 정확히 같아야 한다. 오래된 백업도, 이 checkout이 모르는 migration이 든 백업도 exit 3으로 거부한다. 오래된 백업을 올리려면 그 백업과 같은 commit을 checkout해 복원·검증한 뒤 migration을 별도 단계로 돌린다.
3. 대상 project 이름을 label로 가진 container·volume·network가 하나라도 있으면 exit 4. 기존 설치는 절대 재사용하지 않는다. 같은 이름으로 동시에 들어오는 restore는 `<project>-restore-lock` network 생성으로 하나만 통과한다(끝나면 제거).
4. `infra/docker-compose.restore.yml`을 겹쳐 postgres·localstack·gitea를 띄운다. 이 override는 host port를 `--port-base`부터 loopback에 다시 묶고(postgres, localstack, gitea http, gitea ssh 순), postgres의 initdb SQL 마운트를 없애 dump가 빈 DB에 들어가게 한다.
5. `psql --single-transaction < db.sql` → 복원된 journal이 manifest와 같은지 재확인.
6. bucket이 비어 있는지 확인한 뒤 `awslocal s3 sync`. object 수가 manifest와 같아야 한다. 이미 있는 object를 덮어쓰는 경로는 없다.
7. gitea를 멈추고 `gitea.db`·`app.ini`를 백업본으로 교체, bundle마다 `git clone --mirror`, 빈 repo는 `git init --bare`, `gitea admin regenerate hooks`, 재시작. `app.ini`는 secret(`SECRET_KEY`·`INTERNAL_TOKEN`·`[oauth2] JWT_SECRET`)을 지키려고 통째로 복사하므로 `[server]`의 외부 주소는 원본 것이다. restore override가 gitea에 `GITEA__server__ROOT_URL`·`DOMAIN`·`SSH_DOMAIN`·`SSH_PORT`를 주고, Gitea 이미지 entrypoint의 `environment-to-ini`가 기동할 때마다 이 네 키만 복원 주소(`http://127.0.0.1:<port-base+2>/`, ssh `<port-base+3>`)로 덮어쓴다. 나머지 키와 섹션은 백업본 그대로다. 컨테이너 안 포트인 `HTTP_PORT`(3000)·`SSH_LISTEN_PORT`(22)는 건드리지 않는다. 재시작 뒤 네 값이 실제로 들어갔는지 확인하고, 아니면 실패한다.
8. `migrate` 서비스를 한 번 돌려 `db.migrate.noop`을 확인한다.

끝나면 접속 정보, 다시 띄우는 명령, 정리 명령(`docker compose -p <project> -f infra/docker-compose.yml down -v`)을 출력한다.

복원 project는 **항상 restore override와 같은 `RESTORE_*` 값으로** 다시 띄운다(출력된 "start again" 명령). base 파일만으로 `up`하면 컨테이너가 재생성되며 원본 포트(5432·4566·3001·2222)와 공용 worker network로 되돌아가 원본 설치와 충돌하고, Gitea의 `app.ini`는 복원 포트를 계속 광고해 clone URL이 없는 listener를 가리킨다. 복원본을 원본 자리로 승격하는 절차는 아직 없다.

## 검증

```bash
scripts/verify-restore.sh --project ap-restore-1
```

`checkpoints` 모든 행에 대해 ① `manifest_ref` object를 내려받아 sha256 = `manifest_sha256` ② manifest 안의 transcript part(root·subagent)·untracked 파일·workspace bundle을 각각 내려받아 sha256 대조 ③ bundle을 `git bundle verify`에 넣고 `workspace.gitCommit`이 ref tip인지 확인한다. `sessions.checkpoint_revision`과 같은 행은 `pointer`로 표시되며, pointer가 가리키는 revision에 `checkpoints` 행이 없으면 그 자체로 FAIL이다. manifest의 `sessionId`·`revision`도 행과 같아야 한다. 마지막으로 scratch key에 `If-None-Match: *` 두 번째 쓰기가 412로 거부되는지 확인해 복원된 store가 여전히 create-only임을 본다. 하나라도 실패하면 exit 5.

두 항목은 지금 검증할 수 없어 `SKIP`으로만 출력한다.

- **resume이 같은 native session으로 이어짐** — D3 pause/resume(94S-129) 뒤 direct-local e2e로 확인한다.
- **worker image digest** — 94S-125 이미지가 생기면 `manifest.json`의 `images.worker`와 checkpoint를 만든 worker의 digest를 대조한다.

## 복원본의 API는 `unversioned`로 띄운다

checkpoint manifest와 pointer는 S3 object **version**을 가리킨다(94S-229). `awslocal s3 sync`는 현재 객체의 바이트만 옮기므로 복원된 bucket의 객체는 모두 새 VersionId를 받는다. 백업 시점의 version을 가리키는 manifest는 복원본에서 그 version을 찾을 수 없다. 그래서 복원본의 API는 `CHECKPOINT_OBJECT_PROTECTION=unversioned`로 띄워야 세션을 복원할 수 있다 — key로 읽고 sha256으로 확인하는 저하된 모드다. `verify-restore.sh`는 key로 읽으므로 영향이 없다. version까지 보존하는 백업(VersionId를 유지하는 S3 replication, 또는 복원 뒤 manifest를 다시 고정하는 절차)은 아직 없다.

## 로컬에서 끝까지 돌려 보기

제품에는 아직 checkpoint를 쓰는 경로가 없다(94S-201·246). `scripts/dev/seed-checkpoint.ts`가 워커와 같은 계약으로 세션 하나와 커밋된 checkpoint 하나를 어느 설치에든 심는다.

```bash
# 1. 원본 설치(예: agent-platform 프로젝트)에 fixture 심기
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
bun run scripts/dev/seed-checkpoint.ts

# 2. 백업 → 복원 → 검증
dir=$(scripts/backup.sh --project agent-platform)
scripts/restore.sh "$dir" --into ap-restore-1 --port-base 25432
scripts/verify-restore.sh --project ap-restore-1

# 3. 정리 (복원본만)
docker compose -p ap-restore-1 -f infra/docker-compose.yml down -v
```

`tests/backup-restore.test.ts`는 docker 없이 schema 게이트와 SHA256SUMS 게이트를 검사하며 `bun run test`에 포함된다.

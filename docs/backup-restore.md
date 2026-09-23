# 백업과 복원 (compose 설치)

`scripts/backup.sh`가 한 compose 설치(PostgreSQL·LocalStack S3·Gitea)를 디렉터리 하나로 묶고, `scripts/restore.sh`가 그것을 **새 compose project**에 풀며, `scripts/verify-restore.sh`가 복원된 checkpoint pointer가 가리키는 object를 version 단위로 대조한다. 복원된 checkpoint는 새 bucket의 version으로 **다시 고정**되고 legal hold가 걸리므로, 복원본의 API도 기본값 `CHECKPOINT_OBJECT_PROTECTION=locked`로 뜬다(아래 "checkpoint 객체의 version" 절). 원본 설치의 volume·환경 파일은 어느 스크립트도 쓰지 않는다(README 규칙).

호스트에 필요한 것: docker + compose v2.24 이상(`!override` 병합), git, jq, `sha256sum` 또는 `shasum`, 그리고 `bun install`을 마친 이 저장소 checkout. restore의 `migrate` 서비스가 checkout을 마운트하고, 세 스크립트 모두 `bun run scripts/lib/checkpoint-pins-cli.ts`로 production codec과 S3 어댑터를 부른다(published postgres·localstack 포트로 붙는다). verify는 `scripts/lib/decode-manifest.ts`도 부른다. pg_dump·psql·awslocal은 컨테이너 안에서 실행한다.

macOS에서 Homebrew bash 5.3.9가 PATH 앞에 있으면 1 KB가 넘는 here-string·heredoc에서 멈춘다(`cat <<< "$(seq 1 300)"`가 돌아오지 않는다. backup의 gitea 단계 heredoc이 여기에 걸린다). 스크립트는 `#!/usr/bin/env bash`이므로 `/bin`을 PATH 앞에 두어 /bin/bash 3.2로 실행한다.

## 백업

```bash
scripts/backup.sh                       # project agent-platform → backups/backup-<ts>/
scripts/backup.sh --project ap125 --out /somewhere --bucket claude-sessions
```

```
backup-20260923T101500Z/
├── db.sql          pg_dump --no-owner --no-privileges (schema·data·drizzle journal)
├── objects/        bucket의 모든 object, key가 곧 경로 (checkpoint가 고정한 key는 그 version의 바이트)
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
- checkpoint GC(`apps/api/src/checkpoint-gc.ts`, 94S-281)는 백업 중에 돌리지 않는다. GC는 더 이상 복원될 수 없는 revision의 행에 `collected_at`을 적은 뒤 그 객체를 지운다. capture와 repin은 이렇게 표시된 행을 건너뛴다. 그런데 `pg_dump` 뒤에 GC가 행을 표시하면, 덤프에는 표시가 없는 행이 남고 그 객체는 백업에 없다. 그러면 restore의 repin이 실패한다. 그래서 `backup.sh`는 객체 복사를 마친 뒤 `pg_dump` 시작 1분 전 이후에 `collected_at`이 적힌 행이 있는지 확인하고, 있으면 백업을 실패로 끝낸다. GC를 멈추고 다시 백업한다.
- bucket sync는 각 key의 **현재** 객체만 받는다. 그 뒤 `checkpoint-pins-cli.ts capture`가 `collected_at`이 비어 있는 `checkpoints` 행을 모두 읽고 다음을 확인한다.
  - manifest는 `manifest_version`으로, 그 안의 모든 ref는 자기 `version`으로 읽는다. version이 없는 행(`unversioned`로 커밋된 행)은 key로 읽는다.
  - sha256과 크기를 대조한다.
  - `objects/<key>`가 고정된 바이트와 다르거나 없으면 고정된 바이트로 바꾸고 경고한다. 커밋 뒤 덮어쓰기나 delete marker가 있어도 백업이 손상본을 담지 않게 하려는 것이다.
- 다음 경우에는 백업이 실패한다(exit 1).
  - 고정된 version이 없거나 해시가 맞지 않는다.
  - 한 key에 서로 다른 바이트가 고정되어 있다(`objects/<key>` 파일 하나로 둘을 담을 수 없다).
  - 한 checkpoint의 manifest key를 다른 checkpoint가 ref로 쓴다. 복원 때 manifest를 다시 쓸 수 없다.
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
6. object와 재고정.
   1. bucket을 확인한다. bucket이 없으면 Object Lock으로 만든다. 기본 `claude-sessions`는 localstack init이 만든다.
   2. versioning `Enabled`와 Object Lock `Enabled`인지 확인한다. version이나 delete marker가 하나라도 있으면 거부한다.
   3. `checkpoints` 행이 가리키는 manifest key를 **빼고** `awslocal s3 sync`한다.
   4. `checkpoint-pins-cli.ts repin`이 재고정한다. 먼저 모든 행을 쓰기 없이 검증한다. 백업 manifest가 행의 sha256과 맞는지, 모든 ref가 복원 bucket에서 같은 바이트의 version으로 있는지 본다.
   5. 그 뒤 manifest를 새 version으로 다시 써서 같은 key에 create-only로 만든다. version으로 다시 읽어 확인하고, 모든 version에 legal hold를 건다. 마지막으로 모든 행의 `manifest_sha256`·`manifest_version`·`versions_held=true`를 한 트랜잭션으로 바꾼다.
   6. object 수가 manifest와 같아야 한다.
   7. 재고정이 실패하면 restore는 exit 1로 끝난다. 이미 올라간 object와 hold는 되돌릴 수 없으므로, 그 project는 내리고 새 project로 다시 복원한다. 이미 있는 object를 덮어쓰는 경로는 없다.
7. gitea를 멈추고 `gitea.db`·`app.ini`를 백업본으로 교체, bundle마다 `git clone --mirror`, 빈 repo는 `git init --bare`, `gitea admin regenerate hooks`, 재시작. `app.ini`는 secret(`SECRET_KEY`·`INTERNAL_TOKEN`·`[oauth2] JWT_SECRET`)을 지키려고 통째로 복사하므로 `[server]`의 외부 주소는 원본 것이다. restore override가 gitea에 `GITEA__server__ROOT_URL`·`DOMAIN`·`SSH_DOMAIN`·`SSH_PORT`를 주고, Gitea 이미지 entrypoint의 `environment-to-ini`가 기동할 때마다 이 네 키만 복원 주소(`http://127.0.0.1:<port-base+2>/`, ssh `<port-base+3>`)로 덮어쓴다. 나머지 키와 섹션은 백업본 그대로다. 컨테이너 안 포트인 `HTTP_PORT`(3000)·`SSH_LISTEN_PORT`(22)는 건드리지 않는다. 재시작 뒤 네 값이 실제로 들어갔는지 확인하고, 아니면 실패한다.
8. `migrate` 서비스를 한 번 돌려 `db.migrate.noop`을 확인한다.

끝나면 접속 정보, 다시 띄우는 명령, 정리 명령(`docker compose -p <project> -f infra/docker-compose.yml down -v`)을 출력한다.

복원 project는 **항상 restore override와 같은 `RESTORE_*` 값으로** 다시 띄운다(출력된 "start again" 명령). base 파일만으로 `up`하면 컨테이너가 재생성되며 원본 포트(5432·4566·3001)와 공용 worker network로 되돌아가 원본 설치와 충돌하고, Gitea의 `app.ini`는 복원 포트를 계속 광고해 clone URL이 없는 listener를 가리킨다. 복원본을 원본 자리로 승격하는 절차는 아직 없다.

## 검증

```bash
scripts/verify-restore.sh --project ap-restore-1
```

`checkpoints`의 모든 행을 확인한다. 단, GC가 `collected_at`을 적은 행은 뺀다. 확인하는 내용은 다음과 같다.

1. `manifest_ref`를 **`manifest_version`으로** 내려받아 sha256 = `manifest_sha256`인지 본다. 행의 `versions_held`는 true여야 한다.
2. manifest 안의 transcript part(root·subagent), untracked 파일, workspace bundle을 **각자의 `version`으로** 내려받아 sha256과 크기를 대조한다. version이 없는 ref는 재고정되지 않은 것이므로 FAIL이다.
3. 1과 2의 모든 version에 대해 HEAD의 `ObjectLockLegalHoldStatus`가 `ON`인지 본다.
4. bundle을 `git bundle verify`에 넣고 `workspace.gitCommit`이 ref tip인지 확인한다.

`sessions.checkpoint_revision`과 같은 행은 `pointer`로 표시된다. pointer가 가리키는 revision에 `checkpoints` 행이 없으면 그 자체로 FAIL이다. manifest의 `sessionId`·`revision`도 행과 같아야 한다.

그다음 scratch key에 `If-None-Match: *` 두 번째 쓰기가 412로 거부되는지 확인한다. 복원된 store가 여전히 create-only인지 보는 것이다.

마지막으로 `checkpoint-pins-cli.ts plans`가 복원본의 API가 할 일을 그대로 한다.

- `describeBucketProtection` 결과를 출력하고 API의 `locked` 기동 검사(`assertCheckpointBucketProtection`)를 통과하는지 본다.
- pointer마다 production 배선(`createApiCheckpointService` + Postgres store, `locked`)의 `getRestorePlan`이 `ready`인지 본다.
- plan의 manifest와 모든 object를 plan이 가리키는 version으로 읽고, hold가 걸려 있는지 본다.

하나라도 실패하면 exit 5.

두 항목은 복원된 저장소만으로는 볼 수 없어 이 스크립트에서는 `SKIP`으로 출력한다. 둘 다 스택을 실제로 띄워야 하므로 `tests/e2e/restore-resume.sh`가 확인한다(아래 "실스택에서 복원 뒤 재개 확인").

- **resume이 같은 native session으로 이어짐** — 새 worker가 복원한 checkpoint에서 같은 Claude session을 이어 가는지 본다.
- **worker image digest** — `manifest.json`의 `images.worker`가 checkpoint를 만든 worker의 image와 같은지 본다.

## checkpoint 객체의 version: 복원 뒤 재고정 (94S-282)

checkpoint manifest와 pointer는 S3 object **version**을 가리킨다(94S-229). 복원된 bucket에서는 모든 객체가 새 VersionId를 받으므로, 백업 시점의 version을 그대로 가리키는 manifest는 복원본에서 읽을 수 없다.

**선택: 복원 뒤 재고정(re-pin).** VersionId를 유지하는 replication은 쓰지 않는다. 근거는 다음과 같다.

- S3도 LocalStack도 VersionId는 저장소가 정한다. PutObject로 지정할 수 없다.
- VersionId를 유지하며 복사하는 것은 S3 Replication(SRR/CRR, Batch Replication)뿐이다. 이것은 살아 있는 원본 bucket에서 다른 bucket으로 가는 복제다.
- 이 백업은 디렉터리이므로 원래 id를 되살릴 방법이 없다. 실제 AWS에서 replication을 운영하는 절차는 이 문서의 범위 밖이다.

재고정은 다음 규칙을 지킨다. Codex와 합의했다.

- **key는 그대로 둔다.** manifest는 원래 key(`manifestRefFor(session, revision, attempt)`)에 다시 쓴다. 복원 sync가 그 key를 뺐으므로 새 bucket에서는 이것이 첫 create-only 쓰기다. 그래서 finalize의 key 규칙과 `putImmutable` 규칙이 그대로 성립한다.
- **바뀌는 것은 version과 manifest digest다.** manifest 안 각 object ref(transcript part, bundle, untracked)의 `version` 필드만 바뀐다. 최상위 schema `version`(2)은 그대로다. transcript part-list digest(`digestParts`)는 version을 덮지 않으므로 그대로 유효하다. 행의 `manifest_sha256`·`manifest_version`은 새 값이 된다.
- **`versions_held=true`는 모든 검증을 마친 뒤에만 쓴다.** 재고정 도구는 DB와 bucket 권한을 모두 가진 신뢰된 발급자다. locked finalize와 똑같이 모든 version을 version 단위로 해시하고 hold를 건 뒤에만 true로 둔다. false로 남기면 `getRestorePlan`이 이 값을 올리지 않으므로, 매 복원마다 transcript 전체를 다시 해시하게 된다.
- **`turns.result_json`의 finalize digest는 원래 요청 그대로 둔다.** 원래 요청의 replay는 계속 맞고, 재고정한 필드로 온 요청은 충돌한다. 복원본에는 원래 worker가 없으므로 실제로 오는 요청은 없다.
- **백업 원본은 바뀌지 않는다.** `objects/`의 manifest는 원래 바이트 그대로 남는다.

재고정 뒤 복원본의 API는 기본값 `locked`로 뜬다. `unversioned`는 versioning이 꺼진 bucket에서만 쓴다.

## 실스택에서 복원 뒤 재개 확인 (94S-324)

```bash
tests/e2e/restore-resume.sh    # macOS: PATH="/bin:/usr/bin:$PATH" bash tests/e2e/restore-resume.sh
```

`tests/e2e/run.sh`와 같은 이미지·overlay로 제품 스택(`apps` profile)을 띄워 다음을 한 번에 끝까지 수행한다. 기록은 `RR_OUT`(기본값은 새 임시 디렉터리)에 남는다. 기록에는 tested SHA, image id, SDK·Claude Code 버전, 단계별 JSON, 두 project의 checkpoint 행과 manifest, restore·verify 로그, compose 로그, worker 로그, 대조표가 들어간다. backup 디렉터리는 Gitea secret과 API key 해시를 담으므로 `manifest.json`만 남기고 지운다.

1. 원본 project에서 세션을 만들고 turn 2개를 실제 Claude Code로 돌린다. turn 1은 `echo alpha > hello.txt`, turn 2는 `echo beta >> hello.txt`이다. 그다음 pause로 checkpoint를 커밋하고 worker를 내린다.
2. api·scheduler·reconciler를 멈추고 `scripts/backup.sh`를 뜬다. 그다음 원본 project와 그 installation 라벨이 붙은 container·network·volume(worker workspace volume 포함)을 모두 지운다. 세션을 넘기는 것은 backup뿐이다.
3. `scripts/restore.sh`로 새 project에 복원하고 `scripts/verify-restore.sh`를 돈다. 그 위에 restore override를 겹친 채 같은 이미지로 apps를 띄운다. 이때 restore가 띄운 localstack이 다시 만들어지면 실패로 친다. LocalStack은 컨테이너를 다시 만들면 S3 상태를 잃는다.
4. 원본에서 발급한 API key로 공개 API의 `resume`를 부른다. key 해시도 복원된 DB에 있다. 새 worker가 checkpoint를 복원하고 ready를 보고하면 turn 3(`cat hello.txt`)을 보낸다.
5. 대조한다.
   - turn 3이 `alpha\nbeta`를 한 번씩만 읽는다. 입력이 다시 실행됐다면 beta가 둘이 되고, workspace가 복원되지 않았다면 파일이 없다.
   - 복원본의 fake Messages API는 새 prompt(`rr3`)만 받는다. 그 요청의 history에는 `rr1`, `rr2`, `rr3`가 순서대로 있다. 엔진이 새 대화를 연 것이 아니라 이전 대화를 이어 갔다는 뜻이다.
   - turn 3 뒤 새 checkpoint의 manifest를 원본 manifest와 대조한다. 다음이 모두 같아야 한다.
     - engine session id(`resume`)
     - transcript part(key·sha256)가 앞부분으로 그대로 이어지는지. 새 part는 다음 generation 아래에 붙는다.
     - workspace commit과 untracked 파일의 sha256
   - worker 로그의 `worker.checkpoint.restored`가 원본 revision과 commit을 가리킨다.
   - `manifest.json`의 `images.worker`가 원본 worker 컨테이너의 image와 같고, 복원본 worker의 image와도 같다.

knob: `RR_PROJECT`(원본 project 이름, 복원 project는 `<이름>r`), `RR_INSTALLATION_ID`(두 쪽 공용 `EXECUTION_INSTALLATION_ID`), `RR_PORT_BASE`(복원 project의 loopback 포트 4개, 기본값 24320), `RR_KEEP=1`(스택·이미지·backup을 남김). 두 project와 installation 라벨 자원이 이미 있으면 아무것도 지우지 않고 멈춘다.

engine session id는 manifest의 `resume`에만 있다. `sessions.claude_session_id` 컬럼은 아무 코드도 쓰지 않는다.

### 결과 (2026-09-24, `fc495b83`)

`RR_PROJECT=it324 RR_INSTALLATION_ID=it324`. Docker Engine 29.1.3, compose 5.0.0, claude-agent-sdk 0.3.270, Claude Code 2.1.270, worker image `sha256:2b5b8012…83eb8`.

| 항목 | 원본 r1 | 복원본 r1 | resume 뒤 r2 | 결과 |
|---|---|---|---|---|
| engine session id(`resume`) | `d4f13b9f…be16` | 같음 | 같음 | PASS |
| transcript part | 6개, entry 32 | 같은 sha256 6개, version만 새것 | 앞 6개 그대로 + generation 2의 2개, entry 42 | PASS |
| part-list digest | `d77fb22a…0155` | 같음 | — | PASS |
| workspace commit | `4d457562…a713` | 같음 | 같음 | PASS |
| untracked `hello.txt` sha256 | `e49c81e2…78ee` | — | 같음 | PASS |
| 새 worker 복원 | — | `worker.checkpoint.restored` r1, 같은 commit, `worker.resume.ready` | — | PASS |
| turn 3 `cat hello.txt` | — | — | `alpha\nbeta`, turn 1·2는 completed 그대로 | PASS |
| 모델 호출 | `rr1`, `rr2` | 없음(새 스택) | `rr3`만, history `[rr1, rr2, rr3]` | PASS |
| worker image | backup `images.worker` = 원본 worker | — | 복원본 worker와 같음 | PASS |

verify-restore는 checkpoint 2개 PASS, create-only 412, locked 기동 검사, `plan: ready under locked`를 출력했다. 원본은 backup 뒤 installation 라벨의 container·volume과 compose project 자원이 하나도 남지 않았다(이 실행 뒤 스크립트는 installation 라벨 network까지 확인한다).

## 로컬에서 끝까지 돌려 보기

위 e2e는 worker가 실제로 커밋한 checkpoint로 돈다(94S-246). 세션을 돌리지 않은 설치에서 스크립트만 시험할 때는 `scripts/dev/seed-checkpoint.ts`를 쓴다. 이 스크립트는 워커와 같은 계약으로 세션 하나와 커밋된 checkpoint 하나를 어느 설치에든 심는다. 이 checkpoint는 locked finalize가 남기는 모양이다. 모든 ref와 `manifest_version`이 version을 싣고, 모든 version에 hold가 걸려 있으며, `versions_held=true`다. 그래서 bucket은 versioning과 Object Lock이 켜져 있어야 한다(compose 기본값).

```bash
# 1. 원본 설치(예: agent-platform 프로젝트)에 fixture 심기
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/sessions \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
bun run scripts/dev/seed-checkpoint.ts

# 2. 백업 → 복원 → 검증
dir=$(scripts/backup.sh --project agent-platform)
scripts/restore.sh "$dir" --into ap-restore-1 --port-base 25432
scripts/verify-restore.sh --project ap-restore-1   # 마지막 줄들: bucket PASS, "<session>@<rev> plan: ready under locked"

# 3. (선택) 실제 API 프로세스를 복원본 위에 locked로 띄워 /readyz 200 확인
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:25432/sessions AUTH_MODE=api-key PORT=27999 \
AWS_ENDPOINT_URL=http://127.0.0.1:25433 AWS_REGION=ap-northeast-1 S3_BUCKET=claude-sessions \
EXECUTION_SLOT_LIMIT=10 QUEUED_INPUT_LIMIT_PER_SESSION=20 STORAGE_LIMIT_BYTES=1073741824 \
MAX_TURN_SECONDS=3600 SESSION_COST_LIMIT_USD=25 PROVIDER_MAX_RETRIES=2 \
CHECKPOINT_OBJECT_PROTECTION=locked bun apps/api/src/server.ts   # + 위와 같은 AWS 자격 증명

# 4. 정리 (복원본만)
docker compose -p ap-restore-1 -f infra/docker-compose.yml down -v
```

`tests/backup-restore.test.ts`는 docker 없이 schema 게이트와 SHA256SUMS 게이트를, `tests/checkpoint-pins.test.ts`는 in-memory versioned store로 capture·재고정과 그 거부 경로, 재고정한 checkpoint의 locked `getRestorePlan`을 검사하며 `bun run test`에 포함된다.

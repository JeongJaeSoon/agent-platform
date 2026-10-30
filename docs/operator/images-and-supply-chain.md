# 이미지와 공급망

앱 이미지 셋과 compose `apps` profile, worker 이미지의 업그레이드·롤백, 공급망 취약점 정책을 적는다. 이미지를 빌드·게시하는 workflow는 [ci.md](../contributing/ci.md)에 있다.

## 이미지와 Compose `apps` profile

앱 이미지는 `apps/{control-host,worker,egress-proxy}/Dockerfile` 셋이 정의한다. 셋 다 저장소 루트를 context로 `oven/bun:1.3.14`의 multi-arch index digest 하나를 base로 pin한다(`tests/images.test.ts`가 digest 일치를 검사). control-host 이미지 하나가 api·scheduler·reconciler 세 role을 모두 돌린다 — compose에서는 `api`만 빌드하고 scheduler·reconciler는 같은 `API_IMAGE`를 쓴다. 같은 태그를 두 서비스가 함께 빌드하면 export가 경합하기 때문이다. control-host·worker는 `bun install --frozen-lockfile --production`으로 workspace closure만 설치한 뒤 runtime stage로 복사하고, egress-proxy는 `bun install` 없이 자기 소스만 담은 한 stage다.

digest pin은 Bun 버전과 함께 베이스의 Debian 패키지도 고정한다. oven/bun은 발행한 tag를 다시 빌드하지 않아서, 2026-09-25 기준 `oven/bun:1.3.14`의 마지막 빌드는 2026-05-13이다. 그래서 세 이미지의 배포 stage는 `apt-get upgrade`로 Debian 보안 수정을 올린다. Bun을 올리지 않고 수정을 받는 방법이 이것뿐이기 때문이다. 대가는 재현성이다. 같은 commit이라도 빌드한 날에 따라 Debian 패키지 버전이 다를 수 있다. 배포한 것은 release manifest가 image digest로 고정하고, 빌드마다 images.yml의 라이선스 대조와 Grype 검사가 그 이미지를 본다. layer cache는 `APT_UPGRADE_KEY` build arg가 가른다. images.yml은 UTC 날짜를 넘기고, 로컬 compose 빌드는 빈 값이라 한 번 만든 upgrade layer를 계속 쓴다. 로컬에서 새 수정을 받으려면 `--build-arg APT_UPGRADE_KEY=$(date -u +%F)`나 `--no-cache`로 빌드한다.

| 이미지 | 내용 | 실행 주체 |
|---|---|---|
| `agent-platform-control-host` | `apps/control-host` 실행물 하나로 api·scheduler·reconciler role을 모두 돌린다. `--filter`로 그 앱의 closure만 설치하며 Agent SDK·Claude Code executable을 담지 않는다(빌드가 `node_modules/@anthropic-ai` 부재를 확인). 기본 uid 1000, scheduler role만 compose `user: "0:0"`로 root가 되어 Docker socket을 쥔다 | `bun run apps/control-host/src/main.ts <role>` (CMD 기본은 `api`) |
| `agent-platform-worker` | `--filter ./apps/worker`로 worker와 그것이 의존하는 workspace의 closure만 설치한다(pg·drizzle·웹 콘솔 패키지는 없다). SDK 0.3.270과 번들 Claude Code 2.1.270, git, non-root(uid 1000), `/workspace`를 1000 소유로 미리 생성(LocalDockerBackend의 volume 계약). 빌드 시 `resolvePinnedClaudeExecutable()`로 executable 경로를 확정해 `/usr/local/bin/claude`로 걸고 `claude --version`을 실행한다 | `bun run apps/worker/src/main.ts` — scheduler가 env로 넘긴 bootstrap identity로 세션 하나를 claim하고 WorkerHost 루프를 돈다 |
| (scheduler role) | Docker socket을 mount하는 유일한 서비스이며 root로 실행한다(socket 소유자는 어차피 daemon host의 root와 같고, socket gid는 daemon마다 달라 고정 uid가 이식성을 깎기만 한다) | compose에서는 감독 루프(`main.ts scheduler`)가 `SCHEDULER_INTERVAL_SEC`(기본 5초)마다 자식 프로세스(`--serve`)에 pass 하나를 요청한다. 실패하거나 kill된 pass는 자식과 함께 끝나고 다음 pass는 새 자식에서 돈다([실행](execution.md)). 실패 pass가 `SCHEDULER_MAX_CONSECUTIVE_FAILURES`(3)번 이어지면(degraded exit 76은 세지 않는다) 루프가 exit 1 해 `restart: unless-stopped`가 재시작하고(`compose ps`에 드러남), `SCHEDULER_HEALTH_STALE_SEC`(200초) 동안 완료 pass(성공 또는 degraded)가 없으면 healthcheck(`main.ts scheduler --health`)가 unhealthy가 된다. DB가 멈추면 pass가 스스로 exit 1로 끝난다: scheduler·reconciler pool은 API와 같은 timeout(connect 5초·statement 10초·read 20초, `packages/db/src/pool.ts`의 `JOB_POOL_TIMEOUTS`)을 쓰고, 연결을 한 번 잃은 뒤의 store 호출은 기다리지 않고 바로 실패하므로 DB 대기는 실패한 statement(5+20초)와 pass lock 해제(20초)를 합친 약 45초가 상한이다(실측: pass 전 정지 5초, pass 중 정지 약 40초). `SCHEDULER_PASS_TIMEOUT_SEC`(180초)는 이 45초와 worker 정지 한 번(stop timeout 120초 + request timeout 30초)보다 크게 두는 바깥 watchdog이며, 그 밖의 hang을 kill해 실패로 센다(unhealthy만으로는 Docker가 재시작하지 않는다). pool timeout을 늘리면 이 값도 `connect + 2 × read`보다 크게 올린다 |
| `agent-platform-egress-proxy` | `apps/egress-proxy`의 소스만(의존성 없음, 한 stage). 코드는 root 소유로 두고 uid 1000으로 실행해 proxy가 다음 기동의 코드를 고치지 못한다 | `bun run src/main.ts` — compose `egress-proxy`, 모든 worker 네트워크에 붙는 유일한 바깥 경로 |

```bash
docker compose -f infra/compose.yml --profile worker build          # WORKER_IMAGE(agent-platform-worker:dev)
docker compose -f infra/compose.yml --profile worker run --rm worker claude --version
docker compose -f infra/compose.yml --profile apps up -d --build      # migrate → api(/readyz) → worker 이미지 smoke → scheduler 루프, reconciler 루프
curl -s http://127.0.0.1:3000/readyz
```

compose 진입 파일은 `infra/compose.yml`, 복원용 layer는 `infra/compose.restore.yml`이다. 2026-10 전 checkout에서는 각각 `infra/docker-compose.yml`·`infra/docker-compose.restore.yml`이었다. 옛 이름을 `-f`나 `COMPOSE_FILE`에 적은 스크립트·alias는 새 이름으로 바꾼다. project 이름(`agent-platform`)은 그대로이므로 이미 떠 있는 스택과 볼륨은 새 이름으로 그대로 이어진다. 루트에서 `docker compose`(`compose.yaml`)나 `scripts/local.sh`로 띄우는 경우는 바뀌는 것이 없다.

`apps` profile의 값은 provider key 하나를 빼면 전부 기본값이 있어 환경 파일 없이 뜬다. 기본 카탈로그(`config/`)는 API 프로세스의 `ANTHROPIC_API_KEY`를 읽으므로, 셸이나 `.env`에 key가 없으면 API가 기동하지 않는다(`scripts/local.sh up`은 띄우기 전에 거부한다). key 없이 띄우려면 `scripts/local.sh up --fake-model`로 fake 카탈로그를 쓴다. 이때 API 컨테이너에는 key가 넘어가지 않는다. `DATABASE_URL`만은 예외로 항상 compose의 postgres를 가리킨다 — `up`이 migrate를 실행하므로 셸이나 환경 파일에 있는 다른 DSN이 로컬 스택 기동만으로 migrate되면 안 된다. `AUTH_MODE` 기본값은 `api-key`다 — 워커가 proxy 경유로 `api:3000`에 닿으므로 `none`이면 워커 안의 코드가 `X-Owner-Id`로 아무 owner 행세를 할 수 있다(`/internal` 워커 라우트는 자체 인증). 키는 `bun run keys create <owner> --scopes …`(compose `api` 컨테이너 안에서 key CLI를 실행)로 발급한다. 발급한 key의 id는 stderr에 `key_id <uuid>`로 나온다(stdout은 평문 key 한 줄 그대로다). 폐기는 `bun run keys revoke <key_id>`다. 폐기된 key는 다음 요청부터 401을 받고, 열려 있던 SSE는 keepalive 주기 안에 끊긴다. 같은 owner가 진행 중인 작업은 취소하지 않는다. 세션의 실행 권한을 거두는 것은 별도 운영 명령 `bun run grants revoke <session_id> --reason <text>`다([세션 실행 권한 회수와 복구](api-server.md#세션-실행-권한-회수와-복구)). 이 명령은 한 transaction 안에서 auth_revision과 epoch를 올리고, worker token을 폐기하고, kill intent를 남기고, dispatch를 차단한다. owner의 resume과 start_fresh도 거부된다(403). 차단은 `bun run grants restore <session_id> --reason <text>`로만 풀리며, 풀 수 있는 시점은 이전 execution이 사라진 것이 확인된 뒤다. API 포트는 `127.0.0.1:3000`에만 바인드한다. `EXECUTION_WORKSPACE_QUOTA`는 compose에서 기본 `off`다 — Docker Desktop은 project quota를 감당하지 못하므로 로컬 스택은 무제한 workspace를 감수하고 scheduler pass마다 경고 1건이 남는다; xfs+prjquota daemon이면 `on`으로 되돌린다. 나머지 값은 `.env` 없이 뜬다. `.env`가 있으면 읽되(`required: false`) 만들거나 덮어쓰지 않는다. 카탈로그는 저장소 `config/`를 `/app/config`로 mount해 읽는다 — 이미지에는 카탈로그가 없어 mount 없이 띄운 API는 기동하지 않는다. `secrets`(API 전용 Secrets Manager, 호스트 `127.0.0.1:4567`)와 `fake-messages`는 `infra/compose.fake-model.yml`을 얹을 때만 뜬다. `secret_id`를 읽는 카탈로그가 fake 카탈로그뿐이어서다. 기본 카탈로그를 `secret_id`로 바꾸고 overlay 없이 띄우면 API는 `… could not be read from http://secrets:4566 (…)`로 기동을 멈춘다. worker 컨테이너는 compose 서비스가 아니라 scheduler가 세션마다 띄운다. compose의 `worker` 항목은 그 이미지를 빌드하고 `claude --version`으로 한 번 확인한 뒤 끝나는 one-shot이다(`network_mode: none`). scheduler가 이것의 성공을 기다리므로 `apps` profile의 `up`이 worker 이미지까지 빌드한다. 워커는 forward proxy로 `api:3000`(`EGRESS_PRIVATE_ALLOWLIST` 기본값)에만 닿고, `gitea:3000`·`fake-messages:4010`·`localstack:4566`에는 credential route로만 닿는다(`secrets`에는 닿지 않는다). 직접 연결과 metadata 주소는 internal 네트워크가 막는다.

같은 daemon에 두 설치를 올리면 `EXECUTION_INSTALLATION_ID`를 설치마다 다르게 준다. compose의 `egress-proxy` label은 이 값을 따르므로 설치마다 자기 proxy가 붙는다. 다른 worktree의 compose project가 기본 포트를 잡고 있으면 `-p <name>`과 `ports: !override` override 파일로 분리한다.

`.github/workflows/images.yml`은 PR·main push마다 세 이미지를 빌드하고 worker에서 `claude --version`이 2.1.270인지, api·scheduler에 `@anthropic-ai`가 없는지 확인한 뒤 digest JSON을 `image-digest-<app>` artifact로 남긴다. `v*` tag의 **push 이벤트**에서만(`workflow_dispatch`는 어떤 ref든 지정할 수 있어 이벤트도 본다) `publish`·`promote` job이 `ghcr.io/<owner>/agent-platform-<app>`으로 게시한다. 두 job만 package write 권한을 가지며 `release` environment에서 돌고, tag가 가리키는 commit이 `main`의 조상이 아니면 실패한다(tag는 리뷰가 아니다). `publish`는 이미지마다 run 전용 staging tag로 push한 뒤 그 digest를 pull해 같은 smoke(`.github/scripts/image-smoke.sh`)를 통과시키고, `promote`가 세 digest가 모두 통과한 뒤에야 `vX`·`sha-…` tag로 retag한다(registry-side, 재빌드 없음). 이 run의 staged digest가 release candidate다. 기존 tag가 다른 digest를 가리키면 아무 tag도 쓰기 전에 실패하고(한 버전이 두 build attempt의 이미지로 섞이지 않는다), 조회 자체가 실패하면(인증·rate limit·5xx) "없음"으로 보지 않고 중단한다(fail-closed). tag를 쓴 뒤 여섯 reference(세 이미지 × 두 tag)를 다시 읽어 candidate와 같을 때만 `image-digests-published` artifact를 만든다. retag는 저장소별로 순서대로 일어나므로 중간에 실패하면 세트가 반만 tag된 채 남는다 — 그때는 **같은 run의 "Re-run failed jobs"**로 채운다(publish job은 다시 돌지 않아 staged artifact와 digest가 그대로다). tag를 다시 push하면 새 build(worker의 apt layer는 pin되지 않는다)라 거부된다. 세 digest를 한 번에 커밋하는 소비자용 release manifest는 아직 없고, 그 전까지는 초록 run의 `image-digests-published` artifact가 세트의 기록이다. `release` environment의 required reviewer·deployment branch 규칙은 저장소 설정에서 건다. registry CD는 아직 없다.

### worker 안에서 만든 commit의 작성자

worker 이미지는 git system 설정(`/etc/gitconfig`)에 `user.name=Werft`, `user.email=noreply@werft.invalid`를 둔다. 그래서 Claude가 workspace에서 만든 commit은 저장소나 세션이 따로 정하지 않는 한 author와 committer가 모두 `Werft <noreply@werft.invalid>`다. 이 값이 없으면 git이 commit을 거부하고, Claude는 사용자에게 이름과 주소를 묻는다. `.invalid`는 어디에도 배달되지 않는 예약 도메인이라 실제 사람의 주소와 겹치지 않는다. checkpoint의 내부 commit은 이 값을 쓰지 않는다(`checkpoint@werft.invalid`).

system 설정은 git 설정 중 우선순위가 가장 낮아서, 세션 안에서 정한 값이 있으면 그쪽이 이긴다. 세션의 작성자를 바꾸려면 workspace 저장소에 `git config user.name`·`git config user.email`을 쓴다. `git commit --author`는 author만 바꾸고 committer는 그대로 둔다. `git config --global`은 tmpfs HOME에 쓰이므로 worker가 바뀌면 사라진다. 저장소 설정도 checkpoint에서 복원한 worker에서는 사라진다. 복원이 workspace를 비우고 저장소를 새로 만들기 때문이다. 그때부터는 다시 기본 작성자로 commit된다. 카탈로그나 설치 설정으로 기본값을 바꾸는 기능은 두지 않았다. 사용자별 작성자를 기본값으로 쓰려면 사용자 주소를 worker에 넘겨야 하므로 제품 결정이 먼저다. 이미지 smoke(`.github/scripts/image-smoke.sh`)가 빈 저장소에서 commit해 이 작성자를 확인하고, e2e(`tests/e2e/alpha-path.e2e.ts`)가 실제 Claude Code의 Bash 도구로 같은 것을 확인한다.

### worker 이미지 업그레이드와 checkpoint 호환

`scripts/test-ops.sh upgrade`에서 worker 이미지가 바뀌면 새 이미지의 engine·SDK·CLI·profile digest로 각 현재 checkpoint의 restore plan을 계산한다. 네 값이 모두 같아 호환되는 세션은 승인 없이 이어지고, `INCOMPATIBLE_CHECKPOINT`인 세션만 사용자에게 알리고 정확한 목록을 승인받는다. 검사를 끝까지 돌릴 수 없거나 다른 검증 실패가 섞이면 미수거 checkpoint가 있는 세션 전부를 영향 목록으로 삼는 fail-closed 동작을 하고 로그에 남긴다. writer를 멈춘 뒤에도 같은 검사를 다시 한다. 불호환 세션에 `start_fresh`를 선택하면 이전 checkpoint의 context를 버린다. 현재는 세션별 worker 이미지 고정이 없으며, 호환될 때만 새 이미지에서 이어진다.

### worker·control-host 롤백과 incremental checkpoint

commit `95b0e7b5`부터 worker는 직전 checkpoint의 bundle 사슬 위에 새 객체만 담은 incremental bundle을 올린다. 그 사슬은 manifest의 `workspace.baseBundles`에 적힌다. manifest `version`은 그대로 2이고, incremental인지는 이 필드가 있는지로만 갈린다. **그 이전 빌드로 롤백하면 이 필드가 있는 checkpoint를 복원하지 못한다.** 이전 빌드의 manifest 스키마는 모르는 키를 거절하기 때문이다.

- **옛 worker 이미지.** 복원할 때 manifest decode가 `Invalid Claude checkpoint manifest: workspace Unrecognized key: "baseBundles"`로 실패한다. 이 실패는 workspace를 비우거나 bundle을 받기 전에 나므로 반쯤 복원된 workspace는 남지 않는다. 대신 manifest가 고정돼 있어 다시 launch해도 같은 이유로 `worker.failed`가 된다.
- **옛 control-host.** 복원 계획이 `CHECKPOINT_UNAVAILABLE`로 거절되고, 앞 revision으로 물러나지 않는다. finalize도 incremental manifest를 거절해 pointer가 오르지 않는다. 새 worker와 섞여 있으면 첫 checkpoint처럼 홀로 선 bundle만 commit된다. 옛 GC는 decode되지 않는 세션을 건너뛰므로 base bundle을 지우지는 않는다.
- **영향 세션 찾기.** DB에는 manifest 내용이 없다. `sessions.checkpoint_revision`이 가리키는 `checkpoints` 행(`collected_at IS NULL`)의 `manifest_ref`·`manifest_version`으로 object store에서 manifest를 받아 `jq -e '.workspace.baseBundles | length > 0'`로 가른다. 복원이 `parent_revision`을 따라 물러날 수도 있으므로 부모 행도 같이 본다. worker 로그 `worker.checkpoint.published`의 `base_bundles`가 0보다 크면 incremental로 올린 것이다.
- **롤백 전에 할 일.** 영향 세션이 있으면 롤백하지 말고 롤포워드한다. 새 전체 bundle로 다시 checkpoint하게 하는 운영 수단(환경 변수·설정·CLI)은 아직 없다. worker는 사슬이 없거나 끊겼거나, 길이 32(`MAX_BUNDLE_CHAIN`)나 bundle 상한에 닿았을 때만 스스로 전체 bundle을 올린다. 그래서 롤백이 꼭 필요하면 영향 세션은 롤백 동안 복원되지 않는다. 롤포워드하면 그대로 복원된다.

### worker protocol 필드를 걷어내는 순서

API를 업그레이드해도 이미 떠 있는 worker 컨테이너는 옛 이미지로 계속 돈다. 입력이 없는 worker도 `WORKER_IDLE_TIMEOUT_SEC`(기본 1800초) 동안 남는다. 그래서 worker protocol의 필드는 받는 쪽이 먼저 그 필드 없이도 받아들이게 바꾸고, 그 릴리스로 모두 교체된 다음에야 보내는 쪽이 필드를 뺀다. 한 릴리스에서 양쪽을 같이 바꾸지 않는다.

| 필드 | 1단계: 받는 쪽이 요구하지 않음 | 2단계: 보내는 쪽이 뺌(1단계 교체가 끝난 뒤) |
|---|---|---|
| heartbeat 응답 `auth_revision` | worker가 없는 응답도 받는다 | API가 보내지 않는다. 그 전에 1단계 이전 이미지의 worker가 하나도 남지 않았는지 본다 |
| append-events 요청 `batch_key` | API가 없는 요청도 받는다(아직 안 함) | worker가 보내지 않는다. 그 전에 1단계 이전 API가 하나도 남지 않았는지 본다 |

2단계를 너무 일찍 배포하면 옛 쪽이 상대의 요청이나 응답을 계약 위반으로 거절한다. worker는 계약에 맞지 않는 heartbeat 응답을 재시도할 수 없는 실패로 보므로, 첫 heartbeat에서 lease를 잃었다고 판단하고 멈춘다.

checkpoint manifest에 필드를 더할 때는 반대로 읽는 쪽이 먼저다. control-host(commit 전 검증·복원 계획·GC)와 worker(복원) 모두 모르는 키를 거절한다. 그래서 control-host를 먼저 올리거나 같은 릴리스로 올리고, worker는 그 뒤에 올린다. 그 필드를 쓴 checkpoint가 생긴 뒤 worker를 롤백하면, 위의 `baseBundles`와 같은 이유로 그 세션은 복원되지 않는다.

| 필드 | 먼저: 읽는 쪽 | 그다음: 쓰는 쪽 |
|---|---|---|
| `workerState`(승인 대기 park) | control-host와 worker가 이 키가 있는 manifest를 받는다 | worker가 승인 대기 turn을 park할 때만 쓴다 |

worker가 보내는 worker protocol 필드를 새로 더할 때도 API가 먼저다. API의 worker protocol 요청 schema는 strict라서, 옛 API는 모르는 필드가 실린 요청 전체를 400 `BAD_REQUEST`로 거절한다.

| 필드 | 먼저 배포 | 옛 API를 만난 새 worker |
|---|---|---|
| pending-control 요청 `settled[].reason`·`settled[].answer_result` | API | `worker.pending.settlement_detail_refused` 경고를 한 번 남기고, 그 attempt가 끝날 때까지 `outcome`만 보낸다. receipt는 예전 규칙대로 정산되고 `pending_requests.settled_reason`·`settled_answer_result`는 비어 있다 |

### DB 스키마를 바꾸는 순서

migration은 rollout 전에 돈다. 그래서 새 스키마 위에서 옛 control-host가 잠시 돌고, 옛 worker 이미지는 지원 창 동안 계속 돈다. 옛 코드가 읽고 쓰는 열·테이블은 그 코드가 모두 사라질 때까지 남아 있어야 한다. 그래서 스키마 변경은 세 릴리스에 나눠 한다. 한 릴리스에서 더하기와 지우기를 같이 하지 않는다.

| 단계 | 하는 일 | 옛 코드가 보는 것 |
|---|---|---|
| 1. 확장(expand) | 열·테이블을 더한다. 새 열은 null을 허용하거나 기본값을 둔다. 기본값을 두면 기존 행에서도 그 값이 읽히고, INSERT가 그 열을 빼면 기본값이 들어간다. 명시적 NULL에는 기본값이 적용되지 않아 null 허용 열이면 NULL로 저장되고 NOT NULL 열이면 INSERT가 실패한다. 그래서 기존 행에 맞는 값인지와 옛 코드의 INSERT가 그 열을 어떻게 쓰는지 보고 고른다 | 모르는 열이 생길 뿐이고, 옛 코드의 쓰기는 그 열을 빼고 들어간다 |
| 2. 전환 | 새 코드가 새 열에도 쓰기 시작한다. 옛 코드가 옛 열에 쓰는 동안에는 옛 열이 기준이다. 새 코드는 두 열에 모두 쓰되 옛 열을 읽는다. 옛 코드의 쓰기를 새 열로 옮기는 장치(trigger 등)가 없으면, 옛 writer가 모두 사라진 뒤 기존 행을 마지막으로 backfill하고 나서 읽기를 새 열로 옮긴다 | 옛 열이 그대로 있어 읽기·쓰기가 계속된다 |
| 3. 정리(contract) | 옛 열·테이블을 지우거나 NOT NULL·CHECK로 제약을 강화한다. 그 열을 쓰는 이미지가 지원 창 밖으로 나가고, 그 이미지의 worker와 control-host가 실제로 하나도 남지 않은 것을 확인한 다음 릴리스에서 한다. 제약을 강화하기 전에는 기존 행과 지금 도는 모든 writer가 새 제약을 만족하는지 본다 | 그 열을 쓰는 옛 코드가 더는 없다 |

열 이름을 바꾸는 것도 옛 이름을 바로 없애므로 같은 순서를 따른다. 새 열을 더하고, 데이터를 옮기고 코드를 바꾼 뒤, 옛 열을 지운다. `WORKER_IDLE_TIMEOUT_SEC`는 마지막 turn 뒤의 유휴 시간이지 worker 수명의 상한이 아니다. 일하는 worker는 그보다 오래 남을 수 있으니 정리 시점은 시간이 아니라 실제로 남은 컨테이너로 판단한다.

예: checkpoint 포인터의 런타임 조합 `checkpoints.runtime_*`(migration `0196_checkpoint_runtime`)는 1단계로, 기본값 없는 null 허용 열만 더했다. 그 전에 커밋된 행은 null로 남는다.

## 공급망 취약점 정책

**수정판이 있는 high·critical 취약점만 막는다.** 수정판이 없는 발견은 보고만 하고 실패시키지 않는다.

- **무엇을 보나.** 세 이미지(Grype, Debian 패키지와 `/app`의 npm 패키지)와 `bun.lock` 전체(`bun audit`, dev 의존성 포함)다. "수정판이 있다"는 이미지에서는 Grype의 `fix.state`가 `fixed`인 것이고, npm에서는 GitHub advisory database에서 잠긴 버전을 포함하는 범위에 `first_patched_version`이 있는 것이다. Debian의 `not-fixed`·`wont-fix`와 수정판 없는 npm advisory는 막지 않는다.
- **어디서 막나.** images.yml의 `supply-chain` job이 판정하고, branch protection의 required check다. PR, main push, 매일 03:17 UTC 실행, 수동 실행, `v*` tag에서 모두 돈다. tag의 `publish`는 `supply-chain`을 기다리고, 승격할 digest를 다시 검사해 같은 기준으로 막는다.
- **검사가 답을 못 받으면.** Grype DB나 advisory 서비스가 응답하지 않은 `error`는 PR과 main push에서 경고만 남긴다. 외부 서비스 장애로 모든 머지가 멈추면 안 되기 때문이다. 매일 실행과 tag에서는 실패한다. 이미지가 빌드되지 않아 결과가 아예 없으면 어디서든 실패한다.
- **보고.** 수정판 없는 high·critical도 각 검사의 step summary(접힌 목록)와 `supply-chain-results` artifact(검사마다 JSON 하나, 항목마다 `fix`가 null)에 남는다. 매일 실행이나 수동 실행이 실패하면 `ci-supply-chain` 라벨 이슈가 열린다.
- **밤사이 새 advisory.** 수정판이 있는 advisory가 새로 나오면 main을 포함해 모든 PR의 `supply-chain`이 한꺼번에 빨개진다. 의도한 동작이다. 의존성이나 base를 올리는 PR 하나로 푼다. Debian 패키지는 다음 날의 `APT_UPGRADE_KEY`로 새 빌드가 받는다. 당일에 받으려면 수동 실행(`gh workflow run Images`)이 그날 key로 빌드한다.
- **예외.** 올릴 수 없는 수정(예: `upgrade`가 보류한 Debian 패키지, 코드 경로가 닿지 않는 advisory)은 `.github/vulnerability-exceptions.json`에 `{"id", "package", "reason", "expires"}`로 적는다. `id`는 검사 결과의 `id`(CVE-… 또는 GHSA-…), `package`는 패키지 이름이다. `reason`과 `expires`(YYYY-MM-DD, 그날까지 적용)가 없으면 npm 검사가 `error`가 된다. 만료되면 다시 막는다. 예외는 PR 리뷰를 거친다.

```bash
bun .github/scripts/npm-audit.ts /tmp/sc && cat /tmp/sc/npm.txt   # npm 판정을 로컬에서
.github/scripts/supply-chain-verdict.sh /tmp/sc warn              # 결과 파일 넷(control-host·worker·egress-proxy·npm)의 판정
```

제3자 고지(`THIRD_PARTY_NOTICES.md`와 이미지마다 `/app/DEBIAN_SOURCES.md`)를 만드는 방법은 [ci.md](../contributing/ci.md)에 있다.

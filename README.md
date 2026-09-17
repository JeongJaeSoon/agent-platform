# Claude Code 세션 컨트롤 플레인

공식 TypeScript Claude Agent SDK로 세션을 제어하고, HTTP API·큐·이벤트·격리·영속화를 제공하는 플랫폼이다.

현재는 **G1 설계 확정, M0 기반 레이어, G2 SDK·저장소 gate, API 골격과 SDK adapter까지**다. API 키 인증과 `/v1` base path, 고정 SDK의 streaming·interrupt·abort·resume 경계는 구현됐지만 세션 endpoint와 워커 턴 처리 루프는 아직 구현하지 않았다. 전체 앱이나 Kubernetes가 동작한다고 해석하지 않는다.

## 정본과 다음 단계

- 작업 순서·상태·인수 조건: [Linear 프로젝트](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)의 native blocked-by 관계
- 구조·runtime 계약·검증 계획: [설계서](docs/DESIGN.md)
- 완료된 SDK gate: [94S-91](https://linear.app/94soon/issue/94S-91), 저장 backend 선택: [94S-92](https://linear.app/94soon/issue/94S-92)
- process-level 조사 harness와 검증 범위는 [`spikes/94s-91`](spikes/94s-91/README.md), [`spikes/94s-92`](spikes/94s-92/README.md)에 둔다.

## 현재 구현 범위

| 경로 | 구현된 기반 |
|---|---|
| `packages/contracts` | Zod API·이벤트·큐 계약 |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/queue` | PostgreSQL durable queue·이벤트·lease, Redis placeholder |
| `packages/storage` | S3 transcript와 git 저장·복원 primitive |
| `packages/observability` | 구조화 로깅·메트릭·트레이싱 기반 |
| `apps/api` | Hono `/v1` 골격, API 키 인증, strict zod 검증·에러 응답, 키 발급 CLI |
| `apps/worker` | Claude Agent SDK 0.3.270 adapter, 승인 profile·최소 환경, native envelope·SSE projection, 제어 가능한 fake |
| `infra/docker-compose.yml` | Postgres·LocalStack·Gitea와 one-shot migration |

immutable checkpoint manifest와 authoritative pointer, typed pending requests, SDK 기반 resume은 후속 확장이다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

## 현재 실행 가능한 검증

저장소 루트에서 Bun 1.3.10과 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다.

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 workspace typecheck → Biome → 패키지·앱 Bun 테스트다. `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. API의 실제 PostgreSQL·키 CLI·HTTP 프로세스 검증은 CI와 로컬에서 별도 명령으로 실행한다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다.

워커 adapter의 단위 테스트와 실제 SDK·로컬 fake Messages API 테스트는 분리해서 실행할 수 있다. 후자는 실제 번들 Claude Code subprocess를 띄워 같은 process의 후속 턴과 새 process의 resume을 확인하지만 유료 모델 API는 호출하지 않는다.

```bash
bun run --cwd apps/worker test:unit
bun run --cwd apps/worker test:direct-local
bun test spikes/94s-91/src/litellm-transport.test.ts
```

```bash
QUEUE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun test ./apps/api/src/server.integration.ts
```

로컬 의존 서비스만 기동하려면 다음을 사용한다. 기본 포트 5432·4566·3001·2222가 이미 사용 중인지 먼저 확인한다.

```bash
docker compose -f infra/docker-compose.yml up -d postgres localstack gitea
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml run --rm migrate
```

기존 환경 파일이나 volume을 덮어쓰거나 삭제하지 않는다. host에서 실행하는 테스트는 컨테이너 DNS 이름이 아니라 host에 공개된 endpoint를 사용한다. PostgreSQL integration fixture는 임시 DB 생성 권한이 필요하므로 전용 로컬 테스트 DB만 지정한다. LocalStack fixture는 `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`의 로컬 테스트 설정을 요구한다. 운영 DB·운영 credential로 실행하지 않는다.

API를 로컬 인증 비활성 모드로 띄울 때만 `X-Owner-Id`를 사용할 수 있다. 이 모드는 기동 시 경고를 출력하며 기본값이 아니다.

```bash
AUTH_MODE=none PORT=3000 bun run --cwd apps/api start
curl -H 'X-Owner-Id: local-owner' http://127.0.0.1:3000/v1
```

API 키 모드는 migration을 적용한 전용 로컬 DB에서 키를 한 번 발급한 뒤 사용한다. CLI는 평문 키를 발급 순간 한 번만 출력하고 DB에는 SHA-256 digest만 저장한다.

```bash
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/api keys create local-owner
AUTH_MODE=api-key DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/sessions \
  bun run --cwd apps/api start
curl -H 'Authorization: Bearer <issued-key>' http://127.0.0.1:3000/v1
```

Compose의 `apps`·`worker` profile은 아직 없는 Dockerfile을 참조하는 placeholder다. 현재 활성화하지 않는다. `FAKE_SDK`, `scripts/dev`, `/ui`, 세션 HTTP endpoint, 이미지 빌드 workflow는 후속 티켓 범위다.

## SDK와 LiteLLM 방향

워커는 `apps/worker/src/sdk-adapter.ts` 경계 안에서만 `@anthropic-ai/claude-agent-sdk`를 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리하며, endpoint와 model alias를 allowlist로 검증한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. 설정·인증·버전·모델 alias와 검증 조건은 [설계서 §9](docs/DESIGN.md#9-dockerfile)에 둔다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 제품 adapter의 direct-local suite는 SDK 0.3.270과 번들 Claude Code 2.1.270을 확인한다. 94S-91 transport gate는 LiteLLM 1.100.1의 header·cache·error·timeout·cancel 전달을 별도로 확인한다. 아직 워커 턴 루프나 배포 검증을 대신하지 않는다.

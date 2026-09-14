# Claude Code 세션 컨트롤 플레인

공식 TypeScript Claude Agent SDK로 세션을 제어하고, HTTP API·큐·이벤트·격리·영속화를 제공하는 플랫폼이다.

현재는 **G1 설계 확정 이력과 M0 기반 레이어 구현까지**다. Agent SDK를 사용하는 방향은 설계에 반영했지만 SDK 의존성, API app, 워커 실행 루프는 아직 구현하지 않았다. 전체 앱·SDK·LiteLLM·Kubernetes가 동작한다고 해석하지 않는다.

## 정본과 다음 단계

- 작업 순서·상태·인수 조건: [Linear 프로젝트](https://linear.app/94soon/project/claude-code-세션-컨트롤-플레인-f8420358ae56)의 native blocked-by 관계
- 구조·runtime 계약·검증 계획: [설계서](docs/DESIGN.md)
- 다음 SDK gate: [94S-91](https://linear.app/94soon/issue/94S-91), 저장 backend 선택: [94S-92](https://linear.app/94soon/issue/94S-92). 해당 선행 결론 없이 SDK 구현을 완료로 표시하지 않는다.
- 94S-91의 process-level 조사 harness와 현재 검증 범위는 [`spikes/94s-91`](spikes/94s-91/README.md)에 둔다.

## 현재 구현 범위

| 경로 | 구현된 기반 |
|---|---|
| `packages/contracts` | Zod API·이벤트·큐 계약 |
| `packages/db` | Drizzle 스키마·migration·세션 claim 및 상태 쿼리 |
| `packages/queue` | PostgreSQL durable queue·이벤트·lease, Redis placeholder |
| `packages/storage` | S3 transcript와 git 저장·복원 primitive |
| `packages/observability` | 구조화 로깅·메트릭·트레이싱 기반 |
| `infra/docker-compose.yml` | Postgres·LocalStack·Gitea와 one-shot migration |

immutable checkpoint manifest와 authoritative pointer, typed pending requests, SDK 기반 resume은 후속 확장이다. 기존 storage primitive를 완성된 SDK checkpoint로 간주하지 않는다.

## 현재 실행 가능한 검증

저장소 루트에서 Bun 1.3.10과 Git을 사용한다. 실서비스 의존 검증에는 Docker와 Compose도 필요하다.

```bash
bun install --frozen-lockfile
bun run check
```

`check`는 다섯 패키지 typecheck → Biome → Bun 테스트다. `QUEUE_DATABASE_URL`이 없으면 실제 PostgreSQL integration test가, `STORAGE_LOCALSTACK_TEST=1`이 없으면 LocalStack integration test가 skip된다. 전체 pass 숫자만 보지 말고 실행·skip 목록을 구분한다.

로컬 의존 서비스만 기동하려면 다음을 사용한다. 기본 포트 5432·4566·3001·2222가 이미 사용 중인지 먼저 확인한다.

```bash
docker compose -f infra/docker-compose.yml up -d postgres localstack gitea
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml run --rm migrate
```

기존 환경 파일이나 volume을 덮어쓰거나 삭제하지 않는다. host에서 실행하는 테스트는 컨테이너 DNS 이름이 아니라 host에 공개된 endpoint를 사용한다. PostgreSQL integration fixture는 임시 DB 생성 권한이 필요하므로 전용 로컬 테스트 DB만 지정한다. LocalStack fixture는 `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`의 로컬 테스트 설정을 요구한다. 운영 DB·운영 credential로 실행하지 않는다.

Compose의 `apps`·`worker` profile은 아직 없는 Dockerfile을 참조하는 placeholder다. 현재 활성화하지 않는다. `.env.example`의 앱 설정 역시 예약된 예시이며 `FAKE_SDK`를 포함한 SDK 모드 설정의 실제 구현은 후속 티켓에서 정리한다. `scripts/dev`, `/ui`, HTTP API, 이미지 빌드 workflow는 아직 없다.

## SDK와 LiteLLM 방향

워커는 `@anthropic-ai/claude-agent-sdk`를 직접 호출한다. provider는 Anthropic 직접 연결 또는 승인된 LiteLLM Anthropic Messages endpoint를 거쳐 **Claude 모델**로 연결하는 profile로 분리한다. LiteLLM은 M0 필수 서비스가 아니며 non-Claude 모델 호환은 지원 범위가 아니다. 설정·인증·버전·모델 alias와 검증 조건은 [설계서 §9](docs/DESIGN.md#9-dockerfile)에 둔다.

검증은 adapter fake, 실제 SDK + local fake Messages API, 실제 LiteLLM proxy + local fake upstream, 별도 승인된 paid Claude smoke를 구분한다. 현재 CI는 M0 `bun run check`이며 이러한 미래 runtime suite나 배포 검증을 대신하지 않는다.

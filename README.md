# Agent Platform (코드명 Kollegium) — 세션 컨트롤 플레인

공식 TypeScript Claude Agent SDK로 에이전트 세션을 실행하고, 그 세션을 HTTP API·이벤트 스트림·권한 요청·제어(interrupt·pause·resume·terminate·복구)·checkpoint 복원으로 다루게 하는 플랫폼이다. 세션마다 격리된 worker 컨테이너에서 Claude Code가 돈다.

**private alpha는 신뢰된 내부 인원 한정이다.** provider key, 저장소 credential, object store credential은 worker에 가지 않지만([94S-252](https://linear.app/94soon/issue/94S-252), [94S-251](https://linear.app/94soon/issue/94S-251)), attempt가 살아 있는 동안은 그 attempt의 egress token으로 proxy를 거쳐 provider와 저장소, 자기 세션 prefix 안의 object를 부를 수 있다. 외부 공개 전에 [94S-253](https://linear.app/94soon/issue/94S-253)을 닫는다.

## 로컬에서 시작하기

Docker Engine 28 이상과 Docker Compose v2(2.24 이상)가 있으면 저장소 루트에서 스택을 띄우고 API key를 받는다. 모델 계정은 필요 없다. 예시 카탈로그는 compose의 fake Messages API를 쓴다.

```bash
scripts/local.sh up
scripts/local.sh key quickstart \
  --scopes sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover
```

그다음 curl로 세션 한 바퀴를 도는 절차, 포트 점검, 정리는 **[docs/quickstart.md](docs/quickstart.md)**에 있다.

## 문서

| 읽는 사람 | 문서 | 내용 |
|---|---|---|
| 로컬에서 처음 돌려 보는 사람 | [docs/quickstart.md](docs/quickstart.md) | 준비물, `scripts/local.sh`로 기동·key, curl로 세션 한 바퀴, 정리, 막혔을 때 |
| 자기 Anthropic key로 실제 Claude를 붙이는 사람 | [docs/real-claude.md](docs/real-claude.md) | real-model e2e 한 번, `scripts/local.sh up --real-model`로 직접 대화, 비용 |
| test-ops 운영자 | [docs/test-ops.md](docs/test-ops.md) | `scripts/test-ops.sh`로 배포·업그레이드·백업·복원 훈련, 감시 지점 |
| 운영자 | [docs/operations.md](docs/operations.md) | scheduler·reconciler, worker 격리·egress, workspace 상한, 카탈로그, 설치 상한, 이미지 |
| 운영자 | [docs/backup-restore.md](docs/backup-restore.md) | 설치 백업, 새 project로 복원, 검증 |
| 개발자 | [docs/development.md](docs/development.md) | `bun run check`, integration opt-in 변수, 의존 서비스만 띄우기, e2e·gate·soak 진입점 |
| 개발자 | [docs/ci.md](docs/ci.md) | CI job별 실행 내용, required check, 수동 실행 |
| 설계를 읽는 사람 | [docs/architecture.md](docs/architecture.md) | 구성요소와 경계, checkpoint 경로, SDK·LiteLLM 방향 |
| API 사용자 | [docs/openapi.json](docs/openapi.json) | 공개 `/v1` API 계약(`packages/contracts`에서 생성) |

## 라이선스

이 저장소는 **source-available이지 오픈소스가 아니다.** 읽고 감사할 수 있도록 공개할 뿐,
공개 자체가 사용권을 주지 않는다. 실행·복제·수정·배포와 이 소프트웨어를 이용한 서비스
제공은 저작권자의 사전 서면 허가가 있어야 한다. 전문은 [LICENSE](LICENSE)에 있다.

기여는 지금 받지 않는다. 외부 기여가 섞이면 저작권자가 이 소프트웨어를 상용으로
라이선스할 수 있는 여지가 좁아지기 때문이다.

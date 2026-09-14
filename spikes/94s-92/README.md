# 94S-92 SessionStore 복구 백엔드 게이트

## 결론

고정 Agent SDK `0.3.270`의 `SessionStore`를 G2의 **단일 transcript backend로 채택**한다. 단, SDK mirror의 최신 상태를 곧바로 checkpoint로 보지 않는다. S3에 기록된 immutable part 목록과 각 SHA-256을 exact revision으로 고정하고, 이 revision과 workspace git SHA, `cwd`, SDK/Claude Code 버전, allowlist config profile fingerprint를 하나의 immutable manifest로 묶은 뒤에만 복구 정본으로 승격한다.

M0 filesystem snapshot은 신규 세션의 병행 write backend로 유지하지 않는다. 읽기 전용 legacy importer와 rollback 입력으로만 보존한다. 기존 `meta.json`에는 workspace git SHA가 없으므로 transcript와 branch HEAD가 같은 시점이라고 검증할 수 없고, 자동으로 `consistent` 판정을 내리지 않는다.

## 선택 근거

- 공식 `SessionStore`는 root transcript와 `subpath` 기반 subagent transcript를 같은 SDK resume 경로로 복원한다. 고정 버전의 실제 subprocess를 두 번 띄우고 두 번째 프로세스에 새로운 `CLAUDE_CONFIG_DIR`를 제공했을 때 LocalStack에서 첫 turn 문맥을 읽어 재개했다.
- SDK는 terminal `result`를 iterator에 전달하기 전에 pending mirror batch를 flush한다. 따라서 애플리케이션은 같은 turn에서 먼저 전달된 `system/mirror_error`를 기록하고, 오류가 있으면 checkpoint publish를 fail-close할 수 있다.
- mirror는 best-effort다. append reject는 세 번까지 시도한 뒤 `mirror_error`를 내고 agent 실행은 성공할 수 있으며, timeout은 결과가 늦게 반영될 수 있다. 후보 adapter는 UUID가 같은 deep-equal entry를 한 번만 복원하고, 같은 UUID의 payload가 다르면 손상으로 거절한다.
- store의 최신 suffix는 계속 늘어날 수 있다. checkpoint revision은 capture 시점의 exact part key와 hash만 포함하며, 이후 suffix를 `loadRevision()`에서 보지 않는다.
- `resume` 대상이 store에 없으면 SDK는 로컬 fallback을 시도한다. 제품 경로는 manifest의 exact revision을 먼저 검증·materialize하고, 누락이면 SDK를 실행하지 않은 채 claim을 실패시켜야 한다. 테스트의 빈 config에서는 `No conversation found`로 실패했고 새로운 API turn은 발생하지 않았다.
- store resume용 임시 config는 SDK가 종료 시 삭제한다. host 설정 복사를 안전하다고 가정하지 않고, worker가 owner/session별 allowlist config root를 SDK의 원본 config로 제공한다.

공식 계약과 비교 기준:

- [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [TypeScript conformance suite](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/shared/conformance.ts)
- [공식 S3 예제](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/s3/src/S3SessionStore.ts)

## 고정 계약

### 안전 경계와 publish 순서

60초 timer는 checkpoint 요청만 만든다. 아래 조건이 모두 성립하기 전에는 새 generation을 만들지 않는다.

1. pending Edit/Bash/tool callback과 등록된 background writer를 종료하거나 안전 지점까지 기다린 뒤, CAS 완료·실패까지 새 writer 시작을 거절하는 배타적 checkpoint lease를 잡는다.
2. SDK terminal `result` 직전 mirror flush가 끝나고 해당 turn에 `mirror_error`가 없음을 확인한다.
3. workspace를 commit/push해 exact git SHA를 얻는다.
4. root와 모든 `listSubkeys()` subagent transcript의 exact S3 part key·SHA-256 revision을 capture하고 다시 읽어 검증한다.
5. git SHA, transcript revisions, `cwd`, SDK `0.3.270`, Claude Code `2.1.270`, secret을 제외한 config profile fingerprint를 immutable manifest에 쓴다.
6. 현재 owner/pod와 previous generation을 조건으로 Postgres pointer를 CAS한다.

1~5에서 실패하거나 6의 CAS가 실패하면 이전 pointer를 유지한다. branch HEAD, 최신 mirror object, 미완료 manifest를 서로 조합해 resume하지 않는다.

### 실패 계약

| 상황 | 관찰 | G2 계약 |
|---|---|---|
| 동일 UUID 재전달 | timeout/retry로 part가 여러 개 생길 수 있음 | deep-equal이면 한 번만 복원, payload 충돌이면 손상 오류 |
| append reject | 세 번 시도 후 `mirror_error`, agent `result.success` 가능 | 해당 turn의 suffix를 승격하지 않음 |
| append timeout | 늦은 원 요청과 retry가 모두 반영될 수 있음 | UUID dedup 후에도 `mirror_error`가 있으면 승격 금지 |
| process kill | flush 중이면 result/checkpoint 없음 | 이전 generation만 사용 |
| manifest/object 누락·hash 불일치 | exact revision 검증 실패 | SDK 시작 전 claim 실패, quiet new session 금지 |
| 같은 `/workspace`의 두 session | 동일 project key를 공유 | `sessionId` namespace로 완전 분리 |

### M0 migration과 rollback

M0 `meta.json`과 transcript object bytes는 unknown field를 포함해 그대로 읽고 보존한다. importer는 `legacy_unverified/missing_workspace_git_sha`로 분류하고 원래 key·branch를 수정하거나 삭제하지 않는다. 전환 시 quiescent workspace의 새 exact git SHA와 lossless하게 가져온 전체 transcript revision을 새 generation에 기록한 뒤 CAS한다. CAS 전에는 legacy reader로 롤백할 수 있고, CAS 뒤에도 이전 object와 branch는 삭제 티켓 전까지 유지한다. 과거 M0 쌍 자체가 원래 일관됐다는 보장은 소급해 만들지 않는다.

## 실행

```bash
bun install --cwd spikes/94s-92 --frozen-lockfile
bun run --cwd spikes/94s-92 typecheck
bun run --cwd spikes/94s-92 test:unit
docker compose -f infra/docker-compose.yml up -d --wait localstack
SESSION_STORE_LOCALSTACK_TEST=1 \
AWS_ENDPOINT_URL=http://127.0.0.1:4566 \
AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
S3_BUCKET=claude-sessions \
bun run --cwd spikes/94s-92 test:localstack
```

검증 범위는 공식 13개 conformance, UUID duplicate/conflict, root/subpath/order/isolation, exact revision과 손상 거절, quiescence/publish/CAS 순서, M0 lossless read, 실제 LocalStack, 새 config·새 subprocess resume, reject/timeout/missing-load/process-kill 주입이다. 이 spike의 adapter와 publish coordinator는 계약 증명용이며 제품 연동은 94S-93에서 구현한다.

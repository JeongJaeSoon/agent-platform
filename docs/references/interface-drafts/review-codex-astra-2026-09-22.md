# Interface & Collaboration 적대적 설계 리뷰

**판정: 설계 확정 보류. 구체적 발견 72건이며, Blocker 20건·Major 49건·Minor 3건이다.**

가장 큰 문제는 **다인 권한 모델, 세션 밖 receipt, release의 실행 정책 고정, 협업의 worker 계약, UI의 완료 판정**이다. 여기에 I1 digest와 I4 summarizer의 역방향 의존이 있어, 현재 문서대로는 선언한 병렬 레인을 유지하기 어렵다.

검토 기준은 현재 체크아웃 `b2c5f18`의 문서와 코드다. 테스트·migration·브라우저·실제 Slack·worker 실행은 수행하지 않았다. 현재 코드에 미래 기능이 없다는 사실만을 결함으로 세지 않고, **설계가 현재 계약을 잘못 전제하거나 필요한 확장·책임을 정의하지 않은 경우**를 지적했다.

`04 구현 계획·phase` 원문은 제공된 `review-input`과 저장소 파일 목록에서 찾지 못했다. D는 00a와 03의 phase 언급, 상세 초안의 티켓 분할을 기준으로 검토했다. Linear의 현재 상태·native dependency는 조회하지 않았으므로 티켓 완료 여부를 단정하지 않는다.

문서 인용 약칭:

| 약칭 | 파일 |
|---|---|
| 00a | [설계 접근 비교](</Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/review-input/00a 설계 접근 비교.md>) |
| 01 | [Brief·PRD](</Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/review-input/01 Brief·PRD.md>) |
| 02 | [UX 설계](</Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/review-input/02 UX 설계.md>) |
| 03 | [아키텍처·DD](</Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/review-input/03 아키텍처·DD.md>) |
| Dispatch | [dd-dispatch.md](/Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/dd-dispatch.md) |
| Port | [port-kollegium.md](/Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/port-kollegium.md) |
| Memory | [memory-bench.md](/Users/dev-soon/orca/workspaces/agent-platform/whiting/docs/references/interface-drafts/memory-bench.md) |

## A. 요구사항 분석 — 14건

### A01. 계정 복구와 유일한 관리자 상실 시나리오가 없다 — Major

01 U01·FR-01과 03 §3.3은 bootstrap·login·logout·invite까지만 정의한다. 비밀번호를 잊거나 유일한 owner가 비활성화되면 정상 복구 경로가 없다. bootstrap은 `users=0` 조건이라 재사용할 수도 없다.

**추가 시나리오:** 유일한 관리자가 로그인할 수 없을 때 운영자 증명을 거쳐 계정을 복구하고, 기존 세션을 폐기하며, 복구 이력을 남긴다. 일반 비밀번호 재설정과 설치 운영자의 긴급 복구를 구분해야 한다.

### A02. 초대 만료는 있지만 재발급·기존 계정·동시 수락 계약이 부족하다 — Major

초대 만료·재발급 자체는 이미 U01에 있다. 빠진 것은 다음 경합이다. 03 §3.3은 수락을 “비밀번호 설정 + 멤버십”으로 설명하므로, 이미 같은 이메일 계정이 있는 경우 비밀번호를 재설정하는지 불명확하다.

**추가 시나리오:** 재발급 후 옛 링크 수락, 회수와 수락 동시 실행, 두 탭에서 수락, 기존 계정으로 다른 workspace 초대 수락. 기존 계정의 인증 정보를 초대 수락으로 덮어쓰지 않고, 유효한 초대 하나만 원자적으로 소비해야 한다.  
근거: 01 U01; 03 §3.1 초대 테이블·§3.3.

### A03. 역할 변경·탈퇴·비활성화의 효과 범위가 없다 — Major

03 §3.3은 멤버 역할 변경·비활성화를 제공하지만, 데이터 모델에는 전역 `users.disabledAt`만 있고 membership 비활성 상태가 없다. 한 workspace에서 내보내는 것과 계정 전체를 정지하는 것이 구분되지 않는다.

**추가 시나리오:** 마지막 owner 강등 거절, 소유권 이전, workspace 탈퇴, 멤버 제거 직후 기존 웹 세션·Slack 입력·승인 카드·열린 SSE의 권한 재검사.  
근거: 01 §3; 03 §3.1, §3.3.

### A04. 세션 공유와 과거 대화 공개에 대한 사용자 동의가 없다 — Major

U06은 여러 사람이 같은 Slack 스레드를 사용한다고만 한다. 기존 개인 세션을 팀 채널에 연결할 때 과거 대화·도구 인자·산출물까지 공개하는지는 별도 결정이다.

**추가 시나리오:** 세션 소유자가 공유 대상과 `full/summary` 범위를 검토하고 연결하며, 새 참여자에게 과거 이력 공개 범위를 표시한다. 공유 회수 후 새 출력의 전달을 막는다.  
근거: 01 U06·Session 정의; 03 §5 `session_links.visibility`; Port §5.4.

### A05. 다인 승인 경합을 중복 클릭 안전성으로 대체하고 있다 — Major

U04·U06의 “1회 적용”만으로는 A의 승인과 B의 거절이 동시에 들어오는 상황을 정의하지 못한다. 동일 사용자의 동일 요청 재전송과 서로 다른 유효 결정의 경합은 다르다.

**추가 시나리오:** 웹 승인과 Slack 거절이 동시에 도착하면 첫 유효 결정을 원자적으로 확정하고, 패자에게 확정된 결정과 처리 시각을 보여준다. 이미 처리된 요청을 새 key로 다시 보내도 결정이 바뀌지 않아야 한다.  
근거: 01 U04·U06; 02 §3 승인 카드; 03 §5 마지막 항목.

### A06. API key와 cookie 동시 사용의 사용자 계약이 불완전하다 — Major

FR-01은 공존을 요구하고 03 §3.2는 Bearer 우선순위를 정한다. 하지만 유효하지 않은 Bearer와 유효한 cookie가 함께 있을 때의 실패 정책, 서로 다른 workspace를 가리킬 때의 결과, 감사 actor는 정하지 않았다.

**추가 시나리오:** 두 자격 증명의 권한을 합치지 않고 선택된 인증 방식만 사용한다. 잘못된 Bearer를 cookie로 조용히 대체하지 않으며 `/auth/me`에서 선택된 principal을 확인할 수 있어야 한다.  
근거: 01 FR-01; 03 §3.2, 98–104행.

### A07. workspace 보관·삭제 시나리오가 없다 — Major

Workspace는 세션·기억·산출물의 귀속 단위인데 종료 수명주기가 없다. 삭제 중 루틴이 새 세션을 만들거나 outbox가 결과를 발송하는 상황을 처리할 기준이 없다.

**추가 시나리오:** owner가 먼저 보관하여 신규 접수를 막고, 실행·pending·루틴·전달 작업을 처리한 다음 보존 정책에 따라 삭제한다. 재시도되는 외부 이벤트가 삭제된 workspace를 재생성하지 않아야 한다.  
근거: 01 §4 Workspace·FR-17; 03 §3·§9.

### A08. 감사 로그를 사람이 열람하는 요구사항이 없다 — Major

03 §4.1은 receipt에 actor를 남기고 §7은 override 로그를 남긴다. 그러나 누가 어느 승인을 했는지, 누가 release를 활성화했는지 사람이 찾는 화면·조회 API·접근 권한은 없다.

**추가 시나리오:** owner가 actor·resource·기간·작업으로 검색하고 원 요청, 결정, receipt, 결과를 연결해 본다. 일반 멤버가 볼 수 있는 감사 범위와 민감한 payload의 가림 규칙을 별도로 정한다.  
근거: 01 FR 목록; 02 §2 IA; 03 §4.1, §7.

### A09. 제품 데이터 내보내기와 삭제 후 재수집 방지 요구가 없다 — Major

03 §9의 Markdown export/import는 기억 문서의 부가 기능일 뿐, 세션·승인·release·산출물·출처를 함께 내보내는 제품 계약이 아니다.

**추가 시나리오:** 권한 있는 사용자가 선택한 범위만 manifest와 함께 export한다. 원문 권한이 없는 lineage는 제목까지 숨기며, 삭제한 기억을 import·요약 job이 다시 활성화하지 않게 한다.  
근거: 01 U07·U08; 03 §9; Memory §6 후속 작업.

### A10. “매일 09:00”의 시간 의미가 빠졌다 — Major

U09·FR-17은 일정 종류와 중복 fire 방지만 정의한다. timezone 변경, DST, 서버 중단 후 누락 실행, 이전 실행과의 중첩 여부가 없어서 같은 일정으로 다른 실행 수가 나올 수 있다.

**추가 시나리오:** timezone을 명시해 저장하고, 누락 실행을 건너뛰거나 한 번 보충하는 정책과 중첩 허용 여부를 표시한다. fire의 멱등 키는 명목상 예약 시각에 결합한다.  
근거: 01 U09·FR-17; 03 §9 루틴.

### A11. 루틴의 실행 주체와 권한 회수 시나리오가 없다 — Major

01 §3은 운영 자동화를 사용자 역할로 분류하지만 03 `Principal`에는 사용자와 API key만 있다. 루틴 생성자가 탈퇴하거나 release가 회수된 뒤에도 예약이 실행되는지 결정되지 않았다.

**추가 시나리오:** 루틴별 서비스 주체·승인자·권한 상한을 기록하고 매 fire에 재검사한다. 생성자 제거, profile 회수, 알림 대상 권한 변경 시 실행 보류와 운영자 조치를 보여준다.  
근거: 01 §3·U09; 03 §3.2, §9.

### A12. 성공 지표가 실패 정책과 충돌하며 안전성을 측정하지 못한다 — Major

01 §7의 journal 자동 생성률 100%는 03 §11의 비용 초과 시 요약 생략과 그대로는 양립하지 않는다. `needs_confirm <30%`, override `<15%`도 위험한 자동 배정을 많이 해도 달성할 수 있다.

**수정:** eligible turn·측정 기간·제외 사유를 정의하고, journal 지연/실패/생략을 분리한다. dispatch는 오배정·권한 위반·파괴적 자동 적용의 기준을 출시 gate에 포함한다. Dispatch §9.3의 평가 기준을 PRD 지표에 연결해야 한다.

### A13. 비용 표시의 범위와 차단 정책이 불분명하다 — Major

U12는 세션·workspace 비용과 429 집행 출처 일치를 요구한다. 반면 NFR-07·03 §11은 classifier·summarizer에 별도 예산을 두고, 03 §7의 kill switch는 503이다.

**추가 시나리오:** worker·classifier·summarizer 비용을 포함하는 총액과 부분합, 미확정 사용량, 비용 상한·backlog 상한·운영 중지 사유를 구분한다. 비용을 모르는 경우 0으로 표시해서는 안 된다.  
근거: 01 U12·NFR-07; 03 §7·§11.

### A14. 정정 승인 후 규칙이 언제 적용되는지 모순될 여지가 있다 — Major

U07은 승인 후 “카드에 반영”된다고 한다. 03 §9는 새 version 생성까지만 정의하고, U02는 새 release가 새 세션에만 적용된다고 한다. 승인 직후 현재 세션 행동이 바뀐다고 사용자가 이해하기 쉽다.

**추가 시나리오:** 규칙 승인→새 version→release 활성화→새 세션 적용을 구분한다. 현재 세션에는 기존 pin이 유지됨을 표시하고, 규칙 승인과 release 활성화가 같은 행위인지도 확정한다.  
근거: 01 U02·U07; 03 §4.1·§9.

## B. 아키텍처·계약 결함 — 20건

### B01. 새 Principal은 현재 서비스 계약에 들어갈 수 없다 — Blocker

03 §3.2의 사용자 principal에는 `ownerId`가 없다. 현재 `Principal`은 `{ ownerId: string }`이고, 서비스는 생성·목록에서 `actor.ownerId`를 직접 사용한다.

따라서 미들웨어에서 타입만 교체하면 서비스·reader·UoW까지 연결되지 않는다. **인증 주체, 감사 actor, 저장소 owner, workspace scope를 분리한 공통 authorization context**와 이전 경로 어댑터가 필요하다.  
코드: `packages/platform/src/authorization/policy.ts:1–15`, `packages/platform/src/sessions/session-service.ts:84–100,118–123`, `packages/platform/src/ports/session-unit-of-work.ts:37–45`.

### B02. Session 참여 ACL의 저장·조회 계약이 없다 — Blocker

01 §4는 Session에 참여 ACL이 있다고 정의하고 03 §5는 입력마다 발신자 ACL을 검사한다고 한다. 그러나 03 데이터 모델에는 session membership/Grant 관계가 구체화되지 않았다.

현재 reader는 목록과 상세를 모두 `sessions.ownerId`로 제한한다. 이를 그대로 두면 다른 참여자가 접근하지 못하고, 단순히 owner 필터를 없애면 과도하게 공개된다. **Grant 저장 모델과 목록·상세·pending·receipt·digest의 동일한 접근 predicate**를 I0에서 확정해야 한다.  
코드: `packages/db/src/postgres-unit-of-work.ts:213–225,249–257`; 보완 근거: Port §5.1.

### B03. “모든 새 mutation에 기존 receipt”는 현재 receipt 형태로 불가능하다 — Blocker

03 §1은 auth·초대·Agent·memory 등에도 기존 receipt 규약을 적용한다. 현재 operation enum에는 세션 작업만 있고 `target_ref.session_id`가 필수다.

세션이 아직 없는 초대·Agent draft·dispatch 즉답을 정상적으로 표현할 수 없다. Dispatch §2.3은 dispatch 분기만 보완한다. **resource 종류별 receipt union, 조회 권한, 결과·revision 규약을 I0 공통 계약으로 승격**해야 한다.  
코드: `packages/contracts/src/api/receipt.ts:19–50`; `packages/db/src/schema.ts:169–188`.

### B04. 멱등성 principal의 이름 공간이 정의되지 않았다 — Major

현재 create UoW는 `principal.ownerId`를 idempotency principal로 저장한다. 03은 API key·사용자·Slack actor를 추가하지만 같은 key를 언제 같은 요청으로 볼지 정하지 않는다.

workspace 공용 owner를 그대로 쓰면 서로 다른 사람의 key가 충돌할 수 있다. 반대로 웹/Slack마다 별도 principal을 쓰면 같은 외부 이벤트의 중복은 따로 막아야 한다. **안정적인 principal 식별 형식과 인증 경로 간 replay 범위**를 정하고 기존 API key의 의미를 보존해야 한다.  
코드: `packages/db/src/postgres-unit-of-work.ts:38–59`; `packages/db/src/schema.ts:191–209`.

### B05. 세션 생성 선택자와 replay 시 release 해석 순서가 불완전하다 — Major

03 §4.1은 `agent_release_id`가 있으면 `profile_id`를 서버가 채운다고 한다. 둘을 함께 보냈을 때 거절할지, 일치 검증할지 정의하지 않는다. active release를 해석하는 상위 경로의 재시도에서도 같은 pin을 유지해야 한다.

현재 요청은 `profile_id` 필수 strict object이고 검증된 body 전체를 hash한다. **입력의 XOR/일치 규칙, 해석된 release snapshot 저장, 같은 key replay가 현재 active pointer보다 우선하는 순서**를 명시해야 한다.  
코드: `packages/contracts/src/api/session.ts:150–156`; `packages/platform/src/sessions/session-service.ts:89–100`.

### B06. fingerprint 저장만으로 immutable 실행을 보장하지 못한다 — Blocker

03 §4.1은 release에 profile fingerprint를 저장하지만 실행 시에는 profile ID를 사용한다. 동일 ID의 운영자 설정이 바뀐 뒤 retry/resume하면 어떤 설정을 사용하는지 상위 정본에 없다.

현재 catalog 해석은 profile ID의 현재 값을 읽고, worker는 전달된 현재 config를 검증한다. **versioned config snapshot 해석 또는 fingerprint 불일치 거절**, 현재 revoke 재검사를 구분해야 한다. Port §5.2의 규칙을 03의 필수 계약으로 올려야 한다.  
코드: `packages/platform/src/sessions/session-service.ts:64–70`; `apps/worker/src/profile.ts:37–55`.

### B07. Agent capabilities와 runtime 정책의 교집합 계산이 없다 — Blocker

03 `AgentCard`는 `tools=null`을 “profile 기본 전부”로 정의하고 `forbidden`도 받는다. 그러나 도구·MCP·금지 경로를 어떤 규칙으로 실행 config에 합성하는지 없다.

현재 worker의 강제 검사는 `config.tools`의 정확한 도구 이름 집합이다. 카드에 금지 문구를 넣는 것만으로 이 검사에 반영되지 않는다. **profile 상한 ∩ release 허용 ∩ 현재 Grant**, `null/[]` 의미, MCP 이름 해석, 금지 정책의 서버 집행 위치를 고정해야 한다.  
코드: `apps/worker/src/sdk-adapter.ts:104–122,127–146`; `apps/worker/src/runtime.ts:43–58`.

### B08. activation CAS는 있지만 참조 무결성과 전체 원자성이 부족하다 — Major

03 §4.1 CAS 예시는 `agents.id`와 revision만 검사한다. 지정한 version이 같은 Agent의 것인지, release가 같은 workspace에 속하는지, immutable row 생성과 pointer 갱신·감사가 한 transaction인지 명시하지 않는다.

현재 세션 수락은 여러 행을 하나의 transaction으로 묶는다. Agent도 같은 수준의 보장이 필요하다. **동일 Agent 참조 제약, 동시 version 번호 할당, insert-only 집행, release 생성+CAS+감사 원자성**을 필수 불변식으로 적어야 한다.  
근거: 03 §4.1, 122–175행; 코드: `packages/db/src/postgres-unit-of-work.ts:40–124`.

### B09. 공개 인증 route의 middleware 경계가 없다 — Major

03 §3.3은 `/v1/auth/bootstrap`, `/login`, 초대 수락을 추가하지만 공개 router와 인증 router의 분리를 설명하지 않는다.

현재는 `v1.use("*")` 인증 뒤에 모든 route를 등록한다. 같은 방식으로 추가하면 로그인·bootstrap 자체가 401이 된다. **정확한 공개 route allowlist와 인증 middleware 적용 경계**, webhook/OAuth callback의 별도 검증 경로를 설계해야 한다.  
코드: `apps/api/src/app.ts:141–176`.

### B10. bootstrap의 “한 번만”은 “설치한 사람이”를 보장하지 않는다 — Blocker

03 §3.2의 advisory lock과 `users=0` 검사는 동시 생성만 막는다. 네트워크에 노출된 설치에서 먼저 호출한 사람이 owner를 차지하지 못하게 하는 증명은 없다.

현재 인증 middleware를 우회하는 공개 bootstrap을 만들 경우 이 문제가 새로 생긴다. **설치 시 발급한 일회용 bootstrap secret 또는 동등한 로컬 운영자 증명**, 성공 후 폐기, 재사용 거절을 계약에 추가해야 한다.  
근거: 01 §3 관리자 정의; 03 §3.2, 105행; 코드: `apps/api/src/app.ts:141–166`.

### B11. 공유 transaction primitive 없이 split·Slack binding 원자성을 만족할 수 없다 — Blocker

03 §7의 split all-or-nothing, Port §3.2의 새 session+첫 turn+link+receipt 원자성은 같은 transaction을 요구한다.

현재 `acceptInputAtomic()`은 내부에서 자체 transaction을 연다. 이를 반복 호출하거나 새 route가 기존 HTTP API를 호출하면 전체 원자성이 생기지 않는다. **transaction을 받는 내부 acceptance primitive와 기존 public wrapper의 분리**를 I1 이후 공통 선행 작업으로 지정해야 한다.  
코드: `packages/platform/src/ports/session-unit-of-work.ts:32–34`; `packages/db/src/postgres-unit-of-work.ts:38–40`; Dispatch §5.2.

### B12. digest 요약 입력으로 지정한 `result`에는 본문이 없을 수 있다 — Major

03 §6은 “마지막 assistant `result` + 사용자 입력”으로 요약한다고 한다. 현재 mapper의 `result` projection은 subtype·session ID·usage·오류 관련 필드를 내보내며 답변 본문을 보존하지 않는다.

따라서 이 이벤트만 읽는 summarizer는 실제 답변을 요약할 수 없다. **durable terminal turn과 연결된 assistant 이벤트 범위 또는 transcript manifest**를 입력으로 사용하고 출처 범위를 고정해야 한다.  
코드: `apps/worker/src/mapper.ts:87–102`; `packages/contracts/src/worker-protocol/index.ts:131–147`.

### B13. `needs_input(delegate)`는 기존 pending/answer 계약에 없다 — Blocker

03 §10은 동기 delegate에서 부모를 `needs_input(delegate)`로 대기시킨다. 현재 pending과 answer의 discriminant는 `permission|question`뿐이며 worker answer 전달도 이 schema를 사용한다.

`delegate`를 그대로 추가하면 기존 strict union과 맞지 않는다. **협업 대기 상태를 별도 WorkItem dependency로 둘지, 버전 있는 protocol 확장을 할지**, 부모 callback·재시작·취소 의미까지 결정해야 한다.  
코드: `packages/contracts/src/api/pending.ts:30–42`, `api/answer.ts:58–61`, `worker-protocol/index.ts:121–128`.

### B14. 공유 Room 한 Session에서 여러 release를 실행하는 계약이 없다 — Blocker

03 §10의 Room은 한 Session 안에서 release가 라운드마다 바뀐다. 반면 01 U02와 03 §4.1은 Session에 release를 pin한다.

현재 SDK query는 `start(config)`에서 한 번 만들어지고 이후 `send()`는 사용자 입력만 추가한다. **Room을 제품 수준 컨테이너와 agent별 child session으로 구성하거나, turn별 release·runtime 전환을 alpha 확장으로 정식 설계**해야 한다. active turn 1개만으로 이 충돌은 해결되지 않는다.  
코드: `apps/worker/src/sdk-adapter.ts:73–94,201–203`; `apps/worker/src/runtime.ts:7–10`.

### B15. WorkItem의 축소 권한·예산·부모 재개를 필드 선언만으로 약속한다 — Blocker

03 §10의 WorkItem에는 `budget`, `depth`가 있지만 호출 actor, 위임 Grant, 권한 snapshot/revision, 결과 수락 key, 부모 취소 후 callback 처리 규칙이 없다.

현재 worker 쓰기는 session·attempt·epoch·generation·auth revision에 결합된다. 자식 결과가 이 경계를 건너 부모를 재개하려면 별도 검증이 필요하다. **자식 생성 시 예산 예약, 부모 취소 전파, callback CAS, stale attempt 결과 거절, 부모 resume 의도와 결과 소비의 원자성**을 정의해야 한다.  
코드: `packages/contracts/src/worker-protocol/index.ts:21–30`; 근거: 01 U10, 03 §10.

### B16. Artifact 귀속과 파일 commit 경계가 부족하다 — Major

U08은 session·release·turn 귀속을 요구하지만 03 §9 artifact 스케치에는 release·attempt·checkpoint 기준이 없다. 재시도에서 같은 path가 덮어써졌을 때 어느 실행 결과인지 모호하다.

현재 public turn ID는 session 안의 sequence이고 DB FK는 전역 turn row ID다. finalize도 artifact manifest를 정의하지 않는다. **내부 FK와 공개 ID 변환, immutable object hash, attempt/release provenance, upload와 DB commit 사이 복구**를 추가해야 한다.  
코드: `packages/db/src/schema.ts:72–95`; `packages/contracts/src/worker-protocol/index.ts:131–142`.

### B17. 첨부 UX를 수용할 입력·worker 계약이 없다 — Major

02 §5는 업로드 receipt와 메시지 참조를 약속한다. 현재 메시지 요청은 `{message, mode}`이고 기본 schema가 strict이며, worker 입력도 문자열 메시지 중심이다.

따라서 업로드만 구현해도 실행 입력까지 이어지지 않는다. **attachment ID의 workspace/actor 검증, 업로드 완료 상태, 메시지 수락 transaction, worker 전달 형식, 삭제·만료 정책**을 설계해야 한다.  
코드: `packages/contracts/src/api/turn.ts:21–26`; `packages/contracts/src/worker-protocol/index.ts:61–69`; `apps/worker/src/runtime.ts:7–10`.

### B18. 기존 session의 workspace backfill이 권한 이전으로 변할 수 있다 — Blocker

03 §1은 기존 session에 nullable workspace를 추가하고 backfill한다고만 한다. 기존 owner가 여럿일 때 모두 기본 workspace에 넣으면 “작업 단위 추가”가 기존 비공개 데이터 공개로 변할 수 있다.

현재 session과 API key의 owner는 임의의 문자열이며 users FK가 아니다. **owner→workspace/사용자/service-owner mapping, 미매핑 legacy 경로, 소유권 이전 승인, 단계별 조회 정책**을 먼저 정해야 한다.  
코드: `packages/db/src/schema.ts:34–50,294–301`; `packages/db/src/postgres-unit-of-work.ts:220,256`.

### B19. 다인 입력의 actor provenance가 alpha 행에 연결되지 않는다 — Major

03 §4.1은 receipt에 actor를 남긴다고 하지만 현재 receipt에는 owner만 있고 turn에도 발신 actor가 없다. 공용 service owner로 Slack을 실행하면 “누가 지시했는가”가 사라질 수 있다.

Port §3.2는 inbox→turn FK나 typed provenance를 요구한다. 이를 웹·API까지 확장해 **각 turn·answer·control의 인증 주체와 인간 actor를 연결하는 공통 모델**을 정해야 한다.  
코드: `packages/db/src/schema.ts:72–89,169–178`; `packages/db/src/postgres-unit-of-work.ts:108–114`.

### B20. 서버 저장 개인화 요구에 대응하는 모델·route가 없다 — Major

02 §2는 기기 간 공유되는 사용자별 마지막 열람 시각을 요구하고, 03 §6은 `title_locked=true`를 사용한다. 그러나 제시된 schema에는 둘 다 없다. 현재 `sessions.pinned`는 사용자별 필드가 아닌 전역 값이다.

**사용자별 read marker·pin·정렬과 공유 session 제목을 구분**하고, 갱신 API·revision·workspace 전환 정책을 추가해야 한다. 같은 workspace의 다른 사용자가 핀과 미읽음을 덮어쓰지 않아야 한다.  
코드: `packages/db/src/schema.ts:56–57`; 문서: 02 §2, 03 §6.

## C. UX 계약 결함 — 14건

### C01. `result` 이벤트 수신을 완료 조건으로 쓰면 거짓 성공을 표시한다 — Blocker

02 §1.1은 완료를 서버 `result` 이벤트로 판단한다고 한다. 현재 `result`는 subtype이 자유 문자열이고 오류 결과도 담는다. durable terminal은 별도 finalize 계약이다.

**수정:** `result` 수신은 관측 결과로 처리하고 turn terminal·receipt·필요한 durability를 reconcile해 확정한다. 기존 설계도 승인 대기 abort에서 `success/completed` result만으로 성공 판정하지 말라고 명시한다.  
코드: `packages/contracts/src/api/event.ts:61–68`, `worker-protocol/index.ts:131–147`; [`docs/DESIGN.md:355`](https://github.com/JeongJaeSoon/agent-platform/blob/d6810caadca57db45640340c9ed5fae48b8ead71/docs/DESIGN.md#L355); UI §20.3.

### C02. 상태 표가 admission·turn·execution·receipt·delivery의 조합을 충분히 표현하지 못한다 — Major

02 §4.1은 서로 다른 축을 한 표에 나열하고 §8 `Receipt`는 접수/실행/대기/확정/전달 실패를 한 컴포넌트 의미로 묶는다.

예컨대 `pausing + running`, `receipt=succeeded + turn=queued`, `turn=completed + Slack delivery=unknown`은 정상적으로 가능한 서로 다른 조합이다. **축별 배지와 관찰 시각을 유지하고 대표 상태의 우선순위만 별도로 정의**해야 한다.  
코드: `packages/contracts/src/api/session.ts:22–64`; `api/receipt.ts:13–18`; UI §20.1.

### C03. 승인·질문 카드의 입력 계약이 너무 추상적이다 — Major

02 §3은 “답변(typed)”만 적는다. 현재 permission 거절은 reason이 필수이고 question은 복수 질문·multi-select·free text를 표현한다. pending도 여러 개일 수 있다.

**수정:** 거절 이유, 질문별 검증, 다중 선택, 자유 입력 허용 여부, 부분 처리 후 남은 pending 수를 명시한다. 하나의 카드 처리로 세션 전체가 재개됐다고 표시하지 않는다.  
코드: `packages/contracts/src/api/answer.ts:6–54`; `api/pending.ts:15–40`; UI §20.5.

### C04. control 버튼의 가능 조건과 복구 입력이 생략됐다 — Major

02 §4.1은 `stopped→resume`, recovery 선택지를 단순 노출한다. 그러나 resume 가능성은 checkpoint·현재 상태에 달리고 `confirm_completed`는 evidence reference와 reason이 필요하다.

**수정:** 서버 capability와 최신 revision을 기준으로 버튼을 결정하고, recovery 대상 turn·이유·증거를 입력받는다. terminate 접수와 실제 execution 소멸을 별도로 보여준다.  
코드: `packages/contracts/src/api/control.ts:24–54`; `api/receipt.ts:58–62`.

### C05. 요청 응답 유실과 실행 실패의 재시도가 구분되지 않는다 — Major

02 §1·§3은 실패 턴에 재전송을 붙이지만, 서버가 접수한 뒤 응답만 유실된 상황의 UX가 없다. 새 key로 재전송하면 중복 실행이 된다.

**수정:** 전송 의도와 idempotency key를 보존하고, 응답 불확실 시 같은 요청·receipt를 확인한다. 명시적 재실행은 새로운 사용자 의도로 만들며 `outcome_unknown`에는 일반 재전송을 제공하지 않는다.  
근거: 02 §1.3·§3·§5; UI §20.3·§24; 코드: `packages/db/src/postgres-unit-of-work.ts:62–69`.

### C06. `queueHeld`를 서버 상태라고 부르지만 해제 명령이 없다 — Major

02 §5는 실패·중단 후 queued turn을 보존하고 “지금 보내기/취소”를 묻는다. 현재 계약에는 `mode=enqueue`와 turn interrupt만 있고 held 상태나 queue 재개 명령은 없다.

**수정:** held의 소유 상태·발생 조건·재개 API를 alpha와 합의하거나, 해당 UX를 지원 계약이 생길 때까지 제외한다. 브라우저가 잠시 실행을 보류하는 것으로 서버 보장을 대체하면 안 된다.  
코드: `packages/contracts/src/api/turn.ts:24–26`; `api/control.ts:14–26`.

### C07. dispatch “되돌리기 10초”는 취소할 수 없는 실행을 되돌린다고 약속한다 — Blocker

02 §4.3은 high-confidence route 뒤 10초 undo를 제공한다. Dispatch §9.1은 applied 이후 수정은 기존 turn 변경이 아니라 별도 dispatch/control이라고 명시한다.

이미 실행된 파일 쓰기·외부 요청을 override 로그로 취소할 수 없다. **“배정 수정”과 “실행 중단 요청”을 분리**하고, 아직 실행되지 않은 입력을 이동시키려면 서버의 원자적 취소·재접수 계약을 별도로 설계해야 한다.

### C08. Last-Event-ID만으로 무손실 재연결을 약속한다 — Major

01 NFR-03과 02 §7은 cursor 보존·append만 설명한다. alpha OpenAPI는 SSE에서 410을 허용하고 `CURSOR_EXPIRED` 오류도 정의한다.

**수정:** cursor 만료 시 snapshot 재조회, 중복 event 제거, snapshot과 stream 경계 reconcile, session/turn/attempt별 연결을 정의한다. 연결 실패와 실행 실패도 분리해야 한다.  
코드: `packages/contracts/src/openapi.ts:176–184`; `shared/error.ts:24`; UI §20.6.

### C09. query key에 actor scope가 없고 revision을 identity로 사용한다 — Blocker

02 §7은 `[workspaceId, resource, filters, revision]`, 03 §8은 `["session", id, "events"]`를 제시한다. 같은 workspace에서 계정을 바꾸는 경우 캐시 격리와 reset 계약이 없다.

또 revision을 매번 key에 넣으면 동일 리소스의 캐시가 분열되고 SSE append 대상과 어긋날 수 있다. **actor/auth scope를 key에 포함하고 로그아웃·권한 회수 시 cache를 폐기**한다. revision은 기본적으로 데이터와 CAS 조건에 두고 버전별 조회만 별도 key로 구분한다.  
근거: 02 §7; 03 §8; UI §20.7·§24.

### C10. draft 저장 키와 삭제 시점이 입력 보존 원칙을 깨뜨릴 수 있다 — Major

02 §5의 `draft:{workspace}:{session}`에는 사용자 식별자가 없고 전송 시 지운다. 계정 전환 때 이전 사용자의 초안이 보이거나, 네트워크 실패 시 접수 여부가 불명확한 입력을 잃을 수 있다.

**수정:** 사용자별 namespace와 로그아웃 정책, 전송 중 snapshot을 두고 접수 확인 뒤 초안을 제거한다. failed turn이 서버에 생기지 않은 전송 실패도 복원해야 한다.  
근거: 02 §1.3·§5; UI §24 계정 전환·응답 유실 시나리오.

### C11. `tool_use.name`이라는 경로는 현재 SSE 형태와 다르다 — Major

02 §4.2는 `tool_use.name`만 읽는다고 한다. 현재 이벤트 payload는 assistant message 형태이며 도구 block은 `message.content[]` 안에 들어간다.

설계대로 직접 접근하면 이름을 읽지 못한다. **검증된 SSE→presentation 변환기를 정의**하고 여러 도구·병렬 도구·알 수 없는 도구·tool_result 상관관계를 처리해야 한다.  
코드: `packages/contracts/src/api/event.ts:26–45`; `apps/worker/src/mapper.ts:58–75`.

### C12. 동적 화면의 접근성 수용 기준이 빠졌다 — Minor

02 §6은 키보드·색상·reduced motion만 정의한다. SSE 갱신의 스크린리더 알림, 승인 모달 focus 이동·복귀, 오류 요약 연결, 자동완성 탐색은 없다.

**수정:** live region 알림 빈도, modal focus, 키보드만으로 후보 선택·승인·복구를 끝내는 시나리오를 컴포넌트 수용 기준에 넣는다. 현재 구현의 접근성 실패를 관측했다는 뜻은 아니다.

### C13. 폭 세 가지는 모바일 사용 가능성의 검증 조건으로 부족하다 — Minor

02 §6은 360/768/1440 배치만 정의한다. 모바일 키보드가 composer를 가리는 경우, 긴 diff·코드의 가로 overflow, touch에서 부분 인용 선택, 확대 상태의 제어 접근은 빠졌다.

**수정:** 키보드 열린 viewport, 긴 콘텐츠, 400% 확대, touch 대체 조작, 과거 메시지 로딩 중 scroll anchor를 QA에 추가한다.  
근거: 02 §5·§6; UI §24.

### C14. HTTP status 중심 오류 처리가 서로 다른 실패를 뭉갠다 — Major

02 §7은 409를 revision diff, 429/413을 상한 안내로 처리한다. 그러나 409에는 idempotency conflict·stale request·admission 거절도 있고 413은 payload 크기 문제다.

**수정:** `error.code`별로 재조회·같은 key 재시도·입력 수정·복구·권한 확인을 매핑한다. 401 재로그인 뒤에도 기존 mutation을 새 key로 자동 재전송하지 않는다.  
코드: `packages/contracts/src/shared/error.ts:3–26`; `apps/api/src/routes/sessions.ts:23–28`.

## D. phase·의존 — 9건

### D01. 직렬 그래프와 병렬 선언이 동시에 정본으로 남아 있다 — Major

00a §2.3에는 `I1→I2→I3` edge가 있고 §2.2 설명도 Slack의 dispatcher 선행을 말한다. §2.4는 I2·I3가 서로 의존하지 않는다고 선언한다.

**수정:** 최종 확정인 §2.4 기준으로 그래프를 갱신한다. I3의 명시 binding 모드와 I2 연결 후 자동 배정 모드를 별도 완료 기준으로 둔다.  
근거: 00a 77–107행.

### D02. I0의 선행 조건을 D1만으로 쓰면 94S-132 의존이 숨겨진다 — Blocker

00a §2.1은 I0 선행을 D1 계약으로 적는다. 그러나 01 FR-03·03 §3/4는 94S-132 scope·profile fingerprint를 요구하고, 01 참고는 이를 alpha D4로 설명한다.

현재 policy는 owner match와 read/write만 있다. **94S-132의 인터페이스 조기 확정과 실제 집행 완료를 분리**하고, I0 scaffold와 통합 완료 gate를 각각 지정해야 한다.  
코드: `packages/platform/src/authorization/policy.ts:1–15`; Port I0-K1/K2.

### D03. digest 구현 책임이 I1·I2·I4에 세 번 배정돼 순환 의존을 만든다 — Blocker

00a §4·01 FR-09·03 §6은 I1 digest를 약속한다. Dispatch §13의 세 번째 티켓은 digest 구현을 I2에 두고, Memory I4-M5는 공통 summarizer와 digest를 다시 포함한다.

03 §6의 summarizer 소유 패키지도 신규 I4 `packages/memory`다. **I1 digest schema·job·CAS·기본 summarizer를 선행 납품하고, I2는 검색, I4는 memory projection을 추가**하도록 티켓 책임을 나눠야 한다.

### D04. I4 루틴은 현재 설명대로라면 I2에 의존한다 — Major

병렬 레인 C의 선행은 I1+D4로 적혀 있지만 03 §9 루틴은 dispatch `new_session`을 호출한다. I2가 없으면 루틴의 실행 진입점이 없다.

**수정:** 루틴이 I1의 공통 admission primitive를 직접 사용하는지, 루틴 부분만 I2 이후인지 선택한다. 기억·산출물과 루틴을 같은 레인에 둔 채 전체 무의존이라고 쓰면 안 된다.  
근거: 00a §2.4; 03 §9, 303행.

### D05. I2 split이 I5 WorkItem을 만드는 역방향 의존이 미해결이다 — Major

00a §2.4는 WorkItem을 “I5가 쓰고 I2 split이 만든다”고 한다. 하지만 03 §10에서야 WorkItem 필드가 나오고, Dispatch §5.2의 split은 dispatch item과 session/turn만 만든다.

**수정:** split과 위임 WorkItem이 같은 개념인지 먼저 결정한다. 같다면 최소 schema를 I1에 선행하고, 다르면 split은 dispatch group으로 모델링해 I5 의존을 제거한다.

### D06. worktree 분리만으로 공통 파일 충돌을 해결하지 못한다 — Major

세 레인은 `schema.ts`, contracts export/OpenAPI, API composition root, workspace 설정, `packages/ui`와 웹 IA를 함께 수정한다. 00a §2.4의 worktree 분담은 이 파일들의 계약·merge 책임을 정하지 않는다.

**수정:** 공통 계약 소유자, 레인별 extension point, merge 순서, 통합 branch의 parity·권한 회귀 gate를 지정한다.  
근거: 03 §2·§8·§12; Port §3.1.

### D07. migration 번호·snapshot·적용 순서의 병렬 충돌 대책이 없다 — Major

현재 DB는 `0000`~`0003` SQL과 공통 `meta/_journal.json`, snapshot을 사용한다. 각 레인이 독립 생성하면 번호·snapshot 기준이 겹칠 수 있다.

**수정:** migration 생성/통합 책임과 rebase 후 재생성 절차, alpha migration과의 적용 순서, 기존 데이터 backfill gate를 지정한다. “migration up/down 테스트”만으로 병렬 생성 충돌은 해결되지 않는다.  
근거: 03 §12; `packages/db/migrations/`; `packages/db/src/migrate.ts:19–24,66–88`.

### D08. “alpha 영향 없음·기존 파일 수정 제한”은 실제 변경 요구와 양립하지 않는다 — Blocker

01 NFR-06·03 §1/2는 기존 계약을 유지하고 수정 범위를 좁힌다. 그러나 split transaction 추출, digest finalize 연결, workspace gate, worker memory 입력, Room·delegate는 기존 실행 경계에 들어간다.

**수정:** 실행 정본을 alpha 하나로 유지한다는 원칙은 보존하되, **변경 파일·계약 버전·담당 alpha 티켓·호환성 시험**을 명시한다. “기존 worker 변경 없음”과 “영향 없음”은 제거해야 한다.  
코드: `packages/db/src/postgres-unit-of-work.ts:38–124`; `packages/contracts/src/worker-protocol/index.ts:61–69,131–147`.

### D09. 계약 존재와 실제 alpha 납품을 phase gate에서 구분하지 않는다 — Major

현재 production server는 세션 생성·목록·상세 route만 등록한다. messages·pending·control·SSE schema/OpenAPI가 존재하는 것이 해당 실행 경로의 완료 증거는 아니다.

03 §12의 fake 기반 웹 E2E로도 실제 admission·fencing·복구를 입증할 수 없다. **I1 진입 gate에 필요한 alpha route/service와 실제 runtime 검증 증거를 매핑**하고, mock UI 통과와 통합 완료를 나눠야 한다.  
코드: `apps/api/src/server.ts:27–36`; `apps/api/src/routes/sessions.ts:78–128`; Dispatch §1.1.

## E. 상세 초안 정합성 — 15건

### E01. dispatch 공개 요청 형태가 다르다 — Major

03 §7은 `{text, source, target?, attachments?}`다. Dispatch §2.1의 strict schema는 `input`, `workspace_id`, `repository_id`, `source_context`를 쓰고 attachments가 없다. source도 `web|slack|api`만 받아 03의 routine/mail 입력과 연결되지 않는다.

**권고:** 공통 Zod 계약을 하나 확정하고 03과 상세 초안을 함께 수정한다. routine/mail은 신뢰되는 내부 origin으로 별도 모델링할 수 있지만, 공개 surface와 내부 trigger를 구분해야 한다.

### E02. `target.agent_id`의 bypass 의미가 다르다 — Major

03 §7은 명시 `target`이면 분류기를 건너뛴다고 한다. Dispatch 101–104행은 agent target을 후보 제한으로 사용하고 기존/신규 세션 선택은 계속 수행한다. 00a 118·129행의 명시 session bypass와도 구분이 필요하다.

**권고:** 03을 “`target.session_id`만 세션 분류 bypass”로 고친다. agent target의 기존/신규 선택 정책을 독립적으로 설명한다.

### E03. 후보 수와 paused 처리 정책이 다르다 — Major

03 §7은 active/paused 최근 20개를 후보로 사용한다. Dispatch §7.3은 최대 50개 검색·10개 context, paused/resuming/recovery-required는 확인 후보만 허용한다.

**권고:** 검색 한도·모델 입력 한도·자동 적용 가능 상태를 분리하여 03에 올린다. 평가 fixture와 비용 상한도 같은 정책 버전을 참조해야 한다.

### E04. confirm 만료와 요청의 안전 조건이 다르다 — Major

03 §7은 `{choice}`, 만료 24시간이다. Dispatch §3.4는 기본 15분이며 revision·candidate 소속·현재 권한을 재검사한다.

**권고:** 상세안의 revision/CAS·재검사 규칙을 정본에 반영하고 TTL 하나를 결정한다. 24시간을 유지하더라도 오래된 후보를 그대로 실행해서는 안 된다.  
근거: 03 274행; Dispatch 373–406행.

### E05. idle pause 기본값이 15분과 30분으로 갈린다 — Minor

03 §7은 15분, Dispatch §8.1은 30분이다.

**권고:** 제품 기본값을 한곳에서 정의하고 양쪽에서 참조한다. 테스트 fixture·설정 도움말도 같은 값으로 맞춘다.

### E06. digest 저장 모델과 projection·제한 단위가 정리되지 않았다 — Major

03 §6은 `summary`, `admissionState`, `lastTurnState`, 비용·카운트 등을 둔다. Dispatch §7은 `last_turn_summary`, `state`, session `status`, source revision·summarized sequence를 정의한다. Memory §4.7에는 별도 summary 결과형이 있다.

이들이 DB row·API projection·모델 출력으로 다를 수는 있지만 **변환과 소유 관계가 없다**. title/summary도 문자 수와 bytes 제한이 섞여 있다.

**권고:** 세 층을 명명하고 매핑한다. source CAS·title lock·freshness를 보존하며 다국어 code-point 제한과 byte 상한을 동시에 명시한다.

### E07. ChatInterface가 서로 다른 두 인터페이스다 — Major

03 §5는 `verify(Request)`, `present(): Promise<DeliveryReceipt>`, inbound 기반 mute를 둔다. Port §3.2는 검증된 입력의 normalization, 순수 presenter, outbound 기반 mute를 둔다. envelope도 actor/service principal·audience·attachment·kind 구성이 다르다.

**권고:** 03을 **검증/정규화, binding/admission, presentation, delivery**로 나누고 canonical envelope를 contracts에서 공유한다. 순수 renderer와 실제 전달 완료를 같은 `present` 책임으로 묶지 않는다.

### E08. session link의 격리 키와 revoke 후 의미가 충돌한다 — Blocker

03 §5 unique는 `(surface, channelId, threadId)`이며 revoked 행을 제외한다. 설치/workspace scope가 빠지고 nullable key도 허용한다. Port §4는 `(surfaceBindingId, conversationKey)`를 유지하고 revoked key 재사용을 막는다.

**권고:** 설치·binding scope를 포함한 non-null conversation identity를 채택한다. revoke 후 자동 새 세션 생성은 막고, 명시적 rebind는 권한·revision·generation을 가진 별도 작업으로 정의한다. 03의 partial unique를 그대로 구현하면 안 된다.

### E09. Team shared를 담을 Team 정본이 없다 — Major

03 Agent의 `team`은 문자열 표시 필드다. Memory §5는 `scopeTeamId: uuid`와 I0 Team/Grant 관계를 전제한다. 01·03은 팀의 식별자·membership·삭제·이름 변경 계약을 정의하지 않는다.

**권고:** 팀이 단순 카드 그룹인지 권한 주체인지 결정한다. 권한 주체라면 안정적인 Team ID·membership을 선행하고, 단순 그룹이면 `Team shared`의 실제 공개 범위를 workspace 등으로 다시 정의한다.

### E10. 도메인 코드의 소유 패키지가 다르다 — Major

03 §1/2는 도메인 로직을 platform 옆 새 패키지에 두며 기존 파일 수정을 제한한다. Port §3.1은 Agent·Grant·chat admission을 기존 `platform`에 둔다. 03 자체도 `platform/src/authz.ts` 이식을 말한다.

**권고:** shared domain service는 platform, feature orchestration은 dispatch/memory/chat 패키지 등으로 책임을 확정한다. import 방향과 수정 허용 범위를 한 문서로 통일해야 한다.

### E11. 매 turn 시스템 프롬프트 주입은 상세 조사와 충돌한다 — Blocker

03 §9는 턴 시작마다 요약을 시스템 프롬프트에 주입한다고 확정한다. Memory §4.2는 현재 adapter에 그 계약이 없으므로 typed `memory_context`를 검증하고 그전에는 MCP-only로 시작하라고 한다.

**권고:** 03을 상세안으로 수정한다. 고정 시스템 규칙과 출처가 붙은 참고 데이터를 분리하고, `nextInput` 확장·재전달·restore 검증을 명시한다.  
현재 코드 근거: `apps/worker/src/sdk-adapter.ts:73–94,138–144,201–203`.

### E12. 자동 journal과 기억 활성화의 완료 기준이 다르다 — Major

01 U07·§7, 03 §9는 journal 자동 생성과 notes 쓰기를 설명한다. Memory §4.3은 자동 활성화를 Session private digest에 한정하고 memory write는 후보만 생성한다.

**권고:** 자동 journal이 private 활성 문서인지 후보인지 결정한다. digest와 journal의 구분, 사람 승인 없이 가능한 범위, “기록 완료” 표시 조건을 01·03·Memory에 동일하게 반영한다.

### E13. 링크 그래프가 I4 필수와 후속으로 갈린다 — Major

02 §2·§3은 I4 기억 화면에 링크 그래프를 포함한다. Memory I4-M8은 wiki graph를 명시적으로 제외하고 후속 조건을 둔다.

**권고:** 02에서 그래프를 후속 capability로 옮긴다. I4 필수로 유지하려면 Memory 티켓에 permission-filtered link·접근성·모바일 QA까지 추가해야 한다.

### E14. release identity와 activation 범위의 이식 경계가 불명확하다 — Major

03 §4.1은 `(agentId, versionId, runtimeProfileFingerprint)`와 Agent당 pointer 하나를 채택한다. Port §5.2는 원본의 dependency/policy hash와 environment/binding 범위 pointer를 설명하지만, 대상에서 버리는 부분을 명확히 구분하지 않는다.

**권고:** 원본 설명과 대상 결정을 분리한다. 대상은 Agent당 pointer 하나를 유지할지 확정하고, capability/policy가 version·fingerprint에 포함되는지와 release ID wire/storage 형식을 명시한다. 원본 규칙을 “그대로 이식”한다는 표현으로 남기면 구현자가 서로 다른 모델을 만들 수 있다.

### E15. 자연어 중단 fast-path가 확정 안전 규칙과 충돌한다 — Blocker

02 §5는 “멈춰”, “그만”을 dispatch fast-path가 처리한다고 한다. 00a §3은 DESTRUCTIVE fast-path 금지를 확정했고 Dispatch §6도 모호한 중단을 control 확인 카드로 처리한다.

**권고:** 02를 수정한다. 자연어 중단은 대상·영향을 확인하고, `/stop` 또는 typed control 버튼만 명시된 turn 제어로 처리한다. regex 판정만으로 부작용을 실행하는 경로를 만들지 않는다.

## F. 우선순위 표

아래 표는 A~E의 같은 발견을 재분류한 것이며, 추가 건수로 세지 않았다.

### 설계 확정 전에 반드시 고칠 것 — Blocker 20건

| ID | 문서·섹션 | 수정안 |
|---|---|---|
| B01 | 03 §3.2 | 인증 principal·actor·owner·workspace context를 분리하고 기존 서비스 연결을 정의한다. |
| B02 | 01 §4, 03 §5 | Session ACL/Grant 저장 모델과 모든 read/write 접근 predicate를 확정한다. |
| B03 | 03 §1 | 세션 밖 mutation을 수용하는 resource별 receipt union을 I0에 둔다. |
| B06 | 03 §4.1 | profile snapshot 해석·fingerprint mismatch·현재 revoke 규칙을 고정한다. |
| B07 | 03 §4.1 | release capability와 운영 정책의 교집합을 서버에서 집행한다. |
| B10 | 03 §3.2 | bootstrap에 설치 운영자 증명과 일회용 소비 계약을 추가한다. |
| B11 | 03 §7, Port §3.2 | transaction 공유 acceptance primitive를 공통 선행 작업으로 둔다. |
| B13 | 03 §10 | delegate 대기·callback을 기존 pending과 구분해 protocol을 설계한다. |
| B14 | 03 §10 | Room의 다중 release와 Session pin의 충돌을 해소한다. |
| B15 | 03 §10 | WorkItem 권한 축소·예산 예약·취소·부모 재개 CAS를 정의한다. |
| B18 | 03 §1·§3.1 | legacy owner→workspace mapping과 데이터 공개 방지 절차를 확정한다. |
| C01 | 02 §1 | `result` 수신을 완료 판정에서 제거하고 durable terminal로 확정한다. |
| C07 | 02 §4.3 | 10초 undo를 배정 수정·실행 중단의 정확한 계약으로 바꾼다. |
| C09 | 02 §7, 03 §8 | actor별 query scope와 cache 폐기·revision 사용 규칙을 통일한다. |
| D02 | 00a §2.1 | I0의 94S-132 계약·집행 의존을 명시한다. |
| D03 | 03 §6, 상세 티켓 | I1 digest를 선행 납품하고 I2/I4의 후속 책임을 분리한다. |
| D08 | 01 NFR-06, 03 §1·§2 | alpha 변경 범위와 호환성 gate를 사실대로 재정의한다. |
| E08 | 03 §5, Port §4 | 설치 범위 link identity와 revoke/rebind 불변식을 통일한다. |
| E11 | 03 §9, Memory §4.2 | MCP 기본·검증된 typed context로 worker 기억 전달을 수정한다. |
| E15 | 02 §5, Dispatch §6 | 파괴적 자연어 regex 실행을 금지하고 명시 control과 분리한다. |

### 티켓 작성 시 반영 — Major 49건

| ID | 문서·섹션 | 수정안 |
|---|---|---|
| A01 | 01 U01, 03 §3.3 | 계정·유일 owner 복구 시나리오를 추가한다. |
| A02 | 01 U01, 03 §3 | 초대 재발급·기존 계정·동시 수락 계약을 추가한다. |
| A03 | 03 §3 | workspace 제거와 전역 계정 비활성화를 분리한다. |
| A04 | 01 U06, 03 §5 | 세션 공유·과거 이력 공개·회수 동의를 정의한다. |
| A05 | 01 U04·U06 | 서로 다른 승인 결정의 경합 결과를 정의한다. |
| A06 | 01 FR-01, 03 §3.2 | 복수 자격 증명의 선택·실패·감사 정책을 고정한다. |
| A07 | 01 Workspace, 03 §3·§9 | workspace 보관·삭제와 실행 정리를 정의한다. |
| A08 | 02 IA, 03 §4·§7 | 감사 로그 조회·권한·가림·보존 요구를 추가한다. |
| A09 | 03 §9 | 권한을 보존하는 export와 삭제 재수집 방지를 정의한다. |
| A10 | 01 U09·FR-17 | timezone·누락 실행·중첩·fire identity를 정의한다. |
| A11 | 01 U09, 03 §9 | 루틴 실행 주체와 fire 시 권한 재검사를 정의한다. |
| A12 | 01 §7 | 지표 분모·예외와 안전성 출시 기준을 추가한다. |
| A13 | 01 U12, 03 §11 | 비용 원장 범위·미확정 값·차단 사유를 구분한다. |
| A14 | 01 U02·U07 | 규칙 승인·version·activation·실제 적용을 구분한다. |
| B04 | 03 §3.2 | idempotency principal namespace와 replay 범위를 정의한다. |
| B05 | 03 §4.1 | 세션 생성 selector와 replay 시 pin 해석 순서를 정한다. |
| B08 | 03 §4.1 | release 참조 무결성과 activation 전체 transaction을 명시한다. |
| B09 | 03 §3.3 | 공개 인증·webhook route의 middleware 경계를 정의한다. |
| B12 | 03 §6 | digest 입력을 본문이 있는 durable source 범위로 바꾼다. |
| B16 | 03 §9 | artifact의 turn/attempt/release 귀속과 object commit 복구를 정의한다. |
| B17 | 02 §5, 03 §5 | 첨부 업로드→수락→worker 전달 계약을 추가한다. |
| B19 | 03 §4.1·§5 | turn·answer·control별 인간 actor provenance를 저장한다. |
| B20 | 02 §2, 03 §6 | 사용자별 read marker·pin과 공유 제목 모델을 추가한다. |
| C02 | 02 §4·§8 | admission·turn·execution·receipt·delivery 축을 분리한다. |
| C03 | 02 §3 | permission 거절·다중 질문·복수 pending 카드 계약을 구체화한다. |
| C04 | 02 §4.1 | capability 기반 control과 recovery 증거 입력을 정의한다. |
| C05 | 02 §5 | 응답 유실 재확인과 명시적 재실행을 구분한다. |
| C06 | 02 §5 | queue hold/release의 서버 상태·명령을 정의하거나 제외한다. |
| C08 | 02 §7 | SSE 만료·중복·snapshot reconcile을 추가한다. |
| C10 | 02 §5 | draft를 사용자별로 저장하고 접수 확인 뒤 제거한다. |
| C11 | 02 §4.2 | 실제 SSE payload를 해석하는 stage adapter를 정의한다. |
| C14 | 02 §7 | HTTP status 대신 오류 코드별 복구 UX를 정의한다. |
| D01 | 00a §2.3·§2.4 | 직렬 graph를 최종 병렬 결정과 일치시킨다. |
| D04 | 00a §2.4, 03 §9 | 루틴의 I2 의존 또는 공통 admission 사용을 명시한다. |
| D05 | 00a §2.4, 03 §10 | split group과 WorkItem의 동일성·선행 schema를 결정한다. |
| D06 | 03 §2 | 공통 파일 소유자·merge 순서·통합 gate를 지정한다. |
| D07 | 03 §12 | migration 번호·snapshot·적용 순서 통합 절차를 정한다. |
| D09 | 03 §12 | 계약·mock E2E·실제 alpha runtime gate를 분리한다. |
| E01 | 03 §7, Dispatch §2.1 | dispatch 입력명·첨부·surface/internal origin을 통일한다. |
| E02 | 03 §7, Dispatch §2.1 | session target과 agent target의 bypass 의미를 분리한다. |
| E03 | 03 §7, Dispatch §7.3 | 검색/모델 후보 한도와 paused 정책을 통일한다. |
| E04 | 03 §7, Dispatch §3.4 | confirm TTL·revision·candidate 재검사를 통일한다. |
| E06 | 03 §6, 상세 digest | 저장 row·API projection·모델 결과와 제한 단위를 매핑한다. |
| E07 | 03 §5, Port §3.2 | canonical envelope와 presenter/delivery 책임을 통일한다. |
| E09 | 03 §4, Memory §5 | Team을 표시 그룹인지 권한 주체인지 결정한다. |
| E10 | 03 §1·§2, Port §3.1 | 도메인 service의 패키지 소유와 import 방향을 통일한다. |
| E12 | 01 U07, Memory §4.3 | 자동 journal·digest·기억 후보의 활성화 범위를 맞춘다. |
| E13 | 02 §3, Memory I4-M8 | 그래프의 I4 포함 여부를 통일한다. |
| E14 | 03 §4.1, Port §5.2 | 원본 release 규칙과 대상 identity/pointer 결정을 구분한다. |

### 구현 중 처리 — Minor 3건

| ID | 문서·섹션 | 수정안 |
|---|---|---|
| C12 | 02 §6 | focus·live region·키보드 시나리오를 컴포넌트 기준에 추가한다. |
| C13 | 02 §6 | 모바일 키보드·확대·긴 콘텐츠·touch 대체 조작을 검증한다. |
| E05 | 03 §7, Dispatch §8.1 | idle pause 기본값을 하나로 맞춘다. |

실제 티켓 번호의 오류는 확인하지 못했다. `I0-K*`, `I3-S*`, `I4-M*`, Dispatch의 1~7은 상세 초안의 **로컬 분할 식별자**다. 실제 `94S-*` 티켓과 매핑하고 native blocked-by를 설정하기 전까지 이를 실행 가능한 최종 계획으로 취급하면 안 된다.

파일 저장·저장소 수정 없이 정적 검토만 수행했다.



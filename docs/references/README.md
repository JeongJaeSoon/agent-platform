# 참고 자료 (references)

인터페이스·협업 트랙(웹 콘솔·Dispatch & Routing·Chat Interface/Slack·기억·산출물·루틴)의 조사·초안·리뷰 원문이다. 설계 정본은 Obsidian `Private/Project/agent-platform/interface/00~06`이고, 티켓 정본은 Linear 프로젝트 [agent-platform · Interface & Collaboration](https://linear.app/94soon/project/agent-platform-interface-and-collaboration-933c7892a8a4)(94S-148~195)이다. 여기 파일은 Codex(gpt-6-astra)와 함께 만든 원문이며 정본 문서가 이를 요약·판정한다. 코드 인용의 줄 번호는 작성 시점 커밋(`b2c5f18`) 기준이다.

| 파일 | 내용 | 정본에서의 위치 |
|---|---|---|
| `interface-drafts/dd-dispatch.md` | Dispatch & Routing 상세 설계(트랜잭션 T0~T2, 결정 union, 상태 머신, 평가 하네스) | `03a Dispatch 상세`, 티켓 94S-168~176 |
| `interface-drafts/port-kollegium.md` | Kollegium 코드 이식 판정(파일별 그대로/수정/재작성/제외), Drizzle 스케치 | `03b Slack 이식 상세`, 티켓 94S-177~192 |
| `interface-drafts/memory-bench.md` | 기억 저장·접근 경로 벤치(hermes-agent·openclaw), MCP 도구 설계 | `03c 기억 상세`, 티켓 94S-178~193 |
| `interface-drafts/review-codex-astra-2026-09-22.md` | 01~03 정본과 상세 초안에 대한 적대적 리뷰 72건(Blocker 20·Major 49·Minor 3) | `06 Codex astra 리뷰 반영`(수용/이연 결정과 반영 위치) |

리뷰가 인용한 `review-input/*`는 Obsidian 정본의 당시 스냅샷이며 저장소에는 두지 않는다.

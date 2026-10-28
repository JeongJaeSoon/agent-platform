# 콘솔·Slack 번역 검수 기록

## 계획

한국어를 원문으로 콘솔 메시지와 공유 React 메시지의 모든 키를 일본어·영어와 나란히 비교한다. Slack 알림 생성 경로와 화면의 하드코딩 문구도 확인한다. 의미·용어·문체가 어긋난 항목을 수정하고, 용어집에 기준을 남긴다. 제품 이름과 API 오류 코드는 변경하지 않는다.

검증은 키·보간 변수 일치 검사, 관련 테스트, 타입 검사, 빌드와 자체 verify 스택의 화면 확인으로 진행한다. 일본어·영어 화면 3~4곳을 같은 조건에서 전후 캡처한다. Claude가 최종 head를 독립 리뷰하고 Act-on이 0인 것을 확인한 뒤, head에 연결된 검증 sticky와 실제 CI 로그를 갖춰 `orch land agent-platform-backlog --pr N`으로 반영한다.

## 검수 범위와 결과

- 콘솔 통합 카탈로그: 1,288개 키. `apps/web/src/i18n`과 `packages/react/src/messages`에 분산되어 있다.
- 별도 공유 카탈로그: `packages/react/src/components/operations/messages.ts`, `packages/react/src/components/agent-map/messages.ts`.
- 별도 데모 안내: `apps/web/src/demo/notice.tsx`의 3개 언어도 검수한다.
- Slack 실제 알림: `packages/platform/src/musterrolle/slack-welcome.ts`, `slack-outbox.ts`, `packages/contracts/src/musterrolle/slack-notices.ts`. 현재 한국어만 제공한다. 기존 알림의 게스트·구성원·릴리스 용어와 답변 요청 안내를 교정한다.
- 하드코딩 확인: 콘솔 라우트와 공유 컴포넌트의 사용자 노출 문자열을 검색했다. 에이전트 카드의 `한국어`·`English`는 지원하는 답변 언어의 고유 표시 이름이다. API 필드·모델 ID·도구 이름·사용자 입력은 번역 대상이 아니다. 현재 콘솔에서 사용하지 않는 `ReceiptSummary`·`ReceiptLink`의 기본 한국어 문구는 변경하지 않는다.

수정한 표현은 306개다. 같은 표현이 여러 언어·키에 있으면 각각 세며, 카탈로그와 동적 메시지의 변경된 값 기준이다. 테스트 기대값·문서·서식 변경은 제외한다.

| 대표 항목 | 이전 | 이후 | 이유 |
| --- | --- | --- | --- |
| 한국어 위험 작업 구역 | 위험 영역 / 위험 구역 | 위험 구역 | 같은 개념 통일 |
| 한국어 릴리스 | 배포 판 / release / 배포 탭 | 릴리스 / 릴리스 탭 | 버전·프로필을 묶는 구성의 이름 통일 |
| 영어 에이전트 관리자 | Owners | Admins | 워크스페이스 소유 역할과 구분 |
| 영어 실행 프로필 | Run profiles / Runtime profiles | Runtime profiles | 내비게이션·제목 일치 |
| 일본어 Idle | アイドル / 休止中 / 待機中 | 入力待ち | Queued의 待機中과 구분, 좁은 상태 열에서도 식별 가능 |
| 영어 답변 대기 | Needs input / Needs answer / Waiting for an answer | Waiting for an answer | 운영 화면·에이전트 맵·세션의 같은 상태 통일 |
| 일본어 운영자 | 運営者 / 運用者 | 運用担当者 | 설치를 관리하는 역할 통일 |
| 영어 독립 상태 | completed / succeeded / failed | Completed / Succeeded / Failed | sentence case |
| 일본어 자격 증명 해제 | 실행 중인 세션은 종료까지 계속 사용 | 다음 메시지부터 차단, 원격 MCP는 30초 이내 차단 | 한국어 원문 및 실제 정책과 일치 |
| 한국어 Slack 입력 대기 | 웹에서 승인이 필요해요 | 웹에서 답변이 필요한 요청을 확인해 주세요 | 질문 요청도 포함하는 상태를 정확히 설명 |

자격 증명 해제 안내는 `packages/platform/src/musterrolle/policy.ts`의 연결 검사, `packages/platform/src/workers/mcp-egress.ts`의 재검사와 `apps/egress-proxy/src/credential.ts`의 30초 갱신 간격을 확인했다. 이미 전송한 호출의 완료와 외부 서비스에서의 자격 증명 폐기는 구분해 안내한다.

## 검증

- 기존 i18n 키·보간 변수 검사에 더해 콘솔·운영 화면·에이전트 맵의 세션 상태 이름을 세 언어 모두 비교한다. 위험 작업 구역과 프로필 제목도 같은 언어 안에서 일치하는지 검사한다.
- UI 테스트는 동작·접근성 검사를 유지하고 기대 문구만 변경한다. Bun 1.3.14로 콘솔·React 테스트 1,190개가 통과했다. 이후 수정은 최종 head의 테스트 결과로 다시 확인하며 PR 검증 댓글에 실제 출력과 head를 남긴다.
- 자체 verify 스택의 프로필·에이전트·세션·운영 화면을 일본어·영어로 비교한다. 기본 전후 비교는 1440px 밝은 테마이며, 변경 후에는 390px과 어두운 테마도 검사한다. 데모 데이터의 한국어 이름·지시문은 사용자 데이터이므로 번역하지 않는다.
- 현재 `down.sh --keep-volumes`도 이미지를 삭제하므로, 해당 run의 `lib.sh`를 읽은 셸에서 `scripts/local.sh down --keep-volumes`로 정리한다. 자신의 PID·프로젝트만 대상으로 하며 4510·4620 스택은 사용하지 않는다.

## 남은 일

2026-10-28 오케스트레이터 결정: **Slack 알림 ja/en 카탈로그 + 언어 선택 기준 + 답변 언어 계약 확장**은 이번 PR 범위 밖이다. 웹 언어는 브라우저에만 저장되고 에이전트 답변 언어 계약은 ko/en만 허용하므로, 시스템 알림의 다국어 전송에는 별도 기능 설계가 필요하다. 이번 PR은 콘솔 번역과 기존 한국어 Slack 알림만 교정한다. 오케스트레이터가 오너에게 별도로 전달한다.

최종 캡처·Claude 독립 리뷰·CI 실행 로그는 PR 본문과 head를 명시한 검증 댓글에서 확인한다.

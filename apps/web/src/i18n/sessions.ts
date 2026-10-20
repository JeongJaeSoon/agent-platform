/**
 * The session screens' messages, kept apart from ko.ts and en.ts so the
 * session views can move out as one module; both catalogs spread these in.
 */
export const sessionsKo = {
  "nav.sessions": "세션",

  "sessions.title": "세션",
  "sessions.intro":
    "내가 만든 세션입니다. 세션을 누르면 상태와 이벤트를 봅니다.",
  "sessions.empty": "아직 세션이 없습니다.",
  "sessions.more": "더 보기",
  "sessions.loadingMore": "불러오는 중…",
  "sessions.column.id": "세션",
  "sessions.column.status": "상태",
  "sessions.column.admission": "진행",
  "sessions.column.runtime": "런타임",
  "sessions.column.lastEvent": "최근 이벤트",
  "sessions.column.created": "만든 시각",
  "sessions.tableLabel": "세션 표",
  "session.factsTable": "{title} 표",
  "sessions.none": "—",

  "sessions.status.queued": "대기 중",
  "sessions.status.running": "작업 중",
  "sessions.status.needs_input": "답변 대기",
  "sessions.status.idle": "쉬는 중",
  "sessions.status.failed": "실패",
  "sessions.status.stopped": "멈춤",

  "sessions.admission.active": "활성",
  "sessions.admission.pausing": "일시정지 중",
  "sessions.admission.paused": "일시정지됨",
  "sessions.admission.axis": "세션",
  "sessions.admission.resuming": "복원 중",
  "sessions.admission.stopping": "종료 중",
  "sessions.admission.stopped": "종료됨",
  "sessions.admission.recovery_required": "복구 필요",
  "sessions.admission.closed": "보관됨",

  "session.back": "세션 목록",
  "session.notFound":
    "이 세션을 찾을 수 없습니다. 지워졌거나 볼 권한이 없는 세션입니다.",
  "session.overview": "상태",
  "session.currentTurn": "진행 중인 turn",
  "session.queuedTurns": "대기 중인 turn",
  "session.pendingCount": "대기 중인 요청",
  "session.attention": "확인 필요",
  "session.updated": "마지막 변경",

  "session.profile": "프로필",
  "session.profile.next": "다음 turn부터 쓸 프로필",
  "session.profile.hint":
    "진행 중인 turn은 지금 프로필로 끝나고, 다음 turn부터 새 프로필로 대화를 이어 갑니다.",
  "session.profile.submit": "프로필 바꾸기",
  "session.profile.changed": "다음 turn부터 {profile} 프로필로 돕니다.",
  "session.profile.refused": "이 프로필로 바꿀 수 없습니다.",
  "session.profile.none":
    "같은 런타임과 과금 방식으로 바꿀 수 있는 다른 프로필이 없습니다.",
  "session.profile.unknown":
    "지금 프로필이 카탈로그에 없어 다른 프로필로 바꿀 수 없습니다.",

  "session.usage": "비용",
  "session.usage.amount": "누적 비용",
  "session.usage.unmetered": "과금 없음",
  "session.usage.incomplete": "진행 중인 turn이 있어 아직 확정되지 않았습니다",
  "session.usage.unreported":
    "비용을 보고하지 않고 끝난 turn이 있어 실제보다 적을 수 있습니다",
  "session.usage.costLimit": "비용 한도",
  "session.usage.tokens": "토큰",
  "session.usage.tokenLimit": "토큰 한도",
  "session.usage.noLimit": "없음",
  "session.usage.budgetExceeded": "한도에 도달해 새 turn을 시작하지 않습니다.",

  "session.pending": "대기 중인 요청",
  "session.pending.empty": "답을 기다리는 요청이 없습니다.",
  "session.pending.permission": "권한 요청: {tool}",
  "session.pending.question": "질문",
  "session.pending.expires": "{at}까지",

  "session.events": "이벤트",
  "session.events.empty": "아직 이벤트가 없습니다.",
  "session.events.connecting": "이벤트에 연결하는 중…",
  "session.events.closed":
    "이벤트 연결이 끊겼습니다. 새로고침하면 다시 연결합니다.",
} as const;

export const sessionsEn: Record<keyof typeof sessionsKo, string> = {
  "nav.sessions": "Sessions",

  "sessions.title": "Sessions",
  "sessions.intro":
    "Sessions you started. Open one to see its status and events.",
  "sessions.empty": "No sessions yet.",
  "sessions.more": "Show more",
  "sessions.loadingMore": "Loading…",
  "sessions.column.id": "Session",
  "sessions.column.status": "Status",
  "sessions.column.admission": "State",
  "sessions.column.runtime": "Runtime",
  "sessions.column.lastEvent": "Last event",
  "sessions.column.created": "Created",
  "sessions.tableLabel": "Sessions table",
  "session.factsTable": "{title} table",
  "sessions.none": "—",

  "sessions.status.queued": "Queued",
  "sessions.status.running": "Working",
  "sessions.status.needs_input": "Waiting for an answer",
  "sessions.status.idle": "Idle",
  "sessions.status.failed": "Failed",
  "sessions.status.stopped": "Stopped",

  "sessions.admission.active": "Active",
  "sessions.admission.pausing": "Pausing",
  "sessions.admission.paused": "Paused",
  "sessions.admission.axis": "Session",
  "sessions.admission.resuming": "Resuming",
  "sessions.admission.stopping": "Ending",
  "sessions.admission.stopped": "Ended",
  "sessions.admission.recovery_required": "Needs recovery",
  "sessions.admission.closed": "Archived",

  "session.back": "All sessions",
  "session.notFound":
    "This session cannot be found. It was removed, or you may not see it.",
  "session.overview": "Status",
  "session.currentTurn": "Current turn",
  "session.queuedTurns": "Queued turns",
  "session.pendingCount": "Pending requests",
  "session.attention": "Needs attention",
  "session.updated": "Last changed",

  "session.profile": "Profile",
  "session.profile.next": "Profile for the next turns",
  "session.profile.hint":
    "A turn already running finishes on the current profile; the conversation continues on the new one from the next turn.",
  "session.profile.submit": "Change profile",
  "session.profile.changed": "The next turns run on {profile}.",
  "session.profile.refused": "The session cannot move to this profile.",
  "session.profile.none":
    "No other profile runs the same runtime and billing, so there is nothing to change to.",
  "session.profile.unknown":
    "The current profile is not in the catalog, so the session cannot change profiles.",

  "session.usage": "Cost",
  "session.usage.amount": "Spent so far",
  "session.usage.unmetered": "Not billed",
  "session.usage.incomplete": "Not final while a turn is still running",
  "session.usage.unreported":
    "A turn ended without reporting its cost, so the real total may be higher",
  "session.usage.costLimit": "Cost limit",
  "session.usage.tokens": "Tokens",
  "session.usage.tokenLimit": "Token limit",
  "session.usage.noLimit": "None",
  "session.usage.budgetExceeded": "A limit was reached, so no new turn starts.",

  "session.pending": "Pending requests",
  "session.pending.empty": "Nothing is waiting for an answer.",
  "session.pending.permission": "Permission request: {tool}",
  "session.pending.question": "Question",
  "session.pending.expires": "until {at}",

  "session.events": "Events",
  "session.events.empty": "No events yet.",
  "session.events.connecting": "Connecting to events…",
  "session.events.closed":
    "The event connection ended. Reload the page to reconnect.",
};

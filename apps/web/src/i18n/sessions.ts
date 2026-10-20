/**
 * The session screens' messages, kept apart from ko.ts and en.ts so the
 * session views can move out as one module; both catalogs spread these in.
 */
export const sessionsKo = {
  "nav.sessions": "세션",

  "sessions.title": "세션",
  "sessions.intro":
    "내가 만들었거나 나에게 공유된 세션입니다. 세션을 누르면 상태와 이벤트를 봅니다.",
  "sessions.empty": "아직 세션이 없습니다.",
  "sessions.more": "더 보기",
  "sessions.loadingMore": "불러오는 중…",
  "sessions.column.id": "세션",
  "sessions.column.status": "작업 상태",
  "sessions.column.admission": "세션 상태",
  "sessions.column.runtime": "런타임",
  "sessions.column.lastEvent": "최근 이벤트",
  "sessions.column.created": "만든 시각",
  "sessions.none": "—",

  "sessions.status.queued": "대기 중",
  "sessions.status.running": "작업 중",
  "sessions.status.needs_input": "답변 대기",
  "sessions.status.idle": "쉬는 중",
  "sessions.status.failed": "실패",
  "sessions.status.stopped": "멈춤",

  "sessions.admission.active": "열림",
  "sessions.admission.pausing": "일시정지 중",
  "sessions.admission.paused": "일시정지됨",
  "sessions.admission.resuming": "복원 중",
  "sessions.admission.stopping": "종료 중",
  "sessions.admission.stopped": "종료됨",
  "sessions.admission.recovery_required": "복구 필요",
  "sessions.admission.closed": "보관됨",

  "session.back": "세션 목록",
  "session.notFound":
    "이 세션을 찾을 수 없습니다. 지워졌거나 볼 권한이 없는 세션입니다.",
  "session.overview": "상태",
  "session.currentTurn": "진행 중인 작업",
  "session.queuedTurns": "대기 중인 작업",
  "session.attention": "확인 필요",
  "session.updated": "마지막 변경",

  "session.profile": "프로필",
  "session.profile.next": "다음 작업부터 쓸 프로필",
  "session.profile.hint":
    "진행 중인 작업은 지금 프로필로 끝나고, 다음 작업부터 새 프로필로 대화를 이어 갑니다.",
  "session.profile.submit": "프로필 바꾸기",
  "session.profile.changed": "다음 작업부터 {profile} 프로필을 씁니다.",
  "session.profile.refused.release":
    "이 프로필로 바꿀 수 없습니다. 에이전트 release로 만든 세션은 그 release의 프로필만 씁니다.",
  "session.profile.refused.capability":
    "이 프로필로 바꿀 수 없습니다. 이 세션의 저장소에서 쓸 수 없는 프로필입니다.",
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
  "session.events.debug": "내부 이벤트도 보기",
  "session.events.turn": "turn {turn}",

  "session.event.kind.status": "상태",
  "session.event.kind.system": "시스템",
  "session.event.kind.internal": "내부",
  "session.event.kind.thinking": "생각",
  "session.event.kind.assistant": "응답",
  "session.event.kind.toolUse": "도구 호출",
  "session.event.kind.toolResult": "도구 결과",
  "session.event.kind.permission": "권한 요청",
  "session.event.kind.question": "질문",
  "session.event.kind.result": "turn 끝",
  "session.event.kind.error": "오류",
  "session.event.phase.interrupting": "멈추는 중",
  "session.event.phase.engine_stopped": "엔진이 멈춤",
  "session.event.init": "세션 시작",
  "session.event.vcsChanged": "작업 트리 변경",
  "session.event.thinkingTokens": "생각 중 ({count})",
  "session.event.thought": "생각함",
  "session.event.toolResult": "{tool} 결과",
  "session.event.toolResult.unknown": "도구 결과",
  "session.event.toolResult.ok": "성공",
  "session.event.toolResult.error": "오류",
  "session.event.toolResult.lines": "{count}줄",
  "session.event.result.success": "turn 완료",
  "session.event.result.other": "turn 끝남({subtype})",
  "session.event.result.tokens": "토큰 {count}",
} as const;

export const sessionsEn: Record<keyof typeof sessionsKo, string> = {
  "nav.sessions": "Sessions",

  "sessions.title": "Sessions",
  "sessions.intro":
    "Sessions you started or that are shared with you. Open one to see its status and events.",
  "sessions.empty": "No sessions yet.",
  "sessions.more": "Show more",
  "sessions.loadingMore": "Loading…",
  "sessions.column.id": "Session",
  "sessions.column.status": "Work status",
  "sessions.column.admission": "Session state",
  "sessions.column.runtime": "Runtime",
  "sessions.column.lastEvent": "Last event",
  "sessions.column.created": "Created",
  "sessions.none": "—",

  "sessions.status.queued": "Queued",
  "sessions.status.running": "Working",
  "sessions.status.needs_input": "Waiting for an answer",
  "sessions.status.idle": "Idle",
  "sessions.status.failed": "Failed",
  "sessions.status.stopped": "Stopped",

  "sessions.admission.active": "Open",
  "sessions.admission.pausing": "Pausing",
  "sessions.admission.paused": "Paused",
  "sessions.admission.resuming": "Resuming",
  "sessions.admission.stopping": "Ending",
  "sessions.admission.stopped": "Ended",
  "sessions.admission.recovery_required": "Needs recovery",
  "sessions.admission.closed": "Archived",

  "session.back": "All sessions",
  "session.notFound":
    "This session cannot be found. It was removed, or you may not see it.",
  "session.overview": "Status",
  "session.currentTurn": "Work in progress",
  "session.queuedTurns": "Work waiting",
  "session.attention": "Needs attention",
  "session.updated": "Last changed",

  "session.profile": "Profile",
  "session.profile.next": "Profile from the next piece of work",
  "session.profile.hint":
    "Work already running finishes on the current profile; the conversation continues on the new one from the next piece of work.",
  "session.profile.submit": "Change profile",
  "session.profile.changed": "From the next piece of work, {profile} is used.",
  "session.profile.refused.release":
    "The session cannot move to this profile. A session made from an agent release runs only that release's profile.",
  "session.profile.refused.capability":
    "The session cannot move to this profile. This profile cannot be used with the session's repository.",
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
  "session.events.debug": "Show internal events",
  "session.events.turn": "turn {turn}",

  "session.event.kind.status": "Status",
  "session.event.kind.system": "System",
  "session.event.kind.internal": "Internal",
  "session.event.kind.thinking": "Thinking",
  "session.event.kind.assistant": "Reply",
  "session.event.kind.toolUse": "Tool call",
  "session.event.kind.toolResult": "Tool result",
  "session.event.kind.permission": "Permission request",
  "session.event.kind.question": "Question",
  "session.event.kind.result": "Turn end",
  "session.event.kind.error": "Error",
  "session.event.phase.interrupting": "Stopping",
  "session.event.phase.engine_stopped": "Engine stopped",
  "session.event.init": "Session started",
  "session.event.vcsChanged": "Working tree changed",
  "session.event.thinkingTokens": "Thinking ({count})",
  "session.event.thought": "Thought",
  "session.event.toolResult": "{tool} result",
  "session.event.toolResult.unknown": "Tool result",
  "session.event.toolResult.ok": "succeeded",
  "session.event.toolResult.error": "failed",
  "session.event.toolResult.lines": "{count} lines",
  "session.event.result.success": "Turn complete",
  "session.event.result.other": "Turn ended ({subtype})",
  "session.event.result.tokens": "{count} tokens",
};

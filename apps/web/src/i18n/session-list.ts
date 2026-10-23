export const sessionListKo = {
  "sessionList.filter.label": "상태로 보기",
  "sessionList.filter.all": "전체",
  "sessionList.filter.empty": "이 상태의 세션이 없습니다.",
  "sessionList.new": "새 세션",
  "sessionList.newUnavailable":
    "웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요.",
};

export const sessionListEn: Record<keyof typeof sessionListKo, string> = {
  "sessionList.filter.label": "Show by status",
  "sessionList.filter.all": "All",
  "sessionList.filter.empty": "No sessions in this status.",
  "sessionList.new": "New session",
  "sessionList.newUnavailable":
    "Sessions cannot be started from the web yet. Start one through the API.",
};

export const sessionListJa: Record<keyof typeof sessionListKo, string> = {
  "sessionList.filter.label": "状態で表示",
  "sessionList.filter.all": "すべて",
  "sessionList.filter.empty": "この状態のセッションはありません。",
  "sessionList.new": "新しいセッション",
  "sessionList.newUnavailable":
    "Webからはまだセッションを開始できません。APIから開始してください。",
};

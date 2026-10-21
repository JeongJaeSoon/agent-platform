export const homeKo = {
  "home.title": "워크스페이스",
  "home.signedInAs": "{name}({email}) 계정으로 로그인했습니다",
  "home.checklist.title": "시작하기",
  "home.checklist.admin": "소유자 계정 만들기",
  "home.checklist.invite": "구성원 초대하기",
  "home.checklist.agent": "에이전트 준비하기",
  "home.checklist.session": "첫 세션 확인하기",
  "home.checklist.sessionHint":
    "웹 콘솔에서는 아직 세션을 시작할 수 없습니다. API로 시작한 세션이 세션 목록에 보입니다.",
  "home.checklist.unknown": "확인할 수 없음",
};

export const homeEn: Record<keyof typeof homeKo, string> = {
  "home.title": "Workspace",
  "home.signedInAs": "Logged in as {name} ({email})",
  "home.checklist.title": "Getting started",
  "home.checklist.admin": "Create the owner account",
  "home.checklist.invite": "Invite members",
  "home.checklist.agent": "Set up an agent",
  "home.checklist.session": "Check for the first session",
  "home.checklist.sessionHint":
    "The console cannot start a session yet. Sessions started through the API show up in the session list.",
  "home.checklist.unknown": "Unknown",
};

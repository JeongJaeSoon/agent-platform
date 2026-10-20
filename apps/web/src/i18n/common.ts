export const commonKo = {
  "common.appName": "Agent Platform",
  "common.retry": "다시 시도",
  "common.logout": "로그아웃",
  "common.loggingOut": "로그아웃하는 중…",
  "common.logoutFailed": "로그아웃하지 못해 아직 로그인된 상태입니다.",
  "common.language": "언어",
  "common.skipToContent": "본문으로 건너뛰기",
  "common.done": "완료",
  "common.pending": "예정",
  "common.cancel": "취소",

  "nav.label": "주요 메뉴",
  "nav.home": "홈",
  "nav.members": "구성원",
  "nav.teams": "팀",
  "nav.linkedAccounts": "연동 계정",
  "nav.apiKeys": "API key",
  "nav.workspace": "워크스페이스 설정",
  "nav.agents": "에이전트",

  "role.owner": "소유자",
  "role.admin": "관리자",
  "role.member": "구성원",

  "status.loading.title": "불러오는 중입니다",
  "status.checkingLogin.title": "로그인 상태를 확인하는 중입니다",
  "status.notFound.title": "찾을 수 없는 화면입니다",
  "status.notFound.body": "주소가 바뀌었거나 없는 화면입니다.",
  "status.notFound.action": "홈으로",
  "status.loadFailed": "불러오지 못했습니다",
  "status.loginRequired.title": "로그인이 필요합니다",
  "status.loginRequired.body": "로그인하면 열려던 화면으로 돌아갑니다.",
  "status.loginRequired.action": "로그인 화면으로",
  "status.forbidden.title": "이 화면을 볼 권한이 없습니다",
  "status.forbidden.body":
    "필요하면 워크스페이스 소유자나 관리자에게 권한을 요청하세요.",
  "status.bootstrapRequired.title": "아직 소유자가 없습니다",
  "status.bootstrapRequired.body":
    "설치 때 출력된 bootstrap 토큰으로 첫 소유자를 만드세요.",
  "status.bootstrapRequired.action": "첫 소유자 만들기",
  "status.error.title": "문제가 생겼습니다",

  "field.slugFormat":
    "영어 소문자·숫자·하이픈(-)만 쓰고, 소문자나 숫자로 시작하세요. 예: my-team",

  "guard.missingScope": "{scope} 권한이 있어야 할 수 있습니다.",
  "guard.checking": "권한을 확인하는 중입니다.",
  "guard.missingPermission": "{permission} 권한이 있어야 할 수 있습니다.",
  "guard.missingPermissionAs":
    "{permission} 권한이 있어야 할 수 있습니다. 지금 역할: {role}.",
};

export const commonEn: Record<keyof typeof commonKo, string> = {
  "common.appName": "Agent Platform",
  "common.retry": "Try again",
  "common.logout": "Log out",
  "common.loggingOut": "Logging out…",
  "common.logoutFailed": "Could not log out — you are still logged in.",
  "common.language": "Language",
  "common.skipToContent": "Skip to content",
  "common.done": "Done",
  "common.pending": "To do",
  "common.cancel": "Cancel",

  "nav.label": "Main menu",
  "nav.home": "Home",
  "nav.members": "Members",
  "nav.teams": "Teams",
  "nav.linkedAccounts": "Linked accounts",
  "nav.apiKeys": "API keys",
  "nav.workspace": "Workspace settings",
  "nav.agents": "Agents",

  "role.owner": "Owner",
  "role.admin": "Admin",
  "role.member": "Member",

  "status.loading.title": "Loading",
  "status.checkingLogin.title": "Checking your login",
  "status.notFound.title": "Page not found",
  "status.notFound.body": "The address changed, or there is no such page.",
  "status.notFound.action": "Go home",
  "status.loadFailed": "Could not load this",
  "status.loginRequired.title": "Log in to continue",
  "status.loginRequired.body":
    "After you log in, you go back to the page you were opening.",
  "status.loginRequired.action": "Log in",
  "status.forbidden.title": "You do not have access to this page",
  "status.forbidden.body":
    "If you need access, ask a workspace owner or admin.",
  "status.bootstrapRequired.title": "There is no owner yet",
  "status.bootstrapRequired.body":
    "Create the first owner with the bootstrap token printed during installation.",
  "status.bootstrapRequired.action": "Create the first owner",
  "status.error.title": "Something went wrong",

  "field.slugFormat":
    "Use lowercase letters, digits and hyphens (-), starting with a letter or digit. Example: my-team",

  "guard.missingScope": "You need the {scope} permission for this.",
  "guard.checking": "Checking permissions.",
  "guard.missingPermission": "You need the {permission} permission for this.",
  "guard.missingPermissionAs":
    "You need the {permission} permission for this. Your role: {role}.",
};

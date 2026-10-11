/**
 * The message catalog's source of truth. Keys are `<screen>.<element>`;
 * shared words live under `common.*`, status screens under `status.<kind>.*`
 * and error guidance under `error.<API error code>`. `{name}` is a variable.
 * Every other locale is typed against these keys, so a key added here and
 * not translated fails the typecheck.
 */
export const ko = {
  "common.appName": "Agent Platform",
  "common.retry": "다시 시도",
  "common.logout": "로그아웃",
  "common.loggingOut": "로그아웃하는 중…",
  "common.logoutFailed": "로그아웃하지 못해 아직 로그인된 상태입니다.",
  "common.language": "언어",
  "common.skipToContent": "본문으로 건너뛰기",
  "common.done": "완료",
  "common.pending": "예정",

  "login.title": "로그인",
  "login.email": "이메일",
  "login.password": "비밀번호",
  "login.submit": "로그인",
  "login.submitting": "로그인하는 중…",
  "login.bootstrapPrompt": "처음 설치했다면 관리자부터 만드세요.",
  "login.bootstrapLink": "첫 관리자 만들기",
  "login.notice.bootstrapDone":
    "이미 관리자가 있습니다. 그 계정으로 로그인하세요.",
  "login.notice.loggedOut": "로그아웃했습니다.",
  "login.notice.created":
    "관리자를 만들었습니다. 방금 정한 비밀번호로 로그인하세요.",

  "bootstrap.title": "첫 관리자 만들기",
  "bootstrap.intro":
    "설치할 때 한 번 출력된 bootstrap 토큰으로 첫 관리자와 워크스페이스를 만듭니다. 토큰은 한 번만 쓸 수 있습니다.",
  "bootstrap.token": "Bootstrap 토큰",
  "bootstrap.email": "관리자 이메일",
  "bootstrap.displayName": "이름",
  "bootstrap.password": "비밀번호",
  "bootstrap.passwordHint": "{min}자 이상",
  "bootstrap.workspaceName": "워크스페이스 이름",
  "bootstrap.workspaceSlug": "워크스페이스 주소 이름",
  "bootstrap.workspaceSlugHint": "영문 소문자, 숫자, 하이픈(-)",
  "bootstrap.submit": "관리자 만들기",
  "bootstrap.submitting": "만드는 중…",
  "bootstrap.tokenInvalid":
    "Bootstrap 토큰이 맞지 않습니다 — 설치 때 출력된 값을 그대로 넣으세요.",
  "bootstrap.loginLink": "이미 관리자가 있다면 로그인",

  "invite.title": "초대 수락",
  "invite.intro":
    "초대를 수락하면 워크스페이스에 들어갑니다. 이 이메일로 이미 계정이 있으면 그 비밀번호를, 처음이면 새로 쓸 비밀번호를 넣으세요.",
  "invite.password": "비밀번호",
  "invite.passwordHint": "{min}자 이상. 기존 계정이면 지금 쓰는 비밀번호",
  "invite.displayName": "이름",
  "invite.displayNameHint":
    "처음 가입할 때만 씁니다. 비우면 이메일 앞부분을 씁니다",
  "invite.submit": "초대 수락",
  "invite.submitting": "수락하는 중…",
  "invite.wrongPassword":
    "비밀번호가 맞지 않습니다. 이 이메일로 이미 계정이 있으면 그 계정의 비밀번호를 넣으세요. Google로만 로그인해 온 계정은 비밀번호가 없어 여기서 수락할 수 없습니다 — 관리자에게 재활성을 요청하세요.",
  "invite.expired.title": "쓸 수 없는 초대입니다",
  "invite.expired.body":
    "만료됐거나 회수된 초대입니다. 초대한 사람에게 새 링크를 요청하세요.",
  "invite.used.title": "이미 수락한 초대입니다",
  "invite.used.body":
    "이 초대는 한 번 쓰였습니다. 수락한 계정으로 로그인하세요.",
  "invite.used.login": "로그인 화면으로",
  "invite.member.title": "이미 이 워크스페이스의 구성원입니다",
  "invite.member.body":
    "{email} 계정으로 {workspace}에 로그인되어 있어 초대를 수락할 필요가 없습니다.",
  "invite.member.home": "워크스페이스로 가기",
  "invite.member.switch": "로그아웃하고 다른 계정으로 수락",

  "home.title": "워크스페이스",
  "home.signedInAs": "{name}({email})으로 로그인했습니다",
  "home.checklist.title": "시작하기",
  "home.checklist.admin": "관리자 계정 만들기",
  "home.checklist.invite": "구성원 초대하기",
  "home.checklist.agent": "에이전트 준비하기",
  "home.checklist.session": "첫 세션 시작하기",

  "status.loading.title": "로그인 상태를 확인하는 중입니다",
  "status.loginRequired.title": "다시 로그인하세요",
  "status.loginRequired.body":
    "로그인이 끝났거나 이 계정으로는 더 이상 들어올 수 없습니다.",
  "status.loginRequired.action": "로그인 화면으로",
  "status.forbidden.title": "이 화면을 볼 권한이 없습니다",
  "status.forbidden.body":
    "필요하면 워크스페이스 관리자에게 권한을 요청하세요.",
  "status.bootstrapRequired.title": "아직 관리자가 없습니다",
  "status.bootstrapRequired.body":
    "설치 때 받은 bootstrap 토큰으로 첫 관리자를 만들어야 쓸 수 있습니다.",
  "status.bootstrapRequired.action": "첫 관리자 만들기",
  "status.error.title": "문제가 생겼습니다",

  "guard.missingScope": "{scope} 권한이 있어야 할 수 있습니다.",

  "error.BAD_REQUEST": "입력을 확인하고 다시 보내세요.",
  "error.UNAUTHORIZED": "이메일 또는 비밀번호가 맞지 않습니다.",
  "error.FORBIDDEN": "권한이 없습니다 — 관리자에게 요청하세요.",
  "error.BOOTSTRAP_DONE":
    "이미 관리자가 만들어져 있습니다 — 로그인 화면으로 가세요.",
  "error.RATE_LIMITED": "시도가 너무 많습니다 — 잠시 뒤 다시 시도하세요.",
  "error.BACKEND_UNAVAILABLE":
    "서버에 연결하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  "error.NETWORK_ERROR": "서버에 닿지 못했습니다 — 연결을 확인하세요.",
  "error.UNKNOWN": "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  "error.INVITE_EXPIRED": "만료됐거나 회수된 초대입니다.",
  "error.INVITE_USED": "이미 쓰인 초대입니다.",
} as const;

export type MessageKey = keyof typeof ko;

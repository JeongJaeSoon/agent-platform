export const authKo = {
  "login.title": "로그인",
  "login.email": "이메일",
  "login.password": "비밀번호",
  "login.submit": "로그인",
  "login.submitting": "로그인하는 중…",
  "login.bootstrapPrompt":
    "첫 소유자는 설치 때 출력된 bootstrap 토큰으로 한 번만 만들 수 있습니다.",
  "login.signedIn": "이미 {email} 계정으로 로그인되어 있습니다.",
  "login.signedInHome": "워크스페이스로 가기",
  "login.bootstrapLink": "첫 소유자 만들기",
  "login.notice.bootstrapDone":
    "이미 소유자가 있습니다. 그 계정으로 로그인하세요.",
  "login.notice.loggedOut": "로그아웃했습니다.",
  "login.notice.created":
    "소유자를 만들었습니다. 방금 정한 비밀번호로 로그인하세요.",

  "login.or": "또는",
  "login.alternatives": "다른 로그인 방법",
  "login.google.submit": "Google로 로그인",
  "login.google.starting": "Google로 이동하는 중…",
  "login.google.title": "Google 로그인",
  "login.google.rejected":
    "Google 계정으로 로그인하지 못했습니다 — 초대받은 이메일 주소의 계정인지 확인하고 다시 시도하세요.",
  "login.google.forbidden":
    "이 Google 계정으로는 로그인할 수 없습니다 — 워크스페이스가 허용한 도메인의 계정을 쓰세요.",
  "login.google.cancelled":
    "Google 로그인을 마치지 못했습니다 — 다시 시도하세요.",
  "login.google.backToLogin": "로그인 화면으로",

  "bootstrap.title": "첫 소유자 만들기",
  "bootstrap.intro":
    "설치 때 출력된 bootstrap 토큰으로 첫 소유자와 워크스페이스를 만듭니다. 토큰은 한 번만 쓸 수 있고, 소유자가 이미 있으면 로그인 화면으로 안내합니다.",
  "bootstrap.token": "Bootstrap 토큰",
  "bootstrap.email": "소유자 이메일",
  "bootstrap.displayName": "이름",
  "bootstrap.password": "비밀번호",
  "bootstrap.passwordHint": "{min}자 이상",
  "bootstrap.workspaceName": "워크스페이스 이름",
  "bootstrap.workspaceSlug": "워크스페이스 식별자 (slug)",
  "bootstrap.workspaceSlugHint":
    "워크스페이스를 서로 구분하는 이름이라 다른 워크스페이스와 겹칠 수 없고, 나중에 바꿀 수 없습니다. 영문 소문자, 숫자, 하이픈(-)",
  "bootstrap.submit": "소유자 만들기",
  "bootstrap.submitting": "만드는 중…",
  "bootstrap.tokenInvalid":
    "Bootstrap 토큰이 맞지 않습니다 — 설치 때 출력된 값을 그대로 넣으세요.",
  "bootstrap.loginLink": "이미 소유자가 있다면 로그인",

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
    "비밀번호가 맞지 않습니다. 이 이메일로 이미 계정이 있으면 그 계정의 비밀번호를 넣으세요. Google로만 로그인해 온 계정은 비밀번호가 없어 여기서 수락할 수 없습니다 — 소유자나 관리자에게 다시 활성화해 달라고 요청하세요.",
  "invite.expired.title": "쓸 수 없는 초대입니다",
  "invite.expired.body":
    "만료됐거나 회수된 초대입니다. 초대한 사람에게 새 링크를 요청하세요.",
  "invite.used.title": "이미 수락한 초대입니다",
  "invite.used.body":
    "이 초대는 이미 쓰였습니다. 수락한 계정으로 로그인하세요.",
  "invite.used.login": "로그인 화면으로",
  "invite.member.title": "이미 이 워크스페이스의 구성원입니다",
  "invite.member.body":
    "{email} 계정으로 {workspace}에 로그인되어 있어 초대를 수락할 필요가 없습니다.",
  "invite.member.home": "워크스페이스로 가기",
  "invite.member.switch": "로그아웃하고 다른 계정으로 수락",
};

export const authEn: Record<keyof typeof authKo, string> = {
  "login.title": "Log in",
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Log in",
  "login.submitting": "Logging in…",
  "login.bootstrapPrompt":
    "The first owner is created once, with the bootstrap token printed during installation.",
  "login.signedIn": "You are already logged in as {email}.",
  "login.signedInHome": "Go to the workspace",
  "login.bootstrapLink": "Create the first owner",
  "login.notice.bootstrapDone":
    "An owner already exists. Log in with that account.",
  "login.notice.loggedOut": "You are logged out.",
  "login.notice.created":
    "The owner is ready. Log in with the password you just set.",

  "login.or": "or",
  "login.alternatives": "Other ways to log in",
  "login.google.submit": "Sign in with Google",
  "login.google.starting": "Going to Google…",
  "login.google.title": "Google login",
  "login.google.rejected":
    "Could not log in with Google — make sure the account uses the email address you were invited with, then try again.",
  "login.google.forbidden":
    "This Google account cannot log in here — use an account from a domain this workspace allows.",
  "login.google.cancelled": "Google login was not completed — try again.",
  "login.google.backToLogin": "Back to log in",

  "bootstrap.title": "Create the first owner",
  "bootstrap.intro":
    "Enter the bootstrap token printed during installation to create the first owner and the workspace. The token works only once; if an owner already exists, you are sent to log in.",
  "bootstrap.token": "Bootstrap token",
  "bootstrap.email": "Owner email",
  "bootstrap.displayName": "Name",
  "bootstrap.password": "Password",
  "bootstrap.passwordHint": "At least {min} characters",
  "bootstrap.workspaceName": "Workspace name",
  "bootstrap.workspaceSlug": "Workspace identifier (slug)",
  "bootstrap.workspaceSlugHint":
    "Tells workspaces apart, so no other workspace can use it, and it cannot be changed later. Lowercase letters, digits and hyphens (-)",
  "bootstrap.submit": "Create owner",
  "bootstrap.submitting": "Creating…",
  "bootstrap.tokenInvalid":
    "The bootstrap token is wrong — paste the value printed at install.",
  "bootstrap.loginLink": "Already have an owner? Log in",

  "invite.title": "Accept invite",
  "invite.intro":
    "Accepting adds you to the workspace. If this email already has an account, enter its password; otherwise choose a new one.",
  "invite.password": "Password",
  "invite.passwordHint":
    "At least {min} characters. Your current password if you already have an account",
  "invite.displayName": "Name",
  "invite.displayNameHint":
    "Only used for a new account. If left empty, the part of the email before @ is used",
  "invite.submit": "Accept invite",
  "invite.submitting": "Accepting…",
  "invite.wrongPassword":
    "The password does not match. If this email already has an account, enter that account's password. An account that only signs in with Google has no password and cannot accept here — ask an owner or admin to re-enable it.",
  "invite.expired.title": "This invite cannot be used",
  "invite.expired.body":
    "It expired or was revoked. Ask whoever invited you for a new link.",
  "invite.used.title": "This invite was already accepted",
  "invite.used.body":
    "It has already been used. Log in with the account that accepted it.",
  "invite.used.login": "Log in",
  "invite.member.title": "You are already a member of this workspace",
  "invite.member.body":
    "You are logged in to {workspace} as {email}, so there is nothing to accept.",
  "invite.member.home": "Go to the workspace",
  "invite.member.switch": "Log out and accept with another account",
};

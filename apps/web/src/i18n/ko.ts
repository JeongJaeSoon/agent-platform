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
  "common.cancel": "취소",

  "nav.label": "주요 메뉴",
  "nav.home": "홈",
  "nav.members": "구성원",
  "nav.agents": "에이전트",

  "role.owner": "관리자",
  "role.member": "구성원",

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

  "members.title": "구성원",
  "members.listTitle": "구성원 목록",
  "members.empty": "아직 구성원이 없습니다.",
  "members.column.name": "이름",
  "members.column.role": "역할",
  "members.column.state": "상태",
  "members.column.actions": "관리",
  "members.state.active": "활성",
  "members.state.disabled": "비활성",
  "members.enableHint": "다시 들이려면 초대하지 말고 재활성하세요.",
  "members.roleFor": "{name}의 역할",
  "members.roleChanged": "{name}의 역할을 {role}(으)로 바꿨습니다.",
  "members.disable": "비활성",
  "members.disableFor": "{name} 비활성",
  "members.disableTitle": "{name}을(를) 비활성할까요?",
  "members.disableConsequence":
    "이 사람의 웹 로그인과 개인 API key가 바로 끊기고, 이 사람이 요청한 세션은 관리자가 넘겨받을 때까지 멈춥니다. 재활성해도 끊긴 로그인과 key는 돌아오지 않습니다.",
  "members.disabled": "{name}을(를) 비활성했습니다.",
  "members.enable": "재활성",
  "members.enabled":
    "{name}을(를) 재활성했습니다. 다시 로그인하면 들어올 수 있습니다.",
  "members.invite.title": "초대",
  "members.invite.email": "이메일",
  "members.invite.role": "역할",
  "members.invite.submit": "초대 링크 만들기",
  "members.invite.submitting": "만드는 중…",
  "members.invite.disabledHint":
    "{name}은(는) 비활성 상태의 구성원입니다. 다시 초대하지 말고 목록에서 재활성하세요. Google로만 로그인하던 계정은 비밀번호가 없어 초대를 수락할 수 없습니다.",
  "members.invite.link": "초대 링크",
  "members.invite.linkOnce":
    "이 링크는 지금 한 번만 보입니다. {expires}까지 쓸 수 있습니다. 초대할 사람에게 직접 전하세요.",
  "members.invite.copy": "링크 복사",
  "members.invite.copied": "초대 링크를 복사했습니다.",
  "members.invites.title": "대기 중인 초대",
  "members.invites.empty": "대기 중인 초대가 없습니다.",
  "members.invites.expires": "{expires}까지",
  "members.invites.revoke": "회수",
  "members.invites.revokeFor": "{email} 초대 회수",
  "members.invites.revoked": "{email} 초대를 회수했습니다.",

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

  "agents.title": "에이전트",
  "agents.new": "새 에이전트",
  "agents.empty": "아직 에이전트가 없습니다. 새 에이전트로 카드를 만드세요.",
  "agents.updated": "{at} 수정",
  "agents.state.notReleased": "활성 release 없음",
  "agents.status.active": "활성",
  "agents.status.paused": "일시정지",
  "agents.status.archived": "보관됨",
  "agents.newTitle": "새 에이전트",
  "agents.newIntro":
    "빈 카드에서 시작합니다. 저장하면 첫 version이 생기고, release를 만들어 활성화해야 세션에서 쓸 수 있습니다.",
  "agents.name": "이름",
  "agents.slug": "주소 이름",
  "agents.slugHint": "영문 소문자, 숫자, 하이픈(-). 나중에 바꿀 수 없습니다",
  "agents.create": "에이전트 만들기",
  "agents.creating": "만드는 중…",
  "agentCard.role": "역할",
  "agentCard.roleHint": "한 줄로: 무엇을 맡는 에이전트인지",
  "agentCard.instructions": "지시",
  "agentCard.tone": "말투",
  "agentCard.optional": "선택",
  "agentCard.language": "언어",
  "agentCard.model": "모델",
  "agentCard.modelHint":
    "release할 runtime profile이 허용하는 모델이어야 합니다",
  "agentCard.tools": "쓸 수 있는 도구",
  "agentCard.toolsAll": "runtime profile이 허용하는 도구 전부",
  "agentCard.toolsList": "고른 도구만",
  "agentCard.toolNames": "도구 이름",
  "agentCard.listHint": "한 줄에 하나",
  "agentCard.forbidden": "금지 도구",
  "agentCard.forbiddenHint": "한 줄에 하나. 서버가 막습니다",
  "agent.created":
    "에이전트를 만들었습니다(version 1). release를 만들고 활성화해야 세션에서 쓸 수 있습니다.",
  "agent.noActive": "없음",
  "agent.activeRelease": "활성 release: {release}",
  "agent.releaseLabel": "version {version} · {profile}",
  "agent.versionLabel": "version {version}",
  "agent.saved":
    "저장했습니다 — version {version}. 아직 활성화되지 않았습니다. 쓰려면 release를 만들고 활성화하세요.",
  "agent.savedNoChange":
    "저장했습니다. 카드 내용이 같아 새 version은 생기지 않았습니다.",
  "agent.card.title": "카드",
  "agent.card.intro":
    "저장하면 새 version이 생깁니다. 활성 release는 그대로입니다.",
  "agent.card.save": "저장",
  "agent.card.saving": "저장하는 중…",
  "agent.card.stale":
    "다른 곳에서 카드를 저장해 최신이 version {version}입니다. 고치던 내용은 그대로 두었습니다. 이대로 저장하면 이 내용이 다음 version이 됩니다.",
  "agent.card.takeLatest": "최신 카드 불러오기",
  "agent.versions.title": "version 기록",
  "agent.versions.active": "활성",
  "agent.versions.before": "비교 기준",
  "agent.versions.after": "비교 대상",
  "diff.caption": "{before} → {after}",
  "diff.added": "추가: ",
  "diff.removed": "삭제: ",
  "diff.same": "두 version의 카드가 같습니다.",

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
  "guard.checking": "권한을 확인하는 중입니다.",
  "guard.missingPermission": "{permission} 권한이 있어야 할 수 있습니다.",
  "guard.missingPermissionAs":
    "{permission} 권한이 있어야 할 수 있습니다. 지금 역할: {role}.",

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
  "error.NOT_FOUND": "찾을 수 없습니다 — 목록을 다시 불러오세요.",
  "error.PAYLOAD_TOO_LARGE": "입력이 너무 깁니다 — 줄여서 다시 보내세요.",
  "error.INVITE_EXPIRED": "만료됐거나 회수된 초대입니다.",
  "error.INVITE_USED": "이미 쓰인 초대입니다.",
  "error.LAST_OWNER":
    "마지막 관리자는 역할을 바꾸거나 비활성할 수 없습니다 — 다른 관리자를 먼저 두세요. 자기 자신도 비활성할 수 없습니다.",
  "error.UNSUPPORTED_CAPABILITY":
    "이 runtime profile에서 쓸 수 없는 모델·도구가 카드에 있거나 모르는 profile입니다.",
  "error.ALREADY_EXISTS": "같은 주소 이름이 이미 있습니다.",
} as const;

export type MessageKey = keyof typeof ko;

import { modelsKo } from "./models.ts";
import { sessionsKo } from "./sessions.ts";

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
  ...sessionsKo,
  ...modelsKo,
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

  "login.title": "로그인",
  "login.email": "이메일",
  "login.password": "비밀번호",
  "login.submit": "로그인",
  "login.submitting": "로그인하는 중…",
  "login.bootstrapPrompt": "처음 설치했다면 소유자부터 만드세요.",
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
    "설치할 때 한 번 출력된 bootstrap 토큰으로 첫 소유자와 워크스페이스를 만듭니다. 토큰은 한 번만 쓸 수 있습니다.",
  "bootstrap.token": "Bootstrap 토큰",
  "bootstrap.email": "소유자 이메일",
  "bootstrap.displayName": "이름",
  "bootstrap.password": "비밀번호",
  "bootstrap.passwordHint": "{min}자 이상",
  "bootstrap.workspaceName": "워크스페이스 이름",
  "bootstrap.workspaceSlug": "워크스페이스 주소 이름",
  "bootstrap.workspaceSlugHint": "영문 소문자, 숫자, 하이픈(-)",
  "bootstrap.submit": "소유자 만들기",
  "bootstrap.submitting": "만드는 중…",
  "bootstrap.tokenInvalid":
    "Bootstrap 토큰이 맞지 않습니다 — 설치 때 출력된 값을 그대로 넣으세요.",
  "bootstrap.loginLink": "이미 소유자가 있다면 로그인",

  "members.title": "구성원",
  "members.listTitle": "구성원 목록",
  "members.empty": "아직 구성원이 없습니다.",
  "members.column.name": "이름",
  "members.column.role": "역할",
  "members.column.state": "상태",
  "members.column.actions": "관리",
  "members.state.active": "활성",
  "members.state.disabled": "비활성",
  "members.enableHint": "다시 들어오게 하려면 초대하지 말고 다시 활성화하세요.",
  "members.roleFor": "{name}의 역할",
  "members.roleChanged": "{name}의 역할을 {role}(으)로 바꿨습니다.",
  "members.disable": "비활성화",
  "members.disableFor": "{name} 비활성화",
  "members.disableTitle": "{name}을(를) 비활성화할까요?",
  "members.disableConsequence":
    "이 사람의 웹 로그인과 개인 API key가 바로 끊기고, 이 사람이 시작한 세션은 소유자가 넘겨받을 때까지 멈춥니다. 다시 활성화해도 끊긴 로그인과 key는 돌아오지 않습니다.",
  "members.disabled": "{name}을(를) 비활성화했습니다.",
  "members.enable": "다시 활성화",
  "members.enabled":
    "{name}을(를) 다시 활성화했습니다. 이제 다시 로그인할 수 있습니다.",
  "members.invite.title": "초대",
  "members.invite.email": "이메일",
  "members.invite.role": "역할",
  "members.invite.submit": "초대 링크 만들기",
  "members.invite.submitting": "만드는 중…",
  "members.invite.disabledHint":
    "{name}은(는) 비활성 상태의 구성원입니다. 다시 초대하지 말고 목록에서 다시 활성화하세요. Google로만 로그인하던 계정은 비밀번호가 없어 초대를 수락할 수 없습니다.",
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

  "home.title": "워크스페이스",
  "home.signedInAs": "{name}({email}) 계정으로 로그인했습니다",
  "home.checklist.title": "시작하기",
  "home.checklist.admin": "소유자 계정 만들기",
  "home.checklist.invite": "구성원 초대하기",
  "home.checklist.agent": "에이전트 준비하기",
  "home.checklist.session": "첫 세션 시작하기",
  "home.checklist.unknown": "확인할 수 없음",

  "agents.title": "에이전트",
  "agents.new": "새 에이전트",
  "agents.empty": "아직 에이전트가 없습니다. 새 에이전트를 눌러 만드세요.",
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
  "agentCard.instructions": "지시 사항",
  "agentCard.tone": "말투",
  "agentCard.optional": "선택",
  "agentCard.language": "언어",
  "agentCard.model": "모델",
  "agentCard.modelHint":
    "카탈로그(profiles.yaml)의 모델. 옆에 적힌 것은 그 모델을 쓰는 profile이고, release할 profile과 같은 모델이어야 합니다",
  "agentCard.tools": "쓸 수 있는 도구",
  "agentCard.toolsAll": "runtime profile이 허용하는 도구 전부",
  "agentCard.toolsList": "고른 도구만",
  "agentCard.toolNames": "도구 이름",
  "agentCard.listHint": "한 줄에 하나",
  "agentCard.forbidden": "금지 도구",
  "agentCard.forbiddenHint":
    "한 줄에 하나. 에이전트는 이 도구를 쓸 수 없습니다",
  "agent.created":
    "에이전트를 만들었습니다(version 1). release를 만들고 활성화해야 세션에서 쓸 수 있습니다.",
  "agent.noActive": "없음",
  "agent.activeRelease": "활성 release: {release}",
  "agent.releaseLabel": "version {version} · {profile}",
  "agent.versionLabel": "version {version}",
  "agent.saved":
    "저장했습니다 — version {version}. 아직 활성화되지 않았습니다. 쓰려면 release를 만들고 활성화하세요.",
  "agent.savedExisting":
    "저장했습니다. 같은 카드가 이미 있어(version {version}) 새 version은 생기지 않았습니다.",
  "agent.savedNoChange":
    "저장했습니다. 카드 내용이 같아 새 version은 생기지 않았습니다.",
  "agent.activated":
    "활성화됐습니다 — 이제 새 세션은 {release}(으)로 시작합니다.",
  "agent.alreadyActive": "이미 활성 release입니다. 바뀐 것은 없습니다.",
  "agent.conflict.title": "다른 곳에서 활성 release를 먼저 바꿨습니다",
  "agent.conflict.body":
    "이 화면을 연 뒤 다른 사람이나 다른 탭에서 활성 release를 바꿨기 때문에 덮어쓰지 않고 멈췄습니다. 최신 상태를 불러와 무엇이 바뀌었는지 확인한 뒤 다시 정하세요.",
  "agent.conflict.reload": "최신 상태 불러오기",
  "agent.conflict.reloaded":
    "보던 화면의 활성 release: {seen}. 지금 활성 release: {now}. 아래 차이를 확인하고 필요하면 다시 활성화하세요.",
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
  "agent.releases.title": "release",
  "agent.releases.intro":
    "release는 version을 runtime profile에 묶어 고정한 것입니다. 만들기만 해서는 쓰이지 않고, 활성화해야 새 세션이 씁니다.",
  "agent.releases.version": "version",
  "agent.releases.profile": "runtime profile",
  "agent.releases.profileHint":
    "플랫폼 설정(profiles.yaml)의 profile과 각 profile이 쓰는 모델",
  "agent.releases.profileOption": "{profile} · {model}",
  "agent.releases.profilesLoading": "profile 목록을 불러오는 중…",
  "agent.releases.profilesFailed":
    "profile 목록을 불러오지 못했습니다: {reason}",
  "agent.releases.create": "release 만들기",
  "agent.releases.creating": "만드는 중…",
  "agent.releases.empty": "아직 release가 없습니다.",
  "agent.releases.approved": "{at} 처음 활성화",
  "agent.releases.notApproved": "아직 활성화된 적 없음",
  "agent.releases.active": "활성",
  "agent.releases.activate": "활성화",
  "agent.releases.activating": "활성화하는 중…",
  "agent.releases.activateFor": "{release} 활성화",
  "agent.releaseCreated":
    "release를 만들었습니다(version {version}). 아직 활성화되지 않았습니다.",
  "agent.releaseExisted":
    "같은 내용의 release가 이미 있어 그것을 씁니다. 아직 활성화되지 않았다면 활성화하세요.",
  "diff.caption": "{before} → {after}",
  "diff.added": "추가: ",
  "diff.removed": "삭제: ",
  "diff.same": "두 version의 카드가 같습니다.",

  "status.loading.title": "로그인 상태를 확인하는 중입니다",
  "status.loginRequired.title": "다시 로그인하세요",
  "status.loginRequired.body":
    "로그아웃됐거나 이 계정으로는 더 이상 로그인할 수 없습니다.",
  "status.loginRequired.action": "로그인 화면으로",
  "status.forbidden.title": "이 화면을 볼 권한이 없습니다",
  "status.forbidden.body":
    "필요하면 워크스페이스 소유자나 관리자에게 권한을 요청하세요.",
  "status.bootstrapRequired.title": "아직 소유자가 없습니다",
  "status.bootstrapRequired.body":
    "설치 때 출력된 bootstrap 토큰으로 첫 소유자를 만드세요.",
  "status.bootstrapRequired.action": "첫 소유자 만들기",
  "status.error.title": "문제가 생겼습니다",

  "teams.title": "팀",
  "teams.intro":
    "팀은 사람 묶음입니다. 팀을 에이전트 관리자로 지정하면 팀의 구성원 모두가 그 에이전트를 관리합니다.",
  "teams.name": "팀 이름",
  "teams.create": "팀 만들기",
  "teams.creating": "만드는 중…",
  "teams.created": "{name} 팀을 만들었습니다.",
  "teams.nameTaken": "같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.",
  "teams.listTitle": "팀 목록",
  "teams.empty": "아직 팀이 없습니다.",
  "teams.memberCount": "구성원 {count}명",
  "teams.mine.title": "내가 속한 팀",
  "teams.mine.intro":
    "소유자나 관리자가 넣은 팀입니다. 팀이 에이전트 관리자로 지정되면 그 에이전트를 관리합니다.",
  "teams.mine.empty": "아직 속한 팀이 없습니다.",
  "teams.back": "← 팀 목록",
  "teams.settings": "팀 설정",
  "teams.rename": "이름 바꾸기",
  "teams.renamed": "팀 이름을 {name}(으)로 바꿨습니다.",
  "teams.delete": "팀 삭제",
  "teams.deleteHint":
    "팀을 삭제하면 이 팀이 관리자로 있던 에이전트에서도 빠집니다.",
  "teams.deleteTitle": "{name} 팀을 삭제할까요?",
  "teams.deleteConsequence":
    "구성원은 워크스페이스에 그대로 남지만, 이 팀을 통해 관리하던 에이전트는 더 관리하지 못합니다.",
  "teams.members": "팀 구성원",
  "teams.addHint": "추가하면 수락 없이 바로 구성원이 됩니다.",
  "teams.pickMember": "추가할 사람",
  "teams.pickPlaceholder": "사람을 고르세요",
  "teams.addMember": "구성원 추가",
  "teams.noCandidates": "추가할 수 있는 활성 구성원이 없습니다.",
  "teams.memberAdded": "{name}님을 팀에 추가했습니다.",
  "teams.memberRemoved": "{name}님을 팀에서 뺐습니다.",
  "teams.noMembers": "아직 구성원이 없습니다.",
  "teams.addedAt": "{at} 추가",
  "teams.removeMember": "빼기",
  "teams.removeMemberFor": "{name}님을 팀에서 빼기",
  "agentAdmins.title": "에이전트 관리자",
  "agentAdmins.intro":
    "에이전트 관리자는 이 에이전트의 카드·release·자격 증명 연결과 에이전트 전용 key를 관리합니다. 사람이나 팀을 관리자로 추가하세요.",
  "agentAdmins.empty":
    "아직 에이전트 관리자가 없습니다. 워크스페이스 소유자와 관리자는 여기에 추가하지 않아도 모든 에이전트를 관리할 수 있습니다.",
  "agentAdmins.person": "사람",
  "agentAdmins.team": "팀",
  "agentAdmins.remove": "빼기",
  "agentAdmins.removeFor": "{name}을(를) 관리자에서 빼기",
  "agentAdmins.pickPerson": "관리자로 추가할 사람",
  "agentAdmins.pickTeam": "관리자로 추가할 팀",
  "agentAdmins.pickPlaceholder": "고르세요",
  "agentAdmins.addPerson": "사람 추가",
  "agentAdmins.addTeam": "팀 추가",
  "agentAdmins.added": "{name}을(를) 관리자로 추가했습니다.",
  "agentAdmins.removed": "{name}을(를) 관리자에서 뺐습니다.",
  "agentAdmins.mine.title": "내가 관리하는 에이전트",
  "agentAdmins.mine.intro":
    "직접 또는 팀을 통해 관리자로 지정된 에이전트입니다. 열어서 카드와 관리자를 관리합니다.",
  "agentAdmins.mine.empty": "아직 관리자로 지정된 에이전트가 없습니다.",
  "agentAdmins.mine.truncated": "처음 {count}개만 보입니다.",

  "linked.title": "연동 계정",
  "linked.intro":
    "Slack 계정을 연결하면 Slack에서 에이전트에게 요청할 때 내 권한이 적용됩니다. Slack 토큰은 저장하지 않습니다.",
  "linked.slack": "Slack",
  "linked.none": "연결된 Slack 계정이 없습니다.",
  "linked.connect": "Slack 계정 연결",
  "linked.starting": "Slack으로 이동하는 중…",
  "linked.slackAccount": "Slack 사용자 {user} (워크스페이스 {team})",
  "linked.verified": "{at} 확인",
  "linked.stale":
    "Slack에서 이 계정이 비활성화됐다고 알려 와, 이 계정의 요청을 나와 연결하지 않습니다 — 연결을 해제한 뒤 다시 연결하세요.",
  "linked.unlink": "연결 해제",
  "linked.unlinked": "Slack 계정 연결을 해제했습니다.",
  "linked.unavailable":
    "이 설치에서는 Slack 계정 연결을 쓸 수 없습니다 — 운영자에게 문의하세요.",
  "linked.cancelled": "Slack 계정 연결을 마치지 못했습니다 — 다시 시도하세요.",
  "linked.back": "연동 계정으로",

  "apiKeys.title": "API key",
  "apiKeys.personal": "개인 key",
  "apiKeys.personalHint":
    "내 이름으로 동작하고, 내가 워크스페이스를 떠나면 함께 멈춥니다.",
  "apiKeys.issuePersonal": "개인 key 발급",
  "apiKeys.service": "서비스 key",
  "apiKeys.survivesIssuer":
    "서비스 key는 워크스페이스의 것입니다. 발급자가 떠나도 유효합니다. 필요 없어지면 직접 폐기하세요.",
  "apiKeys.survivesIssuerShort": "발급자가 떠나도 유효",
  "apiKeys.issueWorkspace": "워크스페이스 서비스 key 발급",
  "apiKeys.agent": "에이전트",
  "apiKeys.pickAgent": "에이전트를 고르세요",
  "apiKeys.agentHint":
    "에이전트 전용 key는 그 에이전트의 세션에서만 쓸 수 있습니다.",
  "apiKeys.issueAgent": "에이전트 전용 key 발급",
  "apiKeys.noAgents": "관리하는 에이전트가 없습니다.",
  "apiKeys.agentNeedsScope":
    "권한을 하나 이상 고르세요. 에이전트 전용 key에는 sessions:approve를 넣을 수 없습니다.",
  "apiKeys.agentNoApprove":
    "에이전트 전용 key에는 넣을 수 없습니다. 에이전트가 사람 대신 승인할 수는 없습니다.",
  "apiKeys.scopes": "권한",
  "apiKeys.expires": "만료일(선택)",
  "apiKeys.expiresHint": "비워 두면 폐기할 때까지 유효합니다.",
  "apiKeys.secretTitle": "새 key",
  "apiKeys.secretOnce":
    "이 값은 지금 한 번만 보입니다. 안전한 곳에 복사해 두세요.",
  "apiKeys.secret": "key 값",
  "apiKeys.copy": "복사",
  "apiKeys.copied": "복사했습니다",
  "apiKeys.secretDone": "복사했으니 닫기",
  "apiKeys.listTitle": "발급된 key",
  "apiKeys.empty": "발급된 key가 없습니다.",
  "apiKeys.kind.personal": "개인 key",
  "apiKeys.kind.workspace": "워크스페이스 서비스 key",
  "apiKeys.kind.agent": "에이전트 전용 key · {agent}",
  "apiKeys.createdAt": "발급 {at}",
  "apiKeys.expiresAt": "만료 {at}",
  "apiKeys.revokedAt": "폐기됨 {at}",
  "apiKeys.revoke": "폐기",
  "apiKeys.revokeFor": "{key} 폐기",
  "apiKeys.revokeTitle": "ID {id} key를 폐기할까요?",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.revokeConsequence":
    "이 key를 쓰는 곳은 바로 동작을 멈춥니다. 되돌릴 수 없습니다.",
  "apiKeys.revoked": "key를 폐기했습니다.",

  "workspace.title": "워크스페이스 설정",
  "workspace.retention": "감사 기록 보존 기간",
  "workspace.retentionDays": "보존 기간(일)",
  "workspace.retentionHint":
    "허용·거절한 요청 기록을 이 기간 동안 보관합니다. 30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.",
  "workspace.retentionFloor":
    "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요.",
  "workspace.retentionSaved": "감사 기록을 {days}일 보존합니다.",
  "workspace.save": "저장",
  "workspace.guest": "Slack 게스트",
  "workspace.guestLabel": "Slack 게스트도 에이전트를 쓸 수 있게 하기",
  "workspace.guestOn": "켜짐",
  "workspace.guestOff": "꺼짐",
  "workspace.guestHint":
    "켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수 없습니다. 소유자나 관리자가 바꿀 수 있습니다.",
  "workspace.guestSavedOn": "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.",
  "workspace.guestSavedOff": "이제 Slack 게스트는 에이전트를 쓸 수 없습니다.",

  "guard.missingScope": "{scope} 권한이 있어야 할 수 있습니다.",
  "guard.checking": "권한을 확인하는 중입니다.",
  "guard.missingPermission": "{permission} 권한이 있어야 할 수 있습니다.",
  "guard.missingPermissionAs":
    "{permission} 권한이 있어야 할 수 있습니다. 지금 역할: {role}.",

  "error.BAD_REQUEST": "입력을 확인하고 다시 보내세요.",
  "error.UNAUTHORIZED": "이메일 또는 비밀번호가 맞지 않습니다.",
  "error.SCOPE_NOT_GRANTABLE":
    "내가 가진 것보다 많은 권한을 key에 줄 수 없습니다.",
  "error.FORBIDDEN": "권한이 없습니다 — 소유자나 관리자에게 요청하세요.",
  "error.BOOTSTRAP_DONE": "이미 소유자가 있습니다 — 로그인하세요.",
  "error.RATE_LIMITED": "시도가 너무 많습니다 — 잠시 뒤 다시 시도하세요.",
  "error.BACKEND_UNAVAILABLE":
    "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
  "error.NETWORK_ERROR":
    "서버에 연결하지 못했습니다 — 네트워크 연결을 확인하세요.",
  "error.LOGIN_LINK_REQUIRED":
    "이미 이 이메일로 만든 계정이 있습니다 — 비밀번호로 로그인하세요.",
  "error.UNKNOWN": "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
  "error.NOT_FOUND": "더 이상 없는 항목입니다 — 목록을 다시 불러오세요.",
  "error.PAYLOAD_TOO_LARGE": "입력이 너무 깁니다 — 줄여서 다시 보내세요.",
  "error.INVITE_EXPIRED": "만료됐거나 회수된 초대입니다.",
  "error.INVITE_USED": "이미 쓰인 초대입니다.",
  "error.LAST_OWNER":
    "마지막 소유자는 역할을 바꾸거나 비활성화할 수 없습니다 — 다른 사람을 먼저 소유자로 정하세요. 자기 자신도 비활성화할 수 없습니다.",
  "error.OWNER_PROTECTED":
    "소유자 역할은 소유자만 주거나 바꿀 수 있습니다 — 소유자에게 요청하세요.",
  "error.UNSUPPORTED_CAPABILITY":
    "카드에 이 runtime profile이 허용하지 않는 모델이나 도구가 있거나, 없는 profile입니다.",
  "error.REVISION_CONFLICT":
    "다른 곳에서 먼저 바꿨습니다 — 다시 불러온 뒤 시도하세요.",
  "error.PROFILE_DIGEST_MISMATCH":
    "release를 만든 뒤 runtime profile 설정이 바뀌었습니다 — 새 release를 만드세요.",
  "error.ALREADY_EXISTS": "같은 주소 이름이 이미 있습니다.",
} as const;

export type MessageKey = keyof typeof ko;

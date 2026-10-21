export const membersKo = {
  "members.title": "구성원",
  "members.listTitle": "구성원 목록",
  "members.empty": "아직 구성원이 없습니다.",
  "members.column.name": "이름",
  "members.column.role": "역할",
  "members.column.state": "상태",
  "members.column.actions": "관리",
  "members.tableLabel": "구성원 표",
  "members.state.active": "활성",
  "members.state.disabled": "비활성",
  "members.enableHint": "다시 들어오게 하려면 초대하지 말고 다시 활성화하세요.",
  "members.roleFor": "{name}의 역할",
  "members.roleChanged": "{name}의 역할을 {role}(으)로 바꿨습니다.",
  "members.roleChangeTitle": "{name}의 역할을 {role}(으)로 바꿀까요?",
  "members.roleChangeConsequence":
    "바꾸는 즉시 이 사람이 할 수 있는 일이 새 역할에 맞게 바뀝니다.",
  "members.roleChangeOwnerConsequence":
    "소유자는 워크스페이스 설정과 다른 소유자의 역할까지 바꿀 수 있습니다. 소유자 역할은 소유자만 다시 거둘 수 있습니다.",
  "members.roleChangeConfirm": "역할 바꾸기",
  "members.disableSelf": "자기 자신은 비활성화할 수 없습니다.",
  "members.disableLastOwner":
    "하나뿐인 소유자는 비활성화할 수 없습니다 — 다른 사람을 먼저 소유자로 정하세요.",
  "members.disable": "비활성화",
  "members.disableFor": "{name} 비활성화",
  "members.disableTitle": "{name} 계정을 비활성화할까요?",
  "members.disableConsequence":
    "이 사람의 웹 로그인과 개인 API key가 바로 끊기고, 이 사람이 시작한 세션은 소유자가 넘겨받을 때까지 멈춥니다. 다시 활성화해도 끊긴 로그인과 key는 돌아오지 않습니다.",
  "members.disabled": "{name} 계정을 비활성화했습니다.",
  "members.enable": "다시 활성화",
  "members.enabled":
    "{name} 계정을 다시 활성화했습니다. 이제 다시 로그인할 수 있습니다.",
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
  "members.invite.copyFailed":
    "초대 링크를 복사하지 못했습니다 — 링크 칸을 눌러 직접 복사하세요.",
  "members.invite.description":
    "받는 사람의 이메일과 역할을 정하면 한 번만 보이는 초대 링크를 만듭니다.",
  "members.invite.steps": "초대 단계",
  "members.invite.step.details": "받는 사람",
  "members.invite.step.link": "초대 링크",
  "members.invite.again": "다른 사람 초대",
  "members.invite.close": "닫기",
  "members.invites.title": "대기 중인 초대",
  "members.invites.empty": "대기 중인 초대가 없습니다.",
  "members.invites.expires": "{expires}까지",
  "members.invites.revoke": "회수",
  "members.invites.revokeFor": "{email} 초대 회수",
  "members.invites.revokeTitle": "{email} 초대를 회수할까요?",
  "members.invites.revokeConsequence":
    "보낸 링크로는 더 가입할 수 없습니다. 다시 초대하려면 새 링크를 만들어 보내야 합니다.",
  "members.invites.revoked": "{email} 초대를 회수했습니다.",
  "members.withheld":
    "구성원 초대와 관리는 워크스페이스 소유자나 관리자가 합니다.",
};

export const membersEn: Record<keyof typeof membersKo, string> = {
  "members.title": "Members",
  "members.listTitle": "Member list",
  "members.empty": "No members yet.",
  "members.column.name": "Name",
  "members.column.role": "Role",
  "members.column.state": "Status",
  "members.column.actions": "Manage",
  "members.tableLabel": "Members table",
  "members.state.active": "Active",
  "members.state.disabled": "Disabled",
  "members.enableHint":
    "To let them back in, re-enable them instead of inviting them again.",
  "members.roleFor": "Role of {name}",
  "members.roleChanged": "{name} is now {role}.",
  "members.roleChangeTitle": "Make {name} {role}?",
  "members.roleChangeConsequence":
    "What they can do changes to match the new role as soon as you confirm.",
  "members.roleChangeOwnerConsequence":
    "Owners can change workspace settings and even other owners' roles. Only an owner can take the owner role away again.",
  "members.roleChangeConfirm": "Change role",
  "members.disableSelf": "You cannot disable yourself.",
  "members.disableLastOwner":
    "The only owner cannot be disabled — make someone else an owner first.",
  "members.disable": "Disable",
  "members.disableFor": "Disable {name}",
  "members.disableTitle": "Disable {name}?",
  "members.disableConsequence":
    "Their web logins and personal API keys stop working right away, and sessions they started wait until an owner takes them over. Re-enabling them does not restore those logins or keys.",
  "members.disabled": "{name} is disabled.",
  "members.enable": "Re-enable",
  "members.enabled": "{name} is re-enabled and can log in again.",
  "members.invite.title": "Invite",
  "members.invite.email": "Email",
  "members.invite.role": "Role",
  "members.invite.submit": "Create invite link",
  "members.invite.submitting": "Creating…",
  "members.invite.disabledHint":
    "{name} is a disabled member. Re-enable them in the list instead of inviting again: an account that only logs in with Google has no password and cannot accept an invite.",
  "members.invite.link": "Invite link",
  "members.invite.linkOnce":
    "This link is shown only now and works until {expires}. Send it to the person yourself.",
  "members.invite.copy": "Copy link",
  "members.invite.copied": "Invite link copied.",
  "members.invite.copyFailed":
    "Could not copy the invite link — select the link field and copy it yourself.",
  "members.invite.description":
    "Choose the email and role, and a link that is shown only once is made for them.",
  "members.invite.steps": "Invite steps",
  "members.invite.step.details": "Recipient",
  "members.invite.step.link": "Invite link",
  "members.invite.again": "Invite someone else",
  "members.invite.close": "Close",
  "members.invites.title": "Pending invites",
  "members.invites.empty": "No pending invites.",
  "members.invites.expires": "Expires {expires}",
  "members.invites.revoke": "Revoke",
  "members.invites.revokeFor": "Revoke the invite for {email}",
  "members.invites.revokeTitle": "Revoke the invite for {email}?",
  "members.invites.revokeConsequence":
    "The link you sent stops working. To invite them again, create and send a new link.",
  "members.invites.revoked": "The invite for {email} is revoked.",
  "members.withheld": "Workspace owners and admins invite and manage members.",
};

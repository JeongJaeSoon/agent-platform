export const teamsKo = {
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
  "teams.removeMemberTitle": "{name}님을 {team} 팀에서 뺄까요?",
  "teams.removeMemberConsequence":
    "워크스페이스에는 그대로 남지만, 이 팀을 통해 관리하던 에이전트는 더 관리하지 못합니다. 다시 추가하면 돌아옵니다.",
};

export const teamsEn: Record<keyof typeof teamsKo, string> = {
  "teams.title": "Teams",
  "teams.intro":
    "A team is a group of people. Make a team an agent admin, and everyone on it can manage that agent.",
  "teams.name": "Team name",
  "teams.create": "Create team",
  "teams.creating": "Creating…",
  "teams.created": "Created the {name} team.",
  "teams.nameTaken":
    "A team with that name already exists — choose another name.",
  "teams.listTitle": "All teams",
  "teams.empty": "No teams yet.",
  "teams.memberCount": "Members: {count}",
  "teams.mine.title": "Your teams",
  "teams.mine.intro":
    "An owner or admin put you in these teams. When a team is named an agent's admin, you manage that agent.",
  "teams.mine.empty": "You are not in any team yet.",
  "teams.back": "← All teams",
  "teams.settings": "Team settings",
  "teams.rename": "Rename",
  "teams.renamed": "Renamed the team to {name}.",
  "teams.delete": "Delete team",
  "teams.deleteHint":
    "Deleting a team also removes it from every agent it administers.",
  "teams.deleteTitle": "Delete the {name} team?",
  "teams.deleteConsequence":
    "Its members stay in the workspace, but can no longer manage agents through this team.",
  "teams.members": "Team members",
  "teams.addHint":
    "People you add join the team right away, without having to accept.",
  "teams.pickMember": "Person to add",
  "teams.pickPlaceholder": "Choose a person",
  "teams.addMember": "Add member",
  "teams.noCandidates": "There are no more active members to add.",
  "teams.memberAdded": "Added {name} to the team.",
  "teams.memberRemoved": "Removed {name} from the team.",
  "teams.noMembers": "No members yet.",
  "teams.addedAt": "added {at}",
  "teams.removeMember": "Remove",
  "teams.removeMemberFor": "Remove {name} from the team",
  "teams.removeMemberTitle": "Remove {name} from the {team} team?",
  "teams.removeMemberConsequence":
    "They stay in the workspace, but can no longer manage agents through this team. Adding them again restores it.",
};

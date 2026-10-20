export const agentsKo = {
  "agents.title": "에이전트",
  "agents.new": "새 에이전트",
  "agents.listWithheld":
    "전체 에이전트 목록은 소유자와 관리자만 봅니다. 새 에이전트를 만들면 아래 '내가 관리하는 에이전트'에 나옵니다.",
  "agent.notFound.title": "에이전트를 찾을 수 없습니다",
  "agent.notFound.body":
    "지워졌거나, 주소가 틀렸거나, 볼 수 없는 에이전트입니다.",
  "agent.notFound.back": "에이전트 목록으로",
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
    "release할 runtime profile의 모델과 정확히 같아야 합니다. 옆에 적힌 것은 그 모델을 쓰는 profile입니다",
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
    "각 profile과 그 profile이 쓰는 모델. 카드 모델과 같은 모델의 profile만 release할 수 있습니다",
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

  "agentAdmins.title": "에이전트 관리자",
  "agentAdmins.intro":
    "에이전트 관리자는 이 에이전트의 카드·release·자격 증명 연결과 에이전트 전용 key를 관리합니다. 사람이나 팀을 관리자로 추가하세요.",
  "agentAdmins.empty":
    "아직 에이전트 관리자가 없습니다. 워크스페이스 소유자와 관리자는 여기에 추가하지 않아도 모든 에이전트를 관리할 수 있습니다.",
  "agentAdmins.person": "사람",
  "agentAdmins.team": "팀",
  "agentAdmins.remove": "빼기",
  "agentAdmins.removeFor": "{name}을(를) 관리자에서 빼기",
  "agentAdmins.removeTitle": "{name}을(를) 관리자에서 뺄까요?",
  "agentAdmins.removeConsequence":
    "관리자로 받은 이 에이전트의 관리 권한이 없어집니다. 다시 관리자로 추가하면 돌아옵니다.",
  "agentAdmins.removeSelfConsequence":
    "나 자신을 빼면 관리 권한을 잃습니다. 내가 속한 팀이 관리자가 아니면 이 에이전트를 더 바꿀 수 없고, 나를 다시 추가할 수도 없습니다.",
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
};

export const agentsEn: Record<keyof typeof agentsKo, string> = {
  "agents.title": "Agents",
  "agents.new": "New agent",
  "agents.listWithheld":
    "Only owners and admins see every agent. An agent you create appears under 'Agents you administer' below.",
  "agent.notFound.title": "Agent not found",
  "agent.notFound.body":
    "It was deleted, the address is wrong, or you cannot see it.",
  "agent.notFound.back": "Back to agents",
  "agents.empty": "No agents yet. Select New agent to create one.",
  "agents.updated": "updated {at}",
  "agents.state.notReleased": "No active release",
  "agents.status.active": "Active",
  "agents.status.paused": "Paused",
  "agents.status.archived": "Archived",
  "agents.newTitle": "New agent",
  "agents.newIntro":
    "Start from a blank card. Saving creates version 1. To use it in sessions, create a release and activate it.",
  "agents.name": "Name",
  "agents.slug": "URL name",
  "agents.slugHint":
    "Lowercase letters, digits and hyphens (-). Cannot be changed later",
  "agents.create": "Create agent",
  "agents.creating": "Creating…",
  "agentCard.role": "Role",
  "agentCard.roleHint": "One line on what this agent does",
  "agentCard.instructions": "Instructions",
  "agentCard.tone": "Tone",
  "agentCard.optional": "Optional",
  "agentCard.language": "Language",
  "agentCard.model": "Model",
  "agentCard.modelHint":
    "It must be exactly the model of the runtime profile you release to. Next to it are the profiles that run it",
  "agentCard.tools": "Tools it may use",
  "agentCard.toolsAll": "Every tool the runtime profile allows",
  "agentCard.toolsList": "Only the tools I choose",
  "agentCard.toolNames": "Tool names",
  "agentCard.listHint": "One per line",
  "agentCard.forbidden": "Blocked tools",
  "agentCard.forbiddenHint": "One per line. The agent can never use these",
  "agent.created":
    "Agent created as version 1. To use it in sessions, create a release and activate it.",
  "agent.noActive": "none",
  "agent.activeRelease": "Active release: {release}",
  "agent.releaseLabel": "version {version} · {profile}",
  "agent.versionLabel": "version {version}",
  "agent.saved":
    "Saved as version {version}. It is not in use yet — create a release and activate it.",
  "agent.savedExisting":
    "Saved. This card matches version {version}, so no new version was created.",
  "agent.savedNoChange":
    "Saved. Nothing changed, so no new version was created.",
  "agent.activated": "Activated — new sessions now start with {release}.",
  "agent.alreadyActive": "That release is already active. Nothing changed.",
  "agent.conflict.title": "Someone else changed the active release first",
  "agent.conflict.body":
    "Someone else, or another tab, changed the active release after this page loaded, so nothing was overwritten. Load the latest state, check what changed, then decide again.",
  "agent.conflict.reload": "Load the latest state",
  "agent.conflict.reloaded":
    "This page showed {seen} as active; it is now {now}. Check the difference below and activate again if you still want to.",
  "agent.card.title": "Card",
  "agent.card.intro":
    "Saving creates a new version. The active release does not change.",
  "agent.card.save": "Save",
  "agent.card.saving": "Saving…",
  "agent.card.stale":
    "Someone else saved this card; the latest is now version {version}. Your edits are kept, and saving now makes them the next version.",
  "agent.card.takeLatest": "Load the latest card",
  "agent.versions.title": "Version history",
  "agent.versions.active": "active",
  "agent.versions.before": "Compare from",
  "agent.versions.after": "Compare to",
  "agent.releases.title": "Releases",
  "agent.releases.intro":
    "A release pins a version to a runtime profile. Creating one changes nothing until you activate it.",
  "agent.releases.version": "Version",
  "agent.releases.profile": "Runtime profile",
  "agent.releases.profileHint":
    "Each profile and the model it runs. Only a profile running the card's model can be released to",
  "agent.releases.profileOption": "{profile} · {model}",
  "agent.releases.profilesLoading": "Loading profiles…",
  "agent.releases.profilesFailed": "Could not load the profiles: {reason}",
  "agent.releases.create": "Create release",
  "agent.releases.creating": "Creating…",
  "agent.releases.empty": "No releases yet.",
  "agent.releases.approved": "first activated {at}",
  "agent.releases.notApproved": "never activated",
  "agent.releases.active": "Active",
  "agent.releases.activate": "Activate",
  "agent.releases.activating": "Activating…",
  "agent.releases.activateFor": "Activate {release}",
  "agent.releaseCreated":
    "Release created for version {version}. It is not active yet.",
  "agent.releaseExisted":
    "A release with the same content already exists, so that one is used. Activate it if it is not active yet.",
  "diff.caption": "{before} → {after}",
  "diff.added": "added: ",
  "diff.removed": "removed: ",
  "diff.same": "Both versions have the same card.",

  "agentAdmins.title": "Agent admins",
  "agentAdmins.intro":
    "Agent admins manage this agent's card, releases, linked credentials and agent keys. Add people or teams as admins.",
  "agentAdmins.empty":
    "No agent admins yet. Workspace owners and admins can manage every agent without being added here.",
  "agentAdmins.person": "Person",
  "agentAdmins.team": "Team",
  "agentAdmins.remove": "Remove",
  "agentAdmins.removeFor": "Remove {name} as an admin",
  "agentAdmins.removeTitle": "Remove {name} as an admin?",
  "agentAdmins.removeConsequence":
    "The rights to manage this agent that came with being its admin go away. Adding them again restores them.",
  "agentAdmins.removeSelfConsequence":
    "Removing yourself takes away your admin rights. Unless a team you are in is an admin, you can no longer change this agent or add yourself back.",
  "agentAdmins.pickPerson": "Person to add as admin",
  "agentAdmins.pickTeam": "Team to add as admin",
  "agentAdmins.pickPlaceholder": "Choose one",
  "agentAdmins.addPerson": "Add person",
  "agentAdmins.addTeam": "Add team",
  "agentAdmins.added": "Added {name} as an admin.",
  "agentAdmins.removed": "{name} is no longer an admin.",
  "agentAdmins.mine.title": "Agents you administer",
  "agentAdmins.mine.intro":
    "You were named their admin directly or through a team. Open one to manage its card and admins.",
  "agentAdmins.mine.empty": "You are not named an admin of any agent yet.",
  "agentAdmins.mine.truncated": "Showing the first {count}.",
};

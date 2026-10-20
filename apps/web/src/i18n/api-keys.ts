export const apiKeysKo = {
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
  "apiKeys.scope.read": "세션 보기",
  "apiKeys.scope.write": "세션 만들기",
  "apiKeys.scope.approve": "요청에 답하기",
  "apiKeys.scope.control": "세션 제어",
  "apiKeys.scope.recover": "세션 복구",
  "apiKeys.scopeHint.read": "세션 목록과 상태, 이벤트를 읽습니다.",
  "apiKeys.scopeHint.write":
    "세션을 만들고 진행 중인 세션에 메시지를 보냅니다.",
  "apiKeys.scopeHint.approve": "세션이 기다리는 권한 요청과 질문에 답합니다.",
  "apiKeys.scopeHint.control":
    "세션을 일시정지·재개·종료하고 프로필을 바꿉니다.",
  "apiKeys.scopeHint.recover":
    "복구가 필요한 세션을 어떻게 이어 갈지 정합니다.",
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
};

export const apiKeysEn: Record<keyof typeof apiKeysKo, string> = {
  "apiKeys.title": "API keys",
  "apiKeys.personal": "Personal key",
  "apiKeys.personalHint":
    "Acts as you, and stops working when you leave the workspace.",
  "apiKeys.issuePersonal": "Issue personal key",
  "apiKeys.service": "Service keys",
  "apiKeys.survivesIssuer":
    "A service key belongs to the workspace. It stays valid after its issuer leaves; revoke it yourself when it is no longer needed.",
  "apiKeys.survivesIssuerShort": "Stays valid after the issuer leaves",
  "apiKeys.issueWorkspace": "Issue workspace service key",
  "apiKeys.agent": "Agent",
  "apiKeys.pickAgent": "Choose an agent",
  "apiKeys.agentHint": "An agent key works only with that agent's sessions.",
  "apiKeys.issueAgent": "Issue agent key",
  "apiKeys.noAgents": "You do not administer any agent.",
  "apiKeys.agentNeedsScope":
    "Choose at least one permission. An agent key cannot include sessions:approve.",
  "apiKeys.agentNoApprove":
    "Not available for agent keys — an agent key cannot approve on a person's behalf.",
  "apiKeys.scopes": "Permissions",
  "apiKeys.scope.read": "View sessions",
  "apiKeys.scope.write": "Create sessions",
  "apiKeys.scope.approve": "Answer requests",
  "apiKeys.scope.control": "Control sessions",
  "apiKeys.scope.recover": "Recover sessions",
  "apiKeys.scopeHint.read": "Reads the session list, status and events.",
  "apiKeys.scopeHint.write":
    "Creates sessions and sends messages to running ones.",
  "apiKeys.scopeHint.approve":
    "Answers the permission requests and questions a session waits on.",
  "apiKeys.scopeHint.control":
    "Pauses, resumes and ends sessions, and changes their profile.",
  "apiKeys.scopeHint.recover":
    "Decides how a session that needs recovery continues.",
  "apiKeys.expires": "Expires on (optional)",
  "apiKeys.expiresHint": "Leave empty to keep the key until you revoke it.",
  "apiKeys.secretTitle": "New key",
  "apiKeys.secretOnce": "This value is shown only now. Copy it somewhere safe.",
  "apiKeys.secret": "Key value",
  "apiKeys.copy": "Copy",
  "apiKeys.copied": "Copied",
  "apiKeys.secretDone": "I've copied it — close",
  "apiKeys.listTitle": "Issued keys",
  "apiKeys.empty": "No keys issued.",
  "apiKeys.kind.personal": "Personal key",
  "apiKeys.kind.workspace": "Workspace service key",
  "apiKeys.kind.agent": "Agent key · {agent}",
  "apiKeys.createdAt": "Issued {at}",
  "apiKeys.expiresAt": "Expires {at}",
  "apiKeys.revokedAt": "Revoked {at}",
  "apiKeys.revoke": "Revoke",
  "apiKeys.revokeFor": "Revoke {key}",
  "apiKeys.revokeTitle": "Revoke key ID {id}?",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.revokeConsequence":
    "Anything that uses this key stops working right away. You cannot undo this.",
  "apiKeys.revoked": "Key revoked.",
};

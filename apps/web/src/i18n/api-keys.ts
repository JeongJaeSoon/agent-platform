export const apiKeysKo = {
  "apiKeys.title": "API key",
  "apiKeys.guideTitle": "key 종류",
  "apiKeys.guide.personal.actsAs":
    "발급한 사람으로 동작합니다. 이 key로 시작한 세션은 그 사람의 세션입니다.",
  "apiKeys.guide.personal.issuerLeaves":
    "발급한 사람이 워크스페이스를 떠나거나 계정이 정지되면 바로 멈춥니다. 권한도 그 사람의 지금 역할을 넘지 않습니다.",
  "apiKeys.guide.personal.sessions":
    "발급한 사람이 볼 수 있는 세션에 닿습니다.",
  "apiKeys.guide.personal.approve":
    "'요청에 답하기'(sessions:approve) 권한을 넣을 수 있습니다.",
  "apiKeys.guide.service.actsAs":
    "사람이 아니라 key 자체로 동작합니다. 이 key로 시작한 세션은 key의 세션입니다.",
  "apiKeys.guide.service.issuerLeaves":
    "발급한 사람이 떠나도 계속 유효합니다. 필요 없어지면 직접 폐기하세요.",
  "apiKeys.guide.service.sessions":
    "워크스페이스 전체에 공유된 세션과 이 key로 시작한 세션에 닿습니다. 에이전트를 가리지 않습니다.",
  "apiKeys.guide.service.approve":
    "'요청에 답하기'(sessions:approve) 권한을 넣을 수 있습니다.",
  "apiKeys.guide.agent.actsAs": "서비스 key처럼 key 자체로 동작합니다.",
  "apiKeys.guide.agent.issuerLeaves":
    "발급한 사람이 떠나도 계속 유효합니다. 필요 없어지면 직접 폐기하세요.",
  "apiKeys.guide.agent.sessions":
    "서비스 key가 닿는 세션 가운데 고른 에이전트의 세션에만 닿습니다.",
  "apiKeys.guide.agent.approve":
    "'요청에 답하기'(sessions:approve) 권한은 넣을 수 없습니다. 에이전트가 사람 대신 승인하지 않습니다.",
  "apiKeys.nav": "key 목록",
  "apiKeys.mineTitle": "내 key",
  "apiKeys.mineIntro":
    "나로 동작하는 key입니다. CLI나 스크립트가 내 권한 안에서 API를 부를 때 씁니다.",
  "apiKeys.service": "서비스 key",
  "apiKeys.serviceIntro":
    "사람이 아니라 워크스페이스나 에이전트에 속한 key입니다. 발급한 사람이 떠나도 계속 동작합니다.",
  "apiKeys.new": "새 key",
  "apiKeys.newPersonalTitle": "새 개인 key",
  "apiKeys.newServiceTitle": "새 서비스 key",
  "apiKeys.generate": "key 만들기",
  "apiKeys.emptyMine": "아직 만든 개인 key가 없습니다.",
  "apiKeys.emptyService": "아직 서비스 key가 없습니다.",
  "apiKeys.survivesIssuerShort": "발급자가 떠나도 유효",
  "apiKeys.target": "대상",
  "apiKeys.targetWorkspace": "워크스페이스 전체 (에이전트 지정 없음)",
  "apiKeys.pickAgent": "에이전트를 고르세요",
  "apiKeys.agentHint":
    "에이전트를 고르면 그 에이전트의 세션에서만 쓸 수 있는 에이전트 전용 key가 됩니다.",
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
  "apiKeys.scopeHint.read":
    "세션과 그 턴·이벤트·영수증·사용량·공유 설정, 답을 기다리는 요청을 읽습니다.",
  "apiKeys.scopeHint.write": "새 세션을 시작하고 세션에 메시지를 보냅니다.",
  "apiKeys.scopeHint.approve": "세션이 기다리는 권한 요청과 질문에 답합니다.",
  "apiKeys.scopeHint.control":
    "세션을 멈추고, 다시 잇고, 중단하고, 끝내고, 실행 프로필을 바꿉니다.",
  "apiKeys.scopeHint.recover":
    "복구가 필요한 세션을 어떻게 이을지 정합니다: 턴 버리기·완료 확정·닫기·새로 시작·복원 재시도.",
  "apiKeys.expires": "만료일(필수 아님)",
  "apiKeys.expiresHint": "비워 두면 폐기할 때까지 유효합니다.",
  "apiKeys.secretTitle": "새 key",
  "apiKeys.createdTitle": "key를 만들었습니다",
  "apiKeys.secretOnce":
    "지금 복사해 두세요. 이 화면을 떠나면 값을 다시 볼 수 없습니다.",
  "apiKeys.secret": "key 값",
  "apiKeys.copy": "복사",
  "apiKeys.copied": "복사했습니다",
  "apiKeys.copyFailed":
    "복사하지 못했습니다. 위 칸의 값을 직접 선택해 복사하세요.",
  "apiKeys.toList": "목록으로",
  "apiKeys.listTitle": "발급된 key",
  "apiKeys.kind.personal": "개인 key",
  "apiKeys.kind.service": "서비스 key",
  "apiKeys.kind.agent": "에이전트 전용 key",
  "apiKeys.createdAt": "발급 {at}",
  "apiKeys.expiresAt": "만료 {at}",
  "apiKeys.expiresSoon": "곧 만료 · {at}",
  "apiKeys.expiredAt": "만료됨 · {at}",
  "apiKeys.noExpiry": "만료 없음",
  "apiKeys.approveYes": "승인 가능",
  "apiKeys.approveNo": "승인 불가",
  "apiKeys.revokedAt": "폐기됨 {at}",
  "apiKeys.revoke": "폐기",
  "apiKeys.revokeFor": "{key} 폐기",
  "apiKeys.revokeTitle": "ID {id} key를 폐기할까요?",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.idLabel": "ID",
  "apiKeys.copyIdFor": "ID {id} 복사",
  "apiKeys.copyIdFailed": "복사하지 못했습니다. ID를 직접 선택해 복사하세요.",
  "apiKeys.revokeConsequence":
    "이 key를 쓰는 곳은 바로 동작을 멈춥니다. 되돌릴 수 없습니다.",
  "apiKeys.revoked": "key를 폐기했습니다.",
};

export const apiKeysEn: Record<keyof typeof apiKeysKo, string> = {
  "apiKeys.title": "API keys",
  "apiKeys.guideTitle": "Key types",
  "apiKeys.guide.personal.actsAs":
    "Acts as the person who issued it. Sessions it starts are that person's.",
  "apiKeys.guide.personal.issuerLeaves":
    "Stops at once when that person leaves the workspace or their account is suspended, and never does more than their current role allows.",
  "apiKeys.guide.personal.sessions":
    "Reaches the sessions that person can see.",
  "apiKeys.guide.personal.approve":
    "Can include Answer requests (sessions:approve).",
  "apiKeys.guide.service.actsAs":
    "Acts as the key itself, not as a person. Sessions it starts belong to the key.",
  "apiKeys.guide.service.issuerLeaves":
    "Stays valid after its issuer leaves; revoke it yourself when it is no longer needed.",
  "apiKeys.guide.service.sessions":
    "Reaches sessions shared with the whole workspace and the sessions it started, for any agent.",
  "apiKeys.guide.service.approve":
    "Can include Answer requests (sessions:approve).",
  "apiKeys.guide.agent.actsAs": "Acts as the key itself, like a service key.",
  "apiKeys.guide.agent.issuerLeaves":
    "Stays valid after its issuer leaves; revoke it yourself when it is no longer needed.",
  "apiKeys.guide.agent.sessions":
    "Reaches only the chosen agent's sessions among those a service key reaches.",
  "apiKeys.guide.agent.approve":
    "Cannot include Answer requests (sessions:approve): an agent never approves on a person's behalf.",
  "apiKeys.nav": "Key lists",
  "apiKeys.mineTitle": "My keys",
  "apiKeys.mineIntro":
    "Keys that act as you. Use them when the CLI or a script calls the API with your permissions.",
  "apiKeys.service": "Service keys",
  "apiKeys.serviceIntro":
    "Keys that belong to the workspace or an agent, not a person. They keep working after their issuer leaves.",
  "apiKeys.new": "New key",
  "apiKeys.newPersonalTitle": "New personal key",
  "apiKeys.newServiceTitle": "New service key",
  "apiKeys.generate": "Generate key",
  "apiKeys.emptyMine": "You have no personal keys yet.",
  "apiKeys.emptyService": "No service keys yet.",
  "apiKeys.survivesIssuerShort": "Stays valid after the issuer leaves",
  "apiKeys.target": "For",
  "apiKeys.targetWorkspace": "The whole workspace (no agent)",
  "apiKeys.pickAgent": "Choose an agent",
  "apiKeys.agentHint":
    "Choosing an agent makes an agent key that works only with that agent's sessions.",
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
  "apiKeys.scopeHint.read":
    "Read sessions with their turns, events, receipts, usage and sharing, and the requests waiting for an answer.",
  "apiKeys.scopeHint.write": "Start sessions and send messages to them.",
  "apiKeys.scopeHint.approve":
    "Answer the permission requests and questions a session is waiting on.",
  "apiKeys.scopeHint.control":
    "Pause, resume, interrupt or end sessions, and change their profile.",
  "apiKeys.scopeHint.recover":
    "Decide how a session that needs recovery goes on: abandon a turn, confirm it completed, close, start fresh or retry the restore.",
  "apiKeys.expires": "Expires on (not required)",
  "apiKeys.expiresHint": "Leave empty to keep the key until you revoke it.",
  "apiKeys.secretTitle": "New key",
  "apiKeys.createdTitle": "Key created",
  "apiKeys.secretOnce":
    "Copy it now. Once you leave this page you won't be able to see it again.",
  "apiKeys.secret": "Key value",
  "apiKeys.copy": "Copy",
  "apiKeys.copied": "Copied",
  "apiKeys.copyFailed":
    "Couldn't copy. Select the value above and copy it yourself.",
  "apiKeys.toList": "Back to keys",
  "apiKeys.listTitle": "Issued keys",
  "apiKeys.kind.personal": "Personal key",
  "apiKeys.kind.service": "Service key",
  "apiKeys.kind.agent": "Agent key",
  "apiKeys.createdAt": "Issued {at}",
  "apiKeys.expiresAt": "Expires {at}",
  "apiKeys.expiresSoon": "Expires soon · {at}",
  "apiKeys.expiredAt": "Expired · {at}",
  "apiKeys.noExpiry": "No expiry",
  "apiKeys.approveYes": "Can approve",
  "apiKeys.approveNo": "Cannot approve",
  "apiKeys.revokedAt": "Revoked {at}",
  "apiKeys.revoke": "Revoke",
  "apiKeys.revokeFor": "Revoke {key}",
  "apiKeys.revokeTitle": "Revoke key ID {id}?",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.idLabel": "ID",
  "apiKeys.copyIdFor": "Copy ID {id}",
  "apiKeys.copyIdFailed": "Couldn't copy. Select the ID and copy it yourself.",
  "apiKeys.revokeConsequence":
    "Anything that uses this key stops working right away. You cannot undo this.",
  "apiKeys.revoked": "Key revoked.",
};

export const apiKeysJa: Record<keyof typeof apiKeysKo, string> = {
  "apiKeys.title": "API キー",
  "apiKeys.guideTitle": "キーの種類",
  "apiKeys.guide.personal.actsAs":
    "発行した人として動作します。このキーで開始したセッションは、その人のものになります。",
  "apiKeys.guide.personal.issuerLeaves":
    "その人がワークスペースを離れるかアカウントが停止されるとすぐに使えなくなり、その人の現在のロールで許可された範囲を超えることはありません。",
  "apiKeys.guide.personal.sessions":
    "その人が閲覧できるセッションにアクセスできます。",
  "apiKeys.guide.personal.approve":
    "「リクエストへの回答」（sessions:approve）を含められます。",
  "apiKeys.guide.service.actsAs":
    "人ではなく、キー自体として動作します。このキーで開始したセッションはキーのものになります。",
  "apiKeys.guide.service.issuerLeaves":
    "発行者が離れても有効なままです。不要になったら自分で取り消してください。",
  "apiKeys.guide.service.sessions":
    "すべてのエージェントについて、ワークスペース全体に共有されたセッションと、このキーで開始したセッションにアクセスできます。",
  "apiKeys.guide.service.approve":
    "「リクエストへの回答」（sessions:approve）を含められます。",
  "apiKeys.guide.agent.actsAs":
    "サービスキーと同じく、キー自体として動作します。",
  "apiKeys.guide.agent.issuerLeaves":
    "発行者が離れても有効なままです。不要になったら自分で取り消してください。",
  "apiKeys.guide.agent.sessions":
    "サービスキーがアクセスできるセッションのうち、選択したエージェントのセッションのみにアクセスできます。",
  "apiKeys.guide.agent.approve":
    "「リクエストへの回答」（sessions:approve）は含められません。エージェントが人の代わりに承認することはありません。",
  "apiKeys.nav": "キーの一覧",
  "apiKeys.mineTitle": "自分のキー",
  "apiKeys.mineIntro":
    "あなたとして動作するキーです。CLI やスクリプトがあなたの権限の範囲で API を呼び出すときに使います。",
  "apiKeys.service": "サービスキー",
  "apiKeys.serviceIntro":
    "人ではなく、ワークスペースやエージェントに属するキーです。発行した人が離れても動作し続けます。",
  "apiKeys.new": "新しいキー",
  "apiKeys.newPersonalTitle": "新しい個人キー",
  "apiKeys.newServiceTitle": "新しいサービスキー",
  "apiKeys.generate": "キーを作成",
  "apiKeys.emptyMine": "まだ個人キーを作成していません。",
  "apiKeys.emptyService": "サービスキーはまだありません。",
  "apiKeys.survivesIssuerShort": "発行者が離れても有効",
  "apiKeys.target": "対象",
  "apiKeys.targetWorkspace": "ワークスペース全体（エージェント指定なし）",
  "apiKeys.pickAgent": "エージェントを選択",
  "apiKeys.agentHint":
    "エージェントを選択すると、そのエージェントのセッションでのみ使えるエージェントキーになります。",
  "apiKeys.noAgents": "管理しているエージェントがありません。",
  "apiKeys.agentNeedsScope":
    "権限を 1 つ以上選択してください。エージェントキーには sessions:approve を含められません。",
  "apiKeys.agentNoApprove":
    "エージェントキーでは使えません。エージェントキーは人の代わりに承認できません。",
  "apiKeys.scopes": "権限",
  "apiKeys.scope.read": "セッションの閲覧",
  "apiKeys.scope.write": "セッションの作成",
  "apiKeys.scope.approve": "リクエストへの回答",
  "apiKeys.scope.control": "セッションの操作",
  "apiKeys.scope.recover": "セッションの復旧",
  "apiKeys.scopeHint.read":
    "セッションとそのターン・イベント・レシート・使用量・共有設定、回答待ちのリクエストを閲覧します。",
  "apiKeys.scopeHint.write": "セッションを開始し、メッセージを送信します。",
  "apiKeys.scopeHint.approve":
    "セッションが待っている権限リクエストと質問に回答します。",
  "apiKeys.scopeHint.control":
    "セッションの一時停止・再開・中断・終了と、プロファイルの変更を行います。",
  "apiKeys.scopeHint.recover":
    "復旧が必要なセッションの続け方を決めます。ターンの破棄、完了の確認、クローズ、新規開始、復元の再試行ができます。",
  "apiKeys.expires": "有効期限（任意）",
  "apiKeys.expiresHint": "空欄にすると、取り消すまでキーは有効なままです。",
  "apiKeys.secretTitle": "新しいキー",
  "apiKeys.createdTitle": "キーを作成しました",
  "apiKeys.secretOnce":
    "今すぐコピーしてください。この画面を離れると、値は二度と表示されません。",
  "apiKeys.secret": "キー",
  "apiKeys.copy": "コピー",
  "apiKeys.copied": "コピーしました",
  "apiKeys.copyFailed":
    "コピーできませんでした。上の値を選択して手動でコピーしてください。",
  "apiKeys.toList": "一覧に戻る",
  "apiKeys.listTitle": "発行済みのキー",
  "apiKeys.kind.personal": "個人キー",
  "apiKeys.kind.service": "サービスキー",
  "apiKeys.kind.agent": "エージェントキー",
  "apiKeys.createdAt": "{at}に発行",
  "apiKeys.expiresAt": "{at}に期限切れ",
  "apiKeys.expiresSoon": "まもなく期限切れ · {at}",
  "apiKeys.expiredAt": "期限切れ · {at}",
  "apiKeys.noExpiry": "有効期限なし",
  "apiKeys.approveYes": "承認可",
  "apiKeys.approveNo": "承認不可",
  "apiKeys.revokedAt": "{at}に取り消し",
  "apiKeys.revoke": "取り消し",
  "apiKeys.revokeFor": "{key}を取り消し",
  "apiKeys.revokeTitle": "キー ID {id} を取り消しますか？",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.idLabel": "ID",
  "apiKeys.copyIdFor": "ID {id} をコピー",
  "apiKeys.copyIdFailed":
    "コピーできませんでした。ID を選択して手動でコピーしてください。",
  "apiKeys.revokeConsequence":
    "このキーを使っているものはすぐに動作しなくなります。この操作は元に戻せません。",
  "apiKeys.revoked": "キーを取り消しました。",
};

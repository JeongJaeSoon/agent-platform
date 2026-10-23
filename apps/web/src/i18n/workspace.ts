export const workspaceKo = {
  "workspace.title": "워크스페이스 설정",
  "workspace.description": "워크스페이스 전체에 적용되는 설정입니다.",
  "workspace.readOnlyMark": "읽기 전용",
  "workspace.name": "워크스페이스 이름",
  "workspace.nameHint": "콘솔과 알림에 보이는 이름입니다.",
  "workspace.nameFoot": "콘솔에서는 아직 바꿀 수 없습니다.",
  "workspace.id": "워크스페이스 ID",
  "workspace.idHint": "API와 CLI에서 이 워크스페이스를 가리킬 때 씁니다.",
  "workspace.idCopied": "워크스페이스 ID를 복사했습니다.",
  "workspace.models": "모델 허용 목록",
  "workspace.modelsHint":
    "세션에서 고를 수 있는 모델의 상한입니다. 에이전트 제한과 프로필이 여기서 더 좁힙니다.",
  "workspace.modelsFoot": "설치 설정에서 관리합니다 · 콘솔에서는 읽기 전용",
  "workspace.modelsEmpty": "이 설치에 등록된 모델이 없습니다.",
  "workspace.retention": "감사 기록 보존 기간",
  "workspace.retentionDays": "보존 기간(일)",
  "workspace.retentionHint": "허용·거절한 요청 기록을 이 기간 동안 보관합니다.",
  "workspace.retentionFoot":
    "30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.",
  "workspace.retentionFloor":
    "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요.",
  "workspace.retentionCeiling":
    "감사 기록은 최대 {max}일까지 보존할 수 있습니다. {max}일 이하로 정하세요.",
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
  "workspace.readOnly":
    "지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요.",
  "workspace.retentionValue": "감사 기록을 {days}일 보존합니다.",
  "workspace.guestValueOn": "Slack 게스트도 에이전트를 쓸 수 있습니다.",
  "workspace.guestValueOff": "Slack 게스트는 에이전트를 쓸 수 없습니다.",
};

export const workspaceEn: Record<keyof typeof workspaceKo, string> = {
  "workspace.title": "Workspace settings",
  "workspace.description": "Settings that apply to the whole workspace.",
  "workspace.readOnlyMark": "Read-only",
  "workspace.name": "Workspace name",
  "workspace.nameHint": "The name shown in the console and in notifications.",
  "workspace.nameFoot": "It can't be changed from the console yet.",
  "workspace.id": "Workspace ID",
  "workspace.idHint": "Use it to point at this workspace from the API and CLI.",
  "workspace.idCopied": "Copied the workspace ID.",
  "workspace.models": "Allowed models",
  "workspace.modelsHint":
    "The most a session can choose from. Agent limits and profiles narrow it further.",
  "workspace.modelsFoot":
    "Managed in the installation settings · read-only in the console",
  "workspace.modelsEmpty": "This installation has no models registered.",
  "workspace.retention": "Audit log retention",
  "workspace.retentionDays": "Keep for (days)",
  "workspace.retentionHint":
    "Records of allowed and denied requests are kept this long.",
  "workspace.retentionFoot": "At least 30 days. Only an owner can change this.",
  "workspace.retentionFloor":
    "Audit records must be kept for at least 30 days. Choose a number from 30 to 3650.",
  "workspace.retentionCeiling":
    "Audit records can be kept for at most {max} days. Choose {max} or fewer.",
  "workspace.retentionSaved": "Audit records are kept for {days} days.",
  "workspace.save": "Save",
  "workspace.guest": "Slack guests",
  "workspace.guestLabel": "Let Slack guests use agents",
  "workspace.guestOn": "On",
  "workspace.guestOff": "Off",
  "workspace.guestHint":
    "Even when this is on, a guest must first link their Slack account on the web. People from other organizations joining through Slack Connect can never use agents. An owner or admin can change this.",
  "workspace.guestSavedOn": "Slack guests can now use agents.",
  "workspace.guestSavedOff": "Slack guests can no longer use agents.",
  "workspace.readOnly":
    "These are the current settings. To change them, ask a workspace owner or admin.",
  "workspace.retentionValue": "Audit records are kept for {days} days.",
  "workspace.guestValueOn": "Slack guests can use agents.",
  "workspace.guestValueOff": "Slack guests cannot use agents.",
};

export const workspaceJa: Record<keyof typeof workspaceKo, string> = {
  "workspace.title": "ワークスペース設定",
  "workspace.description": "ワークスペース全体に適用される設定です。",
  "workspace.readOnlyMark": "読み取り専用",
  "workspace.name": "ワークスペース名",
  "workspace.nameHint": "コンソールと通知に表示される名前です。",
  "workspace.nameFoot": "コンソールからはまだ変更できません。",
  "workspace.id": "ワークスペース ID",
  "workspace.idHint": "API や CLI でこのワークスペースを指すときに使います。",
  "workspace.idCopied": "ワークスペース ID をコピーしました。",
  "workspace.models": "許可モデル一覧",
  "workspace.modelsHint":
    "セッションで選べるモデルの上限です。エージェントの制限とプロファイルがここからさらに絞り込みます。",
  "workspace.modelsFoot":
    "インストール設定で管理します · コンソールでは読み取り専用",
  "workspace.modelsEmpty": "このインストールに登録されたモデルはありません。",
  "workspace.retention": "監査ログの保存期間",
  "workspace.retentionDays": "保存日数",
  "workspace.retentionHint":
    "許可・拒否されたリクエストの記録をこの期間保存します。",
  "workspace.retentionFoot": "最短 30 日です。変更できるのはオーナーのみです。",
  "workspace.retentionFloor":
    "監査ログは 30 日以上保存する必要があります。30〜3650 の数値を入力してください。",
  "workspace.retentionCeiling":
    "監査ログの保存期間は最長 {max} 日です。{max} 以下の数値を入力してください。",
  "workspace.retentionSaved": "監査ログを {days} 日間保存します。",
  "workspace.save": "保存",
  "workspace.guest": "Slack ゲスト",
  "workspace.guestLabel": "Slack ゲストにエージェントの利用を許可",
  "workspace.guestOn": "オン",
  "workspace.guestOff": "オフ",
  "workspace.guestHint":
    "オンの場合でも、ゲストは先に Web で Slack アカウントを連携する必要があります。Slack コネクトで参加したほかの組織の人は、エージェントを利用できません。変更できるのはオーナーまたは管理者です。",
  "workspace.guestSavedOn":
    "Slack ゲストがエージェントを利用できるようになりました。",
  "workspace.guestSavedOff":
    "Slack ゲストはエージェントを利用できなくなりました。",
  "workspace.readOnly":
    "現在の設定です。変更するには、ワークスペースのオーナーまたは管理者に依頼してください。",
  "workspace.retentionValue": "監査ログを {days} 日間保存します。",
  "workspace.guestValueOn": "Slack ゲストはエージェントを利用できます。",
  "workspace.guestValueOff": "Slack ゲストはエージェントを利用できません。",
};

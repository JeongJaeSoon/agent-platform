export const workspaceKo = {
  "workspace.title": "워크스페이스 설정",
  "workspace.retention": "감사 기록 보존 기간",
  "workspace.retentionDays": "보존 기간(일)",
  "workspace.retentionHint":
    "허용·거절한 요청 기록을 이 기간 동안 보관합니다. 30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.",
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
  "workspace.retention": "Audit log retention",
  "workspace.retentionDays": "Keep for (days)",
  "workspace.retentionHint":
    "Records of allowed and denied requests are kept this long, for at least 30 days. Only an owner can change this.",
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

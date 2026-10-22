export const linkedKo = {
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
};

export const linkedEn: Record<keyof typeof linkedKo, string> = {
  "linked.title": "Linked accounts",
  "linked.intro":
    "Link your Slack account so that requests you make to agents in Slack use your permissions. No Slack token is stored.",
  "linked.slack": "Slack",
  "linked.none": "No Slack account linked.",
  "linked.connect": "Link Slack account",
  "linked.starting": "Going to Slack…",
  "linked.slackAccount": "Slack user {user} (workspace {team})",
  "linked.verified": "verified {at}",
  "linked.stale":
    "Slack says this account was deactivated, so requests from it are not matched to you — unlink it and link it again.",
  "linked.unlink": "Unlink",
  "linked.unlinked": "Unlinked the Slack account.",
  "linked.unavailable":
    "Slack account linking is not available on this installation — ask your operator.",
  "linked.cancelled": "Slack linking was not completed — try again.",
  "linked.back": "Back to linked accounts",
};

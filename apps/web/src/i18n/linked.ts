export const linkedKo = {
  "linked.title": "연동 계정",
  "linked.intro":
    "Slack 계정을 연결하면 Slack에서 에이전트에게 요청할 때 내 권한이 적용됩니다. Slack 토큰은 저장하지 않습니다.",
  "linked.slack": "Slack",
  "linked.connected": "연결됨",
  "linked.notLinked": "연결 안 됨",
  "linked.soon": "준비 중",
  "linked.use.github": "저장소 읽기·쓰기",
  "linked.use.slack": "알림과 요청 답변",
  "linked.use.google": "Drive·Docs 읽기·쓰기, Calendar",
  "linked.link": "연결",
  "linked.connect": "Slack 계정 연결",
  "linked.starting": "Slack으로 이동하는 중…",
  "linked.slackAccount": "Slack 사용자 {user} (워크스페이스 {team})",
  "linked.slackNamed": "{user} · {team}",
  "linked.slackIds": "사용자 ID {user} · 워크스페이스 ID {team}",
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
  "linked.connected": "Linked",
  "linked.notLinked": "Not linked",
  "linked.soon": "Coming soon",
  "linked.use.github": "Repository read and write",
  "linked.use.slack": "Notifications and answering requests",
  "linked.use.google": "Drive and Docs read and write, Calendar",
  "linked.link": "Link",
  "linked.connect": "Link Slack account",
  "linked.starting": "Going to Slack…",
  "linked.slackAccount": "Slack user {user} (workspace {team})",
  "linked.slackNamed": "{user} · {team}",
  "linked.slackIds": "User ID {user} · workspace ID {team}",
  "linked.verified": "Verified {at}",
  "linked.stale":
    "Slack says this account was deactivated, so requests from it are not matched to you — unlink it and link it again.",
  "linked.unlink": "Unlink",
  "linked.unlinked": "Unlinked the Slack account.",
  "linked.unavailable":
    "Slack account linking is not available on this installation — ask your operator.",
  "linked.cancelled": "Slack linking was not completed — try again.",
  "linked.back": "Back to linked accounts",
};

export const linkedJa: Record<keyof typeof linkedKo, string> = {
  "linked.title": "連携アカウント",
  "linked.intro":
    "Slack アカウントを連携すると、Slack でエージェントに依頼したリクエストに自分の権限が使われます。Slack のトークンは保存しません。",
  "linked.slack": "Slack",
  "linked.connected": "連携済み",
  "linked.notLinked": "未連携",
  "linked.soon": "準備中",
  "linked.use.github": "リポジトリの読み書き",
  "linked.use.slack": "通知とリクエストへの回答",
  "linked.use.google": "Drive・Docs の読み書き、Calendar",
  "linked.link": "連携",
  "linked.connect": "Slack アカウントを連携",
  "linked.starting": "Slack に移動しています…",
  "linked.slackAccount": "Slack ユーザー {user}（ワークスペース {team}）",
  "linked.slackNamed": "{user} · {team}",
  "linked.slackIds": "ユーザー ID {user} · ワークスペース ID {team}",
  "linked.verified": "{at}に確認",
  "linked.stale":
    "Slack でこのアカウントが無効化されたため、このアカウントからのリクエストはあなたと紐付けられません。連携を解除してから、もう一度連携してください。",
  "linked.unlink": "連携を解除",
  "linked.unlinked": "Slack アカウントの連携を解除しました。",
  "linked.unavailable":
    "この環境では Slack アカウント連携を利用できません。運用担当者にお問い合わせください。",
  "linked.cancelled":
    "Slack 連携が完了しませんでした。もう一度お試しください。",
  "linked.back": "連携アカウントへ戻る",
};

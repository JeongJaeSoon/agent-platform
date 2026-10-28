import type { SlackSurfaceAction } from "../kollegium/surfaces.ts";
import type {
  AuthorizationDecision,
  AuthorizationReason,
} from "./authorization.ts";

// What the person a Slack decision refused sees, only them and once per
// thread (design 3.3). Product copy: plain words, no internal module names.
export const SLACK_NOTICE_MESSAGES = {
  connect: "웹에서 Slack 계정을 연결해 주세요",
  noRequestRight: "이 채널에서 이 에이전트에게 요청할 권한이 없어요",
  noApproveRight: "이 요청을 승인할 권한이 없어요",
  guestDisabled: "이 워크스페이스는 게스트의 에이전트 사용을 허용하지 않아요",
  membersOnly: "이 에이전트는 이 워크스페이스 구성원만 쓸 수 있어요",
  outOfShare:
    "이 세션은 공유 범위 밖이라 요청할 수 없어요. 세션을 시작한 사람에게 공유를 요청하세요",
  credentialUnbound:
    "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요",
  failed: "지금은 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요",
  repositoryRequired:
    "이 에이전트의 릴리스에 쓸 수 있는 저장소가 없어 시작하지 못했어요(저장소를 고르지 않았거나 카탈로그에서 빠졌어요). 에이전트 관리자가 웹 콘솔에서 저장소를 골라 새 릴리스를 만들고 활성화해야 해요",
  profileUnavailable:
    "이 에이전트의 릴리스가 쓰는 실행 프로필이 지금 카탈로그에 없거나, 바뀌었거나, 운영자가 차단해 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 쓸 수 있는 프로필로 새 릴리스를 만들고 활성화해야 해요",
  noActiveRelease:
    "이 에이전트는 아직 활성화된 릴리스가 없어요. 에이전트 관리자가 웹 콘솔에서 릴리스를 활성화해야 해요",
} as const;

type NoticeKey = keyof typeof SLACK_NOTICE_MESSAGES;

// Every refusal has a notice, so a new reason code cannot reach Slack as
// silence. A missing right reads differently for whoever pressed approve.
const NOTICE_FOR: Record<
  Exclude<AuthorizationReason, "ok">,
  NoticeKey | "noRight"
> = {
  unlinked: "connect",
  // Linking again is what clears a link that went stale.
  stale_link: "connect",
  role: "noRight",
  surface_ceiling: "noRight",
  agent_ceiling: "noRight",
  disabled: "noRight",
  guest_disabled: "guestDisabled",
  external_user: "membersOnly",
  not_found: "outOfShare",
  // Slack has no field for a reason, so a reason-gated action is out of reach.
  justification_required: "noRight",
  credential_unbound: "credentialUnbound",
  no_requester: "failed",
  error: "failed",
};

export type SlackNotice = {
  text: string;
  /** The web page where the person links their Slack account. */
  link_url?: string;
};

/**
 * The notice for a decision, or null when there is nothing to tell: an
 * allow, or a redact, whose summary and web link the channel shows instead.
 */
export function slackNoticeFor(
  decision: Pick<AuthorizationDecision, "outcome" | "reason_code">,
  action: SlackSurfaceAction,
  links: { connectUrl: string },
): SlackNotice | null {
  if (decision.outcome !== "deny" || decision.reason_code === "ok") {
    return null;
  }
  const key = NOTICE_FOR[decision.reason_code];
  if (key === "connect") {
    return {
      text: SLACK_NOTICE_MESSAGES.connect,
      link_url: links.connectUrl,
    };
  }
  if (key === "noRight") {
    return {
      text:
        action === "session.approve"
          ? SLACK_NOTICE_MESSAGES.noApproveRight
          : SLACK_NOTICE_MESSAGES.noRequestRight,
    };
  }
  return { text: SLACK_NOTICE_MESSAGES[key] };
}

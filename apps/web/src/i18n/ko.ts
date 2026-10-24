import { flowKo, formsKo, sessionsKo } from "@werft-ai/react";
import { agentsKo } from "./agents.ts";
import { apiKeysKo } from "./api-keys.ts";
import { authKo } from "./auth.ts";
import { commonKo } from "./common.ts";
import { errorsKo } from "./errors.ts";
import { homeKo } from "./home.ts";
import { linkedKo } from "./linked.ts";
import { membersKo } from "./members.ts";
import { modelsKo } from "./models.ts";
import { outputsKo } from "./outputs.ts";
import { preferencesKo } from "./preferences.ts";
import { sessionListKo } from "./session-list.ts";
import { shellKo } from "./shell.ts";
import { teamsKo } from "./teams.ts";
import { usageKo } from "./usage.ts";
import { workspaceKo } from "./workspace.ts";

/**
 * The message catalog's source of truth, spread together from one file per
 * area; a new key goes in its area's file, never here. Keys are
 * `<screen>.<element>`; shared words live under `common.*`, status screens
 * under `status.<kind>.*` and error guidance under `error.<API error code>`.
 * `{name}` is a variable. Every other locale is typed against these keys, so
 * a key added to an area's Korean object and not translated fails the
 * typecheck.
 */
export const slackKo = {
  "slack.error.config":
    "워크스페이스의 Slack 앱 생성 설정이 필요합니다. 관리자에게 설정을 요청하세요.",
  "slack.error.creating":
    "앱 생성 결과를 확인 중입니다. Slack에 앱이 있는지 관리자에게 확인한 뒤 새로고침하세요.",
  "slack.error.notInstalled": "Slack 앱을 설치한 뒤 채널을 연결하세요.",
  "slack.error.denied":
    "Slack에서 설치를 허용하지 않았습니다. Slack 탭에서 다시 설치할 수 있습니다.",
  "slack.error.expired":
    "설치 링크가 만료됐거나 이미 사용됐습니다. Slack 탭에서 다시 설치하세요.",
  "slack.error.rejected":
    "Slack 앱이나 워크스페이스가 일치하지 않아 설치하지 못했습니다. Slack 탭에서 다시 시작하세요.",
  "slack.error.cursor":
    "채널 목록이 바뀌었습니다. 새로고침하여 처음부터 검색하세요.",
  "agent.tabs.slack": "Slack",
  "agents.flow.channels": "채널 연결",
  "slack.app": "Slack 앱",
  "slack.verifyNeeded":
    "앱은 설치했지만 이벤트 등록 확인이 필요합니다. 관리자에게 확인을 요청하세요.",
  "slack.joinHint":
    "공개·비공개 채널 모두 /invite로 봇을 초대하세요. 채널 연결만으로 봇이 참여하지는 않습니다.",
  "slack.appId": "앱 ID",
  "slack.state.none": "만들기 전",
  "slack.state.pending": "설치 대기",
  "slack.state.connected": "연결됨",
  "slack.state.reinstall": "재설치 필요",
  "slack.state.error": "오류",
  "slack.createInstall": "Slack 앱 만들고 설치",
  "slack.install": "Slack 앱 설치",
  "slack.reinstall": "다시 설치",
  "slack.working": "준비 중…",
  "slack.refresh": "새로고침",
  "slack.delete": "앱 삭제",
  "slack.deleteWarning":
    "Slack 앱과 저장한 자격을 삭제합니다. 이 앱을 통한 메시지를 더 이상 받지 않습니다.",
  "slack.deleted": "Slack 앱을 삭제했습니다.",
  "slack.revoke": "연결 해제",
  "slack.revokeWarning":
    "이 에이전트의 Slack 신원과 채널 연결을 해제합니다. 이후 이벤트는 받지 않습니다.",
  "slack.revoked": "Slack 연결을 해제했습니다.",
  "slack.activateFirst": "에이전트를 먼저 켠 뒤 Slack 앱을 만들 수 있습니다.",
  "slack.channels": "채널",
  "slack.overview": "개요",
  "slack.settings": "설정",
  "slack.sections": "Slack 관리",
  "slack.saved": "채널 반응을 저장했습니다.",
  "slack.homeSaved": "홈 채널을 지정했습니다.",
  "slack.channelConnected": "채널을 연결했습니다.",
  "slack.dmSaved": "다이렉트 메시지 설정을 저장했습니다.",
  "slack.ambient": "항상 반응",
  "slack.notConfigured": "설정 안 됨",
  "slack.home": "홈",
  "slack.setHome": "홈 지정",
  "slack.channelHome": "{channel} 홈 지정",
  "slack.channelConnect": "{channel} 연결",
  "slack.connectedChannels": "연결된 채널",
  "slack.noConnectedChannels": "연결된 채널이 없습니다",
  "slack.addChannelHint": "채널 추가에서 이 에이전트가 반응할 채널을 고르세요.",
  "slack.addChannel": "채널 추가",
  "slack.basic": "기본",
  "slack.advanced": "고급",
  "slack.connection": "연결",
  "slack.status": "상태",
  "slack.homeChannel": "홈 채널",
  "slack.homeUnset": "선택 안 됨",
  "slack.change": "바꾸기",
  "slack.changeHome": "홈 채널 바꾸기",
  "slack.channelId": "채널 ID: {id}",
  "slack.channelsLoading": "채널을 불러오는 중입니다",
  "slack.danger": "위험 구역",
  "slack.botId": "봇 ID",
  "slack.defaultHint":
    "이 화면에서 새로 연결하는 채널에만 적용합니다. 이미 연결된 채널은 바꾸지 않습니다.",
  "slack.dm": "다이렉트 메시지",
  "slack.dmHint":
    "Slack 앱의 메시지 탭에서 연결된 구성원의 1:1 대화를 받습니다.",
  "slack.public": "공개",
  "slack.private": "비공개",
  "slack.off": "꺼짐",
  "slack.mention": "멘션할 때",
  "slack.reaction": "{channel} 멘션할 때 반응",
  "slack.defaultReaction": "새로 연결할 채널에서 멘션할 때 반응",
  "slack.search": "채널 찾기",
  "slack.invite": "참여 대기",
  "slack.privateInvite": "/invite 필요",
  "slack.add": "연결",
  "slack.noChannels":
    "찾은 채널이 없습니다. 비공개 채널은 먼저 /invite로 초대하세요.",
  "slack.partial": "일부 채널이 없거나 이전 검색 결과일 수 있습니다.",
  "slack.more": "더 보기",
} as const;

export const ko = {
  ...slackKo,
  ...commonKo,
  ...shellKo,
  ...authKo,
  ...homeKo,
  ...membersKo,
  ...teamsKo,
  ...agentsKo,
  ...modelsKo,
  ...sessionsKo,
  ...sessionListKo,
  ...flowKo,
  ...linkedKo,
  ...outputsKo,
  ...apiKeysKo,
  ...workspaceKo,
  ...usageKo,
  ...preferencesKo,
  ...errorsKo,
  ...formsKo,
} as const;

export type MessageKey = keyof typeof ko;

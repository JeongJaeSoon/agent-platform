import type { Meta, StoryObj } from "@storybook/react-vite";
import { Page, Stepper } from "@werft-ai/ui";
import { useState } from "react";

import { MOBILE, PartRequest, ScreenShell } from "./screen-kit.tsx";
import {
  type ChannelGroup,
  type ConnectStep,
  SlackConnectCard,
  storyHref,
} from "./slack-kit.tsx";

/*
 * The new-agent wizard's fifth step, Slack (v3-ia.md §3.3), on apps/web
 * new-agent-flow.tsx. The Stepper is main's; the v3 one (success-toned done
 * steps, connectors, a "완료" line) is the requested part.
 */

const BOT = "@release-notes";
const HOME = "#release-notes";
const DESCRIPTION = "배포가 끝나면 릴리즈 노트 초안을 씁니다";
const STEPS = [
  { id: "name", label: "이름" },
  { id: "job", label: "하는 일" },
  { id: "release", label: "배포 판" },
  { id: "activate", label: "켜기" },
  { id: "slack", label: "Slack 연결", description: "선택" },
];
const LONG_CHANNEL = "#platform-release-announcements-and-deploy-coordination";
const CHANNELS: readonly ChannelGroup[] = [
  {
    label: "공개 채널",
    // The long name checks that a row truncates the name, never the tag.
    options: [
      "#release-notes",
      "#dev-platform",
      LONG_CHANNEL,
      "#general",
      "#random",
    ].map((name) => ({ name })),
  },
  {
    label: "비공개 채널",
    // Invited by /invite, so the bot is in it and Slack shows its name.
    options: [{ name: "#finance-private", private: true, disabled: true }],
  },
];
const NO_CHANNELS: readonly ChannelGroup[] = [
  { label: "공개 채널", options: [] },
];

const DETAIL = "screens-agent-detail-v3--agent-detail";

function NewAgentScreen({
  step: initial,
  empty = false,
}: {
  readonly step: ConnectStep;
  readonly empty?: boolean | undefined;
}) {
  const [step, setStep] = useState(initial);
  const [home, setHome] = useState(HOME);
  return (
    <ScreenShell current="agents" crumb={["에이전트"]}>
      <Page
        title="새 에이전트"
        description="빈 카드에서 네 단계로 만들고, 다섯째 Slack 연결은 선택입니다. '하는 일'까지 마치면 초안으로 저장되어, 그 뒤에 나가도 목록에 초안으로 남습니다."
      >
        <div className="flex flex-col gap-[var(--ap-space-block)]">
          <div className="flex flex-wrap gap-1">
            <PartRequest name="Stepper (v3)" />
          </div>
          <Stepper
            label="에이전트 만들기 단계"
            steps={STEPS}
            currentStepId="slack"
          />
          <SlackConnectCard
            key={step}
            step={step}
            wizard
            bot={BOT}
            description={DESCRIPTION}
            channels={empty ? NO_CHANNELS : CHANNELS}
            home={home}
            onStep={(next, picked) => {
              if (picked) setHome(picked);
              setStep(next === "allowed" ? "pick" : next);
            }}
            // After a failed event registration the app is already installed.
            skipHref={storyHref(
              step === "error"
                ? `${DETAIL}-slack-error`
                : `${DETAIL}-slack-none`,
            )}
            agentHref={
              step === "later"
                ? storyHref(`${DETAIL}-slack-no-home`)
                : `${storyHref(`${DETAIL}-slack-overview`)}&args=home:${home.slice(1)}`
            }
            settingsHref={storyHref(
              "screens-workspace-settings-v4--workspace-settings-slack-unset-edit",
            )}
          />
        </div>
      </Page>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/New agent (v3)",
  component: NewAgentScreen,
  parameters: { layout: "fullscreen" },
  args: { step: "allow" },
} satisfies Meta<typeof NewAgentScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const NewAgentSlackAllow: Story = { name: "Slack 단계: 허용 전" };
export const NewAgentSlackAllowDark: Story = {
  name: "Slack 단계: 허용 전 (dark)",
  globals: DARK,
};
export const NewAgentSlackAllowMobile: Story = {
  name: "Slack 단계: 허용 전 (390px)",
  globals: MOBILE,
};

export const NewAgentSlackPick: Story = {
  name: "Slack 단계: 홈 채널 고르기",
  args: { step: "pick" },
};
export const NewAgentSlackPickDark: Story = {
  ...NewAgentSlackPick,
  name: "Slack 단계: 홈 채널 고르기 (dark)",
  globals: DARK,
};
export const NewAgentSlackPickMobile: Story = {
  ...NewAgentSlackPick,
  name: "Slack 단계: 홈 채널 고르기 (390px)",
  globals: MOBILE,
};

export const NewAgentSlackPickEmpty: Story = {
  name: "Slack 단계: 고를 채널 없음",
  args: { step: "pick", empty: true },
};
export const NewAgentSlackPickEmptyDark: Story = {
  ...NewAgentSlackPickEmpty,
  name: "Slack 단계: 고를 채널 없음 (dark)",
  globals: DARK,
};
export const NewAgentSlackPickEmptyMobile: Story = {
  ...NewAgentSlackPickEmpty,
  name: "Slack 단계: 고를 채널 없음 (390px)",
  globals: MOBILE,
};

export const NewAgentSlackDone: Story = {
  name: "Slack 단계: 완료",
  args: { step: "done" },
};
export const NewAgentSlackDoneDark: Story = {
  ...NewAgentSlackDone,
  name: "Slack 단계: 완료 (dark)",
  globals: DARK,
};
export const NewAgentSlackDoneMobile: Story = {
  ...NewAgentSlackDone,
  name: "Slack 단계: 완료 (390px)",
  globals: MOBILE,
};

export const NewAgentSlackLater: Story = {
  name: "Slack 단계: 나중에 고르기",
  args: { step: "later" },
};
export const NewAgentSlackLaterDark: Story = {
  ...NewAgentSlackLater,
  name: "Slack 단계: 나중에 고르기 (dark)",
  globals: DARK,
};
export const NewAgentSlackLaterMobile: Story = {
  ...NewAgentSlackLater,
  name: "Slack 단계: 나중에 고르기 (390px)",
  globals: MOBILE,
};

export const NewAgentSlackError: Story = {
  name: "Slack 단계: 오류",
  args: { step: "error" },
};
export const NewAgentSlackErrorDark: Story = {
  ...NewAgentSlackError,
  name: "Slack 단계: 오류 (dark)",
  globals: DARK,
};
export const NewAgentSlackErrorMobile: Story = {
  ...NewAgentSlackError,
  name: "Slack 단계: 오류 (390px)",
  globals: MOBILE,
};

export const NewAgentSlackBlocked: Story = {
  name: "Slack 단계: token 없음",
  args: { step: "blocked" },
};
export const NewAgentSlackBlockedDark: Story = {
  ...NewAgentSlackBlocked,
  name: "Slack 단계: token 없음 (dark)",
  globals: DARK,
};
export const NewAgentSlackBlockedMobile: Story = {
  ...NewAgentSlackBlocked,
  name: "Slack 단계: token 없음 (390px)",
  globals: MOBILE,
};

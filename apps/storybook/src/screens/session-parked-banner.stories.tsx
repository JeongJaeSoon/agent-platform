import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusLabel } from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  Badge,
  Button,
  formatTimestamp,
} from "@werft-ai/ui";

/*
 * S-A3: the banner at the head of a session's detail while its requests
 * wait parked, after they all expire, while it resumes, and after a person
 * paused it with answers saved.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type BannerState = "parked" | "expired" | "resuming" | "humanPause";

const EXPIRES_AT = formatTimestamp("2026-10-22T01:00:00.000Z", "ko");

const RESUME = <Button type="button">다시 시작</Button>;

function SessionParkedBannerBody({ state }: { readonly state: BannerState }) {
  if (state === "parked") {
    return (
      <Alert variant="amber">
        답을 기다리다 일시정지했습니다. 아래 요청에 답하면 이어서 진행합니다.{" "}
        {EXPIRES_AT}까지.
      </Alert>
    );
  }
  if (state === "expired") {
    return (
      <Alert variant="amber">
        요청이 모두 만료돼 일시정지 상태로 남아 있습니다. 다시 시작하면 거부된
        것으로 이어집니다.
        <AlertActions>{RESUME}</AlertActions>
      </Alert>
    );
  }
  if (state === "resuming") {
    return <Alert variant="blue">답을 받아 이어서 진행하는 중입니다.</Alert>;
  }
  return (
    <Alert variant="amber">
      <div className="story-row items-center">
        <StatusLabel axis="admission" state="paused" label="일시정지됨" />
        답은 저장했습니다. 다시 시작하면 반영됩니다.
      </div>
      <AlertActions>{RESUME}</AlertActions>
    </Alert>
  );
}

function SessionParkedBannerScreen(
  props: Parameters<typeof SessionParkedBannerBody>[0],
) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <SessionParkedBannerBody {...props} />
    </div>
  );
}

const meta = {
  title: "Screens/Session parked banner (v3)",
  component: SessionParkedBannerScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "parked" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["parked", "expired", "resuming", "humanPause"],
    },
  },
} satisfies Meta<typeof SessionParkedBannerScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionParkedBanner: Story = { name: "Parked" };
export const SessionParkedBannerExpired: Story = {
  name: "All expired",
  args: { state: "expired" },
};
export const SessionParkedBannerResuming: Story = {
  name: "Resuming",
  args: { state: "resuming" },
};
export const SessionParkedBannerHumanPause: Story = {
  name: "Paused by a person, answers saved",
  args: { state: "humanPause" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const SessionParkedBannerExpiredMobile: Story = {
  name: "All expired (390px)",
  args: { state: "expired" },
  globals: MOBILE,
};

export const SessionParkedBannerExpiredMobileDark: Story = {
  name: "All expired (390px, dark)",
  args: { state: "expired" },
  globals: { ...MOBILE, theme: "dark" },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionStatusLabel } from "@werft-ai/react/components";
import { Badge, Link, RowList, RowListItem } from "@werft-ai/ui";

/*
 * S-A4: a session row whose requests wait. SessionRow has no place for a
 * second badge beside its status, so the row is laid out here by hand.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type RowState = "waiting" | "parked" | "expired";

const SESSION_ID = "0192f0c4-7d3a-7b4e-9f00-00000000a001";

function SessionListParkedBadgeBody({ state }: { readonly state: RowState }) {
  return (
    <RowList variant="joined" aria-label="세션">
      <RowListItem>
        <Link href={`#/sessions/${SESSION_ID}`}>
          {SESSION_ID.slice(0, 8)} <span aria-hidden="true">›</span>
        </Link>
        <span className="story-row items-center">
          {state === "expired" ? null : (
            <SessionStatusLabel
              status="needs_input"
              label="답변 대기"
              axisLabel="작업 상태"
            />
          )}
          {state === "waiting" ? null : (
            <Badge variant="amber">일시정지됨</Badge>
          )}
        </span>
      </RowListItem>
    </RowList>
  );
}

function SessionListParkedBadgeScreen(
  props: Parameters<typeof SessionListParkedBadgeBody>[0],
) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <SessionListParkedBadgeBody {...props} />
    </div>
  );
}

const meta = {
  title: "Screens/Session list parked badge (v3)",
  component: SessionListParkedBadgeScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "parked" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["waiting", "parked", "expired"],
    },
  },
} satisfies Meta<typeof SessionListParkedBadgeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionListParkedBadge: Story = { name: "Parked" };
export const SessionListParkedBadgeWaiting: Story = {
  name: "Waiting",
  args: { state: "waiting" },
};
export const SessionListParkedBadgeExpired: Story = {
  name: "Expired",
  args: { state: "expired" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const SessionListParkedBadgeMobile: Story = {
  name: "Parked (390px)",
  globals: MOBILE,
};

export const SessionListParkedBadgeMobileDark: Story = {
  name: "Parked (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

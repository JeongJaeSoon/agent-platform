import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Link,
  RowList,
  RowListItem,
} from "@werft-ai/ui";
import { MOBILE } from "./screen-kit.tsx";

/*
 * The Slack tab's status strip after install. GET .../slack/app answers
 * `events.state`; while it is `pending` the owner still has to press
 * Verify in Slack, so the strip links the app's Event Subscriptions page.
 */

const APP_ID = "A07PLACEHLD";
const MUTED = "text-muted-foreground";
const PAIR = "flex items-center gap-2";

type EventsState = "pending" | "verified";

function SlackEventsStatus({ events }: { readonly events: EventsState }) {
  return (
    <section
      className="flex flex-col gap-[var(--ap-space-block)] p-4"
      aria-label="상태"
    >
      {events === "pending" ? (
        <Alert variant="amber">
          <AlertTitle>Slack에서 Request URL을 Verify하세요</AlertTitle>
          <AlertDescription>
            Slack이 이 앱의 Request URL을 확인하기 전에는 초대·멘션·DM 이벤트가
            오지 않습니다. 앱 설정의 Event Subscriptions에서 Verify(또는
            Retry)를 누르세요. 확인 요청이 도착하면 이 안내는 사라집니다.{" "}
            <Link
              href={`https://api.slack.com/apps/${APP_ID}/event-subscriptions`}
              target="_blank"
              newTabLabel="(새 탭에서 열림)"
              underline="always"
            >
              Event Subscriptions 열기
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <RowList variant="joined">
        <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
          <Badge variant="green">연결됨</Badge>
          <div className={PAIR}>
            <div className={MUTED}>봇 ID</div>
            <div className="font-mono text-caption">U07PLACEBOT</div>
          </div>
          <div className={PAIR}>
            <div className={MUTED}>홈 채널</div>
            <div>#release-notes</div>
          </div>
          <div className={PAIR}>
            <div className={MUTED}>DM 받기</div>
            <div>켜짐</div>
          </div>
        </RowListItem>
      </RowList>
    </section>
  );
}

const meta = {
  title: "Screens/Slack events pending",
  component: SlackEventsStatus,
  parameters: { layout: "fullscreen" },
  args: { events: "pending" },
  argTypes: {
    events: { control: "inline-radio", options: ["pending", "verified"] },
  },
} satisfies Meta<typeof SlackEventsStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const SlackEventsPending: Story = { name: "Request URL 확인 전" };
export const SlackEventsPendingDark: Story = {
  name: "Request URL 확인 전 (dark)",
  globals: DARK,
};
export const SlackEventsPendingMobile: Story = {
  name: "Request URL 확인 전 (390px)",
  globals: MOBILE,
};
export const SlackEventsVerified: Story = {
  name: "확인됨",
  args: { events: "verified" },
};
export const SlackEventsVerifiedDark: Story = {
  ...SlackEventsVerified,
  name: "확인됨 (dark)",
  globals: DARK,
};

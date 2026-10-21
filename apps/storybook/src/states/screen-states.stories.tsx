import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusLabel,
} from "@werft-ai/ui";

/*
 * One list panel in each state a screen goes through, built only from
 * packages/ui. apps/web's StatusScreen is not here: it needs the i18n
 * provider and the router's <Link>, which this workspace does not mount.
 */

type PanelState = "loading" | "empty" | "error" | "ready";

function SessionsPanel({ state }: { readonly state: PanelState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>세션</CardTitle>
      </CardHeader>
      <CardContent>
        {state === "loading" ? <Skeleton lines={4} label="세션 목록" /> : null}
        {state === "empty" ? (
          <EmptyState
            title="아직 세션이 없습니다"
            description="에이전트에게 첫 지시를 보내면 여기에 쌓입니다."
            action={<Button type="button">새 세션</Button>}
          />
        ) : null}
        {state === "error" ? (
          <ErrorState
            message="request timed out"
            code="REQUEST_TIMEOUT"
            retry={() => {}}
          />
        ) : null}
        {state === "ready" ? (
          <ul className="story-stack">
            <li>
              <StatusLabel axis="turn" state="running" detail="2분 12초 경과" />
            </li>
            <li>
              <StatusLabel axis="turn" state="completed" />
            </li>
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

const meta = {
  title: "Screens/Sessions panel",
  component: SessionsPanel,
  args: { state: "loading" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["loading", "empty", "error", "ready"],
    },
  },
} satisfies Meta<typeof SessionsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {};
export const Empty: Story = { args: { state: "empty" } };
export const Failed: Story = { name: "Error", args: { state: "error" } };
export const Ready: Story = { args: { state: "ready" } };

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const EmptyMobile: Story = {
  name: "Empty (390px)",
  args: { state: "empty" },
  globals: MOBILE,
};

export const ErrorMobileDark: Story = {
  name: "Error (390px, dark)",
  args: { state: "error" },
  globals: { ...MOBILE, theme: "dark" },
};

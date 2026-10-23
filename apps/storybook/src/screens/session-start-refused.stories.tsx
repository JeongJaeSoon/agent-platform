import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  RowLines,
  RowList,
  RowListItem,
} from "@werft-ai/ui";

/*
 * S-E6: what the requester sees when starting a session answers 409
 * VARIABLE_UNRESOLVED. The missing names stay in the admins' receipt only.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type ScreenState = "requester";

const ADMINS = [
  { name: "김하나", email: "hana.kim@example.com" },
  { name: "플랫폼 팀", email: "platform-team@example.com" },
];

function SessionStartRefusedScreen(_: { readonly state: ScreenState }) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <ErrorState
        title="이 에이전트에 필요한 설정이 없어 세션을 시작하지 못했습니다."
        guidance="에이전트 관리자에게 문의하세요."
        code="VARIABLE_UNRESOLVED"
      />
      <Card>
        <CardHeader>
          <CardTitle>에이전트 관리자</CardTitle>
        </CardHeader>
        <CardContent>
          <RowList variant="joined" aria-label="에이전트 관리자">
            {ADMINS.map((admin) => (
              <RowListItem key={admin.email}>
                <RowLines>
                  <span>{admin.name}</span>
                  <span className="text-muted-foreground text-caption">
                    {admin.email}
                  </span>
                </RowLines>
              </RowListItem>
            ))}
          </RowList>
        </CardContent>
      </Card>
    </div>
  );
}

const meta = {
  title: "Screens/Session start refused (v3)",
  component: SessionStartRefusedScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "requester" },
  argTypes: {
    state: { control: "inline-radio", options: ["requester"] },
  },
} satisfies Meta<typeof SessionStartRefusedScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionStartRefused: Story = { name: "Requester" };

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const SessionStartRefusedMobile: Story = {
  name: "Requester (390px)",
  globals: MOBILE,
};

export const SessionStartRefusedMobileDark: Story = {
  name: "Requester (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

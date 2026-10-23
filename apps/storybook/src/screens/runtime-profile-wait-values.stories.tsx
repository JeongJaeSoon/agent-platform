import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  RowLines,
  RowList,
  RowListItem,
} from "@werft-ai/ui";

/*
 * S-A7: a runtime profile card in settings, with how long its requests
 * wait before parking and before expiring under the permission mode.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type ProfileState = "configured" | "installDefault";

const WAIT: Record<ProfileState, string> = {
  configured: "답 대기: 10분 뒤 일시정지 · 2시간 뒤 만료",
  installDefault: "답 대기: 30분 뒤 일시정지 · 24시간 뒤 만료 (설치 기본값)",
};

function RuntimeProfileWaitValuesBody({
  state,
}: {
  readonly state: ProfileState;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>claude-default</CardTitle>
      </CardHeader>
      <CardContent>
        <RowList variant="joined" aria-label="claude-default 설정">
          <RowListItem>
            <RowLines>
              <span className="text-muted-foreground text-caption">모델</span>
              <span>claude-sonnet-4-5</span>
            </RowLines>
          </RowListItem>
          <RowListItem>
            <RowLines>
              <span className="text-muted-foreground text-caption">
                권한 모드
              </span>
              <span>default</span>
              <span className="text-muted-foreground text-caption">
                {WAIT[state]}
              </span>
            </RowLines>
          </RowListItem>
        </RowList>
      </CardContent>
    </Card>
  );
}

function RuntimeProfileWaitValuesScreen(
  props: Parameters<typeof RuntimeProfileWaitValuesBody>[0],
) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <RuntimeProfileWaitValuesBody {...props} />
    </div>
  );
}

const meta = {
  title: "Screens/Runtime profile wait values (v3)",
  component: RuntimeProfileWaitValuesScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "configured" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["configured", "installDefault"],
    },
  },
} satisfies Meta<typeof RuntimeProfileWaitValuesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RuntimeProfileWaitValues: Story = { name: "Configured" };
export const RuntimeProfileWaitValuesInstallDefault: Story = {
  name: "Install default",
  args: { state: "installDefault" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const RuntimeProfileWaitValuesInstallDefaultMobile: Story = {
  name: "Install default (390px)",
  args: { state: "installDefault" },
  globals: MOBILE,
};

export const RuntimeProfileWaitValuesInstallDefaultMobileDark: Story = {
  name: "Install default (390px, dark)",
  args: { state: "installDefault" },
  globals: { ...MOBILE, theme: "dark" },
};

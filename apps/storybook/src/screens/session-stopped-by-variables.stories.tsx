import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";

/*
 * S-E7: a session's attention is VARIABLE_REFUSED after a declared name
 * became reserved. Only admins are told which names.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type Viewer = "requester" | "admin";

const ADMINS = [
  { name: "김하나", email: "hana.kim@example.com" },
  { name: "플랫폼 팀", email: "platform-team@example.com" },
];

function SessionStoppedByVariablesScreen({
  state,
}: {
  readonly state: Viewer;
}) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <ErrorState
        title="이 세션의 설정이 더는 허용되지 않아 멈췄습니다."
        guidance="에이전트 관리자에게 문의하세요."
        message={
          state === "admin"
            ? "예약 이름이 된 변수: AP_SESSION_ID. 카드에서 이름을 바꾼 뒤 새 세션을 시작하세요."
            : undefined
        }
        code="VARIABLE_REFUSED"
      />
      <Card>
        <CardHeader>
          <CardTitle>에이전트 관리자</CardTitle>
        </CardHeader>
        <CardContent>
          <TableContainer label="에이전트 관리자">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">이름</TableHead>
                  <TableHead scope="col">이메일</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ADMINS.map((admin) => (
                  <TableRow key={admin.email}>
                    <TableCell>{admin.name}</TableCell>
                    <TableCell>{admin.email}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </div>
  );
}

const meta = {
  title: "Screens/Session stopped by variables (v3)",
  component: SessionStoppedByVariablesScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "requester" },
  argTypes: {
    state: { control: "inline-radio", options: ["requester", "admin"] },
  },
} satisfies Meta<typeof SessionStoppedByVariablesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionStoppedByVariables: Story = { name: "Requester" };
export const SessionStoppedByVariablesAdmin: Story = {
  name: "Admin",
  args: { state: "admin" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const SessionStoppedByVariablesAdminMobile: Story = {
  name: "Admin (390px)",
  args: { state: "admin" },
  globals: MOBILE,
};

export const SessionStoppedByVariablesAdminMobileDark: Story = {
  name: "Admin (390px, dark)",
  args: { state: "admin" },
  globals: { ...MOBILE, theme: "dark" },
};

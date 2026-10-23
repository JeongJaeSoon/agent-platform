import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from "@werft-ai/ui";

/*
 * S-A7: a runtime profile card in settings, with how long its requests
 * wait before parking and expiring under the permission mode. Profiles carry
 * no wait values yet, so the row says the API has to change first; the
 * install-default marker waits on the same field.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type ProfileState = "profile";

function RuntimeProfileWaitValuesBody(_: { readonly state: ProfileState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>claude-default</CardTitle>
      </CardHeader>
      <CardContent>
        <TableContainer label="claude-default 설정">
          <Table>
            <TableBody>
              <TableRow>
                <TableHead scope="row">모델</TableHead>
                <TableCell>claude-sonnet-4-5</TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row">권한 모드</TableHead>
                <TableCell>default</TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row">답 대기</TableHead>
                <TableCell>{API_CHANGE}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
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
  args: { state: "profile" },
  argTypes: {
    state: { control: "inline-radio", options: ["profile"] },
  },
} satisfies Meta<typeof RuntimeProfileWaitValuesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RuntimeProfileWaitValues: Story = { name: "Profile" };

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const RuntimeProfileWaitValuesMobile: Story = {
  name: "Profile (390px)",
  globals: MOBILE,
};

export const RuntimeProfileWaitValuesMobileDark: Story = {
  name: "Profile (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

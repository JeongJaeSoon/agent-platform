import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ProfileSummary } from "@werft-ai/contracts";
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
 * wait before parking and expiring under the permission mode: GET
 * /v1/profiles `permission_wait`, each value marked where the installation
 * default fills in for the profile.
 */

const WAIT: NonNullable<ProfileSummary["permission_wait"]> = {
  park_after_seconds: 600,
  expire_after_seconds: 86_400,
  source: {
    park_after_seconds: "profile",
    expire_after_seconds: "installation",
  },
};

function duration(seconds: number) {
  return seconds % 3600 === 0 ? `${seconds / 3600}시간` : `${seconds / 60}분`;
}

function WaitValue({
  label,
  seconds,
  source,
}: {
  readonly label: string;
  readonly seconds: number;
  readonly source: "profile" | "installation";
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label} {duration(seconds)}
      {source === "installation" ? <Badge>설치 기본값</Badge> : null}
    </div>
  );
}

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
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <WaitValue
                      label="일시정지까지"
                      seconds={WAIT.park_after_seconds}
                      source={WAIT.source.park_after_seconds}
                    />
                    <WaitValue
                      label="만료까지"
                      seconds={WAIT.expire_after_seconds}
                      source={WAIT.source.expire_after_seconds}
                    />
                  </div>
                </TableCell>
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

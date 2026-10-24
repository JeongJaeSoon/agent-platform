import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiErrorState } from "@werft-ai/react/components";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DestructiveActionDialog,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RowList,
  RowListItem,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";

/*
 * S-E1: the workspace settings section where owners and admins keep values
 * several agents share. Fixtures follow design-env-scope §9.3; no API yet.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type PanelState =
  | "loading"
  | "empty"
  | "error"
  | "ready"
  | "delete"
  | "deleted";

const ACTIONS = ["수정", "허락할 에이전트", "삭제"];

const VARIABLES = [
  {
    name: "API_BASE_URL",
    value: "https://api.example.com/v2",
    grant: "에이전트 2개",
    updated: "2026. 10. 20.",
  },
  {
    name: "LOG_LEVEL",
    value: "info",
    grant: "모든 에이전트",
    updated: "2026. 10. 18.",
  },
  {
    name: "DEPLOY_REGION",
    value: "ap-northeast-1",
    grant: "허락 없음",
    updated: "2026. 10. 2.",
  },
];

type Variable = (typeof VARIABLES)[number];

// Below md the table turns into card rows with one menu button each.
function RowMenu({ name }: { readonly name: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={`${name} 관리`}
        >
          ⋯
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-1">
        {ACTIONS.map((label) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start"
          >
            {label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function VariablesTable({ rows }: { readonly rows: readonly Variable[] }) {
  return (
    <>
      <div className="hidden md:block">
        <TableContainer label="변수 표">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">이름</TableHead>
                <TableHead scope="col">값</TableHead>
                <TableHead scope="col">허락</TableHead>
                <TableHead scope="col">마지막 수정</TableHead>
                <TableHead scope="col" variant="actions">
                  관리
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variable) => (
                <TableRow key={variable.name}>
                  <TableCell>{variable.name}</TableCell>
                  <TableCell>{variable.value}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {variable.grant}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {variable.updated}
                  </TableCell>
                  <TableCell variant="actions">
                    <div className="flex gap-2">
                      {ACTIONS.map((label) => (
                        <Button
                          key={label}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-24"
                          aria-label={`${variable.name} ${label}`}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </div>
      <RowList className="md:hidden" aria-label="변수">
        {rows.map((variable) => (
          <RowListItem key={variable.name}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div>{variable.name}</div>
              <div>{variable.value}</div>
              <div>
                {variable.grant} · {variable.updated}
              </div>
            </div>
            <RowMenu name={variable.name} />
          </RowListItem>
        ))}
      </RowList>
    </>
  );
}

function WorkspaceVariablesScreen({ state }: { readonly state: PanelState }) {
  const listed = state === "ready" || state === "delete" || state === "deleted";
  return (
    <div className="story-stack">
      <div className="story-row">{API_CHANGE}</div>
      {state === "deleted" ? (
        <Alert variant="blue" role="status">
          LOG_LEVEL을 삭제했습니다.
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>변수</CardTitle>
          <CardDescription>
            여러 에이전트가 같이 쓰는 값입니다. 에이전트가 이름을 선언하고,
            여기서 허락한 에이전트만 값을 받습니다.
          </CardDescription>
          {listed ? (
            <CardAction>
              <Button type="button">변수 추가</Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {state === "loading" ? (
            <Skeleton lines={4} label="변수 목록" />
          ) : null}
          {state === "empty" ? (
            <EmptyState
              title="아직 등록한 변수가 없습니다."
              description="변수를 추가하고 받을 에이전트를 허락하세요."
              action={<Button type="button">변수 추가</Button>}
            />
          ) : null}
          {state === "error" ? (
            <ApiErrorState
              title="변수를 불러오지 못했습니다."
              message="request timed out"
              code="REQUEST_TIMEOUT"
              retry={() => {}}
            />
          ) : null}
          {listed ? (
            <VariablesTable
              rows={
                state === "deleted"
                  ? VARIABLES.filter((row) => row.name !== "LOG_LEVEL")
                  : VARIABLES
              }
            />
          ) : null}
          {state === "delete" ? (
            <DestructiveActionDialog
              open={true}
              onOpenChange={() => {}}
              onConfirm={() => {}}
              title="LOG_LEVEL 삭제"
              consequence="이 변수를 선언한 에이전트 2개는 다음 세션부터 시작하지 못합니다: 결제 담당, 릴리스 노트 작성. 이미 시작한 세션은 저장해 둔 값으로 계속 돌고, 세션을 닫아야 그 값이 지워집니다."
              resourceName="LOG_LEVEL"
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

const meta = {
  title: "Screens/Workspace variables (v3)",
  component: WorkspaceVariablesScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "loading" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["loading", "empty", "error", "ready", "delete", "deleted"],
    },
  },
} satisfies Meta<typeof WorkspaceVariablesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceVariables: Story = {
  name: "Ready",
  args: { state: "ready" },
};
export const WorkspaceVariablesLoading: Story = { name: "Loading" };
export const WorkspaceVariablesEmpty: Story = {
  name: "Empty",
  args: { state: "empty" },
};
export const WorkspaceVariablesError: Story = {
  name: "Error",
  args: { state: "error" },
};
export const WorkspaceVariablesDelete: Story = {
  name: "Delete confirm",
  args: { state: "delete" },
};
export const WorkspaceVariablesDeleted: Story = {
  name: "Deleted",
  args: { state: "deleted" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const WorkspaceVariablesMobile: Story = {
  name: "Ready (390px)",
  args: { state: "ready" },
  globals: MOBILE,
};

export const WorkspaceVariablesMobileDark: Story = {
  name: "Ready (390px, dark)",
  args: { state: "ready" },
  globals: { ...MOBILE, theme: "dark" },
};

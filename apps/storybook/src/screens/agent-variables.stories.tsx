import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiErrorState } from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import type { ReactNode } from "react";

/*
 * S-E4: under the credential section of an agent's detail, each declared
 * name with where a session would take its value from, and the agent's own
 * values (the S-E1 table without the grant column).
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type PanelState = "loading" | "error" | "none" | "ready" | "warnings";

interface Row {
  readonly name: string;
  readonly source?: "agent" | "workspace";
  readonly value?: string;
  readonly shadows?: boolean;
  readonly notice?: ReactNode;
}

const READY: readonly Row[] = [
  {
    name: "API_BASE_URL",
    source: "agent",
    value: "https://staging.example.com/v2",
    shadows: true,
  },
  { name: "LOG_LEVEL", source: "workspace" },
];

const WARNINGS: readonly Row[] = [
  { name: "LOG_LEVEL", source: "agent", value: "debug" },
  {
    name: "DEPLOY_REGION",
    notice: (
      <Alert className="basis-full" variant="amber">
        워크스페이스 값이 있지만 이 에이전트에 허락되지 않았습니다. 워크스페이스
        관리자에게 요청하세요.
      </Alert>
    ),
  },
  {
    name: "API_BASE_URL",
    notice: (
      <Alert className="basis-full" variant="amber">
        값이 없습니다. 이대로면 세션이 시작되지 않습니다.
        <AlertActions>
          <Button type="button" variant="outline" size="sm">
            에이전트 값 추가
          </Button>
        </AlertActions>
      </Alert>
    ),
  },
  {
    name: "AP_SESSION_ID",
    notice: (
      <Alert className="basis-full" variant="red" role="alert">
        AP_SESSION_ID은 이제 예약 이름이라 세션이 시작되지 않습니다. 카드에서
        이름을 바꾸세요.
      </Alert>
    ),
  },
];

const AGENT_VALUES = [
  {
    name: "API_BASE_URL",
    value: "https://staging.example.com/v2",
    updated: "2026. 10. 21.",
  },
];

const ACTIONS = ["수정", "삭제"];

// The API returns no total, so the sum and the verdict on it wait for it.
const TOTAL = (
  <div className="story-row items-center">
    합계 용량: <Badge variant="red">API 변경 필요</Badge>
  </div>
);

function VariableRows({ rows }: { readonly rows: readonly Row[] }) {
  return (
    <RowList variant="joined" aria-label="선언한 변수">
      {rows.map((row) => (
        <RowListItem key={row.name}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div>{row.name}</div>
            {row.value ? <div>{row.value}</div> : null}
          </div>
          {row.source === "agent" ? (
            <Badge variant="blue">에이전트 값</Badge>
          ) : null}
          {row.shadows ? <Badge>워크스페이스 값을 가립니다</Badge> : null}
          {row.source === "workspace" ? (
            <>
              <Badge>워크스페이스 값</Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${row.name} 값 보기`}
              >
                값 보기
              </Button>
            </>
          ) : null}
          {row.notice}
        </RowListItem>
      ))}
    </RowList>
  );
}

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

function AgentValuesTable() {
  return (
    <>
      <div className="hidden md:block">
        <TableContainer label="에이전트 값 표">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">이름</TableHead>
                <TableHead scope="col">값</TableHead>
                <TableHead scope="col">마지막 수정</TableHead>
                <TableHead scope="col" variant="actions">
                  관리
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {AGENT_VALUES.map((variable) => (
                <TableRow key={variable.name}>
                  <TableCell>{variable.name}</TableCell>
                  <TableCell>{variable.value}</TableCell>
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
      <RowList className="md:hidden" aria-label="에이전트 값">
        {AGENT_VALUES.map((variable) => (
          <RowListItem key={variable.name}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div>{variable.name}</div>
              <div>{variable.value}</div>
              <div>{variable.updated}</div>
            </div>
            <RowMenu name={variable.name} />
          </RowListItem>
        ))}
      </RowList>
    </>
  );
}

function AgentVariablesScreen({ state }: { readonly state: PanelState }) {
  return (
    <div className="story-stack">
      <div className="story-row">{API_CHANGE}</div>
      <Card>
        <CardHeader>
          <CardTitle>변수</CardTitle>
          <CardDescription>
            이 에이전트가 선언한 이름과 세션이 받을 값의 출처입니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="story-stack">
          {state === "loading" ? (
            <Skeleton lines={3} label="변수 목록" />
          ) : null}
          {state === "error" ? (
            <ApiErrorState
              title="변수를 불러오지 못했습니다."
              message="request timed out"
              code="REQUEST_TIMEOUT"
              retry={() => {}}
            />
          ) : null}
          {state === "none" ? (
            <EmptyState
              title="이 에이전트는 변수를 받지 않습니다."
              description="카드 편집에서 이름을 선언하세요."
              action={<Button type="button">카드 편집</Button>}
            />
          ) : null}
          {state === "ready" ? (
            <>
              <VariableRows rows={READY} />
              {TOTAL}
            </>
          ) : null}
          {state === "warnings" ? (
            <>
              <VariableRows rows={WARNINGS} />
              {TOTAL}
            </>
          ) : null}
        </CardContent>
      </Card>
      {state === "ready" ? (
        <Card>
          <CardHeader>
            <CardTitle>에이전트 값</CardTitle>
          </CardHeader>
          <CardContent>
            <AgentValuesTable />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

const meta = {
  title: "Screens/Agent variables (v3)",
  component: AgentVariablesScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "loading" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["loading", "error", "none", "ready", "warnings"],
    },
  },
} satisfies Meta<typeof AgentVariablesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentVariables: Story = {
  name: "Ready",
  args: { state: "ready" },
};
export const AgentVariablesLoading: Story = { name: "Loading" };
export const AgentVariablesError: Story = {
  name: "Error",
  args: { state: "error" },
};
export const AgentVariablesEmpty: Story = {
  name: "No declarations",
  args: { state: "none" },
};
export const AgentVariablesWarnings: Story = {
  name: "Warnings",
  args: { state: "warnings" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const AgentVariablesMobile: Story = {
  name: "Ready (390px)",
  args: { state: "ready" },
  globals: MOBILE,
};

export const AgentVariablesWarningsMobile: Story = {
  name: "Warnings (390px)",
  args: { state: "warnings" },
  globals: MOBILE,
};

export const AgentVariablesWarningsMobileDark: Story = {
  name: "Warnings (390px, dark)",
  args: { state: "warnings" },
  globals: { ...MOBILE, theme: "dark" },
};

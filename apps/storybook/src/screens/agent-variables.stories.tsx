import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiErrorState } from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RowLines,
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

type Tone = "info" | "warning" | "danger";
const TONE = {
  info: { variant: "blue", label: "안내" },
  warning: { variant: "amber", label: "주의" },
  danger: { variant: "red", label: "오류" },
} as const;

// Stands in for the Alert part ui-kit accepted and packages/ui lacks yet.
function AlertStandIn({
  tone,
  children,
  action,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <Card className="basis-full" data-tone={tone}>
      <CardHeader>
        <CardDescription className="flex items-start gap-2">
          <Badge variant={TONE[tone].variant}>{TONE[tone].label}</Badge>
          <span>{children}</span>
        </CardDescription>
        <CardAction>
          <Badge variant="amber" data-part-request="Alert">
            부품 요청 중: Alert
          </Badge>
        </CardAction>
      </CardHeader>
      {action ? <CardContent>{action}</CardContent> : null}
    </Card>
  );
}

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
      <AlertStandIn tone="warning">
        워크스페이스 값이 있지만 이 에이전트에 허락되지 않았습니다. 워크스페이스
        관리자에게 요청하세요.
      </AlertStandIn>
    ),
  },
  {
    name: "API_BASE_URL",
    notice: (
      <AlertStandIn
        tone="warning"
        action={
          <Button type="button" variant="outline" size="sm">
            에이전트 값 추가
          </Button>
        }
      >
        값이 없습니다. 이대로면 세션이 시작되지 않습니다.
      </AlertStandIn>
    ),
  },
  {
    name: "AP_SESSION_ID",
    notice: (
      <AlertStandIn tone="danger">
        AP_SESSION_ID은 이제 예약 이름이라 세션이 시작되지 않습니다. 카드에서
        이름을 바꾸세요.
      </AlertStandIn>
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

function VariableRows({ rows }: { readonly rows: readonly Row[] }) {
  return (
    <RowList variant="joined" aria-label="선언한 변수">
      {rows.map((row) => (
        <RowListItem key={row.name}>
          <RowLines>
            <code>{row.name}</code>
            {row.value ? (
              <code className="text-muted-foreground text-caption">
                {row.value}
              </code>
            ) : null}
            {row.shadows ? (
              <span className="text-muted-foreground text-caption">
                워크스페이스 값을 가립니다
              </span>
            ) : null}
          </RowLines>
          {row.source === "agent" ? (
            <Badge variant="blue">에이전트 값</Badge>
          ) : null}
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
          <span aria-hidden="true">⋯</span>
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
                  <TableCell>
                    <code>{variable.name}</code>
                  </TableCell>
                  <TableCell>
                    <code>{variable.value}</code>
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
      <RowList className="md:hidden" aria-label="에이전트 값">
        {AGENT_VALUES.map((variable) => (
          <RowListItem key={variable.name}>
            <RowLines>
              <code>{variable.name}</code>
              <code className="text-muted-foreground text-caption">
                {variable.value}
              </code>
              <span className="text-muted-foreground text-caption">
                {variable.updated}
              </span>
            </RowLines>
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
      {API_CHANGE}
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
              <p className="text-muted-foreground text-caption">
                지금 값으로 시작하면 합계 3 KB
              </p>
              <h3 className="font-semibold text-body">에이전트 값</h3>
              <AgentValuesTable />
            </>
          ) : null}
          {state === "warnings" ? (
            <>
              <VariableRows rows={WARNINGS} />
              <p className="text-muted-foreground text-caption">
                지금 값으로 시작하면 합계 131 KB
              </p>
              <AlertStandIn tone="warning">
                합계가 128 KB를 넘어 세션이 시작되지 않습니다.
              </AlertStandIn>
            </>
          ) : null}
        </CardContent>
      </Card>
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

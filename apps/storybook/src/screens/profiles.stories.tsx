import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  KeyValueList,
  NativeSelect,
  NativeSelectOption,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  RadioGroup,
  RadioGroupItem,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Textarea,
} from "@werft-ai/ui";
import { useId, useState } from "react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * Run profiles as apps/web draws them (routes/profiles.tsx, profile-detail.tsx,
 * profile-new.tsx, profile-ceiling-form.tsx): installation ceilings and
 * workspace profiles in one list, a ceiling's detail with its record, and the
 * dedicated creation page. Every value is a field of GET /v1/profiles or
 * GET /v1/installation-profiles/options.
 */

type View = "list" | "detail" | "newCeiling" | "newWorkspace" | "refused";
type Role = "owner" | "admin";

type Row = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly kind: "설치 상한" | "워크스페이스 프로필";
  readonly base: string;
  readonly model: string;
  readonly mode: string;
  readonly state: readonly [string, "green" | "red" | "gray"];
};

const ROWS: readonly Row[] = [
  {
    id: "claude-coding",
    name: "claude-coding",
    version: 1,
    kind: "설치 상한",
    base: "—",
    model: "claude-sonnet-5",
    mode: "acceptEdits",
    state: ["사용 가능", "green"],
  },
  {
    id: "op_wide_v2",
    name: "wide",
    version: 2,
    kind: "설치 상한",
    base: "—",
    model: "claude-sonnet-5",
    mode: "auto",
    state: ["사용 가능", "green"],
  },
  {
    id: "op_free_v1",
    name: "free",
    version: 1,
    kind: "설치 상한",
    base: "—",
    model: "claude-sonnet-5",
    mode: "bypassPermissions",
    state: ["이 설치에서 꺼짐", "red"],
  },
  {
    id: "ws_acme_strict_v3",
    name: "strict",
    version: 3,
    kind: "워크스페이스 프로필",
    base: "op_wide_v2",
    model: "claude-sonnet-5",
    mode: "default",
    state: ["사용 가능", "green"],
  },
];

const COLUMNS = [
  "minmax(0,1.6fr) 64px 112px minmax(0,1fr) minmax(0,1fr) 128px 152px",
  "minmax(0,1fr) 128px",
] as const;

function Crumbs({ current }: { readonly current: string }) {
  return (
    <PageBreadcrumb label="위치">
      <PageBreadcrumbLink href="#profiles">실행 프로필</PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{current}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );
}

function List({ role }: { readonly role: Role }) {
  const [filter, setFilter] = useState("all");
  const rows = ROWS.filter(
    (row) =>
      filter === "all" ||
      (filter === "installation") === (row.kind === "설치 상한"),
  );
  return (
    <Page
      headClassName="max-md:flex-col max-md:items-stretch"
      title="실행 프로필"
      description="에이전트가 쓸 모델과 도구를 정합니다. 설치 상한은 이 설치에서 쓸 수 있는 가장 넓은 값이고, 워크스페이스 프로필은 상한 하나를 줄여 만듭니다."
      actions={
        <div className="flex flex-wrap gap-2">
          {role === "owner" ? (
            <Button variant="outline">설치 상한 만들기</Button>
          ) : null}
          <Button>프로필 만들기</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <SegmentedControl
          aria-label="프로필 종류"
          size="toolbar"
          value={filter}
          onValueChange={setFilter}
        >
          <SegmentedControlItem value="all" count={4}>
            전체
          </SegmentedControlItem>
          <SegmentedControlItem value="installation" count={3}>
            설치 상한
          </SegmentedControlItem>
          <SegmentedControlItem value="workspace" count={1}>
            워크스페이스 프로필
          </SegmentedControlItem>
        </SegmentedControl>
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label="실행 프로필"
            columns={COLUMNS[0]}
            narrowAt={860}
            narrowColumns={COLUMNS[1]}
          >
            <GridTableHeader>
              <GridTableColumnHeader>이름</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>버전</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>종류</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                바탕 프로필
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                기본 모델
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                권한 모드
              </GridTableColumnHeader>
              <GridTableColumnHeader>상태</GridTableColumnHeader>
            </GridTableHeader>
            {rows.map((row) => (
              <GridTableRow key={row.id}>
                <GridTableCell>
                  <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
                    <div className="wrap-anywhere font-medium leading-5">
                      {row.name}
                    </div>
                    <div className="wrap-anywhere font-mono text-caption text-muted-foreground leading-4">
                      {row.id}
                    </div>
                    <div className="hidden wrap-anywhere text-caption text-muted-foreground leading-4 [@container(max-width:860px)]:block">
                      {row.kind} · v{row.version}
                    </div>
                  </div>
                </GridTableCell>
                <GridTableCell hideNarrow>v{row.version}</GridTableCell>
                <GridTableCell hideNarrow>{row.kind}</GridTableCell>
                <GridTableCell hideNarrow>{row.base}</GridTableCell>
                <GridTableCell hideNarrow>{row.model}</GridTableCell>
                <GridTableCell hideNarrow>{row.mode}</GridTableCell>
                <GridTableCell>
                  <Badge variant={row.state[1]}>{row.state[0]}</Badge>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </div>
      </div>
    </Page>
  );
}

function Detail({ role }: { readonly role: Role }) {
  return (
    <Page
      headClassName="max-md:flex-col max-md:items-stretch"
      breadcrumb={<Crumbs current="op_wide_v2" />}
      title="wide"
      titleAside={<Badge variant="green">사용 가능</Badge>}
      description="이 설치에서 쓸 수 있는 가장 넓은 값입니다. 저장한 버전은 바뀌지 않고, 고치면 새 버전이 됩니다."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline">이 상한으로 프로필 만들기</Button>
          {role === "owner" ? (
            <>
              <Button>새 버전</Button>
              <Button variant="outline">사용 중지</Button>
            </>
          ) : null}
        </div>
      }
    >
      <Section title="설정">
        <div className="rounded-card border bg-card p-4">
          <KeyValueList
            items={[
              { id: "id", label: "id", value: "op_wide_v2" },
              { id: "kind", label: "종류", value: "설치 상한" },
              { id: "connection", label: "연결", value: "anthropic" },
              {
                id: "runtime",
                label: "런타임",
                value: "claude_agent_sdk 0.3.270",
              },
              { id: "model", label: "기본 모델", value: "claude-sonnet-5" },
              {
                id: "models",
                label: "고를 수 있는 모델",
                value: (
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="mono">claude-sonnet-5</Badge>
                    <Badge variant="mono">claude-haiku-5</Badge>
                  </div>
                ),
              },
              { id: "title", label: "제목 모델", value: "claude-haiku-5" },
              {
                id: "tools",
                label: "도구",
                value: (
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="mono">Read</Badge>
                    <Badge variant="mono">Edit</Badge>
                    <Badge variant="mono">Bash</Badge>
                  </div>
                ),
              },
              { id: "mode", label: "권한 모드", value: "auto" },
              { id: "repository", label: "저장소", value: "저장소 필요" },
              { id: "repositories", label: "허용할 저장소", value: "platform" },
              { id: "billing", label: "비용", value: "비용 집계" },
              {
                id: "claude-md",
                label: "저장소의 CLAUDE.md 읽기",
                value: "켬",
              },
            ]}
          />
        </div>
      </Section>
      <Section title="기록">
        <div className="rounded-card border bg-card p-4">
          <KeyValueList
            items={[
              { id: "origin", label: "출처", value: "콘솔에서 만듦" },
              {
                id: "by",
                label: "만든 사람",
                value: "0b1d0c7e-1f27-4a3e-8a8e-9c1b2d3e4f50 (나)",
              },
              { id: "at", label: "만든 때", value: "2026. 10. 28. 오후 8:15" },
              { id: "previous", label: "앞 버전", value: "op_wide_v1" },
            ]}
          />
        </div>
      </Section>
    </Page>
  );
}

function KindPicker({ kind }: { readonly kind: "workspace" | "installation" }) {
  const legend = useId();
  return (
    <FieldSet className="gap-3">
      <FieldLegend id={legend} variant="label" className="mb-0">
        종류
      </FieldLegend>
      <RadioGroup value={kind} aria-labelledby={legend}>
        <Field orientation="horizontal">
          <RadioGroupItem value="workspace" />
          <FieldContent>
            <FieldLabel>워크스페이스 프로필</FieldLabel>
            <FieldDescription>
              설치 상한 하나를 바탕으로 모델·도구·권한 모드를 줄입니다.
            </FieldDescription>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="installation" />
          <FieldContent>
            <FieldLabel>설치 상한</FieldLabel>
            <FieldDescription>
              연결 하나 위에서 런타임·모델·도구·권한 모드·저장소를 정합니다.
              owner만 만듭니다.
            </FieldDescription>
          </FieldContent>
        </Field>
      </RadioGroup>
    </FieldSet>
  );
}

function NewCeiling({ refused }: { readonly refused: boolean }) {
  return (
    <Page
      breadcrumb={<Crumbs current="설치 상한 만들기" />}
      title="설치 상한 만들기"
      description="이 설치에서 쓸 수 있는 가장 넓은 값입니다. 워크스페이스 프로필은 이 값을 줄이기만 합니다. 연결·자격 증명·비용 한도는 설치 설정에서 정합니다."
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <KindPicker kind="installation" />
        <form className="flex flex-col gap-[var(--ap-space-block)] rounded-card border bg-card p-4">
          <Field>
            <FieldLabel>이름</FieldLabel>
            <Input defaultValue="wide" aria-invalid={refused || undefined} />
            <FieldDescription>wide v1으로 저장합니다.</FieldDescription>
            <FieldError>
              {refused
                ? "이 이름으로 만들 id가 이미 있습니다. 다른 이름을 고르세요."
                : undefined}
            </FieldError>
          </Field>
          <Field className="w-auto max-w-full">
            <FieldLabel>연결</FieldLabel>
            <NativeSelect defaultValue="anthropic">
              <NativeSelectOption value="anthropic">
                anthropic (anthropic · 비용 집계)
              </NativeSelectOption>
              <NativeSelectOption value="local">
                local (litellm · 비용 집계 안 함)
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              모델 공급자와 자격 증명은 연결이 정합니다. 연결은 설치 설정에서
              바꿉니다.
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-4">
            <Field className="w-auto max-w-full">
              <FieldLabel>런타임</FieldLabel>
              <NativeSelect defaultValue="claude_agent_sdk">
                <NativeSelectOption value="claude_agent_sdk">
                  claude_agent_sdk
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="w-auto max-w-full">
              <FieldLabel>런타임 버전</FieldLabel>
              <Input className="font-mono" defaultValue="0.3.270" />
            </Field>
          </div>
          <Field>
            <FieldLabel>모델</FieldLabel>
            <Textarea
              className="font-mono"
              rows={3}
              defaultValue={"claude-sonnet-5\nclaude-haiku-5"}
            />
            <FieldDescription>
              한 줄에 모델 하나씩 적습니다. 세션은 이 가운데에서 모델을
              고릅니다.
            </FieldDescription>
          </Field>
          <Field className="w-auto max-w-full">
            <FieldLabel>권한 모드</FieldLabel>
            <NativeSelect defaultValue="auto">
              <NativeSelectOption value="default">default</NativeSelectOption>
              <NativeSelectOption value="acceptEdits">
                acceptEdits
              </NativeSelectOption>
              <NativeSelectOption value="plan">plan</NativeSelectOption>
              <NativeSelectOption value="auto">auto</NativeSelectOption>
              <NativeSelectOption value="bypassPermissions" disabled>
                bypassPermissions
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              이 설치는 PLATFORM_ALLOW_UNATTENDED_PERMISSIONS가 꺼져 있어
              bypassPermissions를 고를 수 없습니다.
            </FieldDescription>
          </Field>
          <FieldSet className="gap-3">
            <FieldLegend variant="label" className="mb-0">
              허용할 저장소
            </FieldLegend>
            <FieldDescription>
              이 상한의 세션과 릴리스가 쓸 수 있는 저장소입니다.
            </FieldDescription>
            <Field orientation="horizontal">
              <Checkbox />
              <FieldContent>
                <FieldLabel className="font-mono">docs</FieldLabel>
              </FieldContent>
            </Field>
            <Field orientation="horizontal">
              <Checkbox defaultChecked />
              <FieldContent>
                <FieldLabel className="font-mono">platform</FieldLabel>
              </FieldContent>
            </Field>
          </FieldSet>
          {refused ? (
            <Alert variant="red" role="alert">
              <AlertDescription>
                이 이름의 최신 버전은 op_wide_v2입니다. 새 버전은 최신 버전에서
                만듭니다.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <FieldDescription>
              저장한 버전은 바뀌지 않습니다. 고치려면 새 버전을 만듭니다.
            </FieldDescription>
            <div className="flex gap-2">
              <Button variant="outline">취소</Button>
              <Button>저장</Button>
            </div>
          </div>
        </form>
      </div>
    </Page>
  );
}

function NewWorkspace({ role }: { readonly role: Role }) {
  return (
    <Page
      breadcrumb={<Crumbs current="프로필 만들기" />}
      title="프로필 만들기"
      description="바탕이 되는 설치 상한에서 모델·도구를 줄이거나 권한 모드를 더 엄격하게만 바꿀 수 있습니다."
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        {role === "owner" ? <KindPicker kind="workspace" /> : null}
        <form className="flex flex-col gap-[var(--ap-space-block)] rounded-card border bg-card p-4">
          <Field className="w-auto max-w-full">
            <FieldLabel>바탕 프로필</FieldLabel>
            <NativeSelect defaultValue="op_wide_v2">
              <NativeSelectOption value="claude-coding">
                claude-coding
              </NativeSelectOption>
              <NativeSelectOption value="op_wide_v2">
                op_wide_v2
              </NativeSelectOption>
              <NativeSelectOption value="op_free_v1" disabled>
                op_free_v1 · 이 설치에서 꺼짐
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel>이름</FieldLabel>
            <Input defaultValue="strict" />
            <FieldDescription>
              저장할 버전의 id: ws_acme_strict_v4
            </FieldDescription>
          </Field>
          <FieldSet className="gap-2 rounded-card border bg-muted/40 p-3">
            <FieldLegend variant="label" className="mb-0">
              검토
            </FieldLegend>
            <FieldDescription>op_wide_v2와 달라진 칸입니다.</FieldDescription>
            <KeyValueList
              items={[
                {
                  id: "models",
                  label: "모델",
                  value: "claude-sonnet-5, claude-haiku-5 → claude-sonnet-5",
                },
                { id: "mode", label: "권한 모드", value: "auto → default" },
              ]}
            />
          </FieldSet>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button variant="outline">취소</Button>
            <Button>저장</Button>
          </div>
        </form>
      </div>
    </Page>
  );
}

function ProfilesScreen({
  view,
  role,
}: {
  readonly view: View;
  readonly role: Role;
}) {
  return (
    <ScreenShell current="profiles" crumb={["실행 프로필"]} role={role}>
      {view === "list" ? (
        <List role={role} />
      ) : view === "detail" ? (
        <Detail role={role} />
      ) : view === "newWorkspace" ? (
        <NewWorkspace role={role} />
      ) : (
        <NewCeiling refused={view === "refused"} />
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Run profiles",
  component: ProfilesScreen,
  parameters: { layout: "fullscreen" },
  args: { view: "list", role: "owner" },
  argTypes: {
    view: {
      control: "inline-radio",
      options: ["list", "detail", "newCeiling", "newWorkspace", "refused"],
    },
    role: { control: "inline-radio", options: ["owner", "admin"] },
  },
} satisfies Meta<typeof ProfilesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProfilesList: Story = { name: "Owner · list" };
export const ProfilesListAdmin: Story = {
  name: "Admin · list (no ceiling button)",
  args: { role: "admin" },
};
export const ProfilesListMobile: Story = {
  name: "Owner · list (390px)",
  globals: MOBILE,
};
export const ProfileCeilingDetail: Story = {
  name: "Owner · ceiling detail",
  args: { view: "detail" },
};
export const ProfileCeilingDetailAdmin: Story = {
  name: "Admin · ceiling detail (narrow only)",
  args: { view: "detail", role: "admin" },
};
export const ProfileNewCeiling: Story = {
  name: "Owner · new ceiling",
  args: { view: "newCeiling" },
};
export const ProfileNewCeilingRefused: Story = {
  name: "Owner · new ceiling refused",
  args: { view: "refused" },
};
export const ProfileNewCeilingDark: Story = {
  name: "Owner · new ceiling (dark)",
  args: { view: "newCeiling" },
  globals: { theme: "dark" },
};
export const ProfileNewWorkspaceAdmin: Story = {
  name: "Admin · new workspace profile (no kind)",
  args: { view: "newWorkspace", role: "admin" },
};
export const ProfileNewWorkspaceMobile: Story = {
  name: "Owner · new workspace profile (390px)",
  args: { view: "newWorkspace" },
  globals: MOBILE,
};

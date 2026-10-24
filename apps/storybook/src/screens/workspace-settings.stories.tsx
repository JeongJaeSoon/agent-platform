import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardTitle,
  ConfirmDialog,
  ErrorState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  LinkTab,
  LinkTabs,
  PageHeader,
  RowList,
  RowListItem,
  SecretField,
  SettingRow,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { MOBILE, PartRequest, ScreenShell } from "./screen-kit.tsx";
import {
  Heading,
  MUTED_TEXT,
  OutcomeStandIn,
  storyHref,
} from "./slack-kit.tsx";

/*
 * v4 workspace settings (Console.dc.html L853-867), as apps/web draws it:
 * `card flush` cards 16px apart, a 16px body with 12px gaps, and a
 * `form-foot` strip. The name and model cards only read (no API changes
 * them); the retention card is the audit retention the API has, not the
 * mockup's output retention, which has no API. Both gaps are 94S-817.
 */

type Viewer = "owner" | "admin" | "member";
type Models = "ready" | "loading" | "empty" | "error";

// Values GET /v1/auth/me and GET /v1/profiles return.
const WORKSPACE = {
  id: "6d4c1f5e-4c39-4d7a-9a51-0f4f3c7a2b10",
  name: "Acme",
  audit_retention_days: 90,
  slack_guest_enabled: false,
};
const MODELS = ["claude-haiku-5", "claude-sonnet-5"];

const CARD_BODY = "flex flex-col gap-3 p-4";
const META = "text-caption text-subtle-foreground";
const ICON = "size-3.5 shrink-0";

function SettingsCard({
  title,
  description,
  foot,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly foot?: ReactNode;
  readonly children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <Card flush role="region" aria-labelledby={titleId}>
      <div className={CARD_BODY}>
        <CardTitle id={titleId} role="heading" aria-level={2}>
          {title}
        </CardTitle>
        <CardDescription className="text-description">
          {description}
        </CardDescription>
        {children}
      </div>
      {foot ? <CardFooter variant="form">{foot}</CardFooter> : null}
    </Card>
  );
}

function ReadOnlyMark() {
  return (
    <div className="inline-flex shrink-0 items-center gap-1 text-caption text-subtle-foreground">
      <Lock aria-hidden="true" className={ICON} strokeWidth={1.5} />
      읽기 전용
    </div>
  );
}

function SaveButton({ reason }: { readonly reason?: string | undefined }) {
  const reasonId = useId();
  return (
    <div className="inline-flex flex-col gap-1">
      <Button
        type="submit"
        size="sm"
        disabled={reason !== undefined}
        aria-describedby={reason === undefined ? undefined : reasonId}
      >
        저장
      </Button>
      {reason === undefined ? null : (
        <div id={reasonId} className="text-caption text-muted-foreground">
          {reason}
        </div>
      )}
    </div>
  );
}

function ModelList({ models }: { readonly models: Models }) {
  if (models === "loading") return <Skeleton width="50%" />;
  if (models === "error") {
    return (
      <ErrorState
        title="불러오지 못했습니다"
        message="처리하지 못했습니다 — 잠시 뒤 다시 시도하세요."
        retry={() => {}}
        retryLabel="다시 시도"
      />
    );
  }
  if (models === "empty") {
    return <div className={META}>이 설치에 등록된 모델이 없습니다.</div>;
  }
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {MODELS.map((model) => (
        <li key={model}>
          <Badge variant="mono">{model}</Badge>
        </li>
      ))}
    </ul>
  );
}

/*
 * Slack console v3 (mockups/v3-ia.md §3.1): a sub-nav of 일반 / Slack 연결
 * 설정 / 자동으로 만든 앱; Slack 게스트 moves from 일반 to a Switch row
 * beside the App Configuration Token row. The token row shows only what
 * GET .../slack/config-token returns (state, updated_at, updated_by), never
 * a value.
 */

type SlackPage = "general" | "slack" | "apps";
type ConfigToken = "active" | "unset" | "needs_reentry";

const SLACK_PAGES: readonly (readonly [SlackPage, string])[] = [
  ["general", "일반"],
  ["slack", "Slack 연결 설정"],
  ["apps", "자동으로 만든 앱"],
];
const SLACK_STORY = "screens-workspace-settings-v4--workspace-settings-slack";
const TOKEN = {
  saved_at: "2026. 10. 23. 13:58",
  saved_by: "Verify Owner",
};
// Demo rows: there is no workspace-wide Slack app list API yet, only
// GET /v1/agents/{id}/slack/app per agent.
const SLACK_APPS = [
  {
    name: "계정 연결 앱",
    app_id: "A07LINK000",
    agent: null,
    note: "Sign in with Slack",
    updated_at: "2026. 10. 01. 09:20",
  },
  {
    name: "Release Notes 앱",
    app_id: "A07PLACEHLD",
    agent: "Release Notes",
    note: "@release-notes",
    updated_at: "2026. 10. 23. 21:48",
  },
];
const FIT = "w-px whitespace-nowrap";
const WIDE = "hidden @[480px]:table-cell";

function SlackSection({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-[var(--ap-space-block)]"
    >
      <Heading id={titleId}>{title}</Heading>
      <div className={MUTED_TEXT}>{hint}</div>
      {children}
    </section>
  );
}

function SlackConnectionPage({
  viewer,
  token: initialToken,
  editing: initialEditing,
}: {
  readonly viewer: Viewer;
  readonly token: ConfigToken;
  readonly editing: boolean;
}) {
  const readOnly = viewer === "member";
  const [guest, setGuest] = useState(WORKSPACE.slack_guest_enabled);
  const [token, setToken] = useState(initialToken);
  const [editing, setEditing] = useState(initialEditing && !readOnly);
  const [deleting, setDeleting] = useState(false);
  const [missing, setMissing] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const status = {
    unset: [
      <Badge key="b">설정 안 됨</Badge>,
      "에이전트마다 Slack 앱을 이 콘솔이 만들 때 씁니다. api.slack.com/apps의 Your App Configuration Tokens에서 만든 Refresh Token을 넣습니다.",
    ],
    active: [
      <Badge key="b" variant="green">
        설정됨
      </Badge>,
      readOnly
        ? `${TOKEN.saved_at} 저장`
        : `${TOKEN.saved_at} 저장 · 저장한 사람 ${TOKEN.saved_by}`,
    ],
    needs_reentry: [
      <Badge key="b" variant="red">
        오류
      </Badge>,
      "Slack이 저장된 token을 더 받지 않습니다. 새 token을 저장할 때까지 새 Slack 앱을 만들 수 없습니다. 이미 연결된 에이전트는 그대로 동작합니다.",
    ],
  }[token];
  return (
    <>
      {outcome ? (
        <OutcomeStandIn key={outcome}>{outcome}</OutcomeStandIn>
      ) : null}
      <SlackSection
        title="Slack 연결 설정"
        hint={
          readOnly
            ? "지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요."
            : "소유자와 관리자만 바꿀 수 있습니다."
        }
      >
        <RowList variant="joined">
          <SettingRow
            title="Slack 게스트도 에이전트를 쓸 수 있게 하기"
            description="켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수 없습니다."
            control={
              <Switch
                checked={guest}
                disabled={readOnly}
                onCheckedChange={(next) => {
                  setGuest(next);
                  setOutcome(
                    next
                      ? "Slack 게스트도 에이전트를 쓸 수 있게 했습니다."
                      : "Slack 게스트는 이제 에이전트를 쓸 수 없습니다.",
                  );
                }}
              />
            }
          />
          <SettingRow
            title="App Configuration Token"
            badge={status[0]}
            description={status[1]}
            actions={
              readOnly || editing ? undefined : token === "unset" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  token 넣기
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant={token === "needs_reentry" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    교체
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleting(true)}
                  >
                    삭제
                  </Button>
                </>
              )
            }
          />
          {editing ? (
            <RowListItem>
              <form
                className="flex w-full flex-col gap-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem("token");
                  if (
                    input instanceof HTMLInputElement &&
                    !input.value.trim()
                  ) {
                    setMissing(true);
                    input.focus();
                    return;
                  }
                  setMissing(false);
                  setEditing(false);
                  setToken("active");
                  setOutcome("App Configuration Token을 저장했습니다.");
                }}
              >
                <Field>
                  <FieldLabel>새 App Configuration Token</FieldLabel>
                  <Input
                    name="token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    onChange={(event) => {
                      if (event.target.value.trim()) setMissing(false);
                    }}
                  />
                  <FieldDescription>
                    값은 암호화해 저장하고, 저장한 뒤에는 다시 보여 주지
                    않습니다. 이 token을 만든 사람이 자동으로 만드는 앱의
                    협업자가 됩니다. 12시간마다 자동으로 갱신합니다.
                  </FieldDescription>
                  {missing ? (
                    <FieldError>저장하려면 새 token을 넣어 주세요.</FieldError>
                  ) : null}
                </Field>
                <div className="flex flex-wrap items-start justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                  >
                    취소
                  </Button>
                  <Button type="submit">저장</Button>
                </div>
              </form>
            </RowListItem>
          ) : null}
        </RowList>
      </SlackSection>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="App Configuration Token을 삭제할까요?"
        consequence="저장된 값을 지웁니다. 새 token을 저장할 때까지 새 Slack 앱을 만들 수 없습니다. 이미 연결된 에이전트는 그대로 동작합니다."
        confirmLabel="삭제"
        tone="danger"
        onConfirm={() => {
          setDeleting(false);
          setToken("unset");
          setOutcome("App Configuration Token을 삭제했습니다.");
        }}
      />
    </>
  );
}

function SlackAppsPage() {
  return (
    <SlackSection
      title="자동으로 만든 앱"
      hint="앱의 비밀값은 Slack이 앱을 만들 때 서버가 바로 저장합니다. 여기서는 상태만 보고, 켜고 끄기는 에이전트의 Slack 탭에서 합니다."
    >
      <div className="@container overflow-hidden rounded-card border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">앱</TableHead>
              <TableHead scope="col" className={WIDE}>
                에이전트
              </TableHead>
              <TableHead scope="col" className={FIT}>
                상태
              </TableHead>
              <TableHead scope="col" className={`${FIT} ${WIDE} text-right`}>
                갱신
              </TableHead>
              <TableHead scope="col" className={FIT}>
                <div className="sr-only">자세히</div>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SLACK_APPS.map((app) => (
              <TableRow key={app.app_id}>
                <TableCell>
                  <div className="flex flex-col gap-[var(--ap-row-line-gap)]">
                    <div className="font-semibold leading-5">{app.name}</div>
                    <div className="font-mono text-caption text-muted-foreground">
                      {app.app_id}
                    </div>
                    <div className="text-caption text-muted-foreground @[480px]:hidden">
                      {app.agent ? `${app.agent} · ` : ""}
                      {app.updated_at} 갱신
                    </div>
                  </div>
                </TableCell>
                <TableCell className={WIDE}>
                  {app.agent ?? (
                    <div className="text-muted-foreground">없음</div>
                  )}
                </TableCell>
                <TableCell className={FIT}>
                  <div className="flex flex-col gap-[var(--ap-row-line-gap)]">
                    <Badge variant="green">연결됨</Badge>
                    <div className="text-caption text-muted-foreground">
                      {app.note}
                    </div>
                  </div>
                </TableCell>
                <TableCell
                  className={`${FIT} ${WIDE} text-right text-caption text-muted-foreground`}
                >
                  <time>{app.updated_at}</time>
                </TableCell>
                <TableCell className={`${FIT} text-right`}>
                  {app.agent ? (
                    <Button asChild variant="link" size="sm">
                      <a
                        href={storyHref(
                          "screens-agent-detail-v3--agent-detail-slack-settings",
                        )}
                        aria-label={`${app.name} 자세히`}
                      >
                        자세히
                      </a>
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SlackSection>
  );
}

function WorkspaceSettingsScreen({
  viewer,
  models,
  slack: initialPage,
  token = "active",
  editing = false,
}: {
  readonly viewer: Viewer;
  readonly models: Models;
  /** Set for the v3 Slack pages; unset draws main's single page. */
  readonly slack?: SlackPage | undefined;
  readonly token?: ConfigToken | undefined;
  readonly editing?: boolean | undefined;
}) {
  const nameId = useId();
  const daysId = useId();
  const guestId = useId();
  const [page, setPage] = useState(initialPage);
  const editable = viewer !== "member";
  const retentionReason =
    viewer === "admin"
      ? "감사 기록 보존 기간 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자."
      : undefined;
  return (
    <ScreenShell
      current="settings"
      crumb={["워크스페이스", "워크스페이스 설정"]}
      role={viewer}
      width="narrow"
    >
      <PageHeader
        title="워크스페이스 설정"
        description={
          editable
            ? "워크스페이스 전체에 적용되는 설정입니다."
            : "지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요."
        }
      />
      {page ? (
        <div className="mb-4 flex flex-wrap gap-1">
          <PartRequest name="Settings sub-nav" />
        </div>
      ) : null}
      {page ? (
        <LinkTabs aria-label="워크스페이스 설정 메뉴" className="mb-6">
          {SLACK_PAGES.map(([key, label]) => (
            <LinkTab
              key={key}
              current={key === page}
              href={storyHref(`${SLACK_STORY}-${key}`)}
              onClick={(event) => {
                event.preventDefault();
                setPage(key);
              }}
            >
              {label}
            </LinkTab>
          ))}
        </LinkTabs>
      ) : null}
      {/* Stays mounted while hidden so its saved state survives sub-nav moves. */}
      {page ? (
        <div hidden={page !== "slack"} className="flex flex-col gap-4">
          <SlackConnectionPage
            viewer={viewer}
            token={token}
            editing={editing}
          />
        </div>
      ) : null}
      {page === "apps" ? <SlackAppsPage /> : null}
      {page && page !== "general" ? null : (
        <div className="flex flex-col gap-4">
          <SettingsCard
            title="워크스페이스 이름"
            description="콘솔과 알림에 보이는 이름입니다."
            foot={
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className={META}>콘솔에서는 아직 바꿀 수 없습니다.</div>
                  <Badge variant="red">API 변경 필요: 94S-817</Badge>
                </div>
                <ReadOnlyMark />
              </>
            }
          >
            <label className="sr-only" htmlFor={nameId}>
              워크스페이스 이름
            </label>
            <Input
              id={nameId}
              className="max-w-80"
              value={WORKSPACE.name}
              readOnly
            />
          </SettingsCard>
          <SettingsCard
            title="워크스페이스 ID"
            description="API와 CLI에서 이 워크스페이스를 가리킬 때 씁니다."
          >
            <SecretField
              className="max-w-105"
              value={WORKSPACE.id}
              copyLabel="복사"
              copiedMessage="워크스페이스 ID를 복사했습니다."
              copyFailedMessage="복사하지 못했습니다. ID를 직접 선택해 복사하세요."
            />
          </SettingsCard>
          <SettingsCard
            title="모델 허용 목록"
            description="세션에서 고를 수 있는 모델의 상한입니다. 에이전트 제한과 프로필이 여기서 더 좁힙니다."
            foot={
              <>
                <div className={META}>
                  설치 설정에서 관리합니다 · 콘솔에서는 읽기 전용
                </div>
                <ReadOnlyMark />
              </>
            }
          >
            <ModelList models={models} />
          </SettingsCard>
          <SettingsCard
            title="감사 기록 보존 기간"
            description="허용·거절한 요청 기록을 이 기간 동안 보관합니다."
            foot={
              editable ? (
                <>
                  <div className={META}>
                    30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.
                  </div>
                  <SaveButton reason={retentionReason} />
                </>
              ) : undefined
            }
          >
            {editable ? (
              <>
                <label className="sr-only" htmlFor={daysId}>
                  보존 기간(일)
                </label>
                <Input
                  id={daysId}
                  className="max-w-50"
                  type="number"
                  defaultValue={WORKSPACE.audit_retention_days}
                  disabled={retentionReason !== undefined}
                />
              </>
            ) : (
              <div>
                감사 기록을 {WORKSPACE.audit_retention_days}일 보존합니다.
              </div>
            )}
          </SettingsCard>
          {page ? null : (
            <SettingsCard
              title="Slack 게스트"
              description="켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수 없습니다. 소유자나 관리자가 바꿀 수 있습니다."
            >
              {editable ? (
                <div className="flex flex-wrap items-baseline gap-2">
                  <div id={guestId}>
                    Slack 게스트도 에이전트를 쓸 수 있게 하기
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    role="switch"
                    aria-checked={WORKSPACE.slack_guest_enabled}
                    aria-labelledby={guestId}
                  >
                    꺼짐
                  </Button>
                </div>
              ) : (
                <div>Slack 게스트는 에이전트를 쓸 수 없습니다.</div>
              )}
            </SettingsCard>
          )}
        </div>
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Workspace settings (v4)",
  component: WorkspaceSettingsScreen,
  parameters: { layout: "fullscreen" },
  args: { viewer: "owner", models: "ready" },
  argTypes: {
    viewer: { control: "inline-radio", options: ["owner", "admin", "member"] },
    models: {
      control: "inline-radio",
      options: ["ready", "loading", "empty", "error"],
    },
  },
} satisfies Meta<typeof WorkspaceSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceSettings: Story = { name: "Owner" };
export const WorkspaceSettingsAdmin: Story = {
  name: "Admin (retention locked)",
  args: { viewer: "admin" },
};
export const WorkspaceSettingsMember: Story = {
  name: "Member (read-only)",
  args: { viewer: "member" },
};
export const WorkspaceSettingsModelsLoading: Story = {
  name: "Models loading",
  args: { models: "loading" },
};
export const WorkspaceSettingsModelsEmpty: Story = {
  name: "Models empty",
  args: { models: "empty" },
};
export const WorkspaceSettingsModelsError: Story = {
  name: "Models error",
  args: { models: "error" },
};
export const WorkspaceSettingsDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const WorkspaceSettingsMobile: Story = {
  name: "Owner (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsMobileDark: Story = {
  name: "Owner (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

const DARK = { theme: "dark" };

export const WorkspaceSettingsSlackGeneral: Story = {
  name: "Slack v3 › 일반",
  args: { slack: "general" },
};
export const WorkspaceSettingsSlackGeneralDark: Story = {
  ...WorkspaceSettingsSlackGeneral,
  name: "Slack v3 › 일반 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackGeneralMobile: Story = {
  ...WorkspaceSettingsSlackGeneral,
  name: "Slack v3 › 일반 (390px)",
  globals: MOBILE,
};

export const WorkspaceSettingsSlackSlack: Story = {
  name: "Slack v3 › 연결 설정: token 설정됨",
  args: { slack: "slack" },
};
export const WorkspaceSettingsSlackSlackDark: Story = {
  ...WorkspaceSettingsSlackSlack,
  name: "Slack v3 › 연결 설정: token 설정됨 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackSlackMobile: Story = {
  ...WorkspaceSettingsSlackSlack,
  name: "Slack v3 › 연결 설정: token 설정됨 (390px)",
  globals: MOBILE,
};

export const WorkspaceSettingsSlackUnsetEdit: Story = {
  name: "Slack v3 › 연결 설정: token 넣는 중",
  args: { slack: "slack", token: "unset", editing: true },
};
export const WorkspaceSettingsSlackUnsetEditDark: Story = {
  ...WorkspaceSettingsSlackUnsetEdit,
  name: "Slack v3 › 연결 설정: token 넣는 중 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackUnsetEditMobile: Story = {
  ...WorkspaceSettingsSlackUnsetEdit,
  name: "Slack v3 › 연결 설정: token 넣는 중 (390px)",
  globals: MOBILE,
};

export const WorkspaceSettingsSlackReadOnly: Story = {
  name: "Slack v3 › 연결 설정: 읽기 전용",
  args: { slack: "slack", viewer: "member" },
};
export const WorkspaceSettingsSlackReadOnlyDark: Story = {
  ...WorkspaceSettingsSlackReadOnly,
  name: "Slack v3 › 연결 설정: 읽기 전용 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackReadOnlyMobile: Story = {
  ...WorkspaceSettingsSlackReadOnly,
  name: "Slack v3 › 연결 설정: 읽기 전용 (390px)",
  globals: MOBILE,
};

export const WorkspaceSettingsSlackReentry: Story = {
  name: "Slack v3 › 연결 설정: token 교체 필요",
  args: { slack: "slack", token: "needs_reentry" },
};
export const WorkspaceSettingsSlackReentryDark: Story = {
  ...WorkspaceSettingsSlackReentry,
  name: "Slack v3 › 연결 설정: token 교체 필요 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackReentryMobile: Story = {
  ...WorkspaceSettingsSlackReentry,
  name: "Slack v3 › 연결 설정: token 교체 필요 (390px)",
  globals: MOBILE,
};

export const WorkspaceSettingsSlackApps: Story = {
  name: "Slack v3 › 자동으로 만든 앱",
  args: { slack: "apps" },
};
export const WorkspaceSettingsSlackAppsDark: Story = {
  ...WorkspaceSettingsSlackApps,
  name: "Slack v3 › 자동으로 만든 앱 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackAppsMobile: Story = {
  ...WorkspaceSettingsSlackApps,
  name: "Slack v3 › 자동으로 만든 앱 (390px)",
  globals: MOBILE,
};

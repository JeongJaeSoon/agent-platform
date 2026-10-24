import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardTitle,
  ErrorState,
  Input,
  PageHeader,
  RowList,
  SecretField,
  SettingRow,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

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
const STATUS = `${META} min-w-6 text-right`;
// The card draws the box; the rows only keep the rule under the body.
const ROWS = "rounded-none border-x-0 border-b-0 bg-transparent";

function SettingsCard({
  title,
  description,
  descriptionId,
  rows,
  foot,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly descriptionId?: string;
  readonly rows?: ReactNode;
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
        <CardDescription id={descriptionId} className="text-description">
          {description}
        </CardDescription>
        {children}
      </div>
      {rows ? (
        <RowList variant="joined" className={ROWS}>
          {rows}
        </RowList>
      ) : null}
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

function GuestRow({
  hintId,
  saving,
}: {
  readonly hintId: string;
  readonly saving: boolean;
}) {
  const [enabled, setEnabled] = useState(WORKSPACE.slack_guest_enabled);
  return (
    <SettingRow
      title="Slack 게스트도 에이전트를 쓸 수 있게 하기"
      status={
        <div aria-hidden="true" className={STATUS}>
          {enabled ? "켜짐" : "꺼짐"}
        </div>
      }
      control={
        <Switch
          checked={enabled}
          aria-describedby={hintId}
          aria-disabled={saving || undefined}
          onCheckedChange={setEnabled}
        />
      }
    />
  );
}

function WorkspaceSettingsScreen({
  viewer,
  models,
  saving,
}: {
  readonly viewer: Viewer;
  readonly models: Models;
  readonly saving: boolean;
}) {
  const nameId = useId();
  const daysId = useId();
  const guestHintId = useId();
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
    >
      <PageHeader
        title="워크스페이스 설정"
        description={
          editable
            ? "워크스페이스 전체에 적용되는 설정입니다."
            : "지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요."
        }
      />
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
        <SettingsCard
          title="Slack 게스트"
          description="켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수 없습니다. 소유자나 관리자가 바꿀 수 있습니다."
          descriptionId={guestHintId}
          rows={
            editable ? (
              <GuestRow hintId={guestHintId} saving={saving} />
            ) : undefined
          }
        >
          {editable ? null : (
            <div>Slack 게스트는 에이전트를 쓸 수 없습니다.</div>
          )}
        </SettingsCard>
      </div>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Workspace settings (v4)",
  component: WorkspaceSettingsScreen,
  parameters: { layout: "fullscreen" },
  args: { viewer: "owner", models: "ready", saving: false },
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
/** The guest switch while its save is in flight: focusable, but refuses. */
export const WorkspaceSettingsGuestSaving: Story = {
  name: "Guest switch saving",
  args: { saving: true },
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

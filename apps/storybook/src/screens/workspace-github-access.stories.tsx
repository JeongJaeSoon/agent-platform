import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardTitle,
  ConfirmDialog,
  Page,
  RowList,
  SettingRow,
  Switch,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type ReactNode, useId } from "react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * GA-6 (docs/contributing/decisions/github-agent.md §7, mockup screen C):
 * the author App's permission table and the ceiling agents turn features on
 * under, as apps/web draws them below the App card. Values are what
 * GET /v1/workspaces/{id}/github-settings and …/github-app return.
 */

type Viewer = "owner" | "admin" | "member";
type Feature = "review" | "actions" | "checks" | "issues" | "workflows";
type State = "ready" | "lowering" | "conflict" | "unread";

// github-settings: ceiling, agents_using; github-app: permissions.
const PERMISSIONS: Record<string, "read" | "write" | "admin"> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "write",
  checks: "write",
  issues: "write",
  administration: "write",
};
const CEILING: Record<Feature, boolean> = {
  review: false,
  actions: true,
  checks: false,
  issues: false,
  workflows: false,
};
const AGENTS_USING: Record<Feature, number> = {
  review: 0,
  actions: 2,
  checks: 0,
  issues: 0,
  workflows: 0,
};

const GUIDANCE: readonly (readonly [
  string,
  string,
  "read" | "write",
  boolean,
])[] = [
  ["contents", "저장소 내용", "write", true],
  ["pull_requests", "Pull request", "write", true],
  ["metadata", "메타데이터", "read", true],
  ["actions", "Actions", "write", false],
  ["checks", "Checks", "write", false],
  ["issues", "Issues", "write", false],
  ["workflows", "Workflows", "write", false],
];
const LEVEL = { read: "읽기", write: "쓰기", admin: "관리" } as const;

const FEATURES: readonly (readonly [Feature, string, string])[] = [
  ["review", "리뷰 승인", "리뷰용 App으로 PR에 승인 리뷰를 남깁니다."],
  [
    "actions",
    "Actions 실행",
    "에이전트 허용 목록의 워크플로를 실행하거나 다시 실행합니다.",
  ],
  ["checks", "검사 결과 쓰기", "check run을 만들고 결과를 올립니다."],
  ["issues", "이슈 쓰기", "이슈를 열고 코멘트를 남깁니다."],
  [
    "workflows",
    "워크플로 파일 수정",
    ".github/workflows 아래 파일을 바꾼 commit도 push합니다.",
  ],
];

const CARD_BODY = "flex flex-col gap-3 p-4";
const META = "text-caption text-subtle-foreground";
const STATUS = `${META} min-w-14 text-right`;
const ROWS = "rounded-none border-x-0 border-b-0 bg-transparent";

function SettingsCard({
  title,
  description,
  rows,
  foot,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly rows: ReactNode;
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
      <RowList variant="joined" className={ROWS}>
        {rows}
      </RowList>
      {foot ? <CardFooter variant="form">{foot}</CardFooter> : null}
    </Card>
  );
}

function PermissionRows({ unread }: { readonly unread: boolean }) {
  if (unread)
    return (
      <SettingRow title="아직 GitHub에서 권한을 읽지 않았습니다. 소유자나 관리자가 이 화면을 열면 읽습니다." />
    );
  const extras = Object.keys(PERMISSIONS).filter(
    (name) => !GUIDANCE.some(([key]) => key === name),
  );
  return (
    <>
      {GUIDANCE.map(([name, label, guided, base]) => {
        const level = PERMISSIONS[name];
        return (
          <SettingRow
            key={name}
            title={label}
            badge={<Badge variant="mono">{name}</Badge>}
            description={`안내 ${LEVEL[guided]} · ${base ? "기본" : "선택"}`}
            meta={
              <div>
                {level === undefined ? (
                  <Badge variant={base ? "amber" : "gray"}>App에 없음</Badge>
                ) : (
                  <Badge variant="green">App {LEVEL[level]}</Badge>
                )}
              </div>
            }
          />
        );
      })}
      {extras.map((name) => (
        <SettingRow
          key={name}
          title="Administration"
          badge={<Badge variant="mono">{name}</Badge>}
          description="안내에 없음 · 플랫폼이 쓰지 않음"
          meta={
            <div>
              <Badge variant="red">
                App {LEVEL[PERMISSIONS[name] ?? "read"]} · 안내보다 넓음
              </Badge>
            </div>
          }
        />
      ))}
    </>
  );
}

function GitHubAccessScreen({
  viewer,
  state,
}: {
  readonly viewer: Viewer;
  readonly state: State;
}) {
  const editable = viewer !== "member";
  const hintId = useId();
  // The owner turned Actions off and pressed save; the dialog asks first.
  const shown = state === "lowering" ? { ...CEILING, actions: false } : CEILING;
  const lacks = (feature: Feature) =>
    feature === "review"
      ? "리뷰용 App 없음 · 허용해도 리뷰 요청은 거절됩니다."
      : state !== "unread" && PERMISSIONS[feature] === undefined
        ? "App에 권한 없음 · 허용해도 GitHub가 토큰 발급을 거절합니다."
        : null;
  return (
    <ScreenShell
      current="settings"
      crumb={["워크스페이스", "GitHub 연결 설정"]}
      role={viewer}
    >
      <Page
        title="GitHub 연결 설정"
        description="에이전트가 GitHub 저장소를 clone하고, 승인된 결과를 push하고, PR을 열 때 쓰는 GitHub App입니다. 소유자와 관리자만 바꿀 수 있습니다."
      >
        <div className="flex flex-col gap-10">
          {state === "conflict" ? (
            <Alert variant="red" role="alert">
              <AlertDescription>
                다른 사람이 먼저 최대 권한을 바꿨습니다. 지금 저장된 값을 다시
                불러왔으니 확인하고 다시 저장하세요.
              </AlertDescription>
            </Alert>
          ) : null}
          <SettingsCard
            title="App 권한"
            description="작성용 App이 GitHub에 요청한 권한을 마지막으로 읽은 값입니다. 플랫폼은 작업마다 필요한 권한만 골라 토큰을 발급합니다."
            rows={<PermissionRows unread={state === "unread"} />}
          >
            {state === "unread" ? null : (
              <Alert variant="amber">
                <AlertTitle>
                  작성용 App이 안내보다 넓은 권한을 가졌습니다
                </AlertTitle>
                <AlertDescription>
                  administration 쓰기. 플랫폼은 이 권한으로 토큰을 발급하지
                  않지만, 키가 새면 GitHub에서는 쓸 수 있습니다. GitHub의 App
                  설정에서 빼고 설치의 권한 변경을 승인하세요.
                </AlertDescription>
              </Alert>
            )}
          </SettingsCard>
          <SettingsCard
            title="에이전트가 켤 수 있는 최대 권한"
            description="에이전트 GitHub 탭은 여기서 허용한 권한 안에서만 켭니다. 실행 프로필의 상한처럼 소유자와 관리자만 바꿉니다. 낮추면 이미 켠 에이전트도 다음 GitHub 요청부터 거절됩니다."
            rows={
              <>
                <SettingRow
                  title="PR 작성·수정"
                  badge={<Badge>기본</Badge>}
                  description="clone, push, PR 열기·코멘트. GitHub를 쓰는 모든 에이전트가 가집니다."
                  actions={<div className={STATUS}>항상 켜짐</div>}
                />
                {FEATURES.map(([feature, title, hint]) => {
                  const note = lacks(feature);
                  return (
                    <SettingRow
                      key={feature}
                      title={title}
                      description={hint}
                      meta={
                        <>
                          <div className={META}>
                            활성 릴리스에서 켠 에이전트 {AGENTS_USING[feature]}
                            개
                          </div>
                          {note ? (
                            <div className="text-caption text-(color:--ap-tone-caution-fg)">
                              {note}
                            </div>
                          ) : null}
                        </>
                      }
                      status={
                        <div aria-hidden="true" className={STATUS}>
                          {shown[feature] ? "허용" : "허용 안 함"}
                        </div>
                      }
                      control={
                        <Switch
                          checked={shown[feature]}
                          disabled={!editable}
                          aria-describedby={editable ? undefined : hintId}
                        />
                      }
                    />
                  );
                })}
              </>
            }
            foot={
              editable ? (
                <>
                  <div className={META}>
                    바꾸면 감사 기록(receipt)에 남습니다.
                  </div>
                  <div className="flex gap-2">
                    {state === "lowering" ? (
                      <Button type="button" size="sm" variant="ghost">
                        되돌리기
                      </Button>
                    ) : null}
                    <Button
                      type="submit"
                      size="sm"
                      className="aria-disabled:opacity-45"
                      aria-disabled={state !== "lowering" || undefined}
                    >
                      저장
                    </Button>
                  </div>
                </>
              ) : (
                <div id={hintId} className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex shrink-0 items-center gap-1 text-caption text-subtle-foreground">
                    <Lock
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                      strokeWidth={1.5}
                    />
                    읽기 전용
                  </div>
                  <div className={META}>
                    워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금
                    역할: 구성원.
                  </div>
                </div>
              )
            }
          />
        </div>
      </Page>
      <ConfirmDialog
        open={state === "lowering"}
        onOpenChange={() => {}}
        title="최대 권한을 낮출까요?"
        consequence="Actions 실행(활성 릴리스에서 켠 에이전트 2개) 권한을 끕니다. 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다."
        confirmLabel="낮추고 저장"
        cancelLabel="취소"
        onConfirm={() => {}}
      />
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Workspace GitHub access (GA-6)",
  component: GitHubAccessScreen,
  parameters: { layout: "fullscreen" },
  args: { viewer: "owner", state: "ready" },
  argTypes: {
    viewer: { control: "inline-radio", options: ["owner", "admin", "member"] },
    state: {
      control: "inline-radio",
      options: ["ready", "lowering", "conflict", "unread"],
    },
  },
} satisfies Meta<typeof GitHubAccessScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceGitHubAccess: Story = { name: "Owner" };
export const WorkspaceGitHubAccessLowering: Story = {
  name: "Owner lowering (confirm)",
  args: { state: "lowering" },
};
export const WorkspaceGitHubAccessConflict: Story = {
  name: "Revision conflict",
  args: { state: "conflict" },
};
export const WorkspaceGitHubAccessUnread: Story = {
  name: "Permissions not read yet",
  args: { state: "unread" },
};
export const WorkspaceGitHubAccessMember: Story = {
  name: "Member (read-only)",
  args: { viewer: "member" },
};
export const WorkspaceGitHubAccessDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const WorkspaceGitHubAccessMobile: Story = {
  name: "Owner (390px)",
  globals: MOBILE,
};
export const WorkspaceGitHubAccessMemberMobile: Story = {
  name: "Member (390px)",
  args: { viewer: "member" },
  globals: MOBILE,
};

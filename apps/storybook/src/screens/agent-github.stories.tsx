import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Link,
  RowList,
  RowListItem,
  SettingRow,
  Switch,
} from "@werft-ai/ui";
import { MOBILE } from "./screen-kit.tsx";
import { Heading, MUTED_TEXT } from "./slack-kit.tsx";

/*
 * The agent detail's GitHub tab (GA-3), drawn from GET /v1/agents/{id}/github.
 * Each feature row reads `options.features.<feature>.reason`; a locked row
 * shows the reason's sentence and, but for a GitHub Enterprise host, a link
 * to the workspace GitHub settings. The repository ids are the catalog's.
 */

type Feature = "review" | "actions" | "checks" | "issues" | "workflows";
type Reason =
  | "app_permission_missing"
  | "over_workspace_ceiling"
  | "no_reviewer_app"
  | "github_host_unsupported";

const FEATURE: Record<Feature, { title: string; hint: string }> = {
  review: {
    title: "리뷰 승인",
    hint: "리뷰용 App으로 PR에 승인 리뷰를 남깁니다. 필수 리뷰·CODEOWNERS는 저장소의 GitHub 설정을 따릅니다. 필요한 권한: 리뷰용 App의 pull requests 쓰기",
  },
  actions: {
    title: "Actions 실행",
    hint: "허용 목록의 워크플로만 실행(workflow_dispatch)하거나 다시 실행합니다. 필요한 권한: actions 쓰기",
  },
  checks: {
    title: "검사 결과 쓰기",
    hint: "check run을 만들고 결과를 올립니다. 필요한 권한: checks 쓰기",
  },
  issues: {
    title: "이슈 쓰기",
    hint: "이슈를 열고 코멘트를 남깁니다. 필요한 권한: issues 쓰기",
  },
  workflows: {
    title: "워크플로 파일 수정",
    hint: ".github/workflows 아래 파일을 바꾼 commit도 push합니다. 필요한 권한: workflows 쓰기",
  },
};
const REASON: Record<Reason, string> = {
  app_permission_missing:
    "App에 이 권한이 없습니다. GitHub App 설정에서 더한 뒤 설치를 다시 승인하세요.",
  over_workspace_ceiling:
    "워크스페이스 상한 밖입니다. 소유자·관리자가 GitHub 연결 설정에서 켭니다.",
  no_reviewer_app:
    "워크스페이스에 리뷰용 App이 없습니다. PR을 만드는 App은 자기 PR을 승인할 수 없습니다.",
  github_host_unsupported:
    "고른 저장소가 모두 GitHub Enterprise에 있어 기본 작업만 할 수 있습니다.",
};
const ORDER: readonly Feature[] = [
  "review",
  "actions",
  "checks",
  "issues",
  "workflows",
];
const SECTION = "flex flex-col gap-[var(--ap-space-block)]";

interface TabProps {
  readonly enabled: boolean;
  readonly on: Partial<Record<Feature, boolean>>;
  readonly locked: Partial<Record<Feature, Reason>>;
  readonly pending: number;
}

function ReleaseBadge() {
  return <Badge variant="blue">릴리스에 반영</Badge>;
}

function State({ on }: { readonly on: boolean }) {
  return <div className={MUTED_TEXT}>{on ? "켜짐" : "꺼짐"}</div>;
}

function AgentGitHubTab({ enabled, on, locked, pending }: TabProps) {
  const readOnly = !enabled;
  return (
    <div className="flex max-w-[60rem] flex-col gap-8 p-4">
      <RowList variant="joined" aria-label="상태">
        <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
          <Badge variant={enabled ? "green" : "gray"}>
            {enabled ? "사용 중" : "꺼짐"}
          </Badge>
          <div>저장소 1개</div>
          <div className="flex items-center gap-2">
            <div className="text-muted-foreground">push 전 승인</div>
            <div>켜짐</div>
          </div>
        </RowListItem>
      </RowList>
      {pending > 0 ? (
        <Alert variant="blue">
          <AlertTitle>릴리스에 넣지 않은 변경 {pending}건</AlertTitle>
          <AlertDescription>
            저장하면 지금 카드 버전 v1과 실행 프로필 claude-coding-local로 새
            릴리스를 만들고 활성화합니다. 그 뒤에 시작하는 세션부터 적용되고,
            진행 중인 세션은 이전 릴리스 설정을 씁니다.
          </AlertDescription>
          <AlertActions>
            <Button type="button" size="sm">
              새 릴리스로 저장
            </Button>
            <Button type="button" size="sm" variant="ghost">
              되돌리기
            </Button>
          </AlertActions>
        </Alert>
      ) : null}
      <section className={SECTION} aria-label="사용">
        <Heading>사용</Heading>
        <RowList variant="joined">
          <SettingRow
            title="GitHub 사용"
            badge={<Badge variant="gray">즉시 반영</Badge>}
            description="끄면 이 에이전트에 새 GitHub 토큰을 내주지 않습니다. 진행 중인 세션도 다음 GitHub 요청부터 거절됩니다. 릴리스를 거치지 않고 바로 반영됩니다."
            status={<State on={enabled} />}
            control={<Switch aria-label="GitHub 사용" checked={enabled} />}
          />
        </RowList>
        {enabled ? null : (
          <div className={MUTED_TEXT}>
            GitHub 사용이 꺼져 있어 아래 설정은 읽기만 할 수 있습니다.
          </div>
        )}
      </section>
      <div className={`flex flex-col gap-8 ${enabled ? "" : "opacity-60"}`}>
        <section className={SECTION} aria-label="저장소">
          <div className="flex flex-wrap items-center gap-2">
            <Heading>저장소</Heading>
            <ReleaseBadge />
          </div>
          <RowList variant="joined">
            <SettingRow
              title="werft-sandbox"
              description="https://github.com/JeongJaeSoon/werft-sandbox"
              meta="활성 릴리스의 저장소라 뺄 수 없습니다."
              status={<div className={MUTED_TEXT}>사용</div>}
              control={<Switch aria-label="werft-sandbox" checked disabled />}
            />
          </RowList>
        </section>
        <section className={SECTION} aria-label="권한">
          <div className="flex flex-wrap items-center gap-2">
            <Heading>권한</Heading>
            <ReleaseBadge />
          </div>
          <RowList variant="joined">
            <SettingRow
              title="PR 작성·수정"
              badge={<Badge variant="gray">기본</Badge>}
              description="agent/<세션> 브랜치로 push하고, PR을 열고 고치고, 코멘트를 남깁니다. 필요한 권한: contents·pull requests 쓰기"
              status={<div className={MUTED_TEXT}>항상 켜짐</div>}
            />
            {ORDER.map((feature) => {
              const reason = locked[feature];
              const checked = on[feature] ?? false;
              return (
                <SettingRow
                  key={feature}
                  title={FEATURE[feature].title}
                  description={FEATURE[feature].hint}
                  meta={
                    reason ? (
                      <div>
                        {REASON[reason]}{" "}
                        {reason === "github_host_unsupported" ? null : (
                          <Link href="#settings-workspace-github">
                            GitHub 연결 설정
                          </Link>
                        )}
                      </div>
                    ) : undefined
                  }
                  status={<State on={checked} />}
                  control={
                    <Switch
                      aria-label={FEATURE[feature].title}
                      checked={checked}
                      disabled={readOnly || (reason !== undefined && !checked)}
                    />
                  }
                />
              );
            })}
          </RowList>
        </section>
        {on.actions ? (
          <section className={SECTION} aria-label="Actions 허용 목록">
            <div className="flex flex-wrap items-center gap-2">
              <Heading>Actions 허용 목록</Heading>
              <ReleaseBadge />
            </div>
            <RowList variant="joined" aria-label="Actions 허용 목록">
              <SettingRow
                title={<div className="font-mono">ci.yml</div>}
                description="기본 브랜치만"
                actions={
                  <Button type="button" variant="outline" size="sm">
                    빼기
                  </Button>
                }
              />
              <SettingRow
                title={<div className="font-mono">release.yml</div>}
                badge={
                  pending > 0 ? (
                    <Badge variant="blue">저장 전</Badge>
                  ) : undefined
                }
                description="ref 패턴 release/*"
                actions={
                  <Button type="button" variant="outline" size="sm">
                    빼기
                  </Button>
                }
              />
            </RowList>
            <Alert>
              <AlertDescription>
                push나 pull_request로 자동 실행되는 워크플로는 막지 않습니다.
                저장소의 Actions 설정을 따릅니다.
              </AlertDescription>
            </Alert>
          </section>
        ) : null}
      </div>
    </div>
  );
}

const meta = {
  title: "Screens/Agent GitHub tab",
  component: AgentGitHubTab,
  parameters: { layout: "fullscreen" },
  args: {
    enabled: true,
    on: { review: true, actions: true },
    locked: {},
    pending: 0,
  },
} satisfies Meta<typeof AgentGitHubTab>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const AgentGitHubDefault: Story = { name: "기본" };
export const AgentGitHubDefaultDark: Story = {
  name: "기본 (dark)",
  globals: DARK,
};
export const AgentGitHubDefaultMobile: Story = {
  name: "기본 (390px)",
  globals: MOBILE,
};
export const AgentGitHubUnsaved: Story = {
  name: "저장 전 변경",
  args: { pending: 2 },
};
export const AgentGitHubOff: Story = {
  name: "사용 꺼짐",
  args: { enabled: false },
};
export const AgentGitHubNoReviewer: Story = {
  name: "리뷰용 App 없음",
  args: { on: { actions: true }, locked: { review: "no_reviewer_app" } },
};
export const AgentGitHubCeiling: Story = {
  name: "상한·App 권한 밖",
  args: {
    locked: {
      checks: "over_workspace_ceiling",
      issues: "over_workspace_ceiling",
      workflows: "app_permission_missing",
    },
  },
};
export const AgentGitHubCeilingMobile: Story = {
  ...AgentGitHubCeiling,
  name: "상한·App 권한 밖 (390px)",
  globals: MOBILE,
};

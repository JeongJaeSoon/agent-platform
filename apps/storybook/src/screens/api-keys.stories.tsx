import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ApiKeyView, SessionScope } from "@werft-ai/contracts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  type BadgeProps,
  Button,
  Code,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  formatTimestamp,
  Heading,
  LinkTab,
  LinkTabs,
  Page,
  RowList,
  Skeleton,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { CircleAlert, Clock, InfinityIcon, Plus } from "lucide-react";
import { useId, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { MOBILE, type Role, ScreenShell, VIEWER } from "./screen-kit.tsx";

/*
 * The key screens of apps/web routes/api-keys.tsx: the personal and agent
 * key lists (/settings/api-keys, /settings/api-keys/agents) and the
 * organization admin key's place (/settings/workspace/api-keys).
 */

type KeyKind = ApiKeyView["kind"];
type View = KeyKind | "org";
type List = "ready" | "loading" | "empty" | "error" | "forbidden";

const ICON = "size-3.5 shrink-0";
const KEY_COPY = "-my-1 -mr-1 -ml-1.5 h-6 min-w-6 gap-1 px-1 text-xs";
const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_MS = 7 * DAY_MS;
const WORKSPACE = "5b0e8f3a-2c41-4d7e-9a16-3f8b2c7d4e10";
// The shell's viewer: GET /v1/api-keys lists only their own personal keys.
const ME = { id: VIEWER.id, display_name: VIEWER.name };
const ADMIN = {
  id: "8d2f4a6c-1b3e-4f5a-9c7d-0e1f2a3b4c5d",
  display_name: "Verify Admin",
};

/** Days from now, so the expiry states read the same on any day. */
const day = (days: number) =>
  new Date(Date.now() + days * DAY_MS).toISOString();

const AGENTS: Record<string, string> = {
  "3c9a1e7b-5d2f-4a8c-b6e0-1f2d3c4b5a69": "배포 봇",
  "6e2b8d4f-0a1c-4e3b-9d5f-7a8b9c0d1e2f": "리뷰 봇",
};
const [DEPLOY, REVIEW] = Object.keys(AGENTS) as [string, string];

// GET /v1/api-keys for an owner: their own personal keys and every agent
// key, whoever issued it.
const KEYS: readonly ApiKeyView[] = [
  {
    id: "0f9c2e4a-6b1d-4c3e-8a7f-2d5b9e1c3a40",
    kind: "personal",
    name: "laptop",
    workspace_id: WORKSPACE,
    agent_id: null,
    created_by: ME.id,
    created_by_user: ME,
    scopes: ["sessions:read", "sessions:write"],
    created_at: day(-21),
    expires_at: day(80),
    revoked_at: null,
    last_used_at: day(-1),
  },
  {
    id: "7a3e5c1b-2d4f-4e6a-9b8c-0d1e2f3a4b5c",
    kind: "personal",
    name: null,
    workspace_id: WORKSPACE,
    agent_id: null,
    created_by: ME.id,
    created_by_user: ME,
    scopes: ["sessions:read", "sessions:approve"],
    created_at: day(-60),
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
  },
  {
    id: "c4b8d2e6-1a3f-4b5c-8d7e-9f0a1b2c3d4e",
    kind: "agent",
    name: "ci-deploy",
    workspace_id: WORKSPACE,
    agent_id: DEPLOY,
    created_by: ME.id,
    created_by_user: ME,
    scopes: ["sessions:read", "sessions:write", "sessions:approve"],
    created_at: day(-30),
    expires_at: day(3),
    revoked_at: null,
    last_used_at: day(0),
  },
  {
    id: "9b1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e",
    kind: "agent",
    name: "nightly",
    workspace_id: WORKSPACE,
    agent_id: REVIEW,
    created_by: ADMIN.id,
    created_by_user: ADMIN,
    scopes: ["sessions:read", "sessions:write"],
    created_at: day(-120),
    expires_at: day(-2),
    revoked_at: null,
    last_used_at: day(-3),
  },
  {
    id: "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    kind: "agent",
    name: null,
    workspace_id: WORKSPACE,
    agent_id: REVIEW,
    created_by: null,
    created_by_user: null,
    scopes: ["sessions:read"],
    created_at: day(-90),
    expires_at: day(0),
    revoked_at: day(-10),
    last_used_at: null,
  },
];

const REVOKED_ID = "c4b8d2e6-1a3f-4b5c-8d7e-9f0a1b2c3d4e";

// A member who administers the deploy agent lists only that agent's keys.
const MEMBER_KEYS = KEYS.filter(
  (key) => key.kind === "personal" || key.agent_id === DEPLOY,
);

const SCOPE_NAME: Record<SessionScope, string> = {
  "sessions:read": "세션 보기",
  "sessions:write": "세션 만들기",
  "sessions:approve": "요청에 답하기",
  "sessions:control": "세션 제어",
  "sessions:recover": "세션 복구",
};

const KIND_NAME: Record<KeyKind, string> = {
  personal: "개인 키",
  agent: "에이전트 키",
};

const KIND_BADGE: Record<KeyKind, BadgeProps["variant"]> = {
  personal: "gray",
  agent: "blue",
};

const KIND_FACTS: Record<KeyKind, readonly string[]> = {
  personal: [
    "발급한 사람으로 동작합니다. 이 키로 시작한 세션은 그 사람의 세션입니다.",
    "발급한 사람이 워크스페이스를 떠나거나 계정이 정지되면 바로 멈춥니다. 권한도 그 사람의 지금 역할을 넘지 않습니다.",
    "발급한 사람이 볼 수 있는 세션에 닿습니다.",
    "'요청에 답하기'(sessions:approve) 권한을 넣을 수 있습니다.",
  ],
  agent: [
    "사람이 아니라 키 자체로 동작합니다. 이 키로 시작한 세션은 키의 세션입니다.",
    "발급한 사람이 떠나도 계속 유효합니다. 필요 없어지면 직접 폐기하세요.",
    "고른 에이전트의 세션에만 닿습니다. 세션을 시작할 때도 그 에이전트의 릴리스를 지정해야 합니다.",
    "세션을 만들려면 '세션 만들기'와 '세션 보기' 권한을 넣으세요. 이 키로 GET /v1/agents를 부르면 그 에이전트의 active_release_id가 나오고, 그 값을 POST /v1/sessions의 agent_release_id로 보냅니다.",
    "'요청에 답하기'(sessions:approve) 권한을 넣으면 그 에이전트의 세션에서 승인과 질문 답변을 합니다. 이 키로 시작한 세션의 요청은 이 키로 승인하지 못합니다.",
  ],
};

const SCREEN: Record<
  KeyKind,
  { readonly title: string; readonly intro: string; readonly empty: string }
> = {
  personal: {
    title: "개인 키",
    intro:
      "나로 동작하는 키입니다. CLI나 스크립트가 내 권한 안에서 API를 부를 때 씁니다.",
    empty: "아직 만든 개인 키가 없습니다.",
  },
  agent: {
    title: "에이전트 키",
    intro:
      "사람이 아니라 에이전트 하나에 속한 키입니다. 그 에이전트의 세션에만 닿고, 발급한 사람이 떠나도 계속 동작합니다.",
    empty: "아직 에이전트 키가 없습니다.",
  },
};

const at = (iso: string) => formatTimestamp(iso, "ko");

function KindBadge({ kind }: { readonly kind: KeyKind }) {
  return (
    <Badge variant={KIND_BADGE[kind]} data-kind={kind}>
      {KIND_NAME[kind]}
    </Badge>
  );
}

function KeyKindGuide({ kind }: { readonly kind: KeyKind }) {
  const titleId = useId();
  return (
    <Alert asChild aria-labelledby={titleId}>
      <section>
        <AlertTitle asChild>
          <Heading id={titleId} className="m-0">
            키 종류
          </Heading>
        </AlertTitle>
        <AlertDescription className="mt-2 flex flex-col gap-3">
          <div className="flex flex-col items-start gap-2">
            <KindBadge kind={kind} />
            <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
              {KIND_FACTS[kind].map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
          <div>
            API 문서에서 키를 Bearer 칸에 넣고 Test Request로 실제 요청을 보내
            볼 수 있습니다.{" "}
            <TextLink
              href="/docs"
              target="_blank"
              newTabLabel="(새 탭에서 열림)"
            >
              API 문서 열기
            </TextLink>
          </div>
        </AlertDescription>
      </section>
    </Alert>
  );
}

/** The route's StatusScreen, kind "forbidden". */
function Forbidden() {
  return (
    <section
      className="flex flex-col items-start gap-2 rounded-card border border-[var(--ap-tone-danger-border)] bg-card p-4 text-card-foreground"
      data-status="forbidden"
      role="alert"
    >
      <Heading className="flex items-center gap-2">
        이 화면을 볼 권한이 없습니다
      </Heading>
      <Text>필요하면 워크스페이스 소유자나 관리자에게 권한을 요청하세요.</Text>
    </section>
  );
}

function KeyIdMeta({ id }: { readonly id: string }) {
  return (
    <Text
      as="span"
      variant="meta"
      className="inline-flex min-w-0 items-center gap-1"
    >
      <Text as="span" variant="meta">
        ID
      </Text>
      <Code className="min-w-0 text-foreground [overflow-wrap:anywhere]">
        {id}
      </Code>
      <CopyButton
        value={id}
        variant="ghost"
        size="sm"
        className={KEY_COPY}
        label="복사"
        description={`ID ${id}`}
        copiedMessage="복사했습니다"
        iconClassName={ICON}
      />
    </Text>
  );
}

function MetaDot() {
  return (
    <Text as="span" variant="meta" aria-hidden="true">
      ·
    </Text>
  );
}

function expiryState(
  expiresAt: string | null,
): "none" | "later" | "soon" | "expired" {
  if (expiresAt === null) return "none";
  const left = new Date(expiresAt).getTime() - Date.now();
  return left <= 0 ? "expired" : left <= SOON_MS ? "soon" : "later";
}

function ExpiryMeta({ row }: { readonly row: ApiKeyView }) {
  const { expires_at: expiresAt, revoked_at: revokedAt } = row;
  const state = revokedAt ? "revoked" : expiryState(expiresAt);
  if (state === "later" && expiresAt)
    return (
      <Text as="span" variant="meta">
        만료 {at(expiresAt)}
      </Text>
    );
  const danger = state === "expired" || state === "revoked";
  const text =
    state === "revoked" && revokedAt
      ? `폐기됨 ${at(revokedAt)}`
      : state === "none" || !expiresAt
        ? "만료 없음"
        : state === "expired"
          ? `만료됨 · ${at(expiresAt)}`
          : `곧 만료 · ${at(expiresAt)}`;
  return (
    <Text
      as="span"
      variant="meta"
      data-tone={danger ? "danger" : "caution"}
      data-expiry={state}
      className="inline-flex items-center gap-1 font-medium text-[var(--ap-tone-fg)]"
    >
      {danger ? (
        <CircleAlert aria-hidden="true" className={ICON} />
      ) : state === "none" ? (
        <InfinityIcon aria-hidden="true" className={ICON} />
      ) : (
        <Clock aria-hidden="true" className={ICON} />
      )}
      {text}
    </Text>
  );
}

function KeyList({ items }: { readonly items: readonly ApiKeyView[] }) {
  const [confirming, setConfirming] = useState<ApiKeyView | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <RowList
        variant="joined"
        framed={false}
        className="rounded-card border"
        aria-label="발급된 키"
      >
        {items.map((key) => {
          const agent = key.agent_id === null ? null : AGENTS[key.agent_id];
          const name = key.name ?? "이름 없음";
          const title = agent == null ? name : `${agent} · ${name}`;
          const label = `${KIND_NAME[key.kind]} · ${title}`;
          const approves = key.scopes.includes("sessions:approve");
          return (
            <li
              key={key.id}
              className="flex min-h-12 flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
              data-revoked={key.revoked_at !== null}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="min-w-0 font-semibold text-sm leading-5 [overflow-wrap:anywhere]"
                    data-unnamed={key.name === null}
                  >
                    {title}
                  </div>
                  <KindBadge kind={key.kind} />
                  <Badge
                    variant={approves ? "green" : "gray"}
                    data-approve={approves}
                  >
                    {approves ? "승인 가능" : "승인 불가"}
                  </Badge>
                </div>
                <Text as="span" variant="meta">
                  {key.scopes.map((scope) => SCOPE_NAME[scope]).join(", ")}
                </Text>
                <Text
                  as="div"
                  variant="meta"
                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <KeyIdMeta id={key.id} />
                  <MetaDot />
                  <Text as="span" variant="meta">
                    발급 {at(key.created_at)}
                  </Text>
                  <MetaDot />
                  <ExpiryMeta row={key} />
                </Text>
                {key.kind === "agent" ? (
                  <Text as="span" variant="meta">
                    발급자가 떠나도 유효
                  </Text>
                ) : null}
              </div>
              {key.revoked_at ? null : (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  className="shrink-0"
                  aria-label={`${label} (${key.id}) 폐기`}
                  onClick={() => setConfirming(key)}
                >
                  폐기
                </Button>
              )}
            </li>
          );
        })}
      </RowList>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={`ID ${confirming?.id ?? ""} 키를 폐기할까요?`}
        consequence="이 키를 쓰는 곳은 바로 동작을 멈춥니다. 되돌릴 수 없습니다."
        confirmLabel="폐기"
        cancelLabel="취소"
        tone="danger"
        onConfirm={() => setConfirming(null)}
      />
    </>
  );
}

function KeysBody({
  kind,
  list,
  keys,
}: {
  readonly kind: KeyKind;
  readonly list: List;
  readonly keys: readonly ApiKeyView[];
}) {
  if (list === "loading")
    return <Skeleton lines={3} label="불러오는 중입니다" />;
  if (list === "forbidden") return <Forbidden />;
  if (list === "error")
    return (
      <ErrorState
        title="불러오지 못했습니다"
        message="처리하지 못했습니다 — 잠시 뒤 다시 시도하세요."
        retry={() => {}}
        retryLabel="다시 시도"
      />
    );
  const items = keys.filter((key) => key.kind === kind);
  if (items.length === 0) return <EmptyState title={SCREEN[kind].empty} />;
  return <KeyList items={items} />;
}

function KeysScreen({
  kind,
  role,
  administers,
  list,
  revoked,
}: {
  readonly kind: KeyKind;
  readonly role: Role;
  readonly administers: boolean;
  readonly list: List;
  readonly revoked: boolean;
}) {
  const manager = role !== "member";
  const listed = list === "empty" ? [] : manager ? KEYS : MEMBER_KEYS;
  // After a revoke the list reads again: the key stays, revoked just now.
  const keys = revoked
    ? listed.map((key) =>
        key.id === REVOKED_ID
          ? { ...key, revoked_at: new Date().toISOString() }
          : key,
      )
    : listed;
  // useIssuesAgentKeys: managers issue for every agent, a member for theirs.
  const agentKeys = manager || administers;
  const tabs: KeyKind[] =
    agentKeys || kind === "agent" ? ["personal", "agent"] : [];
  const counted = list === "ready" || list === "empty";
  return (
    <Page
      title="API 키"
      description={SCREEN[kind].intro}
      actions={
        <Button type="button">
          <Plus aria-hidden="true" className="size-4" />새 키
        </Button>
      }
    >
      {tabs.length === 0 ? null : (
        <LinkTabs aria-label="키 목록">
          {tabs.map((tab) => {
            const count = counted
              ? keys.filter((key) => key.kind === tab).length
              : undefined;
            return (
              <LinkTab
                key={tab}
                href={`#${tab}`}
                current={tab === kind}
                count={count}
                countLabel={count === undefined ? undefined : `${count}개`}
              >
                {SCREEN[tab].title}
              </LinkTab>
            );
          })}
        </LinkTabs>
      )}
      {revoked ? (
        <Alert asChild variant="blue">
          <output>키를 폐기했습니다.</output>
        </Alert>
      ) : null}
      <KeysBody kind={kind} list={list} keys={keys} />
      <KeyKindGuide kind={kind} />
    </Page>
  );
}

function OrgKeysScreen({ role }: { readonly role: Role }) {
  if (role === "member")
    return (
      <Page title="조직 관리 키">
        <Forbidden />
      </Page>
    );
  return (
    <Page
      title="조직 관리 키"
      description="사람에 묶이지 않는 조직 소유 키입니다. Terraform·CI·SCIM 같은 자동화가 워크스페이스 관리 API를 부를 때 씁니다."
    >
      <EmptyState
        title="준비 중입니다"
        description="아직 발급할 수 없습니다. 세션을 다루는 자동화에는 에이전트 키를 쓰세요. 발급할 수 있게 되면 만료일은 반드시 정해야 합니다."
      />
    </Page>
  );
}

function ApiKeysScreen({
  view,
  role,
  administers,
  list,
  revoked,
}: {
  readonly view: View;
  readonly role: Role;
  /** A member who administers an agent issues its keys (design 4.1). */
  readonly administers: boolean;
  readonly list: List;
  /** The notice a revoke leaves above the list. */
  readonly revoked: boolean;
}) {
  if (view === "org")
    return (
      <ScreenShell
        current="settings"
        crumb={["조직 관리 키"]}
        role={role}
        settings="workspaceApiKeys"
      >
        <OrgKeysScreen role={role} />
      </ScreenShell>
    );
  return (
    <ScreenShell
      current="settings"
      crumb={["API 키"]}
      role={role}
      settings="apiKeys"
    >
      <KeysScreen
        kind={view}
        role={role}
        administers={administers}
        list={list}
        revoked={revoked}
      />
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/API keys (v4)",
  component: ApiKeysScreen,
  parameters: { layout: "fullscreen" },
  args: {
    view: "personal",
    role: "owner",
    administers: false,
    list: "ready",
    revoked: false,
  },
  argTypes: {
    view: { control: "inline-radio", options: ["personal", "agent", "org"] },
    role: { control: "inline-radio", options: ["owner", "admin", "member"] },
    list: {
      control: "inline-radio",
      options: ["ready", "loading", "empty", "error", "forbidden"],
    },
  },
} satisfies Meta<typeof ApiKeysScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ApiKeys: Story = { name: "Owner · personal keys" };
export const ApiKeysAgent: Story = {
  name: "Owner · agent keys",
  args: { view: "agent" },
};
export const ApiKeysOrg: Story = {
  name: "Owner · organization admin keys (coming soon)",
  args: { view: "org" },
};
export const ApiKeysOrgForbidden: Story = {
  name: "Member · organization admin keys (forbidden)",
  args: { view: "org", role: "member" },
};
export const ApiKeysMember: Story = {
  name: "Agent admin member · agent keys",
  args: { view: "agent", role: "member", administers: true },
};
export const ApiKeysMemberNoAgents: Story = {
  name: "Member without agents (no tabs)",
  args: { role: "member" },
};
export const ApiKeysLoading: Story = {
  name: "Loading (no counts)",
  args: { list: "loading" },
};
export const ApiKeysEmpty: Story = {
  name: "Empty",
  args: { list: "empty" },
};
export const ApiKeysError: Story = {
  name: "Load failed",
  args: { list: "error" },
};
export const ApiKeysForbidden: Story = {
  name: "List refused (403)",
  args: { list: "forbidden" },
};
export const ApiKeysRevokeConfirm: Story = {
  name: "Revoke asks first",
  args: { view: "agent" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", {
        name: "에이전트 키 · 배포 봇 · ci-deploy (c4b8d2e6-1a3f-4b5c-8d7e-9f0a1b2c3d4e) 폐기",
      }),
    );
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
    await expect(dialog).toHaveTextContent(
      "ID c4b8d2e6-1a3f-4b5c-8d7e-9f0a1b2c3d4e 키를 폐기할까요?",
    );
  },
};
export const ApiKeysRevoked: Story = {
  name: "Revoked (notice)",
  args: { view: "agent", revoked: true },
};
export const ApiKeysDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const ApiKeysMobile: Story = {
  name: "Owner (390px)",
  globals: MOBILE,
};
export const ApiKeysMobileDark: Story = {
  name: "Owner (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  formatTimestamp,
  LinkTab,
  LinkTabs,
  PageHeader,
  Skeleton,
} from "@werft-ai/ui";
import { CircleAlert, Clock, Copy, Plus } from "lucide-react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * API keys as apps/web draws it (routes/api-keys.tsx). From the v4 mockup
 * (Console.dc.html L795-812) it takes only the route tabs with counts and the
 * `key-meta` line's `·` separators with a 4px 8px gap (L444); the rest is the
 * console's own screen. The mockup's last use and issuer have no API, so
 * they are not drawn.
 */

type Viewer = "owner" | "member";
type List = "ready" | "loading" | "empty" | "error";
type Kind = "personal" | "agent";
type Tab = Kind | "org";

interface KeyRow {
  readonly id: string;
  readonly kind: Kind;
  readonly name?: string;
  /** The bound agent's name, for an agent key. */
  readonly agent?: string;
  readonly scopes: readonly string[];
  readonly approves: boolean;
  readonly created_at: string;
  readonly expiry: "later" | "soon" | "none" | "revoked";
  readonly at?: string;
}

// Values GET /v1/api-keys returns, in the console's words (i18n/api-keys.ts).
const KEYS: Record<Kind, readonly KeyRow[]> = {
  personal: [
    {
      id: "0f9c2e4a-6b1d-4c3e-8a7f-2d5b9e1c3a40",
      kind: "personal",
      name: "laptop",
      scopes: ["세션 보기", "세션 만들기"],
      approves: false,
      created_at: "2026-10-11T00:00:00.000Z",
      expiry: "later",
      at: "2027-01-19T14:59:59.000Z",
    },
    {
      id: "7a3e5c1b-2d4f-4e6a-9b8c-0d1e2f3a4b5c",
      kind: "personal",
      scopes: ["세션 보기", "요청에 답하기"],
      approves: true,
      created_at: "2026-09-02T06:12:00.000Z",
      expiry: "none",
    },
  ],
  agent: [
    {
      id: "c4b8d2e6-1a3f-4b5c-8d7e-9f0a1b2c3d4e",
      kind: "agent",
      name: "ci-deploy",
      agent: "배포 봇",
      scopes: ["세션 보기", "세션 만들기"],
      approves: false,
      created_at: "2026-10-01T01:30:00.000Z",
      expiry: "soon",
      at: "2026-10-27T14:59:59.000Z",
    },
    {
      id: "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
      kind: "agent",
      agent: "리뷰 봇",
      scopes: ["세션 보기"],
      approves: false,
      created_at: "2026-08-20T05:00:00.000Z",
      expiry: "revoked",
      at: "2026-10-01T00:00:00.000Z",
    },
  ],
};

const KIND: Record<
  Kind,
  { readonly label: string; readonly variant: "gray" | "blue" }
> = {
  personal: { label: "개인 key", variant: "gray" },
  agent: { label: "에이전트 key", variant: "blue" },
};

const FACTS: Record<Kind, readonly string[]> = {
  personal: [
    "발급한 사람으로 동작합니다. 이 key로 시작한 세션은 그 사람의 세션입니다.",
    "발급한 사람이 워크스페이스를 떠나거나 계정이 정지되면 바로 멈춥니다. 권한도 그 사람의 지금 역할을 넘지 않습니다.",
    "발급한 사람이 볼 수 있는 세션에 닿습니다.",
    "'요청에 답하기'(sessions:approve) 권한을 넣을 수 있습니다.",
  ],
  agent: [
    "사람이 아니라 key 자체로 동작합니다. 이 key로 시작한 세션은 key의 세션입니다.",
    "발급한 사람이 떠나도 계속 유효합니다. 필요 없어지면 직접 폐기하세요.",
    "고른 에이전트의 세션에만 닿습니다. 세션을 시작할 때도 그 에이전트의 release를 지정해야 합니다.",
    "'요청에 답하기'(sessions:approve) 권한이 없습니다. 승인과 질문 답변은 사람이 합니다.",
  ],
};

const SCREEN: Record<
  Tab,
  { readonly title: string; readonly intro: string; readonly empty: string }
> = {
  personal: {
    title: "개인 key",
    intro:
      "나로 동작하는 key입니다. CLI나 스크립트가 내 권한 안에서 API를 부를 때 씁니다.",
    empty: "아직 만든 개인 key가 없습니다.",
  },
  agent: {
    title: "에이전트 key",
    intro:
      "사람이 아니라 에이전트 하나에 속한 key입니다. 그 에이전트의 세션에만 닿고, 발급한 사람이 떠나도 계속 동작합니다.",
    empty: "아직 에이전트 key가 없습니다.",
  },
  org: {
    title: "조직 관리 key",
    intro:
      "사람에 묶이지 않는 조직 소유 key입니다. Terraform·CI·SCIM 같은 자동화가 워크스페이스 관리 API를 부를 때 씁니다.",
    empty: "준비 중입니다",
  },
};

const META =
  "flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs leading-4";
const ICON = "size-3.5 shrink-0";
// v4 `.key-copy` (Console.dc.html L445): 24px, pulled into the meta gaps.
const KEY_COPY = "-my-1 -mr-1 -ml-1.5 h-6 min-w-6 gap-1 px-1 text-xs";
const at = (iso: string | undefined) => formatTimestamp(iso ?? "", "ko");

function Dot() {
  return <div aria-hidden="true">·</div>;
}

function Expiry({ row }: { readonly row: KeyRow }) {
  if (row.expiry === "later") return <div>만료 {at(row.at)}</div>;
  const danger = row.expiry === "revoked";
  return (
    <div
      data-tone={danger ? "danger" : "caution"}
      className="inline-flex items-center gap-1 font-medium text-[var(--ap-tone-fg)]"
    >
      {danger ? (
        <CircleAlert aria-hidden="true" className={ICON} />
      ) : (
        <Clock aria-hidden="true" className={ICON} />
      )}
      {row.expiry === "revoked"
        ? `폐기됨 ${at(row.at)}`
        : row.expiry === "soon"
          ? `곧 만료 · ${at(row.at)}`
          : "만료 없음"}
    </div>
  );
}

function Row({ row }: { readonly row: KeyRow }) {
  const kind = KIND[row.kind];
  const name = row.name ?? "이름 없음";
  const title = row.agent ? `${row.agent} · ${name}` : name;
  const label = `${kind.label} · ${title}`;
  return (
    <li className="flex min-h-12 flex-col items-start gap-2 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 font-semibold text-sm leading-5 [overflow-wrap:anywhere]">
            {title}
          </div>
          <Badge variant={kind.variant}>{kind.label}</Badge>
          {row.kind === "personal" ? (
            <Badge variant={row.approves ? "green" : "gray"}>
              {row.approves ? "승인 가능" : "승인 불가"}
            </Badge>
          ) : null}
        </div>
        <div className={META}>{row.scopes.join(", ")}</div>
        <div className={META}>
          <div className="inline-flex min-w-0 items-center gap-1">
            <div>ID</div>
            <div className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">
              {row.id}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={KEY_COPY}
              aria-label={`ID ${row.id} 복사`}
            >
              <Copy aria-hidden="true" className={ICON} />
            </Button>
          </div>
          <Dot />
          <div>발급 {at(row.created_at)}</div>
          <Dot />
          <Expiry row={row} />
        </div>
        {row.kind === "agent" ? (
          <div className="text-muted-foreground text-xs">
            발급자가 떠나도 유효
          </div>
        ) : null}
      </div>
      {row.expiry === "revoked" ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-tone="danger"
          className="shrink-0 border-[var(--ap-tone-border)] text-[var(--ap-tone-fg)] hover:bg-[var(--ap-tone-bg)] hover:text-[var(--ap-tone-fg)]"
          aria-label={`${label} (${row.id}) 폐기`}
        >
          폐기
        </Button>
      )}
    </li>
  );
}

function Body({ tab, list }: { readonly tab: Kind; readonly list: List }) {
  if (list === "loading") {
    return (
      <div className="flex flex-col gap-4 rounded-card border p-4">
        <Skeleton width="80%" />
        <Skeleton width="60%" />
      </div>
    );
  }
  if (list === "error") {
    return (
      <ErrorState
        title="불러오지 못했습니다"
        message="처리하지 못했습니다 — 잠시 뒤 다시 시도하세요."
        retry={() => {}}
        retryLabel="다시 시도"
      />
    );
  }
  if (list === "empty") return <EmptyState title={SCREEN[tab].empty} />;
  return (
    <ul
      className="m-0 flex list-none flex-col rounded-card border p-0"
      aria-label="발급된 key"
    >
      {KEYS[tab].map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </ul>
  );
}

function ApiKeysScreen({
  viewer,
  tab,
  list,
}: {
  readonly viewer: Viewer;
  readonly tab: Tab;
  readonly list: List;
}) {
  // A member who administers an agent sees the agent tab; only the holders
  // of api_key.manage see the organization admin key's place.
  const tabs: readonly Tab[] =
    viewer === "member" ? ["personal", "agent"] : ["personal", "agent", "org"];
  const shown: Tab = tabs.includes(tab) ? tab : "personal";
  const counted = list === "ready" || list === "empty";
  const count = (of: Kind) => (list === "ready" ? KEYS[of].length : 0);
  return (
    <ScreenShell
      current="settings"
      crumb={["내 설정", "API key"]}
      role={viewer}
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <PageHeader
          title="API key"
          description={SCREEN[shown].intro}
          actions={
            shown === "org" ? undefined : (
              <Button type="button">
                <Plus aria-hidden="true" className="size-4" />새 key
              </Button>
            )
          }
        />
        <LinkTabs aria-label="key 목록">
          {tabs.map((of) => (
            <LinkTab
              key={of}
              href={`#${of}`}
              current={of === shown}
              // Counts wait for the list, as in the console.
              count={counted && of !== "org" ? count(of) : undefined}
              countLabel={
                counted && of !== "org" ? `${count(of)}개` : undefined
              }
            >
              {SCREEN[of].title}
            </LinkTab>
          ))}
        </LinkTabs>
        {shown === "org" ? (
          <EmptyState
            title="준비 중입니다"
            description="아직 발급할 수 없습니다. 세션을 다루는 자동화에는 에이전트 key를 쓰세요. 발급할 수 있게 되면 만료일은 반드시 정해야 합니다."
          />
        ) : (
          <>
            <Body tab={shown} list={list} />
            <Alert asChild aria-label="key 종류">
              <section>
                <AlertTitle>key 종류</AlertTitle>
                <AlertDescription className="mt-2 flex flex-col items-start gap-2">
                  <Badge variant={KIND[shown].variant}>
                    {KIND[shown].label}
                  </Badge>
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
                    {FACTS[shown].map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </section>
            </Alert>
          </>
        )}
      </div>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/API keys (v4)",
  component: ApiKeysScreen,
  parameters: { layout: "fullscreen" },
  args: { viewer: "owner", tab: "personal", list: "ready" },
  argTypes: {
    viewer: { control: "inline-radio", options: ["owner", "member"] },
    tab: { control: "inline-radio", options: ["personal", "agent", "org"] },
    list: {
      control: "inline-radio",
      options: ["ready", "loading", "empty", "error"],
    },
  },
} satisfies Meta<typeof ApiKeysScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ApiKeys: Story = { name: "Owner · personal keys" };
export const ApiKeysAgent: Story = {
  name: "Owner · agent keys",
  args: { tab: "agent" },
};
export const ApiKeysOrg: Story = {
  name: "Owner · organization admin keys (coming soon)",
  args: { tab: "org" },
};
export const ApiKeysMember: Story = {
  name: "Agent admin member (no organization tab)",
  args: { viewer: "member" },
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
  name: "Error",
  args: { list: "error" },
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

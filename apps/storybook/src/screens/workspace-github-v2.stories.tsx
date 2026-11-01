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
  DangerZone,
  DangerZoneRow,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  Link,
  Page,
  PageFrame,
  RadioGroup,
  RadioGroupItem,
  RowList,
  SegmentedControl,
  SegmentedControlItem,
  SettingRow,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Switch,
} from "@werft-ai/ui";
import {
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  Lock,
  Pencil,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { MOBILE } from "./screen-kit.tsx";

/*
 * GHUI-design: Settings › GitHub, redesigned on the owner's five notes
 * (2026-11-02). One card per App holds its identity, its permission table
 * and the repositories its installations reach, a page at a time. The
 * features each role may turn on sit at the head of that role's section,
 * and the tables below them follow the switches before anything is saved.
 * Values stand in for GET …/github-apps, …/github-settings and the paged
 * …/github-repositories of settings-replace-file-catalog.md §1.1.
 */

type Level = "read" | "write" | "admin";
type Permissions = Readonly<Record<string, Level>>;
type Role = "author" | "reviewer";
type Feature = "actions" | "workflows" | "review";
type Ceiling = Readonly<Record<Feature, boolean>>;

const RANK: Record<Level, number> = { read: 1, write: 2, admin: 3 };
const LEVEL: Record<Level, string> = {
  read: "읽기",
  write: "쓰기",
  admin: "관리",
};
const NAME: Record<string, string> = {
  contents: "저장소 내용",
  pull_requests: "Pull request",
  metadata: "메타데이터",
  actions: "Actions",
  workflows: "Workflows",
  checks: "Checks",
  issues: "Issues",
  administration: "Administration",
};
// Rows keep this order whatever the switches do, so nothing moves under focus.
const ROW_ORDER = Object.keys(NAME);

// packages/contracts GITHUB_APP_PERMISSION_GUIDANCE.
const GUIDANCE: Record<Role, Permissions> = {
  author: {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    actions: "write",
    checks: "write",
    issues: "write",
    workflows: "write",
  },
  reviewer: { contents: "read", pull_requests: "write", metadata: "read" },
};
const BASE_NEED: Permissions = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};
const REVIEW_NEED: Permissions = { contents: "read", pull_requests: "write" };
const FEATURE_NEED: Record<Exclude<Feature, "review">, Permissions> = {
  actions: { actions: "write" },
  workflows: { workflows: "write" },
};

/** What a role's App must hold under a ceiling, saved or not yet saved. */
function needOf(role: Role, ceiling: Ceiling): Permissions {
  if (role === "reviewer") return ceiling.review ? REVIEW_NEED : {};
  return {
    ...BASE_NEED,
    ...(ceiling.actions ? FEATURE_NEED.actions : {}),
    ...(ceiling.workflows ? FEATURE_NEED.workflows : {}),
  };
}

/** The App against what is needed and what the role's guidance allows. */
type AppStatus = "missing" | "short" | "beyond" | "unused" | "ok";
/** The installation against the App: a separate fact from AppStatus. */
type Approval = "approved" | "pending" | "unknown";

function appStatusOf(
  role: Role,
  name: string,
  need: Level | null,
  held: Level | null,
): AppStatus {
  if (need !== null && held === null) return "missing";
  if (need !== null && held !== null && RANK[held] < RANK[need]) return "short";
  const guided = GUIDANCE[role][name];
  if (held !== null && (guided === undefined || RANK[held] > RANK[guided]))
    return "beyond";
  if (held !== null && need === null) return "unused";
  return "ok";
}

/** Unread approvals (no installation, a failed read) are never "pending". */
function approvalOf(
  held: Level | null,
  approved: Permissions | null,
  name: string,
) {
  if (approved === null) return "unknown" satisfies Approval;
  const level = approved[name];
  if (held === null) return "approved" satisfies Approval;
  return level !== undefined && RANK[level] >= RANK[held]
    ? ("approved" satisfies Approval)
    : ("pending" satisfies Approval);
}

const STATUS_TEXT: Record<AppStatus | "pending", string> = {
  missing: "App에 없음",
  short: "App에 부족",
  beyond: "안내보다 넓음",
  unused: "현재 필요 없음",
  ok: "맞음",
  pending: "설치 승인 대기",
};
const STATUS_TONE = {
  missing: "amber",
  short: "amber",
  beyond: "red",
  unused: "gray",
  ok: "green",
  pending: "amber",
} as const;

interface Installation {
  /** GitHub's installation id: the selection key, unique across GitHub. */
  readonly id: number;
  readonly account: string;
  readonly selection: "all" | "selected";
  /** null when GitHub could not be asked. */
  readonly total: number | null;
  /** What the installation accepted; null when it could not be read. */
  readonly approved: Permissions | null;
  readonly failure?: "network" | "suspended";
}

const pendingOf = (app: App, installation: Installation) =>
  installation.approved !== null &&
  Object.entries(app.permissions).some(
    ([name, level]) =>
      approvalOf(level, installation.approved, name) === "pending",
  );

interface App {
  readonly id: string;
  readonly role: Role;
  readonly name: string;
  readonly slug: string;
  readonly owner: string;
  readonly appId: number;
  readonly keySaved: string;
  readonly permissions: Permissions;
  readonly installations: readonly Installation[];
}

const appSettingsUrl = (app: App) =>
  `https://github.com/organizations/${app.owner}/settings/apps/${app.slug}`;
const installationUrl = (installation: Installation) =>
  `https://github.com/organizations/${installation.account}/settings/installations/${installation.id}`;
const newInstallationUrl = (app: App) =>
  `https://github.com/apps/${app.slug}/installations/new`;

const APPS: readonly App[] = [
  {
    id: "a1",
    role: "author",
    name: "werft-agent",
    slug: "werft-agent",
    owner: "acme",
    appId: 4242,
    keySaved: "키 2026.10.30 저장 · Owner",
    permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      actions: "write",
      issues: "write",
    },
    installations: [
      {
        id: 51001,
        account: "acme",
        selection: "selected",
        total: 37,
        approved: {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
          actions: "write",
          issues: "write",
        },
      },
    ],
  },
  {
    id: "a2",
    role: "author",
    name: "werft-agent-labs",
    slug: "werft-agent-labs",
    owner: "acme-labs",
    appId: 4250,
    keySaved: "키 2026.11.01 저장 · Owner",
    permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      actions: "write",
      workflows: "write",
    },
    installations: [
      {
        id: 51007,
        account: "acme-labs",
        selection: "all",
        total: 4,
        approved: {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
          actions: "write",
        },
      },
      {
        id: 51009,
        account: "acme-sandbox",
        selection: "selected",
        total: 2,
        approved: {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
          actions: "write",
          workflows: "write",
        },
      },
    ],
  },
  {
    id: "r1",
    role: "reviewer",
    name: "werft-reviewer",
    slug: "werft-reviewer",
    owner: "acme",
    appId: 4343,
    keySaved: "키 2026.10.31 저장 · Owner",
    permissions: { contents: "read", pull_requests: "write", metadata: "read" },
    installations: [
      {
        id: 51002,
        account: "acme",
        selection: "selected",
        total: 12,
        approved: {
          contents: "read",
          pull_requests: "write",
          metadata: "read",
        },
      },
    ],
  },
];

/** Edge states in one screen: a failed read, an unread approval, no installation. */
const EDGE_APPS: readonly App[] = APPS.map((app) => {
  if (app.id === "a2")
    return {
      ...app,
      installations: [
        {
          id: 51007,
          account: "acme-labs",
          selection: "all",
          total: null,
          approved: null,
          failure: "network",
        },
        ...app.installations.slice(1),
      ],
    };
  if (app.id === "r1") return { ...app, installations: [] };
  return app;
});

/** Resolved rows the author installations no longer reach (§1.1). */
const OUTSIDE = [
  {
    fullName: "acme/legacy-billing",
    branch: "main",
    agents: 1,
    installed: false,
  },
  {
    fullName: "acme-old/release-tools",
    branch: "master",
    agents: 0,
    installed: null,
  },
] as const;

const SAVED: Ceiling = { actions: true, workflows: false, review: true };
const AGENTS_USING: Record<Feature, number> = {
  actions: 2,
  workflows: 0,
  review: 1,
};
const PER_PAGE = 10;
// Shared by both repository tables so their branch buttons line up.
const REPO_COLUMNS = "minmax(0,1fr) 128px 104px";
const REPO_NARROW_COLUMNS = "minmax(0,1fr) 96px 72px";
const REPO_WORDS = [
  "api",
  "web",
  "infra",
  "docs",
  "billing",
  "mobile",
  "search",
  "auth",
  "data",
  "ops",
];

/** One page of an installation's repositories, as GitHub pages them. */
function repositoriesPage(
  role: Role,
  account: string,
  total: number,
  page: number,
) {
  const start = (page - 1) * PER_PAGE;
  return Array.from(
    { length: Math.max(0, Math.min(PER_PAGE, total - start)) },
    (_, offset) => {
      const index = start + offset;
      const word = REPO_WORDS[index % REPO_WORDS.length] ?? "repo";
      const round = Math.floor(index / REPO_WORDS.length);
      // Agents counted per role: the one review agent picks one repository.
      const agents =
        role === "reviewer" ? (index === 0 ? 1 : 0) : index < 3 ? 2 - index : 0;
      return {
        fullName: `${account}/${round ? `${word}-${round + 1}-service` : word}`,
        branch: index % 4 === 3 ? "develop" : "main",
        private: index % 3 !== 2,
        agents,
        resolved: index < 3,
      };
    },
  );
}

const META = "text-caption text-subtle-foreground";
const FEATURES: Record<
  Role,
  readonly (readonly [Feature | "base", string, string])[]
> = {
  author: [
    ["base", "PR 작성·수정", "clone, push, PR 열기·코멘트를 합니다."],
    [
      "actions",
      "Actions 실행",
      "에이전트 허용 목록의 워크플로를 실행하거나 다시 실행합니다.",
    ],
    [
      "workflows",
      "워크플로 파일 수정",
      ".github/workflows 아래 파일을 바꾼 commit도 push합니다.",
    ],
  ],
  reviewer: [
    [
      "review",
      "PR 리뷰 승인",
      "작성용 App이 연 PR에 코멘트·변경 요청·승인 리뷰를 남깁니다.",
    ],
  ],
};
const featuresOf = (role: Role) =>
  FEATURES[role].flatMap(([feature]) => (feature === "base" ? [] : [feature]));
const ROLE_TEXT: Record<Role, { title: string; hint: string; badge: string }> =
  {
    author: {
      title: "작성용 App",
      hint: "에이전트가 저장소를 clone하고, 승인된 결과를 push하고, PR을 열 때 쓰는 App입니다. 저장소를 고를 때 거친 설치의 App이 그 저장소의 토큰을 발급합니다.",
      badge: "작성용",
    },
    reviewer: {
      title: "리뷰 승인용 App",
      hint: "에이전트가 PR에 리뷰를 남길 때 쓰는 App입니다. GitHub는 PR을 연 App의 승인을 받지 않으므로 작성용과 다른 App이어야 합니다.",
      badge: "리뷰 승인용",
    },
  };

/** A tile as tall as the two lines beside it, and as wide. */
function TwoLineTile({ role }: { readonly role: Role }) {
  const Icon = role === "author" ? GitPullRequest : ShieldCheck;
  return (
    <span
      aria-hidden="true"
      data-slot="icon-tile"
      className={`grid size-10 shrink-0 place-items-center rounded-control text-(--ap-color-tile-foreground) ${
        role === "author"
          ? "bg-(--ap-color-tile-slate)"
          : "bg-(--ap-color-tile-blue)"
      }`}
    >
      <Icon aria-hidden="true" strokeWidth={2} className="size-4" />
    </span>
  );
}

function PermissionTable({
  app,
  installation,
  ceiling,
  saved,
}: {
  readonly app: App;
  readonly installation: Installation | undefined;
  readonly ceiling: Ceiling;
  readonly saved: Ceiling;
}) {
  const headingId = useId();
  const need = needOf(app.role, ceiling);
  const before = needOf(app.role, saved);
  const approved = installation?.approved ?? null;
  const names = new Set([
    ...Object.keys(need),
    ...Object.keys(app.permissions),
  ]);
  const rows = ROW_ORDER.filter((name) => names.has(name)).map((name) => {
    const needed = need[name] ?? null;
    const held = app.permissions[name] ?? null;
    const status = appStatusOf(app.role, name, needed, held);
    const approval = approvalOf(held, approved, name);
    return {
      name,
      needed,
      held,
      granted: approved?.[name] ?? null,
      status,
      approval,
      // The App's own gap comes first; an approval gap shows when the App is fine.
      badge:
        approval === "pending" && (status === "ok" || status === "unused")
          ? ("pending" as const)
          : status,
      changed: needed !== (before[name] ?? null),
    };
  });
  const changed = rows.filter((row) => row.changed);
  const level = (value: Level | null, absent = "없음") =>
    value === null ? (
      <span className="text-subtle-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{absent}</span>
      </span>
    ) : (
      LEVEL[value]
    );
  const short = (value: Level | null) => (value ? LEVEL[value] : "—");
  const grantedText = (row: (typeof rows)[number]) =>
    row.approval === "unknown" ? "확인 못 함" : short(row.granted);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 id={headingId} className="m-0 font-semibold text-control">
        권한<span className="sr-only"> — {app.name}</span>
      </h4>
      <GridTable
        aria-labelledby={headingId}
        columns="minmax(0,1fr) 56px 56px 56px 112px"
        narrowAt={480}
        narrowColumns="minmax(0,1fr) 112px"
        className="rounded-card border"
      >
        <GridTableHeader>
          <GridTableColumnHeader>권한</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>필요</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>App</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>설치</GridTableColumnHeader>
          <GridTableColumnHeader align="end">상태</GridTableColumnHeader>
        </GridTableHeader>
        {rows.map((row) => (
          <GridTableRow
            key={row.name}
            data-status={row.status}
            data-approval={row.approval}
            data-changed={row.changed || undefined}
            className={
              row.changed ? "bg-(color:--ap-tone-progress-bg)" : undefined
            }
          >
            <GridTableCell>
              <span className="flex min-w-0 flex-col">
                <span className="[overflow-wrap:anywhere]" title={row.name}>
                  {NAME[row.name] ?? row.name}
                  {row.changed ? (
                    <span className="sr-only"> (저장 전 변경)</span>
                  ) : null}
                </span>
                {/* Below 480px the need, App and installation columns fold here. */}
                <span
                  className={`[overflow-wrap:anywhere] [@container(width>=480px)]:hidden ${META}`}
                >
                  필요 {short(row.needed)} · App {short(row.held)} · 설치{" "}
                  {grantedText(row)}
                </span>
              </span>
            </GridTableCell>
            <GridTableCell hideNarrow>{level(row.needed)}</GridTableCell>
            <GridTableCell hideNarrow>{level(row.held)}</GridTableCell>
            <GridTableCell hideNarrow>
              {row.approval === "unknown" ? (
                level(null, "확인 못 함")
              ) : row.approval === "pending" ? (
                <span className="text-(color:--ap-tone-caution-fg)">
                  {short(row.granted)}
                  <span className="sr-only"> (승인 대기)</span>
                </span>
              ) : (
                level(row.granted)
              )}
            </GridTableCell>
            <GridTableCell align="end">
              <Badge variant={STATUS_TONE[row.badge]}>
                {STATUS_TEXT[row.badge]}
              </Badge>
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
      <output className={`m-0 block ${META}`}>
        {changed.length > 0
          ? `파란 줄은 저장하지 않은 기능 변경으로 바뀐 필요 권한입니다: ${changed
              .map(
                (row) => `${NAME[row.name] ?? row.name} ${short(row.needed)}`,
              )
              .join(", ")}.`
          : null}
      </output>
    </div>
  );
}

function BranchButton({
  fullName,
  branch,
}: {
  readonly fullName: string;
  readonly branch: string;
}) {
  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-1">
      <span className="truncate font-mono text-caption">{branch}</span>
      {/* -my-1 keeps the 28px control inside a text row's height. */}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`${fullName} 기본 브랜치 바꾸기`}
        className="-my-1 shrink-0"
      >
        <Pencil aria-hidden="true" className="size-3.5" />
      </Button>
    </span>
  );
}

const FAILURE_TEXT = {
  network: {
    title: "GitHub에서 저장소 목록을 받지 못했습니다",
    body: "잠시 뒤 다시 시도하세요. 저장된 설정과 에이전트 실행에는 영향이 없습니다.",
  },
  suspended: {
    title: "이 설치가 GitHub에서 중지됐습니다",
    body: "설치 관리에서 다시 켜기 전까지 이 계정 저장소의 요청이 거절됩니다.",
  },
} as const;

function Repositories({
  app,
  installation,
}: {
  readonly app: App;
  readonly installation: Installation;
}) {
  const account = installation.account;
  const [page, setPage] = useState(1);
  const headingId = useId();
  if (installation.total === null) {
    const text = FAILURE_TEXT[installation.failure ?? "network"];
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="m-0 font-semibold text-control">설치된 저장소</h4>
        <Alert variant="amber">
          <AlertTitle>{text.title}</AlertTitle>
          <AlertDescription>{text.body}</AlertDescription>
        </Alert>
        {installation.failure === "suspended" ? null : (
          <div>
            <Button type="button" size="sm" variant="outline">
              다시 시도
            </Button>
          </div>
        )}
      </div>
    );
  }
  const total = installation.total;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rows = repositoriesPage(app.role, account, total, page);
  const from = (page - 1) * PER_PAGE + 1;
  const label = `${app.name} · ${account}`;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 id={headingId} className="m-0 font-semibold text-control">
        설치된 저장소<span className="sr-only"> — {label}</span>
      </h4>
      {total === 0 ? (
        <p className={`m-0 ${META}`}>이 설치가 닿는 저장소가 없습니다.</p>
      ) : (
        <GridTable
          aria-labelledby={headingId}
          columns={REPO_COLUMNS}
          narrowAt={480}
          narrowColumns={REPO_NARROW_COLUMNS}
          className="rounded-card border"
        >
          <GridTableHeader>
            <GridTableColumnHeader>저장소</GridTableColumnHeader>
            <GridTableColumnHeader>기본 브랜치</GridTableColumnHeader>
            <GridTableColumnHeader align="end">
              고른 에이전트
            </GridTableColumnHeader>
          </GridTableHeader>
          {rows.map((row) => (
            <GridTableRow key={row.fullName}>
              <GridTableCell>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="[overflow-wrap:anywhere]">
                    {row.fullName}
                  </span>
                  {row.private ? (
                    <Lock
                      aria-label="비공개"
                      className="size-3.5 shrink-0 text-subtle-foreground"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </span>
              </GridTableCell>
              <GridTableCell>
                {/* Only a row an agent already picked holds its own branch. */}
                {row.resolved ? (
                  <BranchButton fullName={row.fullName} branch={row.branch} />
                ) : (
                  <span className="flex h-5 min-w-0 items-center">
                    <span className="truncate font-mono text-caption">
                      {row.branch}
                    </span>
                  </span>
                )}
              </GridTableCell>
              <GridTableCell align="end">
                {row.agents ? `${row.agents}개` : "—"}
              </GridTableCell>
            </GridTableRow>
          ))}
        </GridTable>
      )}
      {total > 0 ? (
        <nav
          aria-label={`${label} 저장소 페이지`}
          className="flex items-center justify-between gap-2"
        >
          <span className={META} aria-live="polite">
            {from}–{from + rows.length - 1} / {total}
          </span>
          {pages > 1 ? (
            <span className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`${label} 이전 페이지`}
                aria-disabled={page === 1 || undefined}
                className="aria-disabled:opacity-45"
                onClick={() => setPage((was) => Math.max(1, was - 1))}
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
              </Button>
              <span className={`${META} min-w-12 text-center`}>
                {page} / {pages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`${label} 다음 페이지`}
                aria-disabled={page === pages || undefined}
                className="aria-disabled:opacity-45"
                onClick={() => setPage((was) => Math.min(pages, was + 1))}
              >
                <ChevronRight aria-hidden="true" className="size-4" />
              </Button>
            </span>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function AppCard({
  app,
  ceiling,
  saved,
  member,
}: {
  readonly app: App;
  readonly ceiling: Ceiling;
  readonly saved: Ceiling;
  readonly member: boolean;
}) {
  const titleId = useId();
  const [selected, setSelected] = useState(
    String(app.installations[0]?.id ?? ""),
  );
  const installation =
    app.installations.find((one) => String(one.id) === selected) ??
    app.installations[0];
  const lackingUnder = (under: Ceiling) =>
    Object.entries(needOf(app.role, under)).filter(([name, level]) => {
      const held = app.permissions[name];
      return held === undefined || RANK[held] < RANK[level];
    });
  const lacking = lackingUnder(ceiling);
  const lackingNow = lackingUnder(saved).length > 0;
  return (
    <Card flush role="region" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <TwoLineTile role={app.role} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle
                id={titleId}
                role="heading"
                aria-level={3}
                className="min-w-0 truncate"
              >
                {app.name}
              </CardTitle>
              <Badge className="shrink-0">{ROLE_TEXT[app.role].badge}</Badge>
              <Badge variant="green" className="shrink-0">
                키 확인됨
              </Badge>
            </div>
            <span className={`truncate ${META}`}>
              App ID {app.appId}
              {member ? "" : ` · ${app.keySaved}`}
            </span>
          </div>
        </div>
        {member ? null : (
          <div className="ml-13 flex shrink-0 items-center gap-3 sm:ml-0">
            <Link
              href={appSettingsUrl(app)}
              target="_blank"
              newTabLabel="새 탭에서 열림"
            >
              GitHub에서 App 설정
            </Link>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`${app.name} 키 교체`}
            >
              키 교체
            </Button>
          </div>
        )}
      </div>
      {lacking.length > 0 ? (
        <div className="px-4 pb-2">
          <Alert variant="amber">
            <AlertTitle>
              이 App에{" "}
              {lacking
                .map(([name, level]) => `${NAME[name] ?? name} ${LEVEL[level]}`)
                .join(", ")}{" "}
              권한이 없습니다
            </AlertTitle>
            <AlertDescription>
              {lackingNow
                ? "켠 기능의 요청을 GitHub가 거절합니다."
                : "이대로 저장하면 켠 기능의 요청을 GitHub가 거절합니다."}{" "}
              GitHub의 App 설정에서 권한을 더하고, 설치마다 변경을 승인하세요.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="flex flex-col gap-4 border-t p-4">
        {installation ? (
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              {app.installations.length > 1 ? (
                <SegmentedControl
                  aria-label={`${app.name} 설치된 GitHub 계정`}
                  value={String(installation.id)}
                  onValueChange={setSelected}
                >
                  {app.installations.map((one) => (
                    <SegmentedControlItem
                      key={one.id}
                      value={String(one.id)}
                      count={one.total ?? undefined}
                    >
                      {one.account}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              ) : (
                <span className="font-medium text-control">
                  {installation.account}
                </span>
              )}
              {member || installation.total === null ? null : (
                <span className={META}>
                  {installation.selection === "all"
                    ? "모든 저장소"
                    : "선택한 저장소"}{" "}
                  {installation.total}개
                </span>
              )}
              {pendingOf(app, installation) ? (
                <Badge variant="amber">권한 변경 승인 대기</Badge>
              ) : null}
            </div>
            {member ? null : (
              <Link
                href={installationUrl(installation)}
                target="_blank"
                newTabLabel="새 탭에서 열림"
              >
                GitHub에서 설치 관리
              </Link>
            )}
          </div>
        ) : (
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className={META}>
              이 App을 설치한 GitHub 계정이 없습니다. 설치 승인 칸은 설치 뒤에
              채워집니다.
            </span>
            {member ? null : (
              <Link
                href={newInstallationUrl(app)}
                target="_blank"
                newTabLabel="새 탭에서 열림"
              >
                GitHub에서 설치
              </Link>
            )}
          </div>
        )}
        {/* Stacked, so repository names get the card's full width. */}
        <div className="flex flex-col gap-6">
          <PermissionTable
            app={app}
            installation={installation}
            ceiling={ceiling}
            saved={saved}
          />
          {installation && !member ? (
            <Repositories
              key={installation.id}
              app={app}
              installation={installation}
            />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function OutsideRepositories() {
  const headingId = useId();
  return (
    <Card flush role="region" aria-labelledby={headingId}>
      <div className="flex flex-col gap-0.5 p-4">
        <CardTitle id={headingId} role="heading" aria-level={3}>
          설치 밖 저장소
        </CardTitle>
        <CardDescription className="text-description">
          에이전트가 고른 적 있지만 지금 어느 작성용 설치도 닿지 않는
          저장소입니다. 이 저장소를 쓰는 에이전트의 GitHub 요청은 거절됩니다.
        </CardDescription>
      </div>
      <div className="border-t p-4">
        <GridTable
          aria-labelledby={headingId}
          columns={REPO_COLUMNS}
          narrowAt={480}
          narrowColumns={REPO_NARROW_COLUMNS}
          className="rounded-card border"
        >
          <GridTableHeader>
            <GridTableColumnHeader>저장소</GridTableColumnHeader>
            <GridTableColumnHeader>기본 브랜치</GridTableColumnHeader>
            <GridTableColumnHeader align="end">
              고른 에이전트
            </GridTableColumnHeader>
          </GridTableHeader>
          {OUTSIDE.map((row) => (
            <GridTableRow key={row.fullName}>
              <GridTableCell>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <span className="[overflow-wrap:anywhere]">
                    {row.fullName}
                  </span>
                  {row.installed === null ? (
                    <Badge variant="gray">확인 안 됨</Badge>
                  ) : (
                    <Badge variant="amber">설치 밖</Badge>
                  )}
                </span>
              </GridTableCell>
              <GridTableCell>
                <BranchButton fullName={row.fullName} branch={row.branch} />
              </GridTableCell>
              <GridTableCell align="end">
                {row.agents ? `${row.agents}개` : "—"}
              </GridTableCell>
            </GridTableRow>
          ))}
        </GridTable>
      </div>
    </Card>
  );
}

function RoleSection({
  appRole: role,
  apps,
  ceiling,
  saved,
  member,
  onToggle,
  onRevert,
  onSave,
}: {
  readonly appRole: Role;
  readonly apps: readonly App[];
  readonly ceiling: Ceiling;
  readonly saved: Ceiling;
  readonly member: boolean;
  readonly onToggle: (feature: Feature, on: boolean) => void;
  readonly onRevert: (role: Role) => void;
  readonly onSave: (role: Role) => void;
}) {
  const headingId = useId();
  const own = apps.filter((app) => app.role === role);
  const changed = featuresOf(role).filter(
    (feature) => ceiling[feature] !== saved[feature],
  );
  const lowered = changed.filter(
    (feature) => saved[feature] && AGENTS_USING[feature] > 0,
  );
  const title = (feature: Feature) =>
    FEATURES[role].find(([one]) => one === feature)?.[1] ?? feature;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="m-0 font-semibold text-body leading-5">
          {ROLE_TEXT[role].title}
        </h2>
        <p className={`m-0 max-w-[72ch] ${META}`}>{ROLE_TEXT[role].hint}</p>
      </div>
      <Card flush>
        <RowList
          variant="joined"
          className="rounded-none border-0 bg-transparent"
          aria-label={`${ROLE_TEXT[role].title}로 켤 수 있는 기능`}
        >
          {FEATURES[role].map(([feature, title, hint]) =>
            feature === "base" ? (
              <SettingRow
                key={feature}
                title={title}
                badge={<Badge>기본</Badge>}
                description={hint}
                meta={<div className={META}>GitHub를 쓰는 에이전트 모두</div>}
                actions={
                  <div className={`${META} min-w-14 text-right`}>항상 켜짐</div>
                }
              />
            ) : (
              <SettingRow
                key={feature}
                title={title}
                badge={
                  ceiling[feature] !== saved[feature] ? (
                    <Badge variant="blue">저장 전</Badge>
                  ) : undefined
                }
                description={hint}
                meta={
                  <div className={META}>
                    활성 릴리스에서 켠 에이전트 {AGENTS_USING[feature]}개
                  </div>
                }
                status={
                  <div
                    aria-hidden="true"
                    className={`${META} min-w-14 text-right`}
                  >
                    {ceiling[feature] ? "허용" : "허용 안 함"}
                  </div>
                }
                control={
                  <Switch
                    aria-label={title}
                    checked={ceiling[feature]}
                    disabled={member}
                    onCheckedChange={(on) => onToggle(feature, on)}
                  />
                }
              />
            ),
          )}
        </RowList>
        {changed.length > 0 && !member ? (
          <CardFooter variant="form">
            <div className={META}>
              {ROLE_TEXT[role].title} 기능 {changed.length}개를 바꿉니다.
              저장하면 아래 표의 필요 권한이 이대로 적용되고 변경 기록에
              남습니다.
              {lowered.length > 0
                ? ` 끄는 기능을 켠 에이전트(${lowered
                    .map(
                      (feature) =>
                        `${title(feature)} ${AGENTS_USING[feature]}개`,
                    )
                    .join(", ")})의 다음 GitHub 요청부터 거절됩니다.`
                : ""}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onRevert(role)}
              >
                되돌리기
              </Button>
              <Button type="button" size="sm" onClick={() => onSave(role)}>
                저장
              </Button>
            </div>
          </CardFooter>
        ) : null}
      </Card>
      {own.map((app) => (
        <AppCard
          key={app.id}
          app={app}
          ceiling={ceiling}
          saved={saved}
          member={member}
        />
      ))}
      {role === "author" && !member ? <OutsideRepositories /> : null}
    </section>
  );
}

function AddAppDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const appIdId = useId();
  const keyId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>GitHub App 추가</DialogTitle>
          <DialogDescription>
            GitHub에서 만든 App의 ID와 private key를 넣습니다. 저장하면 GitHub에
            물어 App 이름·권한·설치를 읽습니다.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onOpenChange(false);
          }}
        >
          <Field>
            <FieldLabel>용도</FieldLabel>
            <RadioGroup defaultValue="author" aria-label="용도">
              <div className="flex items-start gap-2">
                <RadioGroupItem id={`${keyId}-author`} value="author" />
                <label htmlFor={`${keyId}-author`} className="flex flex-col">
                  <span>작성용</span>
                  <span className={META}>
                    clone·push·PR. 다른 GitHub 계정에 설치한 App을 더할 때.
                  </span>
                </label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem id={`${keyId}-reviewer`} value="reviewer" />
                <label htmlFor={`${keyId}-reviewer`} className="flex flex-col">
                  <span>리뷰 승인용</span>
                  <span className={META}>작성용과 다른 App이어야 합니다.</span>
                </label>
              </div>
            </RadioGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor={appIdId}>App ID</FieldLabel>
            <Input id={appIdId} className="max-w-80" inputMode="numeric" />
            <FieldDescription>
              GitHub의 App 설정 첫 화면 About에 있는 숫자입니다.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={keyId}>Private key (.pem)</FieldLabel>
            <Input id={keyId} type="file" accept=".pem" className="max-w-105" />
            <FieldDescription>
              암호화해 저장하고 다시 보여 주지 않습니다.
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              취소
            </Button>
            <Button type="submit">추가</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const pick = (from: Ceiling, role: Role) =>
  Object.fromEntries(
    featuresOf(role).map((feature) => [feature, from[feature]]),
  );

function GitHubSettingsScreen({
  draft,
  adding,
  member,
  apps,
}: {
  readonly draft: Partial<Ceiling>;
  readonly adding: boolean;
  readonly member: boolean;
  readonly apps: readonly App[];
}) {
  const [saved, setSaved] = useState<Ceiling>(SAVED);
  const [ceiling, setCeiling] = useState<Ceiling>({ ...SAVED, ...draft });
  const [dialog, setDialog] = useState(adding);
  const toggle = (feature: Feature, on: boolean) =>
    setCeiling((was) => ({ ...was, [feature]: on }));
  // Each role saves and reverts only its own switches; checks and issues
  // ride along unchanged in the PUT body.
  const revert = (role: Role) =>
    setCeiling((was) => ({ ...was, ...pick(saved, role) }));
  const save = (role: Role) =>
    setSaved((was) => ({ ...was, ...pick(ceiling, role) }));
  const roleProps = {
    apps,
    ceiling,
    saved,
    member,
    onToggle: toggle,
    onRevert: revert,
    onSave: save,
  };
  return (
    <Shell>
      <SideNavLayout
        nav={
          <SideNav aria-label="설정" current="GitHub 연결 설정">
            <SideNavGroup label="워크스페이스">
              {[
                "일반",
                "Slack 연결 설정",
                "GitHub 연결 설정",
                "조직 관리 키",
              ].map((label) => (
                <SideNavLink
                  key={label}
                  href="#nav"
                  current={label === "GitHub 연결 설정"}
                >
                  {label}
                </SideNavLink>
              ))}
            </SideNavGroup>
          </SideNav>
        }
      >
        <Page
          title="GitHub 연결 설정"
          description={
            member
              ? "에이전트가 GitHub 저장소에 쓰는 App과 워크스페이스가 허용한 기능입니다. 소유자와 관리자가 바꿀 수 있습니다."
              : "에이전트가 GitHub 저장소에 쓰는 App, 워크스페이스가 허용하는 기능, App마다의 권한과 설치된 저장소입니다."
          }
          actions={
            member ? undefined : (
              <Button type="button" size="sm" onClick={() => setDialog(true)}>
                <Plus aria-hidden="true" className="size-4" />
                App 추가
              </Button>
            )
          }
        >
          <div className="flex flex-col gap-10">
            <RoleSection appRole="author" {...roleProps} />
            <RoleSection appRole="reviewer" {...roleProps} />
            {member ? null : (
              <Card flush role="region" aria-label="구성원 계정 연결">
                <div className="flex flex-col gap-0.5 p-4">
                  <CardTitle role="heading" aria-level={2}>
                    구성원 계정 연결
                  </CardTitle>
                  <CardDescription className="text-description">
                    구성원이 자기 GitHub 계정을 연결하면, 그 사람이 시작한
                    세션의 commit에 공동 작성자로 이름이 들어갑니다.
                    werft-agent의 사용자 인증을 씁니다.
                  </CardDescription>
                </div>
                <RowList
                  variant="joined"
                  className="rounded-none border-x-0 border-b-0 bg-transparent"
                >
                  <SettingRow
                    title="Client ID"
                    description={<code>Iv23lifake</code>}
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label="Client ID 복사"
                      >
                        복사
                      </Button>
                    }
                  />
                  <SettingRow
                    title="Callback URL"
                    description={
                      <code className="block truncate">
                        https://console.example.test/settings/linked-accounts/github
                      </code>
                    }
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label="Callback URL 복사"
                      >
                        복사
                      </Button>
                    }
                  />
                  <SettingRow
                    title="Client secret"
                    badge={<Badge variant="green">입력됨</Badge>}
                    description="암호화해 저장합니다."
                    actions={
                      <Button type="button" size="sm" variant="outline">
                        교체
                      </Button>
                    }
                  />
                </RowList>
              </Card>
            )}
            {member ? null : (
              <DangerZone title="위험 구역">
                {apps.map((app) => (
                  <DangerZoneRow
                    key={app.id}
                    title={`${app.name} 연결 해제`}
                    description="다시 추가할 때까지 이 App으로 고른 저장소의 요청과 진행 중 세션의 GitHub 요청이 거절됩니다. GitHub의 App과 설치는 그대로 남습니다."
                    actionLabel="연결 해제"
                    actionName={`${app.name} 연결 해제`}
                    onAction={() => {}}
                  />
                ))}
              </DangerZone>
            )}
          </div>
        </Page>
      </SideNavLayout>
      <AddAppDialog open={dialog} onOpenChange={setDialog} />
    </Shell>
  );
}

const NAV = ["홈", "세션", "에이전트"];
const WORKSPACE_NAV = ["실행 프로필", "사용량·한도", "구성원", "설정"];

/** The console's sidebar and top bar around the page, as AppShell draws them. */
function Shell({ children }: { readonly children: ReactNode }) {
  const item = (label: string) => (
    <Button
      key={label}
      asChild
      variant={label === "설정" ? "secondary" : "ghost"}
      className="w-full justify-start"
    >
      <a href="#nav" aria-current={label === "설정" ? "page" : undefined}>
        {label}
      </a>
    </Button>
  );
  return (
    <div className="flex min-h-screen text-body">
      <nav
        aria-label="사이드바"
        className="hidden w-[236px] flex-none flex-col gap-1 p-2 md:flex"
      >
        <Card className="flex flex-col gap-1 p-2">
          {NAV.map(item)}
          <p className="m-0 px-3 pt-4 text-caption text-muted-foreground">
            워크스페이스
          </p>
          {WORKSPACE_NAV.map(item)}
        </Card>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 w-full items-center gap-2 px-4 md:px-6">
          <p className="m-0 text-muted-foreground">
            워크스페이스 설정 › GitHub 연결 설정
          </p>
        </header>
        <main className="flex w-full flex-1 flex-col">
          <PageFrame className="flex-1">{children}</PageFrame>
        </main>
      </div>
    </div>
  );
}

const meta = {
  title: "Screens/Workspace GitHub v2 (GHUI-design)",
  component: GitHubSettingsScreen,
  parameters: { layout: "fullscreen" },
  args: { draft: {}, adding: false, member: false, apps: APPS },
} satisfies Meta<typeof GitHubSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = { name: "Saved" };
export const WorkflowsTurnedOn: Story = {
  name: "Workflows on, not saved",
  args: { draft: { workflows: true } },
};
export const AddApp: Story = {
  name: "Add App dialog",
  args: { adding: true },
};
export const EdgeStates: Story = {
  name: "Read failed, approval unread, no installation",
  args: { apps: EDGE_APPS },
};
export const Member: Story = {
  name: "Member (read only)",
  args: { member: true },
};
export const SavedDark: Story = {
  name: "Saved (dark)",
  globals: { theme: "dark" },
};
export const SavedMobile: Story = { name: "Saved (390px)", globals: MOBILE };

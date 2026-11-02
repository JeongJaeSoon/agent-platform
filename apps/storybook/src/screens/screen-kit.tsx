import {
  Avatar,
  Button,
  DisabledReason,
  IconTile,
  PageFrame,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Text,
  type TileHue,
  type TileIcon,
} from "@werft-ai/ui";
import {
  Bell,
  Bot,
  ChevronDown,
  Gauge,
  Globe,
  House,
  KeyRound,
  Link as LinkIcon,
  List,
  LogOut,
  Moon,
  Settings,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

/*
 * Stand-in for apps/web's authed shell (routes/layout.tsx,
 * components/app-sidebar.tsx): the workspace line, the work and workspace
 * groups, the account menu with the personal settings, the top bar's trail
 * and, on a settings page, the settings nav beside the page
 * (components/settings-nav.tsx). Words are apps/web's Korean catalog; the
 * kit has no messages of its own.
 */

export type NavKey =
  | "home"
  | "sessions"
  | "agents"
  | "profiles"
  | "operations"
  | "members"
  | "settings";

export type Role = "owner" | "admin" | "member";

interface NavEntry {
  readonly key: NavKey;
  readonly label: string;
  readonly icon: TileIcon;
  readonly hue: TileHue;
}

const WORK_NAV: readonly NavEntry[] = [
  { key: "home", label: "홈", icon: House, hue: "blue" },
  { key: "sessions", label: "세션", icon: List, hue: "violet" },
  { key: "agents", label: "에이전트", icon: Bot, hue: "orange" },
];
const WORKSPACE_NAV: readonly NavEntry[] = [
  {
    key: "profiles",
    label: "실행 프로필",
    icon: SlidersHorizontal,
    hue: "teal",
  },
  { key: "operations", label: "사용량·한도", icon: Gauge, hue: "pink" },
  { key: "members", label: "구성원", icon: Users, hue: "green" },
  { key: "settings", label: "설정", icon: Settings, hue: "slate" },
];

const ROLE_LABEL: Record<Role, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
};

// Members and settings are the managers' (useNavGroups).
function workspaceNav(role: Role) {
  return role === "member"
    ? WORKSPACE_NAV.filter(
        (entry) => entry.key !== "members" && entry.key !== "settings",
      )
    : WORKSPACE_NAV;
}

function NavLink({
  entry,
  current,
}: {
  readonly entry: NavEntry;
  readonly current: boolean;
}) {
  return (
    <a
      href="#nav"
      aria-current={current ? "page" : undefined}
      className="flex h-8 items-center gap-2 rounded-control px-2 font-medium text-control text-foreground no-underline hover:bg-sidebar-hover aria-[current=page]:bg-sidebar-accent"
    >
      <IconTile icon={entry.icon} hue={entry.hue} />
      <Text as="span" truncate className="min-w-0 flex-1">
        {entry.label}
      </Text>
    </a>
  );
}

function NavGroup({
  label,
  entries,
  current,
  headingHidden = false,
}: {
  readonly label: string;
  readonly entries: readonly NavEntry[];
  readonly current: NavKey;
  readonly headingHidden?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, these are links
    <div role="group" aria-label={label} className="flex flex-col">
      {headingHidden ? null : (
        <Text
          as="span"
          variant="meta"
          className="mt-2 mb-0.5 flex h-6 items-center gap-1 px-2"
        >
          {label}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Text>
      )}
      {entries.map((entry) => (
        <NavLink
          key={entry.key}
          entry={entry}
          current={current === entry.key}
        />
      ))}
    </div>
  );
}

const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-control text-popover-foreground no-underline hover:bg-muted";
const MENU_ICON = "size-4 shrink-0 text-muted-foreground";

/** The account pill and its menu: the personal settings live here. */
function UserBar({ role }: { readonly role: Role }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t pt-2">
      <Popover>
        <PopoverTrigger asChild>
          {/* No aria-label: the name begins with the visible text (WCAG 2.5.3). */}
          <button
            type="button"
            className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full px-2 py-1 text-left hover:bg-sidebar-hover aria-expanded:bg-sidebar-accent"
          >
            <Avatar
              initials="김"
              className="bg-sidebar-accent text-foreground"
            />
            <Text as="span" className="flex min-w-0 flex-col">
              <Text as="span" weight="medium" truncate>
                김민지
              </Text>{" "}
              <Text as="span" variant="meta" truncate>
                minji@acme.example
              </Text>
            </Text>
            <Text as="span" className="sr-only">
              {" "}
              · {ROLE_LABEL[role]}
            </Text>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          <a href="#nav" className={MENU_ITEM}>
            <LinkIcon aria-hidden="true" className={MENU_ICON} />
            연동 계정
          </a>
          <button type="button" className={MENU_ITEM}>
            <Globe aria-hidden="true" className={MENU_ICON} />
            언어
            <Text as="span" variant="meta" className="ml-auto">
              한국어
            </Text>
          </button>
          <button type="button" className={MENU_ITEM}>
            <Moon aria-hidden="true" className={MENU_ICON} />
            테마
            <Text as="span" variant="meta" className="ml-auto">
              시스템 설정
            </Text>
          </button>
          <a href="#nav" className={MENU_ITEM}>
            <KeyRound aria-hidden="true" className={MENU_ICON} />
            API 키
          </a>
          <hr className="-mx-1 my-1 border-0 border-t" />
          <button type="button" className={MENU_ITEM}>
            <LogOut aria-hidden="true" className={MENU_ICON} />
            로그아웃
          </button>
        </PopoverContent>
      </Popover>
      <a
        href="#nav"
        aria-label="답변 대기 없음"
        className="grid size-8 shrink-0 place-items-center rounded-control text-muted-foreground hover:bg-sidebar-hover"
      >
        <Bell aria-hidden="true" className="size-4" />
      </a>
    </div>
  );
}

export type SettingsKey =
  | "general"
  | "slack"
  | "github"
  | "workspaceApiKeys"
  | "linkedAccounts"
  | "apiKeys"
  | "preferences";

const SETTINGS_LABEL: Record<SettingsKey, string> = {
  general: "일반",
  slack: "Slack 연결 설정",
  github: "GitHub 연결 설정",
  workspaceApiKeys: "조직 관리 키",
  linkedAccounts: "연동 계정",
  apiKeys: "API 키",
  preferences: "언어·테마",
};
const WORKSPACE_SETTINGS: readonly SettingsKey[] = [
  "general",
  "slack",
  "github",
  "workspaceApiKeys",
];
const PERSONAL_SETTINGS: readonly SettingsKey[] = [
  "linkedAccounts",
  "apiKeys",
  "preferences",
];

/** components/settings-nav.tsx: the settings nav beside a settings page. */
function SettingsLayout({
  current,
  role,
  children,
}: {
  readonly current: SettingsKey;
  readonly role: Role;
  readonly children: ReactNode;
}) {
  const groups: (readonly [string, readonly SettingsKey[]])[] = [
    ["워크스페이스", role === "member" ? [] : WORKSPACE_SETTINGS],
    ["내 설정", PERSONAL_SETTINGS],
  ];
  // A page the reader has no item for (a member on 일반) marks none.
  const listed = groups.some(([, keys]) => keys.includes(current));
  return (
    <SideNavLayout
      nav={
        <SideNav
          aria-label="설정"
          current={listed ? SETTINGS_LABEL[current] : undefined}
        >
          {groups
            .filter(([, keys]) => keys.length > 0)
            .map(([label, keys]) => (
              <SideNavGroup key={label} label={label}>
                {keys.map((key) => (
                  <SideNavLink key={key} href="#nav" current={key === current}>
                    {SETTINGS_LABEL[key]}
                  </SideNavLink>
                ))}
              </SideNavGroup>
            ))}
        </SideNav>
      }
    >
      {children}
    </SideNavLayout>
  );
}

/**
 * The top bar's trail (layout.tsx PageTrail): a screen under a sidebar item
 * leads with the item as a link back to its list.
 */
function Trail({ crumb }: { readonly crumb: readonly string[] }) {
  const leaf = crumb.at(-1) ?? "";
  const parents = crumb.slice(0, -1);
  return (
    <Text
      as="div"
      variant="meta"
      className="flex min-w-0 items-center gap-2 whitespace-nowrap text-control"
    >
      {parents.flatMap((label) => [
        <a
          key={label}
          href="#nav"
          className="shrink-0 text-subtle-foreground no-underline hover:text-foreground"
        >
          {label}
        </a>,
        <Text
          key={`${label}/`}
          as="span"
          aria-hidden="true"
          className="text-border-strong"
        >
          /
        </Text>,
      ])}
      <Text as="span" weight="medium" truncate className="min-w-0">
        {leaf}
      </Text>
    </Text>
  );
}

/**
 * Every screen sits in the console's `PageFrame` (V4-PAGE-FRAME) except a
 * session's detail, which lays out its rail and body itself: `flush`. A
 * settings page names its item in `settings` and gets the settings nav.
 */
export function ScreenShell({
  current,
  crumb,
  role = "owner",
  flush = false,
  settings,
  children,
}: {
  readonly current: NavKey;
  readonly crumb: readonly string[];
  readonly role?: Role;
  readonly flush?: boolean;
  readonly settings?: SettingsKey | undefined;
  readonly children: ReactNode;
}) {
  return (
    // apps/web styles.css breaks Korean between words on the body.
    <div className="flex min-h-screen flex-col break-keep text-body wrap-break-word md:grid md:grid-cols-[var(--ap-layout-sidebar-width)_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
      <header className="flex min-h-[var(--ap-topbar-h)] items-center gap-3 border-b bg-surface px-4 md:col-start-2 md:row-start-1 md:px-6">
        <Button type="button" variant="outline" size="sm" className="md:hidden">
          메뉴 열기
        </Button>
        <Trail crumb={crumb} />
      </header>
      <div className="hidden flex-col gap-2 border-r bg-sidebar px-2 py-3 pt-0 text-foreground md:col-start-1 md:row-span-2 md:row-start-1 md:flex md:h-dvh md:sticky md:top-0">
        <div className="-mx-2 flex h-[var(--ap-topbar-h)] shrink-0 items-center gap-2 border-b px-4">
          <Avatar
            initials="A"
            shape="square"
            className="bg-primary text-primary-foreground"
          />
          <Text truncate>
            <Text as="span" weight="medium" className="font-semibold">
              Acme
            </Text>
            <Text as="span" variant="sub">
              {" · "}Agent Platform
            </Text>
          </Text>
        </div>
        <nav
          aria-label="주요 메뉴"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
        >
          <NavGroup
            label="업무"
            entries={WORK_NAV}
            current={current}
            headingHidden
          />
          <NavGroup
            label="워크스페이스"
            entries={workspaceNav(role)}
            current={current}
          />
        </nav>
        <UserBar role={role} />
      </div>
      {flush ? (
        <main className="flex w-full min-w-0 flex-1 flex-col bg-surface md:col-start-2 md:row-start-2">
          <div
            data-slot="page-flush"
            className="flex w-full min-w-0 flex-1 flex-col"
          >
            {children}
          </div>
        </main>
      ) : (
        <main className="flex w-full min-w-0 flex-1 flex-col bg-surface md:col-start-2 md:row-start-2">
          <PageFrame className="flex-1">
            {settings === undefined ? (
              children
            ) : (
              <SettingsLayout current={settings} role={role}>
                {children}
              </SettingsLayout>
            )}
          </PageFrame>
        </main>
      )}
    </div>
  );
}

/**
 * A withheld action: the disabled button stays in line with its row and says
 * why on hover or focus, above it, as the members table does.
 */
export function LockedButton({
  label,
  reason,
  size = "sm",
}: {
  readonly label: string;
  readonly reason: string;
  readonly size?: "sm" | "default";
}) {
  return (
    <DisabledReason reason={reason} label={label}>
      <Button type="button" variant="outline" size={size} disabled={true}>
        {label}
      </Button>
    </DisabledReason>
  );
}

export const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

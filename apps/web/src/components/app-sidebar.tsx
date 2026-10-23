import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { waitingSessionsQuery } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import { Badge, cn } from "@werft-ai/ui";
import {
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  House,
  KeyRound,
  Link as LinkIcon,
  List,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  Settings,
  Sun,
  Users,
  UsersRound,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useCan, useHasPermission, useMe, useRole } from "../auth/guard.tsx";
import {
  isMessageKey,
  LOCALE_NAMES,
  LOCALES,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";
import { MAIN_CONTENT_ID } from "./main.tsx";
import { chooseTheme, THEMES, type Theme, useTheme } from "./theme.ts";

type NavPath =
  | "/"
  | "/sessions"
  | "/agents"
  | "/members"
  | "/teams"
  | "/settings/workspace"
  | "/settings/linked-accounts"
  | "/settings/api-keys"
  | "/settings/preferences";

export interface NavItem {
  readonly to: NavPath;
  readonly label: MessageKey;
  readonly icon: LucideIcon;
}

export interface NavGroup {
  readonly label: MessageKey;
  readonly items: readonly NavItem[];
}

export function useNavGroups(): readonly NavGroup[] {
  const managesMembers = useHasPermission("member.manage");
  const workspaceManage = useHasPermission("workspace.manage");
  const retentionManage = useHasPermission("audit_retention.manage");
  const showsWorkspaceSettings = workspaceManage || retentionManage;
  const groups: NavGroup[] = [
    {
      label: "shell.group.work",
      items: [
        { to: "/", label: "nav.home", icon: House },
        { to: "/sessions", label: "nav.sessions", icon: List },
        { to: "/agents", label: "nav.agents", icon: Bot },
      ],
    },
    {
      label: "shell.group.workspace",
      items: [
        ...(managesMembers
          ? [{ to: "/members", label: "nav.members", icon: Users } as const]
          : []),
        { to: "/teams", label: "nav.teams", icon: UsersRound },
        ...(showsWorkspaceSettings
          ? [
              {
                to: "/settings/workspace",
                label: "nav.workspace",
                icon: Settings,
              } as const,
            ]
          : []),
      ],
    },
    {
      label: "shell.group.personal",
      items: [
        {
          to: "/settings/linked-accounts",
          label: "nav.linkedAccounts",
          icon: LinkIcon,
        },
        { to: "/settings/api-keys", label: "nav.apiKeys", icon: KeyRound },
        { to: "/settings/preferences", label: "nav.preferences", icon: Globe },
      ],
    },
  ];
  return groups;
}

export function navItemFor(
  groups: readonly NavGroup[],
  pathname: string,
): { group: NavGroup; item: NavItem } | undefined {
  for (const group of groups) {
    for (const item of group.items) {
      const match =
        item.to === "/"
          ? pathname === "/"
          : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (match) return { group, item };
    }
  }
  return undefined;
}

function useWaitingSessions() {
  const { client } = useAgentPlatform();
  const canRead = useCan("sessions:read");
  return useQuery({
    ...waitingSessionsQuery(client),
    select: (page) => ({
      count: page.items.length,
      more: page.next_cursor !== null,
    }),
    enabled: canRead,
  });
}

function WaitingBadge() {
  const { t } = useI18n();
  const waiting = useWaitingSessions().data;
  if (!waiting || waiting.count === 0) return null;
  const { count, more } = waiting;
  return (
    <>
      <Badge variant="amber" className="ml-auto" aria-hidden="true">
        {more ? `${count}+` : count}
      </Badge>
      <span className="sr-only">
        {t(more ? "shell.waitingMore" : "shell.waiting", { count })}
      </span>
    </>
  );
}

export function AppSidebar({
  id,
  openBelowMd,
  groups,
  onNavigate,
  logout,
}: {
  readonly id: string;
  readonly openBelowMd: boolean;
  readonly groups: readonly NavGroup[];
  readonly onNavigate: () => void;
  readonly logout: { readonly pending: boolean; readonly run: () => void };
}) {
  const { t } = useI18n();
  const me = useMe();
  return (
    <div
      id={id}
      data-slot="app-sidebar"
      data-open={openBelowMd}
      // Only the nav scrolls, so the user block stays in view at any height;
      // below md the open menu is capped to the screen under the header.
      // z-10: the language submenu opens past the sidebar, over the page.
      className="hidden max-h-[calc(100dvh-var(--ap-topbar-h))] flex-col gap-2 border-b bg-sidebar px-2 py-3 text-foreground data-[open=true]:flex md:sticky md:top-0 md:z-10 md:col-start-1 md:row-span-2 md:row-start-1 md:flex md:h-dvh md:max-h-none md:border-r md:border-b-0"
    >
      <div className="hidden h-11 shrink-0 flex-col justify-center px-2 md:flex">
        <p className="m-0 truncate font-semibold text-control leading-5">
          {t("common.appName")}
        </p>
        {me?.workspace ? (
          <p className="m-0 truncate text-caption text-muted-foreground leading-5">
            {me.workspace.name}
          </p>
        ) : null}
      </div>
      <nav
        aria-label={t("nav.label")}
        className="-mx-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2"
      >
        {groups.map((group, index) => (
          <NavSection
            key={group.label}
            group={group}
            // The work group leads the rail unlabelled on screen (console
            // v35); the group keeps its name for screen readers.
            headingHidden={index === 0}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
      <UserBar logout={logout} onNavigate={onNavigate} />
    </div>
  );
}

function NavSection({
  group,
  headingHidden,
  onNavigate,
}: {
  readonly group: NavGroup;
  readonly headingHidden: boolean;
  readonly onNavigate: () => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  if (group.items.length === 0) return null;
  return (
    // Not a list: the home checklist's items are the page's only list items.
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, these are links
    <div role="group" aria-labelledby={headingId} className="flex flex-col">
      <p
        id={headingId}
        className={cn(
          "m-0 px-2 pt-3 pb-1 text-caption text-subtle-foreground",
          headingHidden && "sr-only",
        )}
      >
        {t(group.label)}
      </p>
      {group.items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === "/" }}
          onClick={onNavigate}
          className={cn(
            "flex h-8 items-center gap-2 rounded-control px-2 text-control text-foreground no-underline",
            "hover:bg-sidebar-hover",
            "data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium",
          )}
        >
          <item.icon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="whitespace-nowrap">{t(item.label)}</span>
          {item.to === "/sessions" ? <WaitingBadge /> : null}
        </Link>
      ))}
    </div>
  );
}

// By code point, so a name starting with an emoji or a surrogate pair is not
// cut in half.
function initial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "";
}

const THEME_ICONS: Record<Theme, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const ICON = "size-4 shrink-0";
const MENU_CARD =
  "absolute z-20 flex flex-col rounded-card border bg-popover p-1 text-popover-foreground shadow-pop";
const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-control text-popover-foreground no-underline hover:bg-muted focus-visible:bg-muted disabled:opacity-50";
const MENU_ICON = cn(ICON, "text-muted-foreground");
const MENU_RULE = "-mx-1 my-1 border-0 border-t";

type Submenu = "language" | "theme";

// Items are tagged by the menu they belong to, so arrow keys in the account
// menu skip the submenus nested inside it.
function menuItems(root: HTMLElement | null, menu: "account" | Submenu) {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      `[data-menu="${menu}"]:not(:disabled)`,
    ) ?? [],
  );
}

function moveFocus(items: readonly HTMLElement[], key: string) {
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : (at + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

const ARROWS = ["ArrowDown", "ArrowUp", "Home", "End"];

/** The account pill and, beside it, the bell for sessions waiting on me. */
function UserBar({
  logout,
  onNavigate,
}: {
  readonly logout: { readonly pending: boolean; readonly run: () => void };
  readonly onNavigate: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t pt-2">
      <UserMenu logout={logout} onNavigate={onNavigate} />
      <WaitingBell onNavigate={onNavigate} />
    </div>
  );
}

function WaitingBell({ onNavigate }: { readonly onNavigate: () => void }) {
  const { t } = useI18n();
  const waiting = useWaitingSessions().data;
  const count = waiting?.count ?? 0;
  const label =
    count === 0
      ? t("shell.waitingNone")
      : t(waiting?.more ? "shell.waitingMore" : "shell.waiting", { count });
  return (
    <Link
      to="/sessions"
      aria-label={label}
      title={label}
      onClick={onNavigate}
      className="relative grid size-8 shrink-0 place-items-center rounded-control text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
    >
      <Bell aria-hidden="true" className={ICON} />
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 size-2 rounded-full bg-(--ap-tone-attention-fg)"
        />
      ) : null}
    </Link>
  );
}

function UserMenu({
  logout,
  onNavigate,
}: {
  readonly logout: { readonly pending: boolean; readonly run: () => void };
  readonly onNavigate: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const role = useRole();
  const roleKey = `role.${role}`;
  const roleLabel = role && isMessageKey(roleKey) ? t(roleKey) : undefined;
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const triggerId = useId();
  const menuId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuItemRefs = useRef<Record<Submenu, HTMLButtonElement | null>>({
    language: null,
    theme: null,
  });
  const name = me?.user?.display_name ?? t("shell.account");

  useEffect(() => {
    if (!open) {
      setSubmenu(null);
      return;
    }
    menuItems(sectionRef.current, "account")[0]?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!sectionRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!submenu) return;
    const items = menuItems(sectionRef.current, submenu);
    (
      items.find((item) => item.getAttribute("aria-checked") === "true") ??
      items[0]
    )?.focus();
  }, [submenu]);

  // The followed item goes away with the menu; focus lands on the page.
  const followLink = () => {
    setOpen(false);
    onNavigate();
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  };

  const closeSubmenu = () => {
    if (!submenu) return;
    const item = submenuItemRefs.current[submenu];
    setSubmenu(null);
    item?.focus();
  };

  const onAccountKey = (event: KeyboardEvent) => {
    if (event.key === "Tab") setOpen(false);
    if (!ARROWS.includes(event.key)) return;
    event.preventDefault();
    moveFocus(menuItems(sectionRef.current, "account"), event.key);
  };

  const onSubmenuKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      closeSubmenu();
      return;
    }
    if (!ARROWS.includes(event.key) || !submenu) return;
    event.preventDefault();
    event.stopPropagation();
    moveFocus(menuItems(sectionRef.current, submenu), event.key);
  };

  const submenuParent = (
    which: Submenu,
    icon: LucideIcon,
    label: string,
    value: string,
  ) => {
    const Icon = icon;
    const itemId = `${menuId}-${which}`;
    const listId = `${menuId}-${which}-menu`;
    const expanded = submenu === which;
    return (
      <div className="relative">
        <button
          ref={(node) => {
            submenuItemRefs.current[which] = node;
          }}
          id={itemId}
          type="button"
          role="menuitem"
          data-menu="account"
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          tabIndex={-1}
          className={cn(MENU_ITEM, expanded && "bg-muted")}
          onClick={() => setSubmenu(expanded ? null : which)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            setSubmenu(which);
          }}
        >
          <Icon aria-hidden="true" className={MENU_ICON} />
          {label}
          <span className="ml-auto text-caption text-muted-foreground">
            {value}
          </span>
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
        {expanded ? (
          <div
            id={listId}
            role="menu"
            aria-labelledby={itemId}
            // Beside the menu where the sidebar leaves room; on a phone the
            // sidebar is the screen's width, so it covers the item instead.
            className={cn(
              MENU_CARD,
              "inset-x-0 bottom-0 md:inset-x-auto md:left-full md:ml-2 md:w-44",
            )}
            onKeyDown={onSubmenuKey}
          >
            {which === "language"
              ? LOCALES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    data-menu="language"
                    aria-checked={locale === value}
                    tabIndex={-1}
                    className={MENU_ITEM}
                    onClick={() => {
                      setLocale(value);
                      closeSubmenu();
                    }}
                  >
                    <span lang={value}>{LOCALE_NAMES[value]}</span>
                    {locale === value ? (
                      <Check aria-hidden="true" className="ml-auto size-3.5" />
                    ) : null}
                  </button>
                ))
              : THEMES.map((value) => {
                  const ThemeIcon = THEME_ICONS[value];
                  return (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      data-menu="theme"
                      aria-checked={theme === value}
                      tabIndex={-1}
                      className={MENU_ITEM}
                      onClick={() => {
                        chooseTheme(value);
                        closeSubmenu();
                      }}
                    >
                      <ThemeIcon aria-hidden="true" className={MENU_ICON} />
                      {t(`shell.theme.${value}`)}
                      {theme === value ? (
                        <Check
                          aria-hidden="true"
                          className="ml-auto size-3.5"
                        />
                      ) : null}
                    </button>
                  );
                })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section
      ref={sectionRef}
      aria-label={t("shell.account")}
      className="relative min-w-0"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          // The menu is as wide as the sidebar, not the pill it opens from.
          className={cn(
            MENU_CARD,
            "bottom-full left-0 mb-1 w-[calc(var(--ap-layout-sidebar-width)-1rem)] max-w-[calc(100vw-2rem)]",
          )}
          onKeyDown={onAccountKey}
        >
          {me?.user ? (
            <div role="presentation" className="flex flex-col px-2 py-2">
              <span className="truncate text-control">{me.user.email}</span>
              <span className="truncate text-caption text-muted-foreground">
                {[roleLabel, me.workspace?.name].filter(Boolean).join(" · ")}
              </span>
            </div>
          ) : null}
          <hr className={MENU_RULE} />
          <Link
            to="/settings/linked-accounts"
            role="menuitem"
            data-menu="account"
            tabIndex={-1}
            className={MENU_ITEM}
            onClick={followLink}
          >
            <LinkIcon aria-hidden="true" className={MENU_ICON} />
            {t("nav.linkedAccounts")}
          </Link>
          <hr className={MENU_RULE} />
          {submenuParent(
            "language",
            Globe,
            t("common.language"),
            LOCALE_NAMES[locale],
          )}
          {submenuParent(
            "theme",
            THEME_ICONS[theme],
            t("shell.theme"),
            t(`shell.theme.${theme}`),
          )}
          <hr className={MENU_RULE} />
          <Link
            to="/settings/api-keys"
            role="menuitem"
            data-menu="account"
            tabIndex={-1}
            className={MENU_ITEM}
            onClick={followLink}
          >
            <KeyRound aria-hidden="true" className={MENU_ICON} />
            {t("nav.apiKeys")}
          </Link>
          <hr className={MENU_RULE} />
          <button
            type="button"
            role="menuitem"
            data-menu="account"
            tabIndex={-1}
            className={MENU_ITEM}
            disabled={logout.pending}
            onClick={logout.run}
          >
            <LogOut aria-hidden="true" className={MENU_ICON} />
            {logout.pending ? t("common.loggingOut") : t("common.logout")}
          </button>
        </div>
      ) : null}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // The role shows in the menu head, not on the pill; it is still
        // heard with the name.
        aria-label={
          roleLabel ? t("shell.accountOf", { name, role: roleLabel }) : name
        }
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-full px-2 text-left hover:bg-sidebar-hover aria-expanded:bg-sidebar-accent"
      >
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-full bg-sidebar-accent font-semibold text-caption"
        >
          {initial(me?.user?.display_name ?? me?.workspace?.name ?? "")}
        </span>
        <span className="min-w-0 truncate font-medium text-control">
          {name}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </button>
    </section>
  );
}

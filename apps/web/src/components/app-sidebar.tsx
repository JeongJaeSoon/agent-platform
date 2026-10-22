import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { waitingSessionsQuery } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import { Badge, cn } from "@werft-ai/ui";
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
import { chooseTheme, THEMES, useTheme } from "./theme.ts";

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
        { to: "/", label: "nav.home" },
        { to: "/sessions", label: "nav.sessions" },
        { to: "/agents", label: "nav.agents" },
      ],
    },
    {
      label: "shell.group.workspace",
      items: [
        ...(managesMembers
          ? [{ to: "/members", label: "nav.members" } as const]
          : []),
        { to: "/teams", label: "nav.teams" },
        ...(showsWorkspaceSettings
          ? [{ to: "/settings/workspace", label: "nav.workspace" } as const]
          : []),
      ],
    },
    {
      label: "shell.group.personal",
      items: [
        { to: "/settings/linked-accounts", label: "nav.linkedAccounts" },
        { to: "/settings/api-keys", label: "nav.apiKeys" },
        { to: "/settings/preferences", label: "nav.preferences" },
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
      <Badge
        className="ml-auto bg-rail-foreground text-rail"
        aria-hidden="true"
      >
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
      // z-10: the language submenu opens past the rail, over the page.
      className="hidden max-h-[calc(100dvh-3.25rem)] flex-col gap-2 bg-rail px-2 py-3 text-rail-foreground data-[open=true]:flex md:sticky md:top-0 md:z-10 md:col-start-1 md:row-span-2 md:row-start-1 md:flex md:h-dvh md:max-h-none"
    >
      <div className="hidden h-11 shrink-0 flex-col justify-center px-2 md:flex">
        <p className="m-0 truncate font-semibold text-control leading-5">
          {t("common.appName")}
        </p>
        {me?.workspace ? (
          <p className="m-0 truncate text-caption text-rail-muted-foreground leading-5">
            {me.workspace.name}
          </p>
        ) : null}
      </div>
      <nav
        aria-label={t("nav.label")}
        // The rail is dark in both themes; a light scrollbar glared on it.
        className="-mx-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 [scrollbar-color:var(--ap-color-rail-muted-foreground)_transparent]"
      >
        {groups.map((group) => (
          <NavSection key={group.label} group={group} onNavigate={onNavigate} />
        ))}
      </nav>
      <UserMenu logout={logout} onNavigate={onNavigate} />
    </div>
  );
}

function NavSection({
  group,
  onNavigate,
}: {
  readonly group: NavGroup;
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
        className="m-0 px-2 pt-3 pb-1 text-rail-muted-foreground text-caption"
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
            "flex h-8 items-center gap-2 rounded-md px-2 text-rail-muted-foreground text-control no-underline",
            "hover:bg-rail-foreground/10 hover:text-rail-foreground",
            "data-[status=active]:bg-rail-foreground/10 data-[status=active]:font-semibold data-[status=active]:text-rail-foreground",
          )}
        >
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

// Lucide paths (ISC), drawn inline like the other icons in this app.
const ICONS = {
  chevronDown: ["m6 9 6 6 6-6"],
  chevronRight: ["m9 18 6-6-6-6"],
  check: ["M20 6 9 17l-5-5"],
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  ],
  globe: [
    "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0",
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
  ],
  light: [
    "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M12 2v2",
    "M12 20v2",
    "m4.93 4.93 1.41 1.41",
    "m17.66 17.66 1.41 1.41",
    "M2 12h2",
    "M20 12h2",
    "m6.34 17.66-1.41 1.41",
    "m19.07 4.93-1.41 1.41",
  ],
  dark: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
  system: [
    "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M8 21h8",
    "M12 17v4",
  ],
  key: [
    "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
    "M16 7.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0",
  ],
  logOut: [
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    "m16 17 5-5-5-5",
    "M21 12H9",
  ],
} as const;

function Icon({
  name,
  className,
}: {
  readonly name: keyof typeof ICONS;
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const MENU_CARD =
  "absolute z-20 flex flex-col rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg";
const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-control text-popover-foreground no-underline hover:bg-muted focus-visible:bg-muted disabled:opacity-50";
const MENU_ICON = "text-muted-foreground";

// Items are tagged by the menu they belong to, so arrow keys in the account
// menu skip the language submenu nested inside it.
function menuItems(root: HTMLElement | null, menu: "account" | "language") {
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
  const [languageOpen, setLanguageOpen] = useState(false);
  const triggerId = useId();
  const menuId = useId();
  const themeLabelId = useId();
  const languageItemId = useId();
  const languageMenuId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const languageItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setLanguageOpen(false);
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
    if (!languageOpen) return;
    const items = menuItems(sectionRef.current, "language");
    (items.find((item) => item.dataset.locale === locale) ?? items[0])?.focus();
  }, [languageOpen, locale]);

  // The followed item goes away with the menu; focus lands on the page.
  const followLink = () => {
    setOpen(false);
    onNavigate();
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  };

  const closeLanguage = () => {
    setLanguageOpen(false);
    languageItemRef.current?.focus();
  };

  const onAccountKey = (event: KeyboardEvent) => {
    if (event.key === "Tab") setOpen(false);
    if (!ARROWS.includes(event.key)) return;
    event.preventDefault();
    moveFocus(menuItems(sectionRef.current, "account"), event.key);
  };

  const onLanguageKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      closeLanguage();
      return;
    }
    if (!ARROWS.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    moveFocus(menuItems(sectionRef.current, "language"), event.key);
  };

  return (
    <section
      ref={sectionRef}
      aria-label={t("shell.account")}
      className="relative shrink-0 border-rail-foreground/15 border-t pt-2"
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
          className={cn(MENU_CARD, "inset-x-0 bottom-full mb-1")}
          onKeyDown={onAccountKey}
        >
          {me?.user ? (
            <p
              role="presentation"
              className="m-0 truncate px-2 py-1.5 text-caption text-muted-foreground"
            >
              {me.user.email}
            </p>
          ) : null}
          <Link
            to="/settings/preferences"
            role="menuitem"
            data-menu="account"
            tabIndex={-1}
            className={MENU_ITEM}
            onClick={followLink}
          >
            <Icon name="settings" className={MENU_ICON} />
            {t("shell.group.personal")}
          </Link>
          <div className="relative">
            <button
              ref={languageItemRef}
              id={languageItemId}
              type="button"
              role="menuitem"
              data-menu="account"
              aria-haspopup="menu"
              aria-expanded={languageOpen}
              aria-controls={languageOpen ? languageMenuId : undefined}
              tabIndex={-1}
              className={cn(MENU_ITEM, languageOpen && "bg-muted")}
              onClick={() => setLanguageOpen((value) => !value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight") return;
                event.preventDefault();
                setLanguageOpen(true);
              }}
            >
              <Icon name="globe" className={MENU_ICON} />
              {t("common.language")}
              <Icon name="chevronRight" className="ml-auto size-3.5" />
            </button>
            {languageOpen ? (
              <div
                id={languageMenuId}
                role="menu"
                aria-labelledby={languageItemId}
                // Beside the menu where the rail leaves room; on a phone the
                // rail is the screen's width, so it covers the item instead.
                className={cn(
                  MENU_CARD,
                  "inset-x-0 bottom-0 md:inset-x-auto md:left-full md:ml-2 md:w-40",
                )}
                onKeyDown={onLanguageKey}
              >
                {LOCALES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    data-menu="language"
                    data-locale={value}
                    aria-checked={locale === value}
                    tabIndex={-1}
                    className={MENU_ITEM}
                    onClick={() => {
                      setLocale(value);
                      closeLanguage();
                    }}
                  >
                    <span lang={value}>{LOCALE_NAMES[value]}</span>
                    {locale === value ? (
                      <Icon name="check" className="ml-auto size-3.5" />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a menu groups its items with role=group, not a fieldset */}
          <div
            role="group"
            aria-labelledby={themeLabelId}
            className="flex flex-col"
          >
            <p
              id={themeLabelId}
              className="m-0 px-2 pt-1.5 pb-1 text-caption text-muted-foreground"
            >
              {t("shell.theme")}
            </p>
            {THEMES.map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                data-menu="account"
                aria-checked={theme === value}
                tabIndex={-1}
                className={MENU_ITEM}
                onClick={() => chooseTheme(value)}
              >
                <Icon name={value} className={MENU_ICON} />
                {t(`shell.theme.${value}`)}
                {theme === value ? (
                  <Icon name="check" className="ml-auto size-3.5" />
                ) : null}
              </button>
            ))}
          </div>
          <hr className="-mx-1 my-1 border-0 border-t" />
          <Link
            to="/settings/api-keys"
            role="menuitem"
            data-menu="account"
            tabIndex={-1}
            className={MENU_ITEM}
            onClick={followLink}
          >
            <Icon name="key" className={MENU_ICON} />
            {t("nav.apiKeys")}
          </Link>
          <hr className="-mx-1 my-1 border-0 border-t" />
          <button
            type="button"
            role="menuitem"
            data-menu="account"
            tabIndex={-1}
            className={MENU_ITEM}
            disabled={logout.pending}
            onClick={logout.run}
          >
            <Icon name="logOut" className={MENU_ICON} />
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
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
        className="inline-flex h-10 max-w-full items-center gap-2 rounded-full px-2 text-left hover:bg-rail-foreground/10 aria-expanded:bg-rail-foreground/10"
      >
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-full bg-rail-foreground/15 font-semibold text-[0.6875rem]"
        >
          {initial(me?.user?.display_name ?? me?.workspace?.name ?? "")}
        </span>
        <span className="min-w-0 truncate font-medium text-control leading-4">
          {me?.user?.display_name ?? t("shell.account")}
        </span>
        {roleLabel ? (
          <span className="shrink-0 text-caption text-rail-muted-foreground leading-4">
            <span aria-hidden="true">· </span>
            {roleLabel}
          </span>
        ) : null}
        <Icon
          name="chevronDown"
          className="size-3.5 text-rail-muted-foreground"
        />
      </button>
    </section>
  );
}

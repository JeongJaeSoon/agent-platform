import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { waitingSessionsQuery } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  cn,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import { useCan, useHasPermission, useMe } from "../auth/guard.tsx";
import {
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";
import { chooseTheme, storedTheme, THEMES, type Theme } from "./theme.ts";

type NavPath =
  | "/"
  | "/sessions"
  | "/agents"
  | "/members"
  | "/teams"
  | "/settings/workspace"
  | "/settings/linked-accounts"
  | "/settings/api-keys";

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
      className="hidden flex-col gap-6 bg-rail px-2 py-3 text-rail-foreground data-[open=true]:flex md:sticky md:top-0 md:col-start-1 md:row-span-2 md:row-start-1 md:flex md:h-dvh md:overflow-y-auto"
    >
      <div className="hidden px-2 md:block">
        <p className="m-0 font-semibold">{t("common.appName")}</p>
        {me?.workspace ? (
          <p className="m-0 text-rail-muted-foreground text-body [overflow-wrap:anywhere]">
            {me.workspace.name}
          </p>
        ) : null}
      </div>
      <nav aria-label={t("nav.label")} className="flex flex-col gap-3">
        {groups.map((group) => (
          <NavSection key={group.label} group={group} onNavigate={onNavigate} />
        ))}
      </nav>
      <UserMenu logout={logout} />
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

// The select keeps its card surface on the rail, so it needs the card's text
// colour back: inherited, the rail's light text vanished on a light card.
const ON_RAIL = "text-card-foreground";

function UserMenu({
  logout,
}: {
  readonly logout: { readonly pending: boolean; readonly run: () => void };
}) {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  return (
    <section
      aria-label={t("shell.account")}
      className="mt-auto flex flex-col gap-3 border-rail-foreground/15 border-t px-2 pt-4"
    >
      {me?.user ? (
        <div className="min-w-0">
          <p className="m-0 font-medium text-body [overflow-wrap:anywhere]">
            {me.user.display_name}
          </p>
          <p className="m-0 text-rail-muted-foreground text-caption [overflow-wrap:anywhere]">
            {me.user.email}
          </p>
        </div>
      ) : null}
      <Field orientation="horizontal" className="justify-between gap-2">
        <FieldLabel className="text-rail-muted-foreground text-caption">
          {t("common.language")}
        </FieldLabel>
        <NativeSelect
          size="sm"
          className={ON_RAIL}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {LOCALES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {LOCALE_NAMES[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field orientation="horizontal" className="justify-between gap-2">
        <FieldLabel className="text-rail-muted-foreground text-caption">
          {t("shell.theme")}
        </FieldLabel>
        <NativeSelect
          size="sm"
          className={ON_RAIL}
          value={theme}
          onChange={(event) => {
            const next = event.target.value as Theme;
            setTheme(next);
            chooseTheme(next);
          }}
        >
          {THEMES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {t(`shell.theme.${value}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-rail-muted-foreground bg-transparent text-rail-foreground hover:bg-rail-foreground/10 hover:text-rail-foreground"
        disabled={logout.pending}
        onClick={logout.run}
      >
        {logout.pending ? t("common.loggingOut") : t("common.logout")}
      </Button>
    </section>
  );
}

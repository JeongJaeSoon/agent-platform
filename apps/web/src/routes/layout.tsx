import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { ApiError, isApiError, unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { Bot, ChevronDown, List, Plus, Users, UsersRound } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useState } from "react";
import { useHasPermission, useMe } from "../auth/guard.tsx";
import {
  AppSidebar,
  type NavGroup,
  navItemFor,
  useNavGroups,
} from "../components/app-sidebar.tsx";
import { MAIN_CONTENT_ID, Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { applyTheme, storedTheme } from "../components/theme.ts";
import {
  errorKey,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  useI18n,
} from "../i18n/i18n.tsx";

export function RootLayout() {
  const { t } = useI18n();
  const authed = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === "/authed"),
  });
  useLayoutEffect(() => applyTheme(storedTheme()), []);
  return (
    <div className="group/root flex min-h-dvh flex-col">
      <a
        className="absolute top-2 left-2 z-50 -translate-y-[200%] rounded-control bg-card px-3 py-2 focus:translate-y-0"
        href={`#${MAIN_CONTENT_ID}`}
      >
        {t("common.skipToContent")}
      </a>
      {/* On an AuthPage this spacer and the footer split the spare height,
          so the page sits in the middle of the viewport and, once taller,
          scrolls from its top. Other public screens keep to the top. Both
          grow from a 0px basis with no padding of their own: the root's
          height is indefinite, so a 0% basis would fall back to content. */}
      {authed ? null : (
        <div className="hidden grow basis-0 group-has-[>.auth-page]/root:block" />
      )}
      <Outlet />
      {authed ? null : (
        <footer className="mt-auto flex justify-end group-has-[>.auth-page]/root:grow group-has-[>.auth-page]/root:basis-0 group-has-[>.auth-page]/root:items-end">
          <div className="p-4">
            <LocaleSwitch />
          </div>
        </footer>
      )}
    </div>
  );
}

function LocaleSwitch() {
  const { t, locale, setLocale } = useI18n();
  return (
    <Field orientation="horizontal" className="w-auto gap-2">
      <FieldLabel>{t("common.language")}</FieldLabel>
      <NativeSelect
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
  );
}

// Lists, though they sit under settings.
const KEY_LISTS = new Set(["/settings/api-keys", "/settings/api-keys/service"]);

/**
 * One width per screen, which every block on it shares (console v35): forms
 * and settings read in one narrow column, lists take the wide one.
 */
function contentWidth(pathname: string) {
  if (
    pathname === "/agents/new" ||
    (pathname.startsWith("/settings/") && !KEY_LISTS.has(pathname))
  ) {
    return "max-w-[calc(var(--ap-w-narrow)+2*var(--ap-gutter))]";
  }
  return "max-w-[calc(var(--ap-w-wide)+2*var(--ap-gutter))]";
}

// The top bar's "new" lives only on the screens that list what it makes.
const NEW_ON = new Set(["/", "/sessions", "/agents"]);

export function AuthedLayout() {
  const { t } = useI18n();
  const me = useMe();
  const groups = useNavGroups();
  const can: CreatePermissions = {
    agent: useHasPermission("agent.create"),
    invite: useHasPermission("member.manage"),
    team: useHasPermission("team.manage"),
  };
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sidebarId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = useMutation<unknown, ApiError>({
    // A 401 means the session is already gone, which is what was asked.
    meta: { public: true },
    mutationFn: () =>
      unwrap(client.POST("/v1/auth/logout")).catch((error: unknown) => {
        if (!isApiError(error, "UNAUTHORIZED")) throw error;
      }),
    // Only once the server has dropped the session: on any other failure the
    // cookie still works, and saying "logged out" would be a lie.
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/login", search: { notice: "logged_out" } });
    },
  });

  return (
    // Header, sidebar, main in reading order: below md the open menu unfolds
    // under its button; from md on the grid puts the sidebar on the left.
    <div className="flex flex-1 flex-col md:grid md:grid-cols-[var(--ap-layout-sidebar-width)_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
      <header className="flex min-h-[var(--ap-topbar-h)] items-center gap-3 border-b bg-surface px-4 md:col-start-2 md:row-start-1 md:px-[var(--ap-gutter)]">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="md:hidden"
          aria-expanded={menuOpen}
          aria-controls={sidebarId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? t("shell.closeMenu") : t("shell.openMenu")}
        </Button>
        <PageTrail
          groups={groups}
          fallback={me?.workspace?.name ?? t("common.appName")}
        />
        {can.agent || can.invite || can.team ? <NewMenu can={can} /> : null}
      </header>
      <AppSidebar
        id={sidebarId}
        openBelowMd={menuOpen}
        groups={groups}
        onNavigate={() => {
          if (!menuOpen) return;
          setMenuOpen(false);
          // The followed link hides with the menu; focus lands on the page.
          document.getElementById(MAIN_CONTENT_ID)?.focus();
        }}
        logout={{ pending: logout.isPending, run: () => logout.mutate() }}
      />
      <ShellMain>
        {logout.error ? (
          <p className="m-0 text-destructive" role="alert">
            {t("common.logoutFailed")} {t(errorKey(logout.error.code))}
          </p>
        ) : null}
        <Outlet />
      </ShellMain>
    </div>
  );
}

function usePathname() {
  return useRouterState({ select: (state) => state.location.pathname });
}

function PageTrail({
  groups,
  fallback,
}: {
  readonly groups: readonly NavGroup[];
  readonly fallback: string;
}) {
  const { t } = useI18n();
  const here = navItemFor(groups, usePathname());
  // The same words as the sidebar item and the page title.
  return (
    <p className="m-0 min-w-0 truncate font-medium text-control">
      {here ? t(here.item.label) : fallback}
    </p>
  );
}

interface CreatePermissions {
  readonly agent: boolean;
  readonly invite: boolean;
  readonly team: boolean;
}

/**
 * Making something starts here on the screens that list it. Items the viewer
 * may not make are left out, as their screens leave out the form. Sessions
 * start from the API, Slack or the SDK, so that item stays, inert, to say
 * so. It re-renders on every navigation, so it must not read the signed-in
 * user itself: after logout that read would fetch them again into the
 * cleared cache.
 */
function NewMenu({ can }: { readonly can: CreatePermissions }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const reasonId = useId();
  if (!NEW_ON.has(pathname)) return null;
  // The agent list's own thing to make names the button there.
  const label =
    pathname === "/agents" && can.agent ? t("agents.new") : t("shell.new");
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <Plus aria-hidden="true" />
          {label}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {can.agent ? (
          <DropdownMenuItem asChild>
            <Link to="/agents/new">
              <Bot aria-hidden="true" />
              {t("agents.new")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {can.invite ? (
          <DropdownMenuItem asChild>
            <Link to="/members">
              <Users aria-hidden="true" />
              {t("shell.new.invite")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {can.team ? (
          <DropdownMenuItem asChild>
            <Link to="/teams">
              <UsersRound aria-hidden="true" />
              {t("teams.create")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {/* aria-disabled, not disabled: Radix skips a disabled item, and the
            reason would never reach a keyboard or screen reader. */}
        <DropdownMenuItem
          aria-disabled="true"
          aria-describedby={reasonId}
          onSelect={(event) => event.preventDefault()}
        >
          <List aria-hidden="true" />
          <span className="flex min-w-0 flex-col">
            {t("shell.new.session")}
            <span id={reasonId} className="text-caption">
              {t("shell.new.sessionUnavailable")}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShellMain({ children }: { readonly children: ReactNode }) {
  return (
    // Left-aligned (console v35): the column starts at the sidebar and stops
    // at its width, it does not centre in the space left over.
    <Main
      className={cn(
        "web-shell__main flex w-full min-w-0 flex-col bg-surface p-4 md:col-start-2 md:row-start-2 md:px-[var(--ap-gutter)] md:pt-[var(--ap-space-page-top)] md:pb-[var(--ap-space-section)]",
        contentWidth(usePathname()),
      )}
    >
      {children}
    </Main>
  );
}

export function AuthedError({ error }: ErrorComponentProps) {
  const router = useRouter();
  if (isApiError(error, "FORBIDDEN")) {
    return (
      <Main className="mx-auto w-full max-w-md px-4 py-10">
        <StatusScreen kind="forbidden" />
      </Main>
    );
  }
  return (
    <Main className="mx-auto w-full max-w-md px-4 py-10">
      <StatusScreen
        kind="error"
        detail={
          error instanceof ApiError ? errorKey(error.code) : "error.UNKNOWN"
        }
        // reset() only clears the boundary; the failure is in beforeLoad,
        // which runs again only when the router reloads.
        onRetry={() => void router.invalidate()}
      />
    </Main>
  );
}

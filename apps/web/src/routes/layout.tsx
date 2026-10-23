import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { ApiError, isApiError, unwrap } from "@werft-ai/client";
import { sessionQuery } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Button,
  cn,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  SkipLink,
} from "@werft-ai/ui";
import { type ReactNode, useId, useLayoutEffect, useState } from "react";
import { agentQuery } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
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
      <SkipLink href={`#${MAIN_CONTENT_ID}`}>
        {t("common.skipToContent")}
      </SkipLink>
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

export function AuthedLayout() {
  const { t } = useI18n();
  const me = useMe();
  const groups = useNavGroups();
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

// The router opens these with a trailing slash too.
const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const AGENT_PATH = /^\/agents\/([^/]+)\/?$/;

/**
 * What a screen under a sidebar item is called after it, when it is not the
 * item's own list: a session by its title, an agent by its name (console v4
 * crumb). Read from the cache the screen fills, so the bar asks for nothing.
 */
function useLeafTitle(pathname: string): string | undefined {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const sessionId = SESSION_PATH.exec(pathname)?.[1];
  const agentId = AGENT_PATH.exec(pathname)?.[1];
  const session = useQuery({
    ...sessionQuery(client, sessionId ?? ""),
    enabled: false,
  }).data;
  const agent = useQuery({
    ...agentQuery(client, agentId === "new" ? "" : (agentId ?? "")),
    enabled: false,
  }).data;
  // Until the screen has it, or when it failed, the bar names only the item:
  // no separator left hanging before an empty name.
  if (session && sessionId !== undefined) {
    // A server from before titles sends none, as the page head shows.
    return session.title || sessionId.slice(0, 8);
  }
  if (agentId === "new") return t("agents.newTitle");
  return agent?.agent.name;
}

function PageTrail({
  groups,
  fallback,
}: {
  readonly groups: readonly NavGroup[];
  readonly fallback: string;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const here = navItemFor(groups, pathname);
  const leaf = useLeafTitle(pathname);
  if (!here) {
    return (
      <p className="m-0 min-w-0 truncate font-medium text-control">
        {fallback}
      </p>
    );
  }
  // The same words as the sidebar item and the page title; a screen under an
  // item leads with the item, a link back to its list (console v4 `.crumbs`).
  return (
    <p className="m-0 flex min-w-0 items-center gap-2 whitespace-nowrap text-control text-subtle-foreground">
      {leaf === undefined ? null : (
        <>
          <Link
            to={here.item.to}
            className="shrink-0 text-subtle-foreground no-underline hover:text-foreground"
          >
            {t(here.item.label)}
          </Link>
          <span aria-hidden="true" className="text-border-strong">
            /
          </span>
        </>
      )}
      <span className="min-w-0 truncate font-medium text-foreground">
        {leaf ?? t(here.item.label)}
      </span>
    </p>
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

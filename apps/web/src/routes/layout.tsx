import { useAgentPlatform } from "@agent-platform/react";
import {
  Button,
  cn,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@agent-platform/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useId, useLayoutEffect, useState } from "react";
import { ApiError, isApiError, unwrap } from "../api/client.ts";
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
import { errorKey, LOCALES, type Locale, useI18n } from "../i18n/i18n.tsx";

export function RootLayout() {
  const { t } = useI18n();
  // Signed in, the language moves into the sidebar's user menu.
  const authed = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === "/authed"),
  });
  useLayoutEffect(() => applyTheme(storedTheme()), []);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        className="absolute top-2 left-2 z-50 -translate-y-[200%] rounded-sm bg-card px-3 py-2 focus:translate-y-0"
        href={`#${MAIN_CONTENT_ID}`}
      >
        {t("common.skipToContent")}
      </a>
      <Outlet />
      {authed ? null : (
        <footer className="mt-auto flex justify-end p-4">
          <LocaleSwitch />
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
            {value === "ko" ? "한국어" : "English"}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

/*
 * Width rule: forms and settings keep the reading column; lists, details and
 * home take the wide one, which leaves room for tables and side-by-side cards.
 */
function readingWidth(pathname: string) {
  return pathname === "/agents/new" || pathname.startsWith("/settings/");
}

/*
 * The path is read only by the header and the main column below, never here:
 * a re-render of this layout after logout cleared the cache would re-read
 * /auth/me through its useMe and put the old identity back.
 */
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
    <div className="flex flex-1 flex-col md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
      <header className="flex min-h-14 items-center gap-3 border-b bg-card px-4 md:col-start-2 md:row-start-1 md:px-8">
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
        <Whereabouts
          groups={groups}
          fallback={me?.workspace?.name ?? t("common.appName")}
        />
      </header>
      <AppSidebar
        id={sidebarId}
        open={menuOpen}
        groups={groups}
        // A link followed from the open menu lands on the page, not the menu.
        onNavigate={() => setMenuOpen(false)}
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

/** The page header's "group / page" line for where the reader is. */
function Whereabouts({
  groups,
  fallback,
}: {
  readonly groups: readonly NavGroup[];
  readonly fallback: string;
}) {
  const { t } = useI18n();
  const here = navItemFor(groups, usePathname());
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
      {here ? (
        <>
          <span className="text-muted-foreground">{t(here.group.label)}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <span className="font-medium">{t(here.item.label)}</span>
        </>
      ) : (
        <span className="font-medium">{fallback}</span>
      )}
    </p>
  );
}

function ShellMain({ children }: { readonly children: ReactNode }) {
  return (
    <Main
      className={cn(
        "web-shell__main mx-auto flex w-full min-w-0 flex-col gap-4 px-4 py-6 md:col-start-2 md:row-start-2 md:px-8 md:py-8",
        readingWidth(usePathname())
          ? "max-w-[var(--ap-layout-reading-width)]"
          : "max-w-6xl",
      )}
    >
      {children}
    </Main>
  );
}

export function AuthedError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  if (isApiError(error, "FORBIDDEN")) {
    return (
      <Main className="web-auth">
        <StatusScreen kind="forbidden" />
      </Main>
    );
  }
  return (
    <Main className="web-auth">
      <section className="web-status" data-status="error" role="alert">
        <h2 className="web-status__title">{t("status.error.title")}</h2>
        <p className="web-status__body">
          {t(
            error instanceof ApiError ? errorKey(error.code) : "error.UNKNOWN",
          )}
        </p>
        <button type="button" className="ap-button" onClick={reset}>
          {t("common.retry")}
        </button>
      </section>
    </Main>
  );
}

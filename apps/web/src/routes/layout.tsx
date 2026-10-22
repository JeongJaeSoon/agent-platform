import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
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
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { type ReactNode, useId, useLayoutEffect, useState } from "react";
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

// The key screens keep their own 840px column (api-keys.tsx).
function usesReadingColumn(pathname: string) {
  return (
    pathname === "/agents/new" ||
    (pathname.startsWith("/settings/") &&
      !pathname.startsWith("/settings/api-keys"))
  );
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
      <header className="flex min-h-[3.25rem] items-center gap-3 border-b bg-card px-4 md:col-start-2 md:row-start-1 md:px-6">
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

function PageTrail({
  groups,
  fallback,
}: {
  readonly groups: readonly NavGroup[];
  readonly fallback: string;
}) {
  const { t } = useI18n();
  const here = navItemFor(groups, usePathname());
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-control">
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
        "web-shell__main mx-auto flex w-full min-w-0 flex-col p-4 md:col-start-2 md:row-start-2 md:px-6 md:py-6",
        usesReadingColumn(usePathname())
          ? "max-w-[var(--ap-layout-reading-width)]"
          : "max-w-[var(--ap-layout-content-width)]",
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

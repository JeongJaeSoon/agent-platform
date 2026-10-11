import { useMutation } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { ApiError, unwrap } from "../api/client.ts";
import { useMe } from "../auth/guard.tsx";
import { MAIN_CONTENT_ID, Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey as errorKeyOf,
  LOCALES,
  type Locale,
  useI18n,
} from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

export function RootLayout() {
  const { t } = useI18n();
  return (
    <div className="web-root">
      <a className="web-skip" href={`#${MAIN_CONTENT_ID}`}>
        {t("common.skipToContent")}
      </a>
      <Outlet />
      <footer className="web-footer">
        <LocaleSwitch />
      </footer>
    </div>
  );
}

function LocaleSwitch() {
  const { t, locale, setLocale } = useI18n();
  return (
    <label className="web-locale">
      <span>{t("common.language")}</span>
      <select
        className="ap-input"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            {value === "ko" ? "한국어" : "English"}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The workspace shell: who is signed in, where, and the way out. */
export function AuthedLayout() {
  const { t } = useI18n();
  const me = useMe();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => unwrap(client.POST("/v1/auth/logout")),
    // Logged out or not, this page must stop showing the old identity.
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: "/login", search: { notice: "logged_out" } });
    },
  });

  return (
    <div className="web-shell">
      <header className="web-shell__bar">
        <span className="web-shell__brand">{t("common.appName")}</span>
        {me?.workspace ? (
          <span className="web-shell__workspace">{me.workspace.name}</span>
        ) : null}
        <span className="web-shell__spacer" />
        {me?.user ? (
          <span className="web-shell__user">{me.user.display_name}</span>
        ) : null}
        <button
          type="button"
          className="ap-button ap-button--quiet"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          {logout.isPending ? t("common.loggingOut") : t("common.logout")}
        </button>
      </header>
      <Main className="web-shell__main">
        <Outlet />
      </Main>
    </div>
  );
}

/** What the authenticated layout shows when /v1/auth/me did not answer 200. */
export function AuthedError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Main className="web-auth">
        <StatusScreen kind="forbidden" detail={error.message} />
      </Main>
    );
  }
  return (
    <Main className="web-auth">
      <section className="web-status" data-status="error" role="alert">
        <h2 className="web-status__title">{t("status.error.title")}</h2>
        <p className="web-status__body">
          {t(
            error instanceof ApiError
              ? errorKeyOf(error.code)
              : "error.UNKNOWN",
          )}
        </p>
        <button type="button" className="ap-button" onClick={reset}>
          {t("common.retry")}
        </button>
      </section>
    </Main>
  );
}

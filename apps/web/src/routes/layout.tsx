import { useMutation } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { ApiError, isApiError, unwrap } from "../api/client.ts";
import { useHasPermission, useMe } from "../auth/guard.tsx";
import { MAIN_CONTENT_ID, Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, LOCALES, type Locale, useI18n } from "../i18n/i18n.tsx";
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

export function AuthedLayout() {
  const { t } = useI18n();
  const me = useMe();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const managesTeams = useHasPermission("team.manage");
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
    <div className="web-shell">
      <header className="web-shell__bar">
        <span className="web-shell__brand">{t("common.appName")}</span>
        {me?.workspace ? (
          <span className="web-shell__workspace">{me.workspace.name}</span>
        ) : null}
        <nav className="web-shell__nav" aria-label={t("nav.label")}>
          <Link to="/" activeOptions={{ exact: true }}>
            {t("nav.home")}
          </Link>
          <Link to="/members">{t("nav.members")}</Link>
          {managesTeams ? <Link to="/teams">{t("nav.teams")}</Link> : null}
          <Link to="/agents">{t("nav.agents")}</Link>
          <Link to="/settings/linked-accounts">{t("nav.linkedAccounts")}</Link>
          <Link to="/settings/api-keys">{t("nav.apiKeys")}</Link>
        </nav>
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
        {logout.error ? (
          <p className="web-form__error" role="alert">
            {t("common.logoutFailed")} {t(errorKey(logout.error.code))}
          </p>
        ) : null}
        <Outlet />
      </Main>
    </div>
  );
}

export function AuthedError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  if (isApiError(error, "FORBIDDEN")) {
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

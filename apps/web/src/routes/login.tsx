import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { type ApiError, CSRF_HEADER_VALUE, unwrap } from "../api/client.ts";
import { loginMethodsQuery } from "../api/queries.ts";
import { Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

const NOTICES = ["bootstrap_done", "logged_out", "created"] as const;
type Notice = (typeof NOTICES)[number];

export interface LoginSearch {
  /** Where to go after logging in; a same-origin path only. */
  readonly redirect?: string;
  readonly notice?: Notice;
}

/**
 * Only a path on this origin survives: `//evil.example` and `https://…`
 * would turn the login page into an open redirect.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  return value;
}

/** Where the Google round trip returns to after the callback; per tab. */
export const POST_LOGIN_PATH_KEY = "ap.postLoginPath";

export function loginSearch(search: Record<string, unknown>): LoginSearch {
  const redirect = safeRedirect(search.redirect);
  const notice = NOTICES.find((value) => value === search.notice);
  return {
    ...(redirect ? { redirect } : {}),
    ...(notice ? { notice } : {}),
  };
}

const NOTICE_KEY = {
  bootstrap_done: "login.notice.bootstrapDone",
  logged_out: "login.notice.loggedOut",
  created: "login.notice.created",
} as const;

export function LoginScreen() {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/auth/login", {
          // The operation declares the header, so its types require it here
          // although the client middleware sets the same value.
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
          body: { email, password },
        }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: search.redirect ?? "/" });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <Main className="web-auth">
      <h1 className="web-auth__title">{t("login.title")}</h1>
      {search.redirect ? (
        <StatusScreen kind="login-required" action={false} />
      ) : null}
      {search.notice ? (
        <output className="web-notice">{t(NOTICE_KEY[search.notice])}</output>
      ) : null}
      <form className="web-form" onSubmit={submit}>
        <label className="web-field">
          <span>{t("login.email")}</span>
          <input
            className="ap-input"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="web-field">
          <span>{t("login.password")}</span>
          <input
            className="ap-input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {login.error ? (
          <p className="web-form__error" role="alert">
            {t(errorKey(login.error.code))}
          </p>
        ) : null}
        <button
          type="submit"
          className="ap-button ap-button--primary"
          disabled={login.isPending}
        >
          {login.isPending ? t("login.submitting") : t("login.submit")}
        </button>
      </form>
      <GoogleChoice redirect={search.redirect} />
      <p className="web-auth__aside">
        {t("login.bootstrapPrompt")}{" "}
        <Link to="/bootstrap">{t("login.bootstrapLink")}</Link>
      </p>
    </Main>
  );
}

/**
 * The other way in, offered only where the server says Google sign-in is
 * configured. A failed lookup leaves the password form, which always works.
 */
function GoogleChoice({ redirect }: { readonly redirect: string | undefined }) {
  const { t } = useI18n();
  const { client, leave } = useServices();
  const methods = useQuery(loginMethodsQuery(client));

  const start = useMutation<{ authorization_url: string }, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/auth/google/start", {
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
        }),
      ),
    onSuccess: ({ authorization_url }) => {
      try {
        if (redirect) sessionStorage.setItem(POST_LOGIN_PATH_KEY, redirect);
        else sessionStorage.removeItem(POST_LOGIN_PATH_KEY);
      } catch {
        // Without storage the callback lands on home; the sign-in still works.
      }
      leave(authorization_url);
    },
  });

  if (!methods.data?.methods.includes("google")) return null;
  return (
    <section className="web-auth__alt" aria-label={t("login.alternatives")}>
      <p className="web-auth__divider">{t("login.or")}</p>
      {start.error ? (
        <p className="web-form__error" role="alert">
          {t(errorKey(start.error.code))}
        </p>
      ) : null}
      <button
        type="button"
        className="ap-button"
        disabled={start.isPending || start.isSuccess}
        onClick={() => start.mutate()}
      >
        {start.isPending || start.isSuccess
          ? t("login.google.starting")
          : t("login.google.submit")}
      </button>
    </section>
  );
}

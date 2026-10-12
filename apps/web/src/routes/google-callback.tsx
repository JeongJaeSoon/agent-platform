import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { type ApiError, CSRF_HEADER_VALUE, unwrap } from "../api/client.ts";
import { Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";
import { POST_LOGIN_PATH_KEY, safeRedirect } from "./login.tsx";

export interface GoogleCallbackSearch {
  readonly code?: string;
  readonly state?: string;
}

export function googleCallbackSearch(
  search: Record<string, unknown>,
): GoogleCallbackSearch {
  const pick = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const code = pick(search.code);
  const state = pick(search.state);
  return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
}

function refusalKey(error: ApiError): MessageKey {
  if (error.code === "UNAUTHORIZED") return "login.google.rejected";
  if (error.code === "FORBIDDEN") return "login.google.forbidden";
  return errorKey(error.code);
}

function takePostLoginPath(): string {
  try {
    const stored = sessionStorage.getItem(POST_LOGIN_PATH_KEY);
    sessionStorage.removeItem(POST_LOGIN_PATH_KEY);
    return safeRedirect(stored) ?? "/";
  } catch {
    return "/";
  }
}

/**
 * Where Google sends the browser back (GOOGLE_OIDC_REDIRECT_URI). The code
 * and state go to the API as they came; the flow cookie it set at the start
 * proves this browser began the sign-in.
 */
export function GoogleCallbackScreen() {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const { code, state } = useSearch({ from: "/auth/google/callback" });
  const sent = useRef(false);

  const finish = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/auth/google/callback", {
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
          body: { code: code ?? "", state: state ?? "" },
        }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: takePostLoginPath(), replace: true });
    },
  });

  // The code is single use: a second POST (a re-render, StrictMode) would be
  // refused and hide the first one's answer.
  useEffect(() => {
    if (sent.current || !code || !state) return;
    sent.current = true;
    finish.mutate();
  }, [code, state, finish]);

  const failure = !code || !state ? "login.google.cancelled" : null;
  return (
    <Main className="web-auth">
      <h1 className="web-auth__title">{t("login.google.title")}</h1>
      {failure || finish.error ? (
        <>
          <p className="web-form__error" role="alert">
            {t(failure ?? refusalKey(finish.error as ApiError))}
          </p>
          <p className="web-auth__aside">
            <Link to="/login">{t("login.google.backToLogin")}</Link>
          </p>
        </>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </Main>
  );
}

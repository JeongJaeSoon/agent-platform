import {
  type ApiError,
  CSRF_HEADER_VALUE,
  unwrap,
} from "@agent-platform/client";
import { useAgentPlatform } from "@agent-platform/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ASIDE, AuthPage, FormError, LINK } from "../components/auth-page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";
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
  // The callback route answers 404 only when Google sign-in is not set up.
  if (error.code === "NOT_FOUND") return "login.google.unavailable";
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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
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
    <AuthPage title={t("login.google.title")}>
      {failure || finish.error ? (
        <>
          <FormError>
            {t(failure ?? refusalKey(finish.error as ApiError))}
          </FormError>
          <p className={ASIDE}>
            <Link className={LINK} to="/login">
              {t("login.google.backToLogin")}
            </Link>
          </p>
        </>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </AuthPage>
  );
}

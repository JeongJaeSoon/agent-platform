import {
  type ApiError,
  CSRF_HEADER_VALUE,
  unwrap,
} from "@agent-platform/client";
import { useAgentPlatform } from "@agent-platform/react";
import { Button, Field, FieldLabel, Input } from "@agent-platform/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { loginMethodsQuery, viewerQuery } from "../api/queries.ts";
import {
  ASIDE,
  AuthPage,
  FormError,
  LINK,
  NOTICE,
} from "../components/auth-page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The email bootstrap just created, to fill in on the login form. */
    readonly loginEmail?: string;
  }
}

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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const loginEmail = useLocation({ select: (l) => l.state.loginEmail });
  const viewer = useQuery(viewerQuery(client));
  const [email, setEmail] = useState(loginEmail ?? "");
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
    <AuthPage title={t("login.title")}>
      {viewer.data?.user ? (
        <output className={NOTICE}>
          {t("login.signedIn", { email: viewer.data.user.email })}{" "}
          <Link className={LINK} to="/">
            {t("login.signedInHome")}
          </Link>
        </output>
      ) : null}
      {search.redirect ? (
        <StatusScreen kind="login-required" action={false} />
      ) : null}
      {/* A failed attempt makes "the owner is ready" old news. */}
      {search.notice && !login.error ? (
        <output className={NOTICE}>{t(NOTICE_KEY[search.notice])}</output>
      ) : null}
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field>
          <FieldLabel>{t("login.email")}</FieldLabel>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>{t("login.password")}</FieldLabel>
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {login.error ? (
          <FormError>{t(errorKey(login.error.code))}</FormError>
        ) : null}
        <Button type="submit" disabled={login.isPending}>
          {login.isPending ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
      <GoogleChoice redirect={search.redirect} />
      <p className={ASIDE}>
        {t("login.bootstrapPrompt")}{" "}
        <Link className={LINK} to="/bootstrap">
          {t("login.bootstrapLink")}
        </Link>
      </p>
    </AuthPage>
  );
}

/**
 * The other way in, offered only where the server says Google sign-in is
 * configured. A failed lookup leaves the password form, which always works.
 */
function GoogleChoice({ redirect }: { readonly redirect: string | undefined }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const { leave } = useAppServices();
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
    <section
      className="flex flex-col gap-3"
      aria-label={t("login.alternatives")}
    >
      <p className={`${ASIDE} text-center`}>{t("login.or")}</p>
      {start.error ? (
        <FormError>{t(errorKey(start.error.code))}</FormError>
      ) : null}
      <Button
        type="button"
        variant="outline"
        // Not held after success: back from Google (bfcache) must be able
        // to start again.
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        {start.isPending
          ? t("login.google.starting")
          : t("login.google.submit")}
      </Button>
    </section>
  );
}

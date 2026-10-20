import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  type ApiError,
  CSRF_HEADER_VALUE,
  isApiError,
  unwrap,
} from "../api/client.ts";
import { viewerQuery } from "../api/queries.ts";
import {
  DISPLAY_NAME_MAX,
  INVITE_TOKEN_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../auth/limits.ts";
import { TextField } from "../components/field.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { Main } from "../components/main.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

/**
 * Redeeming an invite link. Whoever opens it may or may not be signed in,
 * and there is no way to ask the server whether the address already has an
 * account without spending the token, so the form takes a password either
 * way: an existing account proves itself with it, a new one is created with
 * it. Only the server's answer says which happened.
 */
export function InviteScreen() {
  const { t } = useI18n();
  const { token } = useParams({ from: "/invite/$token" });
  const { client, queryClient } = useServices();
  const viewer = useQuery(viewerQuery(client));

  const logout = useMutation<unknown, ApiError>({
    meta: { public: true },
    mutationFn: () =>
      unwrap(client.POST("/v1/auth/logout")).catch((error: unknown) => {
        if (!isApiError(error, "UNAUTHORIZED")) throw error;
      }),
    onSuccess: () => {
      queryClient.clear();
    },
  });

  let body: ReactNode;
  if (viewer.isPending) body = <StatusScreen kind="loading" />;
  else if (viewer.error) {
    body = (
      <LoadFailure error={viewer.error} onRetry={() => void viewer.refetch()} />
    );
  } else if (viewer.data) {
    // One workspace per installation: anyone signed in is already a member.
    body = (
      <section className="web-status" data-status="invite-member">
        <h2 className="web-status__title">{t("invite.member.title")}</h2>
        <p className="web-status__body">
          {t("invite.member.body", {
            workspace: viewer.data.workspace?.name ?? "",
            email: viewer.data.user?.email ?? "",
          })}
        </p>
        <Link className="ap-button ap-button--primary" to="/">
          {t("invite.member.home")}
        </Link>
        <button
          type="button"
          className="ap-button"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          {t("invite.member.switch")}
        </button>
        {logout.error ? (
          <p className="web-form__error" role="alert">
            {t("common.logoutFailed")} {t(errorKey(logout.error.code))}
          </p>
        ) : null}
      </section>
    );
  } else body = <AcceptForm key={token} token={token} />;

  return (
    <Main className="web-auth">
      <h1 className="web-auth__title">{t("invite.title")}</h1>
      {body}
    </Main>
  );
}

function AcceptForm({ token }: { readonly token: string }) {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const accept = useMutation<unknown, ApiError>({
    // A 401 here is a wrong password, not an ended session.
    meta: { public: true },
    mutationFn: () =>
      unwrap(
        client.POST("/v1/invites/accept", {
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
          body: {
            token,
            password,
            ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          },
        }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/" });
    },
  });

  // A link cut short or made up has a token the server can only call an
  // invalid request, so its length is checked here; a 400 for a valid-looking
  // token is about the fields and keeps the form.
  if (
    token.length < INVITE_TOKEN_LENGTH.min ||
    token.length > INVITE_TOKEN_LENGTH.max ||
    accept.error?.code === "INVITE_EXPIRED"
  ) {
    return (
      <section className="web-status" data-status="invite-expired" role="alert">
        <h2 className="web-status__title">{t("invite.expired.title")}</h2>
        <p className="web-status__body">{t("invite.expired.body")}</p>
      </section>
    );
  }
  if (accept.error?.code === "INVITE_USED") {
    return (
      <section className="web-status" data-status="invite-used" role="alert">
        <h2 className="web-status__title">{t("invite.used.title")}</h2>
        <p className="web-status__body">{t("invite.used.body")}</p>
        <Link className="ap-button ap-button--primary" to="/login">
          {t("invite.used.login")}
        </Link>
      </section>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept.mutate();
  };

  return (
    <form className="web-form" onSubmit={submit}>
      <p className="web-auth__intro">{t("invite.intro")}</p>
      <TextField
        label={t("invite.displayName")}
        hint={t("invite.displayNameHint")}
        type="text"
        name="name"
        autoComplete="name"
        maxLength={DISPLAY_NAME_MAX}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <TextField
        label={t("invite.password")}
        hint={t("invite.passwordHint", { min: PASSWORD_MIN_LENGTH })}
        type="password"
        name="password"
        autoComplete="current-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {accept.error ? (
        <p className="web-form__error" role="alert">
          {accept.error.code === "UNAUTHORIZED"
            ? t("invite.wrongPassword")
            : t(errorKey(accept.error.code))}
        </p>
      ) : null}
      <button
        type="submit"
        className="ap-button ap-button--primary"
        disabled={accept.isPending}
      >
        {accept.isPending ? t("invite.submitting") : t("invite.submit")}
      </button>
    </form>
  );
}

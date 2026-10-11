import { Link } from "@tanstack/react-router";
import { useI18n } from "../i18n/i18n.tsx";

export type StatusKind =
  | "loading"
  | "login-required"
  | "forbidden"
  | "bootstrap-required";

export interface StatusScreenProps {
  readonly kind: StatusKind;
  /** The server's own words, shown under ours (a 403 names the scope). */
  readonly detail?: string | undefined;
  /** Where login-required sends the reader back to after logging in. */
  readonly redirect?: string | undefined;
  /** Off where the screen already is the way forward (the login form). */
  readonly action?: boolean;
}

export function StatusScreen({
  kind,
  detail,
  redirect,
  action = true,
}: StatusScreenProps) {
  const { t } = useI18n();
  if (kind === "loading") {
    return (
      <section className="web-status" data-status={kind} aria-busy="true">
        <output className="web-status__title">
          <span className="web-spinner" aria-hidden="true" />
          {t("status.loading.title")}
        </output>
      </section>
    );
  }
  const copy = {
    "login-required": {
      title: t("status.loginRequired.title"),
      body: t("status.loginRequired.body"),
    },
    forbidden: {
      title: t("status.forbidden.title"),
      body: t("status.forbidden.body"),
    },
    "bootstrap-required": {
      title: t("status.bootstrapRequired.title"),
      body: t("status.bootstrapRequired.body"),
    },
  }[kind];
  return (
    <section
      className="web-status"
      data-status={kind}
      role={kind === "forbidden" ? "alert" : undefined}
    >
      <h2 className="web-status__title">{copy.title}</h2>
      <p className="web-status__body">{copy.body}</p>
      {detail ? <p className="web-status__detail">{detail}</p> : null}
      {kind === "login-required" && action ? (
        <Link
          className="ap-button ap-button--primary"
          to="/login"
          search={redirect ? { redirect } : {}}
        >
          {t("status.loginRequired.action")}
        </Link>
      ) : null}
      {kind === "bootstrap-required" && action ? (
        <Link className="ap-button ap-button--primary" to="/bootstrap">
          {t("status.bootstrapRequired.action")}
        </Link>
      ) : null}
    </section>
  );
}

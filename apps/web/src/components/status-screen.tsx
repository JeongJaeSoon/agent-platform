import { Link } from "@tanstack/react-router";
import { Button, cn } from "@werft-ai/ui";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

export type StatusKind =
  | "loading"
  | "checking-login"
  | "not-found"
  | "login-required"
  | "forbidden"
  | "bootstrap-required"
  | "error";

export type StatusScreenProps =
  | {
      readonly kind: Exclude<StatusKind, "error">;
      /** Where login-required sends the reader back to after logging in. */
      readonly redirect?: string | undefined;
      /** Off where the screen already is the way forward (the login form). */
      readonly action?: boolean;
    }
  | {
      readonly kind: "error";
      readonly detail?: MessageKey;
      readonly onRetry?: () => void;
    };

const BOX =
  "flex flex-col items-start gap-2 rounded-card border bg-card p-4 text-card-foreground";
const TITLE = "m-0 flex items-center gap-2 font-semibold text-body";

export function StatusScreen(props: StatusScreenProps) {
  const { t } = useI18n();
  const { kind } = props;
  const { redirect, action = true } = props.kind === "error" ? {} : props;
  const { detail, onRetry } = props.kind === "error" ? props : {};
  if (kind === "loading" || kind === "checking-login") {
    return (
      <section className={BOX} data-status={kind} aria-busy="true">
        <output className={TITLE}>
          <span
            className="size-4 animate-spin rounded-full border-2 border-input border-t-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
          {kind === "loading"
            ? t("status.loading.title")
            : t("status.checkingLogin.title")}
        </output>
      </section>
    );
  }
  const copy = {
    "not-found": {
      title: t("status.notFound.title"),
      body: t("status.notFound.body"),
    },
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
    error: {
      title: t("status.error.title"),
      body: t(detail ?? "error.UNKNOWN"),
    },
  }[kind];
  const alert = kind === "forbidden" || kind === "error";
  return (
    <section
      className={cn(
        BOX,
        alert && "border-[var(--ap-tone-danger-border)]",
        kind === "bootstrap-required" &&
          "border-[var(--ap-tone-attention-border)]",
      )}
      data-status={kind}
      role={alert ? "alert" : undefined}
    >
      <h2 className={TITLE}>{copy.title}</h2>
      <p className="m-0">{copy.body}</p>
      {kind === "login-required" && action ? (
        <Button asChild>
          <Link to="/login" search={redirect ? { redirect } : {}}>
            {t("status.loginRequired.action")}
          </Link>
        </Button>
      ) : null}
      {kind === "not-found" ? (
        <Button asChild>
          <Link to="/">{t("status.notFound.action")}</Link>
        </Button>
      ) : null}
      {kind === "bootstrap-required" && action ? (
        <Button asChild>
          <Link to="/bootstrap">{t("status.bootstrapRequired.action")}</Link>
        </Button>
      ) : null}
      {kind === "error" && onRetry ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </section>
  );
}

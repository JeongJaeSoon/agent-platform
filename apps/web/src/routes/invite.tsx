import {
  type ApiError,
  CSRF_HEADER_VALUE,
  isApiError,
  unwrap,
} from "@agent-platform/client";
import { acceptInviteStep } from "@agent-platform/core/forms";
import {
  formAlerts,
  submitStep,
  useAgentPlatform,
  useStepForm,
  useStepper,
} from "@agent-platform/react";
import {
  Button,
  buttonVariants,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Stepper,
} from "@agent-platform/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { viewerQuery } from "../api/queries.ts";
import {
  DISPLAY_NAME_MAX,
  INVITE_TOKEN_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../auth/limits.ts";
import { AuthPage, FormError } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { FunnelResetNotice, useFunnel } from "../funnel/tanstack-funnel.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

const BOX =
  "flex flex-col items-start gap-3 rounded-md border bg-card p-4 text-card-foreground";
const BOX_TITLE = "m-0 font-semibold text-lg";
const BOX_BODY = "m-0 text-muted-foreground";

function InviteStatus({
  status,
  title,
  body,
  alert = false,
  children,
}: {
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly alert?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <section
      className={BOX}
      data-status={status}
      role={alert ? "alert" : undefined}
    >
      <h2 className={BOX_TITLE}>{title}</h2>
      <p className={BOX_BODY}>{body}</p>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </section>
  );
}

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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
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
      <InviteStatus
        status="invite-member"
        title={t("invite.member.title")}
        body={t("invite.member.body", {
          workspace: viewer.data.workspace?.name ?? "",
          email: viewer.data.user?.email ?? "",
        })}
      >
        <Link className={buttonVariants()} to="/">
          {t("invite.member.home")}
        </Link>
        <Button
          type="button"
          variant="outline"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          {t("invite.member.switch")}
        </Button>
        {logout.error ? (
          <FormError>
            {t("common.logoutFailed")} {t(errorKey(logout.error.code))}
          </FormError>
        ) : null}
      </InviteStatus>
    );
  } else if (
    // A link cut short or made up has a token the server can only call an
    // invalid request, so its length is checked here.
    token.length < INVITE_TOKEN_LENGTH.min ||
    token.length > INVITE_TOKEN_LENGTH.max
  ) {
    body = (
      <InviteStatus
        status="invite-invalid"
        alert
        title={t("invite.invalid.title")}
        body={t("invite.invalid.body")}
      />
    );
  } else body = <AcceptFlow key={token} token={token} />;

  return <AuthPage title={t("invite.title")}>{body}</AuthPage>;
}

type Account = "existing" | "new";

type AcceptSteps = {
  account: { account?: Account };
  password: { account: Account };
};

const isObject = (data: unknown): data is AcceptSteps["account"] =>
  typeof data === "object" && data !== null;
const hasAccount = (data: unknown): data is AcceptSteps["password"] =>
  isObject(data) &&
  ((data as { account?: unknown }).account === "existing" ||
    (data as { account?: unknown }).account === "new");

/*
 * Which account the reader says they have only shapes the form (autofill, the
 * name field); the request is the same either way. The password never goes
 * into the flow's stored input, so a reload on the second step asks for it
 * again.
 */
function AcceptFlow({ token }: { readonly token: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const funnel = useFunnel<AcceptSteps>({
    id: "accept",
    initial: { step: "account", context: {} },
    steps: {
      account: { guard: isObject },
      password: { guard: hasAccount },
    },
  });
  const stepper = useStepper({
    steps: [
      { id: "account", label: t("invite.step.account") },
      { id: "password", label: t("invite.step.password") },
    ],
    currentStepId: funnel.step,
    onStepSelect: () => void funnel.history.back(),
  });

  const accept = useMutation<
    unknown,
    ApiError,
    { password: string; display_name?: string | undefined }
  >({
    // A 401 here is a wrong password, not an ended session.
    meta: { public: true },
    mutationFn: ({ password, display_name }) =>
      unwrap(
        client.POST("/v1/invites/accept", {
          params: { header: { "X-Requested-With": CSRF_HEADER_VALUE } },
          body: { token, password, ...(display_name ? { display_name } : {}) },
        }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/" });
    },
  });

  if (accept.error?.code === "INVITE_EXPIRED") {
    return (
      <InviteStatus
        status="invite-expired"
        alert
        title={t("invite.expired.title")}
        body={t("invite.expired.body")}
      />
    );
  }
  if (accept.error?.code === "INVITE_USED") {
    return (
      <InviteStatus
        status="invite-used"
        alert
        title={t("invite.used.title")}
        body={t("invite.used.body")}
      >
        <Link className={buttonVariants()} to="/login">
          {t("invite.used.login")}
        </Link>
      </InviteStatus>
    );
  }

  return (
    <>
      <FunnelResetNotice funnel={funnel} />
      <Stepper label={t("invite.steps")} {...stepper} />
      <funnel.Render
        account={({ history }) => (
          <AccountStep
            onPick={(account) => void history.push("password", { account })}
          />
        )}
        password={({ context, history }) => (
          <PasswordStep
            account={context.account}
            pending={accept.isPending}
            send={(values) => accept.mutateAsync(values)}
            onBack={() => void history.back()}
          />
        )}
      />
    </>
  );
}

function AccountStep({
  onPick,
}: {
  readonly onPick: (account: Account) => void;
}) {
  const { t } = useI18n();
  const questionId = useId();
  return (
    <section className="flex flex-col gap-3" aria-labelledby={questionId}>
      <p className="m-0">{t("invite.intro")}</p>
      <h2 id={questionId} className="m-0 font-semibold text-base">
        {t("invite.account.question")}
      </h2>
      <Button type="button" onClick={() => onPick("existing")}>
        {t("invite.account.existing")}
      </Button>
      <Button type="button" variant="outline" onClick={() => onPick("new")}>
        {t("invite.account.new")}
      </Button>
    </section>
  );
}

const FIELDS = ["password", "display_name"] as const;

function PasswordStep({
  account,
  pending,
  send,
  onBack,
}: {
  readonly account: Account;
  readonly pending: boolean;
  readonly send: (values: {
    password: string;
    display_name?: string | undefined;
  }) => Promise<unknown>;
  readonly onBack: () => void;
}) {
  const { t } = useI18n();
  const form = useStepForm(acceptInviteStep, {
    defaultValues: { password: "", display_name: "" },
  });
  const { errors } = form.formState;
  const alerts = formAlerts(errors, FIELDS);

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submitStep(form, send, (error) =>
        isApiError(error, "UNAUTHORIZED")
          ? t("invite.wrongPassword")
          : t(errorKey(isApiError(error) ? error.code : "UNKNOWN")),
      )}
    >
      {alerts.map((alert) => (
        <FormError key={alert}>{alert}</FormError>
      ))}
      <Field>
        <FieldLabel>{t("invite.password")}</FieldLabel>
        <Input
          type="password"
          autoComplete={
            account === "existing" ? "current-password" : "new-password"
          }
          {...form.register("password")}
        />
        <FieldDescription>
          {t("invite.passwordHint", { min: PASSWORD_MIN_LENGTH })}
        </FieldDescription>
        <FieldError>{errors.password?.message}</FieldError>
      </Field>
      {account === "new" ? (
        <Field>
          <FieldLabel>{t("invite.displayName")}</FieldLabel>
          <Input
            type="text"
            autoComplete="name"
            maxLength={DISPLAY_NAME_MAX}
            {...form.register("display_name")}
          />
          <FieldDescription>{t("invite.displayNameHint")}</FieldDescription>
          <FieldError>{errors.display_name?.message}</FieldError>
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          {t("invite.back")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("invite.submitting") : t("invite.submit")}
        </Button>
      </div>
    </form>
  );
}

import { type ApiError, unwrap } from "@agent-platform/client";
import type { MemberView, WorkspaceRole } from "@agent-platform/contracts";
import { inviteStep } from "@agent-platform/core/forms";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Input,
  NativeSelect,
  NativeSelectOption,
  Stepper,
} from "@agent-platform/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { queryKeys } from "../api/queries.ts";
import {
  ReasonButton,
  roleLabel,
  useRole,
  WORKSPACE_ROLE_VALUES,
} from "../auth/guard.tsx";
import { FormError, NOTICE } from "../components/auth-page.tsx";
import { copyText } from "../components/copy.ts";
import { useDialogFunnel } from "../funnel/tanstack-funnel.tsx";
import { useI18n } from "../i18n/i18n.tsx";

// The least authority; anything more is a choice the inviter makes.
const DEFAULT_INVITE_ROLE: WorkspaceRole = "member";

type InviteSteps = {
  details: { expires?: string };
  link: { expires: string };
};

const isObject = (data: unknown): data is InviteSteps["details"] =>
  typeof data === "object" && data !== null;
const hasExpiry = (data: unknown): data is InviteSteps["link"] =>
  isObject(data) && typeof (data as { expires?: unknown }).expires === "string";

/** Opens the invite flow: who and with which role, then the link to hand over. */
export function InviteDialog({
  reason,
  members,
  refusal,
}: {
  readonly reason: string | undefined;
  readonly members: readonly MemberView[];
  /** Words a refused request the way the page words a disabled action. */
  readonly refusal: (error: ApiError, role: string | undefined) => string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* As the trigger, the button gets the focus back when the dialog closes. */}
      <DialogTrigger asChild>
        <ReasonButton
          type="button"
          className={buttonVariants()}
          reason={reason}
        >
          {t("members.invite.submit")}
        </ReasonButton>
      </DialogTrigger>
      <DialogContent>
        <InviteFlow members={members} refusal={refusal} />
      </DialogContent>
    </Dialog>
  );
}

type Outcome =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

/*
 * Mounted while the dialog is open, so each opening starts on the first
 * step. The link holds a token that works once: it stays in this component
 * and never goes into the flow's stored input, where history would keep it.
 */
function InviteFlow({
  members,
  refusal,
}: {
  readonly members: readonly MemberView[];
  readonly refusal: (error: ApiError, role: string | undefined) => string;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [url, setUrl] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  // A request still out when the dialog closes must not move the next opening.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const funnel = useDialogFunnel<InviteSteps>({
    id: "invite",
    initial: { step: "details", context: {} },
    steps: {
      details: { guard: isObject },
      link: { guard: hasExpiry },
    },
  });
  const stepper = useStepper({
    steps: [
      { id: "details", label: t("members.invite.step.details") },
      { id: "link", label: t("members.invite.step.link") },
    ],
    currentStepId: funnel.step,
  });

  const invite = useMutation<
    { invite_token: string; expires_at: string },
    ApiError,
    { email: string; role: WorkspaceRole }
  >({
    mutationFn: (body) => unwrap(client.POST("/v1/invites", { body })),
    onSuccess: async (created) => {
      if (mounted.current) {
        setUrl(
          `${window.location.origin}/invite/${encodeURIComponent(created.invite_token)}`,
        );
        await funnel.history.push("link", { expires: created.expires_at });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites });
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("members.invite.title")}</DialogTitle>
        <DialogDescription>{t("members.invite.description")}</DialogDescription>
      </DialogHeader>
      <Stepper label={t("members.invite.steps")} {...stepper} />
      <funnel.Render
        details={() => (
          <DetailsStep
            members={members}
            pending={invite.isPending}
            send={(values) => invite.mutateAsync(values)}
            serverMessage={(error) => refusal(error as ApiError, role)}
          />
        )}
        link={({ context, history }) =>
          url === null ? (
            // Forward into a link step from an earlier opening: its link
            // was never kept, so the flow starts over.
            <StartOver onStart={() => void history.replace("details", {})} />
          ) : (
            <div className="flex flex-col gap-4" data-testid="invite-link">
              <Field>
                <FieldLabel>{t("members.invite.link")}</FieldLabel>
                <LinkFocus target={linkRef} />
                <Input
                  ref={linkRef}
                  className="font-mono"
                  type="text"
                  readOnly
                  value={url}
                  onFocus={(event) => event.target.select()}
                />
                <FieldDescription>
                  {t("members.invite.linkOnce", {
                    expires: formatTimestamp(context.expires, locale),
                  })}
                </FieldDescription>
              </Field>
              {outcome?.kind === "error" ? (
                <FormError>{outcome.text}</FormError>
              ) : outcome ? (
                <output className={NOTICE}>{outcome.text}</output>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setUrl(null);
                    setOutcome(null);
                    void history.replace("details", {});
                  }}
                >
                  {t("members.invite.again")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void copyText(url, linkRef).then((copied) =>
                      setOutcome(
                        copied
                          ? { kind: "notice", text: t("members.invite.copied") }
                          : {
                              kind: "error",
                              text: t("members.invite.copyFailed"),
                            },
                      ),
                    );
                  }}
                >
                  {t("members.invite.copy")}
                </Button>
                <DialogClose asChild>
                  <Button type="button">{t("members.invite.close")}</Button>
                </DialogClose>
              </DialogFooter>
            </div>
          )
        }
      />
    </>
  );
}

function StartOver({ onStart }: { readonly onStart: () => void }) {
  // Once, when the empty step shows.
  useEffect(onStart, []);
  return null;
}

/** Puts the focus on the new link, which selects it ready to copy. */
function LinkFocus({
  target,
}: {
  readonly target: RefObject<HTMLInputElement | null>;
}) {
  useEffect(() => target.current?.focus(), [target]);
  return null;
}

const FIELDS = ["email", "role"] as const;

function DetailsStep({
  members,
  pending,
  send,
  serverMessage,
}: {
  readonly members: readonly MemberView[];
  readonly pending: boolean;
  readonly send: (values: {
    email: string;
    role: WorkspaceRole;
  }) => Promise<unknown>;
  readonly serverMessage: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const form = useStepForm(inviteStep, {
    defaultValues: { email: "", role: DEFAULT_INVITE_ROLE },
  });
  const { errors } = form.formState;
  const email = form.watch("email");

  // Re-inviting someone whose membership is off leads nowhere when their
  // account has no password (Google sign-in only): the invite asks for one.
  // Enabling the membership is the way back for everyone.
  const disabledMatch = members.find(
    (member) =>
      member.disabled_at !== null &&
      member.email.toLowerCase() === email.trim().toLowerCase(),
  );

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submitStep(form, send, serverMessage)}
    >
      {formAlerts(errors, FIELDS).map((alert) => (
        <FormError key={alert}>{alert}</FormError>
      ))}
      <Field>
        <FieldLabel>{t("members.invite.email")}</FieldLabel>
        <Input type="email" autoComplete="off" {...form.register("email")} />
        {disabledMatch ? (
          <FieldDescription>
            {t("members.invite.disabledHint", {
              name: disabledMatch.display_name,
            })}
          </FieldDescription>
        ) : null}
        <FieldError>{errors.email?.message}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("members.invite.role")}</FieldLabel>
        <NativeSelect {...form.register("role")}>
          {WORKSPACE_ROLE_VALUES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {roleLabel(t, value)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldError>{errors.role?.message}</FieldError>
      </Field>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("common.cancel")}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending
            ? t("members.invite.submitting")
            : t("members.invite.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

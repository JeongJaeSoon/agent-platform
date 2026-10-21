import type { ApiError } from "@agent-platform/client";
import type {
  PendingRequest,
  SessionDetail as SessionDetailData,
} from "@agent-platform/contracts";
import {
  ApprovalCard,
  Button,
  Composer,
  ConfirmDialog,
  QuestionCard,
} from "@agent-platform/ui";
import { useId, useState } from "react";
import {
  type SessionControl,
  useAnswer,
  useSendMessage,
  useSessionControl,
} from "../sessions.ts";
import { useBlockText } from "./text.ts";

/** What a reader can do to a session from these blocks. */
export type SessionAction = "answer" | "control" | "send";

export interface SessionActionProps {
  /**
   * Why the reader may not take an action, by action. A named one is drawn
   * disabled with that reason; the server refuses it either way.
   */
  readonly unavailable?: Partial<Record<SessionAction, string>> | undefined;
  /** The host's words for a command the server refused. */
  readonly refusal?: ((error: ApiError) => string) | undefined;
}

type Outcome = { readonly kind: "notice" | "error"; readonly text: string };

function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  // Always mounted, so a screen reader hears the line when it changes.
  return (
    <output
      className={
        outcome?.kind === "error"
          ? "m-0 text-destructive text-sm"
          : "m-0 text-muted-foreground text-sm"
      }
    >
      {outcome?.text}
    </output>
  );
}

function Reason({ id, text }: { readonly id?: string; readonly text: string }) {
  return (
    <p id={id} className="m-0 text-muted-foreground text-sm">
      {text}
    </p>
  );
}

// Refusals that read the same on any host; the rest are the host's words.
const SESSION_REFUSALS = [
  "REQUEST_EXPIRED",
  "REQUEST_STALE",
  "TURN_NOT_STARTED",
  "REVISION_CONFLICT",
  "PAUSE_COMMITTING",
  "SESSION_PAUSED",
  "SESSION_RESUMING",
  "SESSION_STOPPED",
  "SESSION_CLOSED",
  "RECOVERY_REQUIRED",
] as const;

function useRefusal(refusal: SessionActionProps["refusal"]) {
  const { t } = useBlockText();
  return (error: ApiError) => {
    const code = SESSION_REFUSALS.find((known) => known === error.code);
    if (code) return t(`session.refused.${code}`);
    return refusal?.(error) ?? t("session.command.refused");
  };
}

/** The session's open requests, each answerable where it is drawn. */
export function PendingAnswers({
  sessionId,
  items,
  unavailable,
  refusal,
}: SessionActionProps & {
  readonly sessionId: string;
  readonly items: readonly PendingRequest[];
}) {
  const { t, locale } = useBlockText();
  const answer = useAnswer(sessionId);
  const refused = useRefusal(refusal);
  const [outcome, setOutcome] = useState<
    (Outcome & { readonly requestId: string }) | null
  >(null);
  const reason = unavailable?.answer;
  const busyId = answer.isPending ? answer.variables?.request_id : undefined;

  const send = (body: Parameters<typeof answer.mutate>[0]) => {
    setOutcome(null);
    answer.mutate(body, {
      onSuccess: () =>
        setOutcome({
          kind: "notice",
          requestId: body.request_id,
          text: t("session.answer.sent"),
        }),
      onError: (error) =>
        setOutcome({
          kind: "error",
          requestId: body.request_id,
          text: refused(error),
        }),
    });
  };
  const errorFor = (request: PendingRequest) =>
    outcome?.kind === "error" && outcome.requestId === request.request_id
      ? outcome.text
      : undefined;
  const expires = (at: string) => t("session.pending.expires", { at });

  return (
    <div className="flex flex-col gap-2">
      <OutcomeLine outcome={outcome?.kind === "notice" ? outcome : null} />
      {reason === undefined ? null : <Reason text={reason} />}
      {items.length === 0 ? (
        <p className="m-0 text-muted-foreground text-sm">
          {t("session.pending.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((request) => (
            <li key={request.request_id}>
              {request.kind === "permission" ? (
                <ApprovalCard
                  request={request}
                  locale={locale}
                  pending={busyId === request.request_id}
                  disabled={reason !== undefined || busyId !== undefined}
                  error={errorFor(request)}
                  messages={{
                    title: (tool) => t("session.pending.permission", { tool }),
                    input: t("session.answer.input"),
                    expires,
                    expired: t("session.pending.expired"),
                    allow: t("session.answer.allow"),
                    deny: t("session.answer.deny"),
                    denyReason: t("session.answer.denyReason"),
                    denySubmit: t("session.answer.denySubmit"),
                    cancel: t("session.answer.cancel"),
                  }}
                  onAllow={() =>
                    send({
                      request_id: request.request_id,
                      kind: "permission",
                      decision: "allow",
                    })
                  }
                  onDeny={(text) =>
                    send({
                      request_id: request.request_id,
                      kind: "permission",
                      decision: "deny",
                      reason: text,
                    })
                  }
                />
              ) : (
                <QuestionCard
                  request={request}
                  locale={locale}
                  pending={busyId === request.request_id}
                  disabled={reason !== undefined || busyId !== undefined}
                  error={errorFor(request)}
                  messages={{
                    title: t("session.pending.question"),
                    expires,
                    expired: t("session.pending.expired"),
                    freeText: t("session.answer.freeText"),
                    unanswered: t("session.answer.unanswered"),
                    submit: t("session.answer.submit"),
                  }}
                  onSubmit={(answers) =>
                    send({
                      request_id: request.request_id,
                      kind: "question",
                      answers,
                    })
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ControlAction = SessionControl["action"];

/**
 * The commands an admission state takes. Recovery decisions are their own
 * screen; a closed or stopping session takes nothing here.
 */
function actionsFor(session: SessionDetailData): readonly ControlAction[] {
  switch (session.admission_state) {
    case "active":
      return session.current_turn_id === null
        ? ["pause", "terminate"]
        : ["interrupt", "pause", "terminate"];
    case "pausing":
    case "paused":
      return ["resume", "terminate"];
    case "resuming":
    case "recovery_required":
      return ["terminate"];
    case "stopped":
      return ["resume"];
    case "stopping":
    case "closed":
      return [];
  }
}

function commandFor(
  action: ControlAction,
  session: SessionDetailData,
): SessionControl {
  const expected_revision = session.revision;
  switch (action) {
    case "interrupt":
      return {
        action,
        body: { target_turn_id: session.current_turn_id ?? "" },
      };
    case "pause":
      return { action, body: { expected_revision } };
    case "terminate":
      return { action, body: { expected_revision } };
    case "resume":
      return { action, body: { expected_revision } };
  }
}

export function SessionControls({
  session,
  unavailable,
  refusal,
}: SessionActionProps & { readonly session: SessionDetailData }) {
  const { t } = useBlockText();
  const control = useSessionControl(session.id);
  const refused = useRefusal(refusal);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirming, setConfirming] = useState(false);
  const reason = unavailable?.control;
  const reasonId = useId();
  const actions = actionsFor(session);

  const run = (action: ControlAction) => {
    setOutcome(null);
    control.mutate(commandFor(action, session), {
      onSuccess: () => {
        setConfirming(false);
        setOutcome({ kind: "notice", text: t("session.control.sent") });
      },
      onError: (error) => {
        setConfirming(false);
        setOutcome({ kind: "error", text: refused(error) });
      },
    });
  };

  return (
    <>
      {actions.length === 0 ? (
        <p className="m-0 text-muted-foreground text-sm">
          {t("session.control.none")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === "terminate" ? "destructive" : "outline"}
              disabled={reason !== undefined || control.isPending}
              aria-describedby={reason === undefined ? undefined : reasonId}
              onClick={() =>
                action === "terminate" ? setConfirming(true) : run(action)
              }
            >
              {t(`session.control.${action}`)}
            </Button>
          ))}
        </div>
      )}
      {reason === undefined ? null : <Reason id={reasonId} text={reason} />}
      <OutcomeLine outcome={outcome} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!control.isPending) setConfirming(open);
        }}
        title={t("session.control.terminate.title")}
        consequence={t("session.control.terminate.consequence")}
        confirmLabel={t("session.control.terminate.confirm")}
        cancelLabel={t("session.control.cancel")}
        tone="danger"
        busy={control.isPending}
        onConfirm={() => run("terminate")}
      />
    </>
  );
}

export function SessionComposer({
  session,
  unavailable,
  refusal,
}: SessionActionProps & { readonly session: SessionDetailData }) {
  const { t } = useBlockText();
  const send = useSendMessage(session.id);
  const refused = useRefusal(refusal);
  const [notice, setNotice] = useState<Outcome | null>(null);
  const inactive = session.admission_state !== "active";
  const reason =
    unavailable?.send ??
    (inactive ? t("session.composer.inactive") : undefined);

  return (
    <div className="flex flex-col gap-2">
      <Composer
        messages={{
          label: t("session.composer.label"),
          send: t("session.composer.send"),
          hint: t("session.composer.hint"),
          queued: t("session.composer.queued"),
        }}
        disabled={reason !== undefined}
        disabledReason={reason}
        pending={send.isPending}
        error={send.error ? refused(send.error) : undefined}
        onSend={async (message) => {
          setNotice(null);
          const accepted = await send.mutateAsync({ message });
          setNotice({
            kind: "notice",
            text: t("session.composer.sent", { turn: accepted.turn_id }),
          });
        }}
      />
      <OutcomeLine outcome={notice} />
    </div>
  );
}

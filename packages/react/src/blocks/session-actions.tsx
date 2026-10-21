import type { ApiError } from "@werft-ai/client";
import type {
  PendingRequest,
  SessionDetail as SessionDetailData,
} from "@werft-ai/contracts";
import {
  ApprovalCard,
  Button,
  Composer,
  ConfirmDialog,
  QuestionCard,
} from "@werft-ai/ui";
import { type Ref, useId, useLayoutEffect, useRef, useState } from "react";
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

function OutcomeLine({
  outcome,
  ref,
}: {
  readonly outcome: Outcome | null;
  readonly ref?: Ref<HTMLOutputElement>;
}) {
  // Always mounted, so a screen reader hears the line when it changes.
  return (
    <output
      ref={ref}
      tabIndex={-1}
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

/** Whether focus fell back to the page, as when its element was removed. */
export function focusLost(node: Element | null): boolean {
  const page = node?.ownerDocument;
  return page !== undefined && page.activeElement === page.body;
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
  onAnswered,
}: SessionActionProps & {
  readonly sessionId: string;
  readonly items: readonly PendingRequest[];
  readonly onAnswered?: () => void;
}) {
  const { t, locale } = useBlockText();
  const answer = useAnswer(sessionId);
  const refused = useRefusal(refusal);
  const [outcome, setOutcome] = useState<
    (Outcome & { readonly requestId: string }) | null
  >(null);
  const reason = unavailable?.answer;
  const busyId = answer.isPending ? answer.variables?.request_id : undefined;
  const listRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLOutputElement>(null);
  // The request just answered, whose card may still hold the keyboard.
  const answered = useRef<string | null>(null);

  // An answered card leaves with the next read and takes focus with it:
  // hand the keyboard to the next request, or to the notice when none is left.
  useLayoutEffect(() => {
    const id = answered.current;
    if (id === null || items.some((request) => request.request_id === id)) {
      return;
    }
    answered.current = null;
    if (!focusLost(listRef.current)) return;
    // While another answer is on its way the buttons are off; the next
    // card's folded input still takes focus.
    const root = listRef.current;
    const next =
      root?.querySelector<HTMLElement>(
        "li button:not(:disabled), li input:not(:disabled)",
      ) ?? root?.querySelector<HTMLElement>("li summary");
    (next ?? noticeRef.current)?.focus();
  }, [items]);

  const send = (body: Parameters<typeof answer.mutate>[0]) => {
    setOutcome(null);
    // Marked before the request: an event can take the card away before
    // the answer's receipt comes back.
    answered.current = body.request_id;
    answer.mutate(body, {
      onSuccess: () => {
        setOutcome({
          kind: "notice",
          requestId: body.request_id,
          text: t("session.answer.sent"),
        });
        onAnswered?.();
      },
      onError: (error) => {
        answered.current = null;
        setOutcome({
          kind: "error",
          requestId: body.request_id,
          text: refused(error),
        });
      },
    });
  };
  const errorFor = (request: PendingRequest) =>
    outcome?.kind === "error" && outcome.requestId === request.request_id
      ? outcome.text
      : undefined;
  const expires = (at: string) => t("session.pending.expires", { at });
  // An error shows on its card; once the card is gone, it shows here.
  const shownHere =
    outcome?.kind === "notice" ||
    (outcome !== null &&
      !items.some((request) => request.request_id === outcome.requestId));

  return (
    <div ref={listRef} className="flex flex-col gap-2">
      <OutcomeLine ref={noticeRef} outcome={shownHere ? outcome : null} />
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

// On the way to a state that takes different commands.
const MOVING: ReadonlySet<SessionDetailData["admission_state"]> = new Set([
  "pausing",
  "resuming",
  "stopping",
]);

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
  const actionSet = actions.join(" ");
  const groupRef = useRef<HTMLDivElement>(null);
  const outcomeRef = useRef<HTMLOutputElement>(null);
  // The commands drawn when one ran; a pause swaps its button for resume.
  const ranOn = useRef<string | null>(null);
  // Focus sits on the outcome line only until a command other than
  // terminate is drawn again.
  const parked = useRef(false);
  const moving = MOVING.has(session.admission_state);

  // A command's button may leave with the new state, taking focus with it:
  // hand the keyboard to what the session takes now, until the state the
  // command made has settled or the command was refused. Never to terminate:
  // while resuming it is the only button, and Enter would open its dialog.
  useLayoutEffect(() => {
    if (ranOn.current === null) return;
    const line = outcomeRef.current;
    if (
      focusLost(line) ||
      (parked.current && line?.ownerDocument.activeElement === line)
    ) {
      const next = groupRef.current?.querySelector<HTMLElement>(
        "button:not(:disabled):not([data-action='terminate'])",
      );
      if (next) {
        next.focus();
        parked.current = false;
      } else if (!parked.current) {
        line?.focus();
        parked.current = true;
      }
    }
    if (
      control.isError ||
      (control.isSuccess && actionSet !== ranOn.current && !moving)
    ) {
      ranOn.current = null;
      parked.current = false;
    }
  }, [actionSet, control.isError, control.isSuccess, moving]);

  // The confirm dialog gives focus back to what was focused last outside it,
  // and the terminate button that opened it may be gone by now; the outcome
  // line stays.
  const settle = (next: Outcome) => {
    if (confirming) outcomeRef.current?.focus();
    setConfirming(false);
    setOutcome(next);
  };

  const run = (action: ControlAction) => {
    setOutcome(null);
    ranOn.current = actionSet;
    control.mutate(commandFor(action, session), {
      onSuccess: () =>
        settle({ kind: "notice", text: t("session.control.sent") }),
      onError: (error) => settle({ kind: "error", text: refused(error) }),
    });
  };

  return (
    <>
      {actions.length === 0 ? (
        <p className="m-0 text-muted-foreground text-sm">
          {t("session.control.none")}
        </p>
      ) : (
        <div ref={groupRef} className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              data-action={action}
              variant={action === "terminate" ? "destructive" : "outline"}
              disabled={reason !== undefined}
              // Not `disabled` while a command runs: Chrome takes focus off a
              // disabled button, and the keyboard would lose its place.
              aria-disabled={control.isPending || undefined}
              className="aria-disabled:opacity-50"
              aria-describedby={reason === undefined ? undefined : reasonId}
              onClick={() => {
                if (control.isPending) return;
                if (action === "terminate") setConfirming(true);
                else run(action);
              }}
            >
              {t(`session.control.${action}`)}
            </Button>
          ))}
        </div>
      )}
      {reason === undefined ? null : <Reason id={reasonId} text={reason} />}
      <OutcomeLine ref={outcomeRef} outcome={outcome} />
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
        role="alertdialog"
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
  const rootRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLOutputElement>(null);

  // The send button turns off while sending and Chrome drops focus to the
  // page: give it back to the field, or to the notice if the field is off.
  // Not when the reader pointed or tabbed elsewhere meanwhile, even at blank
  // page, which leaves focus on <body> just the same.
  const keepFocus = async (sending: Promise<void>) => {
    const root = rootRef.current;
    const page = root?.ownerDocument;
    let movedOn = false;
    const away = (event: Event) => {
      if (!root?.contains(event.target as Node)) movedOn = true;
    };
    page?.addEventListener("pointerdown", away, true);
    page?.addEventListener("focusin", away, true);
    let refusal: ApiError | null = null;
    try {
      await sending;
    } catch (error) {
      refusal = error as ApiError;
    } finally {
      page?.removeEventListener("pointerdown", away, true);
      page?.removeEventListener("focusin", away, true);
    }
    const field = root?.querySelector<HTMLElement>("textarea:not(:disabled)");
    // A refusal shows under the field; with the field off (the session
    // stopped meanwhile) it shows on the notice, where focus goes.
    if (refusal && !field) setNotice({ kind: "error", text: refused(refusal) });
    if (!movedOn && focusLost(root)) (field ?? noticeRef.current)?.focus();
    if (refusal) throw refusal;
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
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
        error={
          send.error && notice?.kind !== "error"
            ? refused(send.error)
            : undefined
        }
        onSend={(message) => {
          setNotice(null);
          return keepFocus(
            send.mutateAsync({ message }).then((accepted) => {
              setNotice({
                kind: "notice",
                text: t("session.composer.sent", { turn: accepted.turn_id }),
              });
            }),
          );
        }}
      />
      <OutcomeLine ref={noticeRef} outcome={notice} />
    </div>
  );
}

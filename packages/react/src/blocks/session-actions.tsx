import type { ApiError } from "@werft-ai/client";
import type {
  PendingRequest,
  SessionDetail as SessionDetailData,
} from "@werft-ai/contracts";
import { Badge, Button, ConfirmDialog, cn } from "@werft-ai/ui";
import { type LucideIcon, Play, Power, Square } from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type Ref,
  type SetStateAction,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Pause } from "../components/console-icons.ts";
import {
  ApprovalCard,
  ApprovalRow,
  Composer,
  QuestionCard,
} from "../components/index.ts";
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

/**
 * A permission request as the full card, as one line of a list, or as a
 * list line under its session's name (`heading`), the answer at its end.
 */
export type ApprovalLayout = "card" | "row" | "summary";

type Outcome = { readonly kind: "notice" | "error"; readonly text: string };

function OutcomeLine({
  outcome,
  ref,
  className,
}: {
  readonly outcome: Outcome | null;
  readonly ref?: Ref<HTMLOutputElement>;
  readonly className?: string | undefined;
}) {
  // Always mounted, so a screen reader hears the line when it changes.
  return (
    <output
      ref={ref}
      tabIndex={-1}
      className={cn(
        outcome?.kind === "error"
          ? "m-0 text-destructive text-body"
          : "m-0 text-muted-foreground text-body",
        className,
      )}
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
    <p id={id} className="m-0 text-muted-foreground text-body">
      {text}
    </p>
  );
}

/** The summary layout's line for a request that is answered below it. */
function SummaryLine({
  heading,
  badge,
  meta,
}: {
  readonly heading: ReactNode;
  readonly badge: string;
  readonly meta: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-[var(--ap-row-padding-x)] pt-[var(--ap-row-padding-y)] pb-2">
      <p className="m-0 flex min-w-0 items-center gap-2 font-medium text-control leading-5">
        <span className="min-w-16 truncate">{heading}</span>
        <Badge variant="amber" className="min-w-0 max-w-max shrink">
          <span className="truncate">{badge}</span>
        </Badge>
      </p>
      {meta === undefined ? null : (
        <p className="m-0 text-caption text-muted-foreground leading-4 [overflow-wrap:anywhere]">
          {meta}
        </p>
      )}
    </div>
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
  showEmpty = true,
  subject,
  answerable = true,
  layout = "card",
  heading,
  meta,
}: SessionActionProps & {
  readonly sessionId: string;
  readonly items: readonly PendingRequest[];
  /** False when the reader only sees the session and may not answer for it. */
  readonly answerable?: boolean;
  readonly onAnswered?: () => void;
  readonly showEmpty?: boolean;
  /** What each request belongs to, drawn on its card's title line. */
  readonly subject?: ReactNode;
  /** How a permission request is drawn; a question is always a card. */
  readonly layout?: ApprovalLayout | undefined;
  /** The session as the summary layout's first line names it. */
  readonly heading?: ReactNode;
  /** The summary layout's second line for a request, such as its wait. */
  readonly meta?: ((request: PendingRequest) => ReactNode) | undefined;
}) {
  const { t, locale } = useBlockText();
  const summary = layout === "summary";
  const Approval = layout === "card" ? ApprovalCard : ApprovalRow;
  const short = sessionId.slice(0, 8);
  // A summary line always names its session, given a heading or not.
  const lineHeading = heading ?? subject ?? short;
  const answer = useAnswer(sessionId);
  const refused = useRefusal(refusal);
  const [outcome, setOutcome] = useState<
    (Outcome & { readonly requestId: string }) | null
  >(null);
  const reason =
    unavailable?.answer ??
    (answerable ? undefined : t("session.answer.notAnswerer"));
  // A list line has no room above it; why the reader may not answer joins
  // the line instead.
  const metaFor = (request: PendingRequest) => {
    const lead = meta?.(request);
    if (reason === undefined) return lead;
    return lead === undefined ? (
      reason
    ) : (
      <>
        {lead}
        <span aria-hidden="true"> · </span>
        {reason}
      </>
    );
  };
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
    <div
      ref={listRef}
      data-slot="pending-answers"
      className={cn("flex flex-col", summary ? null : "gap-2")}
    >
      <OutcomeLine
        ref={noticeRef}
        outcome={shownHere ? outcome : null}
        // In a list line an empty notice must not open a gap.
        className={
          summary
            ? "px-[var(--ap-row-padding-x)] [&:not(:empty)]:pt-[var(--ap-row-padding-y)]"
            : undefined
        }
      />
      {reason === undefined || summary ? null : <Reason text={reason} />}
      {items.length === 0 ? (
        showEmpty ? (
          <p className="m-0 text-muted-foreground text-body">
            {t("session.pending.empty")}
          </p>
        ) : null
      ) : (
        <ul
          className={cn(
            "m-0 flex list-none flex-col p-0",
            summary ? "divide-y" : "gap-2",
          )}
        >
          {items.map((request) => (
            <li key={request.request_id}>
              {request.kind === "permission" ? (
                <Approval
                  request={request}
                  subject={subject}
                  {...(summary
                    ? { heading: lineHeading, meta: metaFor(request) }
                    : undefined)}
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
                    allowName: (tool) =>
                      t("session.answer.allowFor", { tool, session: short }),
                    denyName: (tool) =>
                      t("session.answer.denyFor", { tool, session: short }),
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
                <>
                  {summary ? (
                    <SummaryLine
                      heading={lineHeading}
                      badge={t("session.pending.question")}
                      meta={metaFor(request)}
                    />
                  ) : subject === undefined ? null : (
                    // QuestionCard has no title-line slot yet.
                    <p className="m-0 mb-2 text-caption">{subject}</p>
                  )}
                  <div
                    className={
                      summary
                        ? "px-[var(--ap-row-padding-x)] pb-[var(--ap-row-padding-y)]"
                        : undefined
                    }
                  >
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
                  </div>
                </>
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
    case "closing":
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

const CONTROL_ICON = {
  interrupt: Square,
  pause: Pause,
  resume: Play,
  terminate: Power,
} as const satisfies Record<ControlAction, LucideIcon>;

export interface SessionControlsProps extends SessionActionProps {
  readonly session: SessionDetailData;
  /**
   * `icons` draws each command as a square icon button named by its label,
   * for a page header; `buttons` (the default) draws labelled buttons.
   */
  readonly variant?: "buttons" | "icons";
  /** Drawn before the icon buttons on their row, such as a back link. */
  readonly leading?: ReactNode;
}

export function SessionControls({
  session,
  unavailable,
  refusal,
  variant = "buttons",
  leading,
}: SessionControlsProps) {
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

  const icons = variant === "icons";
  const buttons = actions.map((action) => {
    const label = t(`session.control.${action}`);
    const Icon = CONTROL_ICON[action];
    return (
      <Button
        key={action}
        type="button"
        data-action={action}
        variant={action === "terminate" && !icons ? "destructive" : "outline"}
        disabled={reason !== undefined}
        // Not `disabled` while a command runs: Chrome takes focus off a
        // disabled button, and the keyboard would lose its place.
        aria-disabled={control.isPending || undefined}
        size={icons ? "icon-sm" : "sm"}
        className={
          icons && action === "terminate"
            ? "text-destructive hover:text-destructive aria-disabled:opacity-50"
            : "aria-disabled:opacity-50"
        }
        aria-label={icons ? label : undefined}
        // Until @werft-ai/ui has a Tooltip, the native one names the icon.
        title={icons ? label : undefined}
        aria-describedby={reason === undefined ? undefined : reasonId}
        onClick={() => {
          if (control.isPending) return;
          if (action === "terminate") setConfirming(true);
          else run(action);
        }}
      >
        {icons ? <Icon strokeWidth={1.5} aria-hidden="true" /> : label}
      </Button>
    );
  });
  const group = (
    <div ref={groupRef} className="flex flex-wrap gap-2">
      {buttons}
    </div>
  );

  return (
    <>
      {icons ? (
        // Wrapped under the title on a narrow page, the row starts at the left.
        <div className="flex min-w-0 flex-col items-start gap-1 md:items-end">
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {leading}
            {actions.length === 0 ? null : group}
          </div>
          {reason === undefined ? null : <Reason id={reasonId} text={reason} />}
          <OutcomeLine ref={outcomeRef} outcome={outcome} />
        </div>
      ) : (
        <>
          {actions.length === 0 ? (
            <p className="m-0 text-muted-foreground text-body">
              {t("session.control.none")}
            </p>
          ) : (
            group
          )}
          {reason === undefined ? null : <Reason id={reasonId} text={reason} />}
          <OutcomeLine ref={outcomeRef} outcome={outcome} />
        </>
      )}
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
  draft,
  onDraftChange,
}: SessionActionProps & {
  readonly session: SessionDetailData;
  readonly draft?: string;
  readonly onDraftChange?: Dispatch<SetStateAction<string>>;
}) {
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
        value={draft}
        onValueChange={onDraftChange}
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

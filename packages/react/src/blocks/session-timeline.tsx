import {
  presentTurnEvent,
  type TurnEventPart,
  type TurnEventPresentation,
} from "@werft-ai/contracts";
import { type ReactNode, useMemo } from "react";
import {
  Timeline,
  type TimelineEntry,
  turnSummaryText,
} from "../components/index.ts";
import type { EventStreamState, SessionEventFrame } from "../sessions.ts";
import { useBlockText } from "./text.ts";

type Translate = ReturnType<typeof useBlockText>["t"];

// The worker's own words for why it stopped waiting, each read as a duration.
const REASONS = [
  [/^No input for (\d+(?:\.\d+)?)s$/, "session.reason.idle"],
  [/^No answer arrived within (\d+(?:\.\d+)?)s$/, "session.reason.noAnswer"],
  [
    /^Turn \S+ ran past its (\d+(?:\.\d+)?)s budget/,
    "session.reason.turnBudget",
  ],
  [/ ran past its (\d+(?:\.\d+)?)s budget$/, "session.reason.stageBudget"],
] as const;

function duration(seconds: number, locale: string) {
  const minutes = seconds >= 60;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: minutes ? "minute" : "second",
    unitDisplay: "long",
    maximumFractionDigits: 0,
  }).format(minutes ? seconds / 60 : seconds);
}

/** A worker reason this screen can say in the reader's words, or null. */
export function readableReason(
  text: string,
  t: Translate,
  locale: string,
): string | null {
  if (text === "The turn ran out of time") return t("session.reason.turnOver");
  for (const [pattern, key] of REASONS) {
    const seconds = pattern.exec(text)?.[1];
    if (seconds !== undefined) {
      return t(key, { duration: duration(Number(seconds), locale) });
    }
  }
  return null;
}

// The worker's sentence moves to the folded detail, so it is still there to
// quote in a report.
function withReadableReasons(
  presentation: TurnEventPresentation,
  t: Translate,
  locale: string,
): TurnEventPresentation {
  let original: string | undefined;
  const summary = presentation.summary.map((part): TurnEventPart => {
    if (!("text" in part)) return part;
    const readable = readableReason(part.text, t, locale);
    if (readable === null) return part;
    original = part.text;
    return { text: readable };
  });
  return original === undefined
    ? presentation
    : { ...presentation, summary, detail: presentation.detail ?? original };
}

function questionOf(frame: SessionEventFrame) {
  if (frame.payload.event !== "question") return {};
  const { request_id, input } = frame.payload.data;
  const questions = (input as { questions?: unknown } | null)?.questions;
  const options = Array.isArray(questions)
    ? questions.flatMap((question: { options?: unknown }) =>
        Array.isArray(question?.options)
          ? question.options.flatMap((option: { label?: unknown }) =>
              typeof option?.label === "string" ? [option.label] : [],
            )
          : [],
      )
    : [];
  return { requestId: request_id, options };
}

/** A session's events as the timeline reads them. */
export function SessionTimeline({
  events,
  state,
  debug = false,
  request,
}: {
  readonly events: readonly SessionEventFrame[];
  readonly state: EventStreamState;
  readonly debug?: boolean;
  /** Drawn under a request's line; see `Timeline`. */
  readonly request?: ((requestId: string) => ReactNode) | undefined;
}) {
  const { t, formatMessage, locale } = useBlockText();
  const entries = useMemo(
    () =>
      events.map(
        (frame): TimelineEntry => ({
          id: frame.id,
          occurredAt: frame.occurredAt,
          turnId: frame.turnId,
          presentation: withReadableReasons(
            presentTurnEvent(frame.payload, { toolName: frame.toolName }),
            t,
            locale,
          ),
          toolCallId: eventToolCallId(frame.payload),
          ...questionOf(frame),
        }),
      ),
    [events, t, locale],
  );
  const latestStatus = entries
    .filter((_, index) => events[index]?.payload.event === "status")
    .at(-1);
  return (
    <div className="px-4">
      <output className="sr-only">
        {latestStatus
          ? turnSummaryText(latestStatus.presentation.summary, formatMessage)
          : null}
      </output>
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={{
          label: t("session.events"),
          empty: t("session.events.empty"),
          connecting: t("session.events.connecting"),
          closed: t("session.events.closed"),
          turn: (turn) => t("session.events.turn", { turn }),
          kind: (kind) => t(`session.events.kind.${kind}`),
          folded: (count) => t("session.events.folded", { count }),
          running: t("session.events.running"),
          options: t("session.events.options"),
        }}
        state={state}
        showDebug={debug}
        locale={locale}
        request={request}
      />
    </div>
  );
}

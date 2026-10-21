import { isApiError } from "@agent-platform/client";
import {
  type PendingRequest,
  presentTurnEvent,
  type SessionDetail as SessionDetailData,
  type SessionUsageResponse,
} from "@agent-platform/contracts";
import {
  Checkbox,
  Field,
  FieldLabel,
  formatTimestamp,
  SessionStatusLabel,
  StatusLabel,
  Timeline,
  type TimelineEntry,
  turnSummaryText,
} from "@agent-platform/ui";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  type EventStreamState,
  type SessionEventFrame,
  usePendingRequests,
  useSession,
  useSessionEvents,
  useSessionUsage,
} from "../sessions.ts";
import { useBlockText } from "./text.ts";

export interface SessionDetailProps {
  readonly id: string;
  /** Shown until the session arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /** Drawn under the overview: what the host lets the reader change. */
  readonly controls?: (session: SessionDetailData) => ReactNode;
}

export function SessionDetail({
  id,
  loading,
  renderError,
  controls,
}: SessionDetailProps) {
  const { t } = useBlockText();
  const session = useSession(id);
  const lostAccess =
    isApiError(session.error, "NOT_FOUND") ||
    isApiError(session.error, "FORBIDDEN");
  const detail = lostAccess ? undefined : session.data;
  const readable = detail !== undefined;
  const usage = useSessionUsage(id, readable);
  const pending = usePendingRequests(id, readable);
  const events = useSessionEvents(id, readable);

  if (detail === undefined) {
    if (session.isPending) return loading;
    if (isApiError(session.error, "NOT_FOUND")) {
      return (
        <p className="m-0 text-destructive" role="alert">
          {t("session.notFound")}
        </p>
      );
    }
    return renderError(session.error, () => void session.refetch());
  }
  return (
    <div className="flex flex-col gap-6">
      <Overview session={detail} />
      {controls?.(detail)}
      {usage.data ? (
        <Usage usage={usage.data} />
      ) : usage.error ? (
        renderError(usage.error, () => void usage.refetch())
      ) : null}
      {pending.data ? (
        <PendingRequests items={pending.data.items} />
      ) : pending.error ? (
        renderError(pending.error, () => void pending.refetch())
      ) : null}
      <Events events={events.events} state={events.state} />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="flex flex-col gap-3" aria-labelledby={titleId}>
      <h2 id={titleId} className="m-0 font-semibold text-lg">
        {title}
      </h2>
      {children}
    </section>
  );
}

type Fact = readonly [label: string, value: ReactNode];

function Facts({ rows }: { readonly rows: readonly (Fact | null)[] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.map((row) =>
        row ? (
          <div key={row[0]} className="contents">
            <dt className="font-medium text-muted-foreground">{row[0]}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{row[1]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

function Overview({ session }: { readonly session: SessionDetailData }) {
  const { t, locale } = useBlockText();
  const { attention, runtime } = session;
  return (
    <Section title={t("session.overview")}>
      <Facts
        rows={[
          [
            t("sessions.column.status"),
            <SessionStatusLabel
              key="status"
              status={session.status}
              label={t(`sessions.status.${session.status}`)}
              axisLabel={t("sessions.column.status")}
            />,
          ],
          [
            t("sessions.column.admission"),
            <StatusLabel
              key="admission"
              axis="admission"
              state={session.admission_state}
              label={t(`sessions.admission.${session.admission_state}`)}
              axisLabel={t("sessions.column.admission")}
            />,
          ],
          [
            t("sessions.column.runtime"),
            runtime
              ? `${runtime.profile_id} · ${runtime.kind} ${runtime.version}`
              : t("sessions.none"),
          ],
          [
            t("session.currentTurn"),
            session.current_turn_id ?? t("sessions.none"),
          ],
          [t("session.queuedTurns"), session.queued_turn_count],
          [t("session.updated"), formatTimestamp(session.updated_at, locale)],
          attention
            ? [
                t("session.attention"),
                <span key="attention">
                  <code>{attention.code}</code>
                  {"reason" in attention ? ` ${attention.reason}` : null}
                </span>,
              ]
            : null,
        ]}
      />
    </Section>
  );
}

function Usage({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t } = useBlockText();
  const { cost } = usage;
  return (
    <Section title={t("session.usage")}>
      <Facts
        rows={[
          [
            t("session.usage.amount"),
            <span key="amount">
              {cost.kind === "unmetered"
                ? t("session.usage.unmetered")
                : `$${cost.amount_usd}`}
              {cost.complete ? null : (
                <span className="text-muted-foreground">
                  {" "}
                  (
                  {cost.open_turn_count > 0
                    ? t("session.usage.incomplete")
                    : t("session.usage.unreported")}
                  )
                </span>
              )}
            </span>,
          ],
          [
            t("session.usage.costLimit"),
            usage.cost_limit_usd === null
              ? t("session.usage.noLimit")
              : `$${usage.cost_limit_usd}`,
          ],
          [t("session.usage.tokens"), usage.token_count],
          [
            t("session.usage.tokenLimit"),
            usage.token_limit ?? t("session.usage.noLimit"),
          ],
        ]}
      />
      {usage.budget_exceeded ? (
        <output className="rounded-md border border-[var(--ap-tone-attention-border)] bg-card px-3 py-2 text-sm">
          {t("session.usage.budgetExceeded")}
        </output>
      ) : null}
    </Section>
  );
}

function PendingRequests({
  items,
}: {
  readonly items: readonly PendingRequest[];
}) {
  const { t, locale } = useBlockText();
  return (
    <Section title={t("session.pending")}>
      {items.length === 0 ? (
        <p className="m-0 text-muted-foreground text-sm">
          {t("session.pending.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((request) => (
            <li
              key={request.request_id}
              className="flex flex-col gap-1 rounded-md border bg-card p-3 text-sm"
            >
              <span className="font-medium [overflow-wrap:anywhere]">
                {request.kind === "permission"
                  ? t("session.pending.permission", { tool: request.tool })
                  : `${t("session.pending.question")}: ${request.questions
                      .map((question) => question.prompt)
                      .join(" / ")}`}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("session.pending.expires", {
                  at: formatTimestamp(request.expires_at, locale),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Events({
  events,
  state,
}: {
  readonly events: readonly SessionEventFrame[];
  readonly state: EventStreamState;
}) {
  const { t, formatMessage, locale } = useBlockText();
  const [debug, setDebug] = useState(false);
  const entries = useMemo(
    () =>
      events.map(
        (frame): TimelineEntry => ({
          id: frame.id,
          occurredAt: frame.occurredAt,
          turnId: frame.turnId,
          presentation: presentTurnEvent(frame.payload, {
            toolName: frame.toolName,
          }),
        }),
      ),
    [events],
  );
  const latestStatus = entries
    .filter((_, index) => events[index]?.payload.event === "status")
    .at(-1);
  return (
    <Section title={t("session.events")}>
      <output className="sr-only">
        {latestStatus
          ? turnSummaryText(latestStatus.presentation.summary, formatMessage)
          : null}
      </output>
      <Field orientation="horizontal">
        <Checkbox
          checked={debug}
          onCheckedChange={(checked) => setDebug(checked === true)}
        />
        <FieldLabel>{t("session.events.debug")}</FieldLabel>
      </Field>
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={{
          label: t("session.events"),
          empty: t("session.events.empty"),
          connecting: t("session.events.connecting"),
          closed: t("session.events.closed"),
          turn: (turn) => t("session.events.turn", { turn }),
        }}
        state={state}
        showDebug={debug}
        locale={locale}
      />
    </Section>
  );
}

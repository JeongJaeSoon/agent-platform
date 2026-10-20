import type {
  AdmissionState,
  PendingRequest,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { formatTimestamp } from "@agent-platform/ui";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import type { EventStreamState, SessionEventFrame } from "./hooks.ts";
import { phaseText, type TimelineItem, timelineItems } from "./timeline.ts";

/*
 * What the session screens draw, from props alone: no fetching and no
 * services, so these move with hooks.ts and nothing else.
 */

function statusText(t: Translate, status: SessionStatus) {
  return t(`sessions.status.${status}`);
}

// Plain text, not StatusLabel: its admission icon, a rounded square, read as
// a missing-glyph box next to the word.
function Admission({ state }: { readonly state: AdmissionState }) {
  const { t } = useI18n();
  return <>{t(`sessions.admission.${state}`)}</>;
}

function runtimeText(t: Translate, session: SessionSummary) {
  const { runtime } = session;
  return runtime
    ? `${runtime.profile_id} · ${runtime.kind} ${runtime.version}`
    : t("sessions.none");
}

function when(t: Translate, at: string | null) {
  return at ? formatTimestamp(at) : t("sessions.none");
}

export function SessionTable({
  sessions,
}: {
  readonly sessions: readonly SessionSummary[];
}) {
  const { t } = useI18n();
  return (
    <div className="web-table-wrap">
      <table className="web-table">
        <thead>
          <tr>
            <th scope="col">{t("sessions.column.id")}</th>
            <th scope="col">{t("sessions.column.status")}</th>
            <th scope="col">{t("sessions.column.admission")}</th>
            <th scope="col">{t("sessions.column.runtime")}</th>
            <th scope="col">{t("sessions.column.lastEvent")}</th>
            <th scope="col">{t("sessions.column.created")}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                <Link
                  to="/sessions/$id"
                  params={{ id: session.id }}
                  className="web-table__primary"
                >
                  <code>{session.id}</code>
                </Link>
              </td>
              <td>{statusText(t, session.status)}</td>
              <td>
                <Admission state={session.admission_state} />
              </td>
              <td>{runtimeText(t, session)}</td>
              <td>{when(t, session.last_event_at)}</td>
              <td>{formatTimestamp(session.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      {children}
    </section>
  );
}

type Fact = readonly [label: string, value: React.ReactNode];

function Facts({ rows }: { readonly rows: readonly (Fact | null)[] }) {
  return (
    <div className="web-table-wrap">
      <table className="web-table">
        <tbody>
          {rows.map((row) =>
            row ? (
              <tr key={row[0]}>
                <th scope="row">{row[0]}</th>
                <td>{row[1]}</td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SessionOverview({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const { attention } = session;
  return (
    <Section title={t("session.overview")}>
      <Facts
        rows={[
          [t("sessions.column.status"), statusText(t, session.status)],
          [
            t("sessions.column.admission"),
            <Admission key="admission" state={session.admission_state} />,
          ],
          [t("sessions.column.runtime"), runtimeText(t, session)],
          [
            t("session.currentTurn"),
            session.current_turn_id ?? t("sessions.none"),
          ],
          [t("session.queuedTurns"), session.queued_turn_count],
          [t("session.updated"), formatTimestamp(session.updated_at)],
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

export function SessionUsagePanel({
  usage,
}: {
  readonly usage: SessionUsageResponse;
}) {
  const { t } = useI18n();
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
                <span className="web-table__secondary">
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
        <output className="web-notice">
          {t("session.usage.budgetExceeded")}
        </output>
      ) : null}
    </Section>
  );
}

export function PendingRequestList({
  items,
}: {
  readonly items: readonly PendingRequest[];
}) {
  const { t } = useI18n();
  return (
    <Section title={t("session.pending")}>
      {items.length === 0 ? (
        <p className="web-page__empty">{t("session.pending.empty")}</p>
      ) : (
        <ul className="web-list">
          {items.map((request) => (
            <li key={request.request_id} className="web-list__item">
              <span className="web-table__primary">
                {request.kind === "permission"
                  ? t("session.pending.permission", { tool: request.tool })
                  : `${t("session.pending.question")}: ${request.questions
                      .map((question) => question.prompt)
                      .join(" / ")}`}
              </span>
              <span className="web-table__secondary">
                {t("session.pending.expires", {
                  at: formatTimestamp(request.expires_at),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function TimelineRow({ item }: { readonly item: TimelineItem }) {
  const { t } = useI18n();
  const summaryClass = item.error ? "web-form__error" : "web-table__primary";
  return (
    <li className="web-list__item">
      <span className="web-badge" data-tone={item.error ? undefined : "muted"}>
        {item.label}
      </span>
      {item.detail ? (
        <details>
          <summary className={summaryClass}>{item.summary}</summary>
          <p className="web-table__secondary">{item.detail}</p>
        </details>
      ) : (
        <span className={summaryClass}>{item.summary}</span>
      )}
      <span className="web-table__secondary">
        {formatTimestamp(item.occurredAt)}
        {item.turnId
          ? ` · ${t("session.events.turn", { turn: item.turnId })}`
          : ""}
      </span>
    </li>
  );
}

export function SessionEventList({
  events,
  state,
}: {
  readonly events: readonly SessionEventFrame[];
  readonly state: EventStreamState;
}) {
  const { t } = useI18n();
  const [debug, setDebug] = useState(false);
  const items = timelineItems(t, events, { debug });
  const latestStatus = events
    .filter((frame) => frame.payload.event === "status")
    .at(-1);
  return (
    <Section title={t("session.events")}>
      {state === "closed" ? (
        <output className="web-notice">{t("session.events.closed")}</output>
      ) : state === "connecting" ? (
        <output className="web-notice">{t("session.events.connecting")}</output>
      ) : null}
      {/* Only status changes are announced; each event read aloud as it
          arrives would drown them. */}
      <output className="web-sr-only">
        {latestStatus?.payload.event === "status"
          ? phaseText(t, latestStatus.payload.data.phase)
          : null}
      </output>
      <label className="web-check">
        <input
          type="checkbox"
          checked={debug}
          onChange={(event) => setDebug(event.target.checked)}
        />
        <span>{t("session.events.debug")}</span>
      </label>
      {items.length === 0 ? (
        state === "open" ? (
          <p className="web-page__empty">{t("session.events.empty")}</p>
        ) : null
      ) : (
        <ol className="web-list">
          {items.map((item) => (
            <TimelineRow key={item.key} item={item} />
          ))}
        </ol>
      )}
    </Section>
  );
}

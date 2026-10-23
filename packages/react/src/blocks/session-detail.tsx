import { isApiError } from "@werft-ai/client";
import {
  presentTurnEvent,
  type SessionDetail as SessionDetailData,
  type SessionUsageResponse,
} from "@werft-ai/contracts";
import {
  Checkbox,
  Field,
  FieldLabel,
  formatTimestamp,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useDetailLayout,
} from "@werft-ai/ui";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  SessionStatusLabel,
  StatusLabel,
  Timeline,
  type TimelineEntry,
  turnSummaryText,
} from "../components/index.ts";
import {
  type EventStreamState,
  type SessionEventFrame,
  usePendingRequests,
  useSession,
  useSessionEvents,
  useSessionUsage,
} from "../sessions.ts";
import {
  PendingAnswers,
  type SessionActionProps,
  SessionComposer,
  SessionControls,
} from "./session-actions.tsx";
import { useBlockText } from "./text.ts";

export interface SessionDetailProps extends SessionActionProps {
  readonly id: string;
  readonly back?: ReactNode;
  /** Shown until the session arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /** What the host lets the reader change in the operations panel. */
  readonly controls?: (session: SessionDetailData) => ReactNode;
}

export function SessionDetail({
  id,
  back,
  loading,
  renderError,
  controls,
  unavailable,
  refusal,
}: SessionDetailProps) {
  const { t, locale } = useBlockText();
  const session = useSession(id);
  const [tab, setTab] = useState("timeline");
  const [debug, setDebug] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftFor, setDraftFor] = useState(id);
  if (draftFor !== id) {
    setDraftFor(id);
    setDraft("");
  }
  const lostAccess =
    isApiError(session.error, "NOT_FOUND") ||
    isApiError(session.error, "FORBIDDEN");
  const detail = lostAccess ? undefined : session.data;
  const readable = detail !== undefined;
  const layout = useDetailLayout(readable);
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
  const pendingCount = pending.data?.items.length;
  const hasPending = (pendingCount ?? 0) > 0;
  // The composer moves between the tab and the panel as requests come and
  // go; the draft lives here so the move does not wipe it.
  const composer = (
    <SessionComposer
      session={detail}
      unavailable={unavailable}
      refusal={refusal}
      draft={draft}
      onDraftChange={setDraft}
    />
  );
  const body = (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="min-w-0 gap-[var(--ap-space-block)]"
      key="body"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b">
        <TabsList
          variant="line"
          aria-label={t("session.tabs.label")}
          className="h-9 p-0"
        >
          <TabsTrigger
            value="timeline"
            className="h-9 text-control after:bottom-0"
          >
            {t("session.tabs.timeline")}
          </TabsTrigger>
          <TabsTrigger value="info" className="h-9 text-control after:bottom-0">
            {t("session.tabs.info")}
          </TabsTrigger>
        </TabsList>
        {tab === "timeline" ? (
          <Field orientation="horizontal" className="w-auto gap-2 text-caption">
            <Checkbox
              checked={debug}
              onCheckedChange={(checked) => setDebug(checked === true)}
            />
            <FieldLabel className="text-caption">
              {t("session.events.debug")}
            </FieldLabel>
          </Field>
        ) : null}
      </div>
      <TabsContent value="timeline" className="flex flex-col gap-4">
        <div className="min-w-0 rounded-card border bg-card">
          <Events events={events.events} state={events.state} debug={debug} />
        </div>
        {hasPending ? composer : null}
      </TabsContent>
      <TabsContent value="info">
        <div className="flex flex-col gap-3 rounded-card border bg-card p-4">
          <Overview session={detail} />
          {usage.data ? <Usage usage={usage.data} /> : null}
        </div>
      </TabsContent>
    </Tabs>
  );
  const panel = (
    <aside
      key="panel"
      aria-label={t("session.panel")}
      // Stacked above the body, the cards keep about the panel's width side
      // by side instead of stretching a question across the whole page. With
      // nothing to show, the answers block keeps its live region mounted but
      // leaves the grid, so it does not hold an empty cell.
      className={
        layout.narrow
          ? "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ap-layout-detail-panel-width)),1fr))] items-start gap-4 [&>[data-slot=pending-answers]:not(:has(li,p,output:not(:empty)))]:absolute"
          : "flex min-w-0 flex-col gap-4"
      }
    >
      {pending.data ? (
        <PendingAnswers
          sessionId={id}
          items={pending.data.items}
          showEmpty={false}
          unavailable={unavailable}
          refusal={refusal}
        />
      ) : pending.error ? (
        renderError(pending.error, () => void pending.refetch())
      ) : null}
      {pendingCount === 0 ? (
        <Section title={t("session.pending.emptyTitle")}>
          <p className="m-0 text-caption text-muted-foreground">
            {t("session.pending.empty")}
          </p>
          {composer}
        </Section>
      ) : pendingCount === undefined ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4">
          {pending.error ? null : (
            <output className="text-caption text-muted-foreground">
              {t("sessions.loadingMore")}
            </output>
          )}
          {composer}
        </div>
      ) : null}
      {usage.data ? (
        <Usage usage={usage.data} compact />
      ) : usage.error ? (
        renderError(usage.error, () => void usage.refetch())
      ) : null}
      <Section title={t("session.control")}>
        <SessionControls
          session={detail}
          unavailable={unavailable}
          refusal={refusal}
        />
        {controls?.(detail)}
      </Section>
    </aside>
  );
  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title={<span className="font-mono [overflow-wrap:anywhere]">{id}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <SessionStatusLabel
              status={detail.status}
              label={t(`sessions.status.${detail.status}`)}
              axisLabel={t("sessions.column.status")}
            />
            <span className="[overflow-wrap:anywhere]">
              {detail.runtime
                ? `${detail.runtime.profile_id} · ${detail.runtime.kind} ${detail.runtime.version}`
                : t("sessions.none")}
            </span>
            <span>
              {t("session.currentTurn")}:{" "}
              {detail.current_turn_id ?? t("sessions.none")}
            </span>
            <span>
              {t("session.updated")}:{" "}
              {formatTimestamp(detail.updated_at, locale)}
            </span>
          </span>
        }
        actions={back}
      />
      <div
        ref={layout.ref}
        data-slot="session-detail-layout"
        className={layout.className}
      >
        {layout.narrow ? [panel, body] : [body, panel]}
      </div>
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
    <section
      className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="m-0 font-semibold text-body leading-5">
        {title}
      </h2>
      {children}
    </section>
  );
}

type Fact = readonly [label: string, value: ReactNode];

function Facts({
  rows,
  compact = false,
}: {
  readonly rows: readonly (Fact | null)[];
  readonly compact?: boolean;
}) {
  return (
    <dl
      className={
        compact
          ? "m-0 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1 text-control [&_dt]:min-h-6 [&_dd]:text-right"
          : "m-0 grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-3 text-control"
      }
    >
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
  );
}

function Usage({
  usage,
  compact = false,
}: {
  readonly usage: SessionUsageResponse;
  readonly compact?: boolean;
}) {
  const { t } = useBlockText();
  const { cost } = usage;
  const content = (
    <>
      <Facts
        compact={compact}
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
          compact
            ? null
            : [
                t("session.usage.costLimit"),
                usage.cost_limit_usd === null
                  ? t("session.usage.noLimit")
                  : `$${usage.cost_limit_usd}`,
              ],
          [t("session.usage.tokens"), usage.token_count],
          compact
            ? null
            : [
                t("session.usage.tokenLimit"),
                usage.token_limit ?? t("session.usage.noLimit"),
              ],
        ]}
      />
      {usage.budget_exceeded ? (
        <output className="rounded-control border border-[var(--ap-tone-attention-border)] bg-card px-3 py-2 text-body">
          {t("session.usage.budgetExceeded")}
        </output>
      ) : null}
    </>
  );
  return compact ? (
    <Section title={t("session.usage")}>{content}</Section>
  ) : (
    content
  );
}

function Events({
  events,
  state,
  debug,
}: {
  readonly events: readonly SessionEventFrame[];
  readonly state: EventStreamState;
  readonly debug: boolean;
}) {
  const { t, formatMessage, locale } = useBlockText();
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
        }}
        state={state}
        showDebug={debug}
        locale={locale}
      />
    </div>
  );
}

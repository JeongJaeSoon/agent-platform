import { isApiError } from "@werft-ai/client";
import {
  presentTurnEvent,
  type SessionDetail as SessionDetailData,
  type SessionUsageResponse,
} from "@werft-ai/contracts";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldLabel,
  formatTimestamp,
  KeyValueList,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Section as TitledBlock,
  useDetailLayout,
} from "@werft-ai/ui";
import {
  Bot,
  Copy,
  Folder,
  Gauge,
  Lock,
  type LucideIcon,
  UserRound,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { CircleCheck, GitBranch } from "../components/console-icons.ts";
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
  actionsFor,
  PendingAnswers,
  type SessionActionProps,
  SessionComposer,
  SessionControls,
} from "./session-actions.tsx";
import { useBlockText } from "./text.ts";

/** A tab a host adds between the timeline and the info tab. */
export interface SessionDetailTab {
  readonly value: string;
  readonly label: ReactNode;
  /** Drawn muted after the label, such as how many outputs there are. */
  readonly count?: ReactNode;
  readonly content: ReactNode;
}

export interface SessionDetailProps extends SessionActionProps {
  readonly id: string;
  readonly back?: ReactNode;
  /** Shown until the session arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /** What the host lets the reader change in the operations panel. */
  readonly controls?: (session: SessionDetailData) => ReactNode;
  /** The host's own tabs, such as the session's outputs. */
  readonly tabs?: (session: SessionDetailData) => readonly SessionDetailTab[];
}

export function SessionDetail({
  id,
  back,
  loading,
  renderError,
  controls,
  tabs,
  unavailable,
  refusal,
}: SessionDetailProps) {
  const { t } = useBlockText();
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
  const hostTabs = tabs?.(detail) ?? [];
  const body = (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex min-w-0 flex-col gap-6"
      key="body"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b">
        <TabsList
          variant="line"
          aria-label={t("session.tabs.label")}
          className="h-9 gap-1 p-0"
        >
          <TabsTrigger value="timeline" className={TAB}>
            {t("session.tabs.timeline")}
          </TabsTrigger>
          {hostTabs.map((extra) => (
            <TabsTrigger key={extra.value} value={extra.value} className={TAB}>
              {extra.label}
              {extra.count === undefined ? null : (
                <span className="text-caption text-muted-foreground tabular-nums">
                  {extra.count}
                </span>
              )}
            </TabsTrigger>
          ))}
          <TabsTrigger value="info" className={TAB}>
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
      <TabsContent value="timeline" className="flex flex-1 flex-col gap-4">
        {/* Grows so the body ends where a taller panel does. */}
        <div className="min-w-0 flex-1 rounded-card border bg-card">
          <Events events={events.events} state={events.state} debug={debug} />
        </div>
        {usage.data ? <BudgetExceeded usage={usage.data} /> : null}
        <SessionComposer
          session={detail}
          unavailable={unavailable}
          refusal={refusal}
          draft={draft}
          onDraftChange={setDraft}
        />
      </TabsContent>
      {hostTabs.map((extra) => (
        <TabsContent key={extra.value} value={extra.value}>
          {extra.content}
        </TabsContent>
      ))}
      <TabsContent value="info">
        <div className="flex flex-col gap-3 rounded-card border bg-card p-4">
          <Overview session={detail} />
          {usage.data ? (
            <Usage usage={usage.data} />
          ) : usage.error ? (
            renderError(usage.error, () => void usage.refetch())
          ) : null}
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
          : // The last card grows so the panel ends where a taller body does.
            "flex min-w-0 flex-col gap-4 [&>:last-child]:flex-1"
      }
    >
      {pending.data ? (
        <PendingAnswers
          sessionId={id}
          items={pending.data.items}
          answerable={pending.data.answerable}
          showEmpty={false}
          unavailable={unavailable}
          refusal={refusal}
        />
      ) : pending.error ? (
        renderError(pending.error, () => void pending.refetch())
      ) : null}
      {pendingCount === 0 ? (
        <Section
          title={t("session.pending.emptyTitle")}
          note={t(idleNote(detail.status), {
            status: t(`sessions.status.${detail.status}`),
          })}
          mark={
            <CircleCheck
              className="size-4 shrink-0 text-[var(--ap-tone-success-fg)]"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          }
        />
      ) : pendingCount === undefined && !pending.error ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4">
          <output className="text-caption text-muted-foreground">
            {t("sessions.loadingMore")}
          </output>
        </div>
      ) : null}
      <Operations
        session={detail}
        answerable={pending.data?.answerable}
        unavailable={unavailable}
      />
      {controls ? (
        // A host's controls may draw nothing; the empty card then goes.
        <div className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 empty:hidden">
          {controls(detail)}
        </div>
      ) : null}
    </aside>
  );
  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        // Wide, the meta line wraps under the title and the commands stay
        // top right (console v4 `.page-head`); narrow, the commands wrap below.
        className="flex-wrap md:flex-nowrap"
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* A server from before titles sends none at all. */}
            {detail.title ? (
              <span className="[overflow-wrap:anywhere]">{detail.title}</span>
            ) : (
              <span className="font-mono">{id.slice(0, 8)}</span>
            )}
            <SessionStatusLabel
              status={detail.status}
              label={t(`sessions.status.${detail.status}`)}
              axisLabel={t("sessions.column.status")}
            />
          </span>
        }
        description={
          <SessionMeta
            session={detail}
            usage={usage.data}
            className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-2 text-control text-muted-foreground"
          />
        }
        actions={
          <SessionControls
            session={detail}
            unavailable={unavailable}
            refusal={refusal}
            variant="icons"
            leading={back}
          />
        }
      />
      <div
        ref={layout.ref}
        data-slot="session-detail-layout"
        className={
          layout.narrow ? layout.className : `${layout.className} items-stretch`
        }
      >
        {layout.narrow ? [panel, body] : [body, panel]}
      </div>
    </div>
  );
}

// Console v4 `.tab`: 36px, 8px each side, the underline inset to the text.
const TAB =
  "h-9 text-control group-data-[variant=line]/tabs-list:px-2 group-data-[orientation=horizontal]/tabs:after:inset-x-2 group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]";

function idleNote(status: SessionDetailData["status"]) {
  switch (status) {
    case "idle":
      return "session.pending.note.idle";
    case "queued":
    case "running":
    case "needs_input":
      return "session.pending.note.running";
    case "failed":
    case "stopped":
      return "session.pending.note.ended";
  }
}

/**
 * The header's one line: id to copy, agent, who started it, repository,
 * model and cost so far. What the session's API does not carry yet says so.
 */
function SessionMeta({
  session,
  usage,
  className,
}: {
  readonly session: SessionDetailData;
  readonly usage: SessionUsageResponse | undefined;
  readonly className: string;
}) {
  const { t } = useBlockText();
  const [copied, setCopied] = useState(false);
  const label = t("session.id.copy");
  return (
    <span className={className}>
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-caption">{session.id.slice(0, 8)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          onClick={() => {
            void navigator.clipboard?.writeText(session.id).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          <Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        </Button>
        <output className="sr-only">
          {copied ? t("session.id.copied") : null}
        </output>
      </span>
      <MetaItem icon={Bot}>
        {t("session.meta.unknown", { label: t("session.info.agent") })}
      </MetaItem>
      <MetaItem icon={UserRound}>
        {t("session.meta.unknown", { label: t("session.info.startedBy") })}
      </MetaItem>
      <MetaItem
        icon={session.repository_id === null ? Folder : GitBranch}
        label={t("session.meta.repository")}
      >
        {session.repository_id ?? t("session.repository.none")}
      </MetaItem>
      <MetaItem icon={Lock} label={t("session.meta.model")}>
        <span className="font-mono text-caption">
          {session.runtime?.model ?? t("sessions.none")}
        </span>
      </MetaItem>
      {usage ? (
        <MetaItem icon={Gauge} label={t("session.usage")}>
          {usage.cost.kind === "unmetered"
            ? t("session.usage.unmetered")
            : `$${usage.cost.amount_usd}`}
        </MetaItem>
      ) : null}
    </span>
  );
}

function MetaItem({
  icon: Icon,
  label,
  children,
}: {
  readonly icon: LucideIcon;
  /** Read before the value; text that names itself needs none. */
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 [overflow-wrap:anywhere]">
      <Icon
        className="size-3.5 shrink-0"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      {label ? <span className="sr-only">{label}: </span> : null}
      {children}
    </span>
  );
}

function Section({
  title,
  note,
  mark,
  children,
}: {
  readonly title: string;
  /** The line under the title. */
  readonly note?: string;
  /** Drawn at the head's far end, such as a done mark. */
  readonly mark?: ReactNode;
  readonly children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4"
      aria-labelledby={titleId}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="m-0 font-semibold text-body leading-5">
            {title}
          </h2>
          {note ? (
            <p className="m-0 text-caption text-muted-foreground leading-[1.5]">
              {note}
            </p>
          ) : null}
        </div>
        {mark}
      </div>
      {children}
    </section>
  );
}

/**
 * Who may answer and what the reader may do to the session. The API names
 * no answerers, so the rule stands in for a list; the commands themselves
 * stay in the header.
 */
function Operations({
  session,
  answerable,
  unavailable,
}: {
  readonly session: SessionDetailData;
  /** Unknown until the pending requests arrive. */
  readonly answerable: boolean | undefined;
  readonly unavailable: SessionActionProps["unavailable"];
}) {
  const { t } = useBlockText();
  const actions = actionsFor(session);
  return (
    <Section title={t("session.ops")}>
      <TitledBlock
        titleAs="h3"
        title={t("session.answerers")}
        description={t("session.answerers.roles")}
      >
        {answerable === undefined ? null : (
          <p className="m-0 text-body">
            {/* The same condition that turns the answer buttons off. */}
            {!answerable
              ? t("session.answerers.viewOnly")
              : (unavailable?.answer ?? t("session.answerers.you"))}
          </p>
        )}
      </TitledBlock>
      <TitledBlock
        titleAs="h3"
        title={t("session.ops.actions")}
        description={t("session.ops.actions.note")}
      >
        <KeyValueList
          items={[
            {
              label: t("session.ops.available"),
              value:
                actions.length === 0
                  ? t("session.ops.none")
                  : actions
                      .map((action) => t(`session.control.${action}`))
                      .join(" · "),
            },
            {
              label: t("session.ops.mine"),
              // The server judges each command again.
              value:
                unavailable?.control === undefined ? (
                  <Badge variant="green">{t("session.ops.allowed")}</Badge>
                ) : (
                  <span className="text-muted-foreground">
                    {unavailable.control}
                  </span>
                ),
            },
          ]}
        />
      </TitledBlock>
    </Section>
  );
}

type Fact = readonly [label: string, value: ReactNode];

function Facts({ rows }: { readonly rows: readonly (Fact | null)[] }) {
  return (
    <dl className="m-0 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-control">
      {rows.map((row) =>
        row ? (
          <div key={row[0]} className="contents">
            <dt className="text-muted-foreground">{row[0]}</dt>
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
        // Not in the session's API yet: said so rather than guessed.
        [t("session.info.agent"), t("session.info.notProvided")],
        [t("session.info.startedBy"), t("session.info.notProvided")],
        [
          t("session.meta.repository"),
          session.repository_id ?? t("session.repository.none"),
        ],
        [t("session.info.branch"), t("session.info.notProvided")],
        [
          t("session.meta.model"),
          <span key="model" className="font-mono">
            {runtime?.model ?? t("sessions.none")}
          </span>,
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

function Usage({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t } = useBlockText();
  const { cost } = usage;
  return (
    <>
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
      <BudgetExceeded usage={usage} />
    </>
  );
}

function BudgetExceeded({ usage }: { readonly usage: SessionUsageResponse }) {
  const { t } = useBlockText();
  return usage.budget_exceeded ? (
    <output className="rounded-control border border-[var(--ap-tone-attention-border)] bg-card px-3 py-2 text-body">
      {t("session.usage.budgetExceeded")}
    </output>
  ) : null;
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

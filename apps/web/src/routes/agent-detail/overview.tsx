import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import type { AgentDetail, SessionSummary } from "@werft-ai/contracts";
import {
  agentSessionsQuery,
  agentsQuery,
  usageBreakdownQuery,
} from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  OPERATIONS_MESSAGES,
  SessionRowOpener,
  SessionStatusLabel,
  StatusLabel,
} from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Card,
  cn,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Link,
  RelativeTime,
  Skeleton,
  StatCard,
} from "@werft-ai/ui";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useHasPermission } from "../../auth/guard.tsx";
import { copyText } from "../../components/copy.ts";
import { LoadFailure } from "../../components/load-failure.tsx";
import { OutcomeLine } from "../../components/outcome.tsx";
import { type Locale, useI18n } from "../../i18n/i18n.tsx";
import { usagePeriod } from "../operations.tsx";
import { credentialBindingsQuery } from "./credentials.tsx";
import { latestVersion } from "./versions.tsx";

// Console v4: section head 28px tall, 12px above its body.
const SECTION = "flex min-w-0 flex-col gap-3";
const SECTION_HEAD = "flex min-h-7 items-center justify-between gap-3";
const SECTION_TITLE = "m-0 font-semibold text-body leading-5";
const META = "m-0 text-caption text-muted-foreground";
const TERM = "m-0 text-muted-foreground";
const VALUE = "m-0 min-w-0 [overflow-wrap:anywhere]";

/** The version new sessions run, or the newest one before any release. */
export function shownVersion(detail: AgentDetail) {
  return (
    detail.versions.find(
      (version) => version.id === detail.active_release?.version_id,
    ) ?? latestVersion(detail)
  );
}

const releasedVersion = (detail: AgentDetail, version: { id: string }) =>
  detail.releases.some((release) => release.version_id === version.id);

/** A figure, nothing yet while it loads, or why there is none. */
type Reading = string | { readonly missing: string } | undefined;

/**
 * The overview's figures: who waits on an answer, what runs, what it cost.
 * The counts are the agent list's summary (GET /v1/agents, owners and admins
 * only).
 */
export function AgentGlance({ detail }: { readonly detail: AgentDetail }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const lists = useHasPermission("agent.manage");
  const agents = useQuery({ ...agentsQuery(client), enabled: lists });
  const failed = { missing: t("agents.cards.unavailable") };
  const summary = agents.data?.items.find(
    (item) => item.id === detail.agent.id,
  )?.summary;
  const count = (
    pick: (counts: NonNullable<typeof summary>) => number,
  ): Reading =>
    !lists
      ? { missing: t("agent.glance.countsWithheld") }
      : agents.isError
        ? failed
        : !agents.data
          ? undefined
          : summary
            ? String(pick(summary))
            : failed;
  return (
    <ul
      aria-label={t("agent.glance.label")}
      className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[720px]:grid-flow-col @[720px]:auto-cols-fr @[720px]:grid-cols-none"
    >
      <Figure
        label={t("agent.glance.waiting")}
        value={count((counts) => counts.needs_input_count)}
        note={t("agent.glance.waitingNote")}
      />
      <Figure
        label={t("agent.glance.running")}
        value={count((counts) => counts.running_count)}
        note={t("agent.glance.runningNote")}
      />
      <WeekCost agentId={detail.agent.id} />
    </ul>
  );
}

/**
 * The agent's cost over the last 7 days. Only the install-wide figures split
 * by agent, so only owners see a number.
 */
function WeekCost({ agentId }: { readonly agentId: string }) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const operator = useHasPermission("usage.installation_read");
  const { since, until } = usagePeriod(7);
  const breakdown = useQuery({
    ...usageBreakdownQuery(client, "installation", since, "agent", until),
    enabled: operator,
  });
  const row = breakdown.data?.rows.find((item) => item.key === agentId);
  return (
    <Figure
      label={t("agent.glance.cost")}
      badge={<Badge variant="gray">{t("usage.kpi.estimated")}</Badge>}
      value={
        !operator
          ? { missing: t("agent.glance.costWithheld") }
          : breakdown.isError
            ? { missing: t("agents.cards.unavailable") }
            : breakdown.data
              ? OPERATIONS_MESSAGES[locale].format.usd(row?.cost_usd ?? "0")
              : undefined
      }
      note={t("usage.kpi.costNote")}
    />
  );
}

function Figure({
  label,
  badge,
  value,
  note,
}: {
  readonly label: string;
  readonly badge?: ReactNode;
  readonly value: Reading;
  readonly note: string;
}) {
  const { t } = useI18n();
  const missing = typeof value === "object" ? value.missing : null;
  return (
    <li className="min-w-0">
      <StatCard
        className="h-full"
        label={label}
        badge={badge}
        value={
          value === undefined ? (
            <Skeleton lines={1} label={t("status.loading.title")} />
          ) : typeof value === "object" ? (
            // A screen reader hears the reason under it instead.
            <span aria-hidden="true">—</span>
          ) : (
            value
          )
        }
        muted={missing !== null}
        description={missing ?? note}
      />
    </li>
  );
}

type StepState = "done" | "todo";

/**
 * What stands between the agent and new sessions: credentials, a release,
 * the activation. The first open step offers the release tab, where all
 * three are done.
 */
export function AgentReadiness({
  detail,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly toRelease: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const { client } = useAgentPlatform();
  const bindings = useQuery(credentialBindingsQuery(client, detail.agent.id));
  const { agent } = detail;
  const latest = latestVersion(detail);
  const active = detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
  const refs = [
    ...new Set([
      ...(latest?.card.capabilities.credential_refs ?? []),
      ...(active?.card.capabilities.credential_refs ?? []),
    ]),
  ];
  const bound = new Set(
    (bindings.data?.items ?? [])
      .filter((binding) => binding.revoked_at === null)
      .map((binding) => binding.credential_ref),
  );
  const missing = refs.filter((ref) => !bound.has(ref));

  const credentials: {
    state: StepState | "unknown";
    desc: ReactNode;
  } =
    refs.length === 0
      ? { state: "done", desc: t("agent.ready.credentialsNone") }
      : bindings.isPending
        ? {
            state: "unknown",
            desc: <Skeleton lines={1} label={t("status.loading.title")} />,
          }
        : bindings.error
          ? { state: "unknown", desc: t("agent.ready.credentialsUnknown") }
          : missing.length === 0
            ? {
                state: "done",
                desc: t("agent.ready.credentialsBound", {
                  count: refs.length,
                }),
              }
            : {
                state: "todo",
                desc: t("agent.ready.credentialsMissing", {
                  names: missing.join(", "),
                }),
              };
  const released = detail.releases.length > 0;
  const upToDate =
    agent.active_release_id !== null &&
    latest !== undefined &&
    active !== undefined &&
    latest.id === active.id;
  // A paused or archived agent starts no session whatever its release, and
  // no screen changes the status, so its step offers nothing to press.
  const runnable = agent.status === "active";
  const steps = [
    {
      key: "credentials",
      title: t("agent.ready.credentials"),
      state: credentials.state,
      desc: credentials.desc,
    },
    {
      key: "release",
      title: t("agent.ready.release"),
      state: released ? "done" : "todo",
      desc: released
        ? t("agent.ready.releaseDone", { count: detail.releases.length })
        : t("agent.ready.releaseTodo"),
    },
    {
      key: "activate",
      title: t("agent.ready.activate"),
      state: upToDate && runnable ? "done" : "todo",
      desc: !runnable
        ? t("agent.ready.notRunnable", {
            status: t(`agents.status.${agent.status}`),
          })
        : agent.active_release_id === null
          ? t("agent.overview.notActive")
          : latest && active && latest.id !== active.id
            ? t("agent.overview.newerVersion", {
                latest: latest.version_no,
                active: active.version_no,
              })
            : t("agent.overview.upToDate"),
    },
  ] as const;
  const firstOpen = steps.findIndex((step) => step.state === "todo");
  const ready = firstOpen === -1 && credentials.state === "done";

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <div className={SECTION_HEAD}>
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agent.ready.title")}
        </h2>
        <Badge variant={ready ? "green" : "amber"}>
          {ready ? t("agent.ready.on") : t("agent.ready.todo")}
        </Badge>
      </div>
      <Card className="gap-0 p-4">
        <ol className="m-0 flex list-none flex-col p-0">
          {steps.map((step, index) => (
            <li
              key={step.key}
              data-state={step.state}
              className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-6 flex-none place-items-center rounded-full border font-semibold text-caption",
                  step.state === "done"
                    ? "border-[var(--ap-tone-success-border)] bg-[var(--ap-tone-success-bg)] text-[var(--ap-tone-success-fg)]"
                    : "border-[var(--ap-color-border-strong)] text-muted-foreground",
                )}
              >
                {step.state === "done" ? (
                  <Check className="size-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-control">
                  {step.title}
                  <span className="sr-only">
                    {" "}
                    {step.state === "done"
                      ? t("agent.ready.stepDone")
                      : step.state === "todo"
                        ? t("agent.ready.stepTodo")
                        : ""}
                  </span>
                </span>
                <span className={META}>{step.desc}</span>
              </div>
              {index === firstOpen && (step.key !== "activate" || runnable)
                ? toRelease
                : null}
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

const RECENT_COLUMNS = "minmax(0,2fr) 136px 120px minmax(0,1fr) 96px";
// Admission and release drop out; the title keeps the width at 390px.
const RECENT_NARROW_COLUMNS = "minmax(0,1fr) 116px 72px";

/** The newest sessions created for this agent that the reader can see. */
export function AgentRecentSessions({ agentId }: { readonly agentId: string }) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const titleId = useId();
  const sessions = useQuery(agentSessionsQuery(client, agentId));
  const items = sessions.data?.items;
  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <div className={SECTION_HEAD}>
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agent.sessions.title")}
        </h2>
        <Link asChild className="text-control">
          <RouterLink to="/sessions">{t("agent.sessions.all")}</RouterLink>
        </Link>
      </div>
      {sessions.error ? (
        <LoadFailure
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : !items ? (
        <Card className="px-4 py-3">
          <Skeleton lines={3} label={t("status.loading.title")} />
        </Card>
      ) : items.length === 0 ? (
        <Card className="px-4 py-6 text-center text-control text-muted-foreground">
          {t("agent.sessions.empty")}
        </Card>
      ) : (
        // The row opener's focus ring sits outside the row: no overflow clipping.
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label={t("agent.sessions.title")}
            columns={RECENT_COLUMNS}
            narrowAt={640}
            narrowColumns={RECENT_NARROW_COLUMNS}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("sessions.column.id")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("sessions.column.status")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow={true}>
                {t("sessions.column.admission")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow={true}>
                {t("agent.sessions.release")}
              </GridTableColumnHeader>
              <GridTableColumnHeader align="end">
                {t("sessions.column.lastEvent")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {items.map((session) => (
              <AgentSessionRow
                key={session.id}
                session={session}
                locale={locale}
              />
            ))}
          </GridTable>
        </div>
      )}
    </section>
  );
}

function AgentSessionRow({
  session,
  locale,
}: {
  readonly session: SessionSummary;
  readonly locale: Locale;
}) {
  const { t } = useI18n();
  const shortId = session.id.slice(0, 8);
  return (
    <GridTableRow data-status={session.status}>
      <GridTableCell lines={true}>
        <SessionRowOpener
          name={t("agent.sessions.open", { name: session.title ?? shortId })}
          title={session.id}
          renderLink={({ children, ...link }) => (
            <RouterLink
              to="/sessions/$id"
              params={{ id: session.id }}
              {...link}
            >
              {children}
            </RouterLink>
          )}
        />
        <span
          className="max-w-full truncate font-medium text-link"
          title={session.title ?? session.id}
        >
          {session.title ?? shortId}
        </span>
        {session.title ? (
          <span className="font-mono text-caption text-muted-foreground">
            {shortId}
          </span>
        ) : null}
      </GridTableCell>
      <GridTableCell>
        <SessionStatusLabel
          status={session.status}
          label={t(`sessions.status.${session.status}`)}
          axisLabel={t("sessions.column.status")}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <StatusLabel
          className="whitespace-nowrap"
          axis="admission"
          state={session.admission_state}
          label={t(`sessions.admission.${session.admission_state}`)}
          axisLabel={t("sessions.column.admission")}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="sr-only">{t("agent.sessions.release")}: </span>
        {session.agent
          ? t("agent.versionLabel", {
              version: session.agent.release_version_no,
            })
          : t("agent.panel.none")}
      </GridTableCell>
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
      >
        <span className="sr-only">
          {session.last_event_at
            ? t("sessions.column.lastEvent")
            : t("sessions.column.created")}{" "}
        </span>
        {/* Above the row's opener, so hovering and focus reach it. */}
        <RelativeTime
          value={session.last_event_at ?? session.created_at}
          locale={locale}
          className="relative truncate focus-visible:-outline-offset-2!"
        />
      </GridTableCell>
    </GridTableRow>
  );
}

/** The card tab when not editing: the card in words, and as sent. */
export function CardSummary({
  detail,
  edit,
}: {
  readonly detail: AgentDetail;
  /** The button that turns this view into the editor. */
  readonly edit: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const rawId = useId();
  const [copied, setCopied] = useState<boolean | null>(null);
  const version = shownVersion(detail);
  const card = version?.card;
  const live = version !== undefined && version.id === active(detail)?.id;
  const none = t("agent.panel.none");
  const names = (items: readonly string[]) =>
    items.length === 0 ? (
      none
    ) : (
      <span className="inline-flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} variant="gray" className="font-mono font-normal">
            {item}
          </Badge>
        ))}
      </span>
    );
  const raw = card ? JSON.stringify(card, null, 2) : "";

  return (
    <div className="grid grid-cols-1 items-stretch gap-4 @[720px]:grid-cols-2">
      <section
        className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 text-card-foreground"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={titleId} className={SECTION_TITLE}>
              {t("agent.card.summaryTitle")}
            </h2>
            <span className={META}>
              {!version
                ? t("agent.noActive")
                : !live
                  ? releasedVersion(detail, version)
                    ? t("agent.card.subReleased")
                    : t("agent.card.subDraft")
                  : detail.agent.status === "active"
                    ? t("agent.card.subActive")
                    : t("agent.card.subStopped", {
                        status: t(`agents.status.${detail.agent.status}`),
                      })}
            </span>
          </div>
          <div className="flex flex-none items-center gap-2">
            {version ? (
              <Badge variant="gray" className="font-mono font-normal">
                {t("agent.versionShort", { version: version.version_no })}
              </Badge>
            ) : null}
            {edit}
          </div>
        </div>
        <dl className="m-0 grid grid-cols-1 items-baseline gap-x-4 gap-y-1 text-control sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-y-2">
          <dt className={TERM}>{t("agents.name")}</dt>
          <dd className={VALUE}>{detail.agent.name}</dd>
          <dt className={TERM}>{t("agents.slug")}</dt>
          <dd className={`${VALUE} font-mono`}>{detail.agent.slug}</dd>
          {card ? (
            <>
              <dt className={TERM}>{t("agentCard.role")}</dt>
              <dd className={VALUE}>{card.role}</dd>
              <dt className={TERM}>{t("agentCard.instructions")}</dt>
              <dd className={`${VALUE} line-clamp-3`}>{card.instructions}</dd>
              <dt className={TERM}>{t("agents.cards.credentials")}</dt>
              <dd className={VALUE}>
                {names(card.capabilities.credential_refs ?? [])}
              </dd>
              <dt className={TERM}>{t("agents.cards.mcp")}</dt>
              <dd className={VALUE}>
                {names(
                  (card.capabilities.mcp ?? []).map((server) => server.server),
                )}
              </dd>
              <dt className={TERM}>{t("agentCard.model")}</dt>
              <dd className={`${VALUE} font-mono`}>{card.model}</dd>
              <dt className={TERM}>{t("agentCard.language")}</dt>
              <dd className={VALUE}>
                {card.language === "ko" ? "한국어" : "English"}
              </dd>
              <dt className={TERM}>{t("agentCard.tools")}</dt>
              <dd className={VALUE}>
                {card.capabilities.tools === null
                  ? t("agentCard.toolsAll")
                  : names(card.capabilities.tools)}
              </dd>
              <dt className={TERM}>{t("agentCard.forbidden")}</dt>
              <dd className={VALUE}>{names(card.capabilities.forbidden)}</dd>
            </>
          ) : null}
        </dl>
        {card ? null : (
          <p className={`${META} text-control`}>{t("agent.noActive")}</p>
        )}
      </section>
      {card ? (
        <section
          className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 text-card-foreground"
          aria-labelledby={rawId}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 id={rawId} className={SECTION_TITLE}>
                {t("agent.card.raw")}
              </h2>
              <span className={META}>
                {live ? t("agent.card.rawSubActive") : t("agent.card.rawSub")}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copyText(raw, { current: null }).then(setCopied);
              }}
            >
              {copied ? (
                <Check aria-hidden="true" className="size-3.5" />
              ) : (
                <Copy aria-hidden="true" className="size-3.5" />
              )}
              {copied ? t("agent.card.copied") : t("agent.card.copy")}
            </Button>
          </div>
          <OutcomeLine
            outcome={
              copied === false
                ? { kind: "error", text: t("agent.card.copyFailed") }
                : null
            }
          />
          <pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap rounded-control border bg-muted px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]">
            {raw}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function active(detail: AgentDetail) {
  return detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
}

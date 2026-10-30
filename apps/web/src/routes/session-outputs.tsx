import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { isApiError, unwrap } from "@werft-ai/client";
import type {
  ListSessionGitHubRefusalsResponse,
  ListSessionOutcomesResponse,
  ListSessionOutputsResponse,
  SessionDetail,
  SessionGitHubAttribution,
  SessionOutcome,
} from "@werft-ai/contracts";
import { queryKeysOf } from "@werft-ai/core";
import { useAgentPlatform, useSessionUsage } from "@werft-ai/react";
import { OPERATIONS_MESSAGES } from "@werft-ai/react/components";
import {
  Badge,
  buttonVariants,
  EmptyState,
  Heading,
  Link,
  RelativeTime,
  RowLines,
  RowList,
  RowListItem,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { Download } from "lucide-react";
import { useId } from "react";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

function useSessionOutputs(session: SessionDetail) {
  const { client } = useAgentPlatform();
  return useQuery({
    // A new checkpoint is a new list.
    queryKey: [
      ...queryKeysOf(client).session(session.id),
      "outputs",
      session.checkpoint_revision,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/outputs", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionOutputsResponse>,
    retry: false,
    enabled: session.checkpoint_revision !== null,
  });
}

// Absent from a cached detail older than the field, as well as null.
const hasRepository = (session: SessionDetail) => Boolean(session.repository);

// GitHub changes a pull request after the session has stopped, and the
// server's refresher reads it once a minute, so no session event says when.
const OUTCOMES_REFETCH_MS = 60_000;

function useSessionOutcomes(session: SessionDetail) {
  const { client } = useAgentPlatform();
  return useQuery({
    queryKey: [...queryKeysOf(client).session(session.id), "outcomes"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/outcomes", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionOutcomesResponse>,
    retry: false,
    enabled: hasRepository(session),
    refetchInterval: OUTCOMES_REFETCH_MS,
  });
}

/** Pull requests and files, once both are read: the outputs tab's count. */
export function SessionOutputsCount({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const outputs = useSessionOutputs(session);
  const outcomes = useSessionOutcomes(session);
  const files =
    session.checkpoint_revision === null
      ? 0
      : (outputs.data?.items.length ?? null);
  const pulls = hasRepository(session)
    ? (outcomes.data?.items.length ?? (outcomes.error ? 0 : null))
    : 0;
  return files === null || pulls === null ? null : files + pulls;
}

/** `owner/name#7` from a pull request's URL; the repository id otherwise. */
function pullRequestName(outcome: SessionOutcome): string {
  const [, owner, name] = new URL(outcome.url).pathname.split("/");
  const repository =
    owner && name ? `${owner}/${name}` : (outcome.repository_id ?? "");
  return `${repository}#${outcome.external_id ?? ""}`;
}

const STATE_BADGE = {
  open: "blue",
  merged: "green",
  closed: "gray",
} as const;

function PullRequestRow({ outcome }: { readonly outcome: SessionOutcome }) {
  const { t, locale } = useI18n();
  const state = outcome.state as keyof typeof STATE_BADGE;
  const ended =
    outcome.state === "merged" && outcome.merged_at !== null
      ? { label: t("session.outcomes.mergedAt"), at: outcome.merged_at }
      : outcome.state === "closed" && outcome.closed_at !== null
        ? { label: t("session.outcomes.closedAt"), at: outcome.closed_at }
        : null;
  return (
    <RowListItem>
      <RowLines>
        <Text as="span" className="flex min-w-0 items-center gap-2">
          <Link
            href={outcome.url}
            target="_blank"
            rel="noreferrer"
            variant="table"
            className="font-mono [overflow-wrap:anywhere]"
          >
            {pullRequestName(outcome)}
          </Link>
          <Badge variant={STATE_BADGE[state] ?? "gray"}>
            {t(`session.outcomes.state.${state}`)}
          </Badge>
        </Text>
        <Text as="span" variant="meta">
          {ended === null ? null : (
            <>
              {ended.label} <RelativeTime value={ended.at} locale={locale} />
              {" · "}
            </>
          )}
          {outcome.state_checked_at === null ? (
            t("session.outcomes.notChecked")
          ) : (
            <>
              {t("session.outcomes.checkedAt")}{" "}
              <RelativeTime value={outcome.state_checked_at} locale={locale} />
            </>
          )}
        </Text>
        {outcome.check_error === null ? null : (
          <Text as="span" variant="meta">
            {t(`session.outcomes.checkError.${outcome.check_error}`)}
          </Text>
        )}
      </RowLines>
    </RowListItem>
  );
}

/** This session's tokens and estimated cost, as the detail reads them. */
function SessionUsageLine({ session }: { readonly session: SessionDetail }) {
  const { t, locale } = useI18n();
  const usage = useSessionUsage(session.id, true).data;
  if (usage === undefined) return null;
  const tokens = new Intl.NumberFormat(locale).format(usage.token_count);
  return (
    <Text variant="sub">
      {usage.cost.kind === "unmetered"
        ? t("session.outcomes.usageUnmetered", { tokens })
        : t("session.outcomes.usage", {
            tokens,
            cost: OPERATIONS_MESSAGES[locale].format.usd(usage.cost.amount_usd),
          })}
    </Text>
  );
}

function SessionPullRequests({
  session,
  outcomes,
}: {
  readonly session: SessionDetail;
  readonly outcomes: ReturnType<typeof useSessionOutcomes>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  if (outcomes.error && !isApiError(outcomes.error, "NOT_FOUND")) {
    return (
      <LoadFailure
        error={outcomes.error}
        onRetry={() => void outcomes.refetch()}
      />
    );
  }
  const items = outcomes.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={titleId}>
      <Heading id={titleId}>{t("session.outcomes.title")}</Heading>
      <RowList variant="joined">
        {items.map((outcome) => (
          <PullRequestRow key={outcome.id} outcome={outcome} />
        ))}
      </RowList>
      <SessionUsageLine session={session} />
    </section>
  );
}

/** The session's latest GitHub gate refusals: why, for what, and when. */
function SessionGitHubRefusals({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const titleId = useId();
  const refusals = useQuery({
    queryKey: [...queryKeysOf(client).session(session.id), "github-refusals"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/github/refusals", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionGitHubRefusalsResponse>,
    retry: false,
    enabled: hasRepository(session),
    refetchInterval: OUTCOMES_REFETCH_MS,
  });
  const items = refusals.data?.items ?? [];
  if (!hasRepository(session) || items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={titleId}>
      <Heading id={titleId}>{t("session.refusals.title")}</Heading>
      <RowList variant="joined">
        {items.map((refusal) => (
          <RowListItem key={refusal.receipt_id}>
            <RowLines>
              <Text as="span">
                {t(`agentGitHub.refusal.${refusal.reason_code}`)}
              </Text>
              <Text as="span" variant="meta">
                {t(`agentGitHub.purpose.${refusal.purpose}`)}
                {" · "}
                <RelativeTime value={refusal.created_at} locale={locale} />
              </Text>
            </RowLines>
          </RowListItem>
        ))}
      </RowList>
    </section>
  );
}

/**
 * The outputs tab: whom commits name, the pull requests the session opened
 * with its tokens and cost, recent GitHub refusals, then its `out/` files.
 */
export function SessionOutputsTab({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const outputs = useSessionOutputs(session);
  const outcomes = useSessionOutcomes(session);
  const files = outputs.data?.items ?? [];
  const pulls = outcomes.data?.items ?? [];
  const filesRead =
    session.checkpoint_revision === null || outputs.data !== undefined;
  const pullsRead =
    !hasRepository(session) ||
    outcomes.data !== undefined ||
    outcomes.error !== null;
  return (
    <div className="flex flex-col gap-[var(--ap-space-block)]">
      <SessionAttribution session={session} />
      <SessionPullRequests session={session} outcomes={outcomes} />
      <SessionGitHubRefusals session={session} />
      {filesRead && pullsRead && files.length === 0 && pulls.length === 0 ? (
        outputs.error && !isApiError(outputs.error, "NOT_FOUND") ? (
          <SessionOutputs session={session} />
        ) : (
          <EmptyState
            title={t("session.outputs.empty")}
            description={t("session.outputs.emptyHint")}
          />
        )
      ) : (
        <SessionOutputs session={session} />
      )}
    </div>
  );
}

/**
 * Whom the session's commits name besides the App. Shown only for a session
 * with a repository; a failed read leaves the line out, as the outputs do not
 * depend on it.
 */
export function SessionAttribution({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const attribution = useQuery({
    queryKey: [
      ...queryKeysOf(client).session(session.id),
      "github-attribution",
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/github/attribution", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<SessionGitHubAttribution>,
    retry: false,
    enabled: hasRepository(session),
  });
  const data = attribution.data;
  if (!hasRepository(session) || data === undefined) return null;
  return (
    <p className="m-0 text-caption text-muted-foreground">
      {data.attribution === "co_author" && data.login !== null ? (
        t("session.attribution.coAuthor", { login: data.login })
      ) : data.attribution === "unlinked" ? (
        <>
          {t("session.attribution.unlinked")}{" "}
          <Link asChild underline="always">
            <RouterLink to="/settings/linked-accounts">
              {t("session.attribution.link")}
            </RouterLink>
          </Link>
        </>
      ) : (
        t("session.attribution.appOnly")
      )}
    </p>
  );
}

/**
 * The files the session left under `out/` at its latest checkpoint, each
 * with a download link; nothing without any.
 */
function SessionOutputs({ session }: { readonly session: SessionDetail }) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const outputs = useSessionOutputs(session);

  // A session gone from view is the detail screen's to report.
  if (outputs.error && !isApiError(outputs.error, "NOT_FOUND")) {
    return (
      <LoadFailure
        error={outputs.error}
        onRetry={() => void outputs.refetch()}
      />
    );
  }
  if (outputs.isPending && session.checkpoint_revision !== null) {
    return <StatusScreen kind="loading" />;
  }
  const items = outputs.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={titleId}>
      <Heading id={titleId}>{t("session.outputs.files")}</Heading>
      <ul className="m-0 flex list-none flex-col gap-2 rounded-card border bg-card p-4">
        {items.map((item) => {
          const name = item.path.replace(/^out\//, "");
          return (
            <li
              key={item.path}
              className="flex min-w-0 items-center justify-between gap-3 text-control"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-mono [overflow-wrap:anywhere]">
                  {name}
                </span>
                <span className="text-caption text-muted-foreground">
                  {item.omitted === null
                    ? formatBytes(item.bytes, locale)
                    : `${formatBytes(item.bytes, locale)} · ${t("session.outputs.tooLarge")}`}
                </span>
              </div>
              {item.omitted === null ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href={`/v1/sessions/${encodeURIComponent(session.id)}/outputs/${encodeURIComponent(item.path)}`}
                      download={name.slice(name.lastIndexOf("/") + 1)}
                      aria-label={t("session.outputs.download", { name })}
                      className={buttonVariants({
                        variant: "outline",
                        size: "icon",
                      })}
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("session.outputs.download", { name })}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

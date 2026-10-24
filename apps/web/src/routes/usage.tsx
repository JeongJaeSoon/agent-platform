import { useQuery } from "@tanstack/react-query";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  InstallationLimitsResponse,
  UsageSummaryResponse,
  UsageSummaryScope,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  EmptyState,
  formatTimestamp,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Clock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { Page } from "../components/page.tsx";
import { type MessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { formatBytes } from "./session-outputs.tsx";

// Console v4 usage (Console.dc.html L766-783, CSS L245-248, L318-324, L336-337).
// `.kpi-label` 13px text-2, `.kpi-num` 24/32 600 -0.5px, `.meta` 12px text-3.
const KPI_LABEL = "flex items-center gap-2 text-control text-muted-foreground";
const KPI_NUM = "m-0 font-semibold text-number tracking-[-0.5px] tabular-nums";
const META = "m-0 text-caption text-subtle-foreground";

const MONTH_START = (now: Date) => `${now.toISOString().slice(0, 8)}01`;

export function usageSummaryQuery(
  client: ApiClient,
  scope: UsageSummaryScope,
  since: string,
) {
  return {
    queryKey: ["usage-summary", scope, since],
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/summary", {
          params: { query: { scope, since } },
        }),
      ) as Promise<UsageSummaryResponse>,
    // A failure shows its retry button at once, like the home's limits.
    retry: false,
  };
}

/** The usage of the viewer's sessions, and the install's for its operator. */
export function UsageScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const operator = useHasPermission("usage.installation_read");
  const [picked, setPicked] = useState<UsageSummaryScope>("me");
  const scope = operator ? picked : "me";
  // The design's period: this UTC month so far. Read on every render so a
  // page left open across the month's end asks for the new month.
  const since = MONTH_START(new Date());
  const summary = useQuery(usageSummaryQuery(client, scope, since));
  const limits = useQuery({
    queryKey: ["limits"],
    queryFn: () =>
      unwrap(client.GET("/v1/limits")) as Promise<InstallationLimitsResponse>,
    enabled: operator,
    retry: false,
  });

  return (
    <Page
      title={t("usage.title")}
      description={t(
        operator ? "usage.description.owner" : "usage.description.member",
      )}
      actions={
        operator ? (
          <SegmentedControl
            aria-label={t("usage.scope.label")}
            value={scope}
            onValueChange={(value) => setPicked(value as UsageSummaryScope)}
          >
            <SegmentedControlItem value="me">
              {t("usage.scope.me")}
            </SegmentedControlItem>
            <SegmentedControlItem value="installation">
              {t("usage.scope.installation")}
            </SegmentedControlItem>
          </SegmentedControl>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {summary.data ? <Basis summary={summary.data} /> : null}
        {summary.isPending ? (
          <KpiSkeleton />
        ) : summary.isError ? (
          <Card className="py-0">
            <LoadFailure
              error={summary.error}
              onRetry={() => void summary.refetch()}
            />
          </Card>
        ) : summary.data.session_count === 0 ? (
          <Card className="py-0">
            <EmptyState
              title={t("usage.empty.title")}
              description={t("usage.empty.body")}
            />
          </Card>
        ) : (
          <Kpis summary={summary.data} />
        )}
      </div>
      {/* The limits are the install's; only its operator may read them. */}
      {operator && !isApiError(limits.error, "FORBIDDEN") ? (
        <LimitsSection
          limits={limits.data}
          error={limits.error}
          onRetry={() => void limits.refetch()}
        />
      ) : null}
    </Page>
  );
}

/** `.banner`: what the figures count and when they were read. */
function Basis({ summary }: { readonly summary: UsageSummaryResponse }) {
  const { t, locale } = useI18n();
  const installation = summary.scope === "installation";
  const period = `${utcStamp(summary.period.since)} ~ ${utcStamp(summary.period.until).slice(5)}`;
  return (
    <Alert icon={<Clock strokeWidth={1.5} />}>
      <AlertTitle asChild>
        <p className="m-0">
          {t(
            installation
              ? "usage.basis.installationTitle"
              : "usage.basis.meTitle",
            { period },
          )}
        </p>
      </AlertTitle>
      <AlertDescription>
        {t(installation ? "usage.basis.installation" : "usage.basis.me", {
          at: formatTimestamp(summary.refreshed_at, locale),
        })}
      </AlertDescription>
    </Alert>
  );
}

/** "2026-10-01 00:00" in UTC, the zone the period is cut in. */
function utcStamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

function Kpis({ summary }: { readonly summary: UsageSummaryResponse }) {
  const { t, locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0 md:grid-cols-4">
      <Kpi
        label={t("usage.kpi.sessions")}
        value={number.format(summary.session_count)}
        note={t("usage.kpi.sessionsNote")}
      />
      <Kpi
        label={t("usage.kpi.runTime")}
        value={duration(summary.run_seconds, t)}
        note={t("usage.kpi.runTimeNote")}
      />
      <Kpi
        label={t("usage.kpi.cost")}
        tag={t("usage.kpi.estimated")}
        value={`$${summary.cost_usd}`}
        note={t(
          summary.cost_complete
            ? "usage.kpi.costNote"
            : "usage.kpi.costIncomplete",
        )}
      />
      <Kpi
        label={t("usage.kpi.tokens")}
        value={number.format(summary.token_count)}
        note={t("usage.kpi.tokensNote")}
      />
    </ul>
  );
}

function Kpi({
  label,
  tag,
  value,
  note,
}: {
  readonly label: string;
  readonly tag?: string;
  readonly value: string;
  readonly note: string;
}) {
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 p-4">
        <p className={`m-0 ${KPI_LABEL}`}>
          {label}
          {tag ? <Badge>{tag}</Badge> : null}
        </p>
        <p className={KPI_NUM}>{value}</p>
        <p className={META}>{note}</p>
      </Card>
    </li>
  );
}

function KpiSkeleton() {
  return (
    <div aria-busy="true" className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <Card key={index} className="gap-3.5 p-4">
          <Skeleton width="40%" />
          <Skeleton width="60%" height="24px" />
          <Skeleton width="80%" />
        </Card>
      ))}
    </div>
  );
}

export function duration(seconds: number, t: Translate): string {
  // A fake-model or short run lasts seconds; "0분" would read as nothing ran.
  if (seconds < 60) return t("usage.duration.seconds", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0
    ? t("usage.duration.hours", { h, m })
    : t("usage.duration.minutes", { m });
}

interface LimitRow {
  readonly name: MessageKey;
  readonly current: ReactNode;
  readonly limit: ReactNode;
  readonly note: MessageKey;
}

function LimitsSection({
  limits,
  error,
  onRetry,
}: {
  readonly limits: InstallationLimitsResponse | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    // Not a region: the table's own frame is the landmark named "한도".
    <div className="flex min-w-0 flex-col gap-[var(--ap-space-block)]">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="m-0 font-semibold text-body">
          {t("usage.limits.title")}
        </h2>
        {limits ? (
          <p className={META}>
            {t("usage.limits.meta", {
              at: formatTimestamp(limits.refreshed_at, locale),
            })}
          </p>
        ) : null}
      </div>
      {limits ? (
        <LimitsTable limits={limits} />
      ) : error ? (
        <Card className="py-0">
          <LoadFailure error={error} onRetry={onRetry} />
        </Card>
      ) : (
        <Card className="p-4">
          <Skeleton lines={3} />
        </Card>
      )}
    </div>
  );
}

function LimitsTable({
  limits,
}: {
  readonly limits: InstallationLimitsResponse;
}) {
  const { t, locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  const perSession = (
    <span className="text-subtle-foreground">
      {t("usage.limits.perSession")}
    </span>
  );
  const { limits: cap, usage } = limits;
  const rows: readonly LimitRow[] = [
    {
      name: "usage.limits.slots",
      current: (
        <Usage
          text={`${number.format(usage.execution_slots_used)} / ${number.format(cap.execution_slot_limit)}`}
          used={usage.execution_slots_used}
          limit={cap.execution_slot_limit}
        />
      ),
      limit: number.format(cap.execution_slot_limit),
      note: "usage.limits.slotsNote",
    },
    {
      name: "usage.limits.storage",
      current: (
        <Usage
          text={formatBytes(usage.storage.used_bytes, locale)}
          used={usage.storage.used_bytes}
          limit={cap.storage_limit_bytes}
        />
      ),
      limit: formatBytes(cap.storage_limit_bytes, locale),
      note: "usage.limits.storageNote",
    },
    {
      name: "usage.limits.sessionCost",
      current: perSession,
      limit: `$${cap.session_cost_limit_usd}`,
      note: "usage.limits.sessionCostNote",
    },
    {
      name: "usage.limits.sessionTokens",
      current: perSession,
      limit:
        cap.session_token_limit === null ? (
          <Badge>{t("usage.limits.notSet")}</Badge>
        ) : (
          number.format(cap.session_token_limit)
        ),
      note: "usage.limits.sessionTokensNote",
    },
    {
      name: "usage.limits.queuedInput",
      current: perSession,
      limit: t("usage.limits.queuedInputValue", {
        count: number.format(cap.queued_input_limit_per_session),
      }),
      note: "usage.limits.queuedInputNote",
    },
    {
      name: "usage.limits.maxTurn",
      current: perSession,
      limit: duration(cap.max_turn_seconds, t),
      note: "usage.limits.maxTurnNote",
    },
  ];
  return (
    <TableContainer label={t("usage.limits.title")}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("usage.limits.item")}</TableHead>
            <TableHead>{t("usage.limits.current")}</TableHead>
            <TableHead>{t("usage.limits.limit")}</TableHead>
            <TableHead>{t("usage.limits.note")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell variant="nowrap" className="font-medium">
                {t(row.name)}
              </TableCell>
              <TableCell variant="nowrap">{row.current}</TableCell>
              <TableCell variant="nowrap" className="tabular-nums">
                {row.limit}
              </TableCell>
              <TableCell variant="text" className="text-subtle-foreground">
                {t(row.note)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** The figure over a `.bar`: 6px, radius 3, a 120px track. */
function Usage({
  text,
  used,
  limit,
}: {
  readonly text: string;
  readonly used: number;
  readonly limit: number;
}) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <span className="flex flex-col gap-1">
      <span className="tabular-nums">{text}</span>
      <span
        aria-hidden="true"
        className="block h-1.5 w-[120px] overflow-hidden rounded-[3px] bg-active"
      >
        <span
          className="block h-full rounded-[3px] bg-(--ap-tone-progress-fg)"
          style={{ width: `${percent}%` }}
        />
      </span>
    </span>
  );
}

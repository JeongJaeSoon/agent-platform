import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type {
  CountSessionsResponse,
  InstallationLimitsResponse,
  UsageSummaryScope,
} from "@werft-ai/contracts";
import { usageSeriesQuery } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  InstallationLimits,
  OperationsHead,
  type OperationsTab,
  SessionCounts,
  UsageFilters,
  UsageKpis,
  type UsagePeriod,
} from "@werft-ai/react/components";
import { Card, Section } from "@werft-ai/ui";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { SESSION_FILTERS } from "./sessions.tsx";

const DAY_MS = 86_400_000;
const USAGE_STALE_MS = 60_000;

/**
 * The last `days` UTC days, today included, cut at the next UTC midnight so
 * the query key stays the same all day.
 */
export function usagePeriod(
  days: number,
  now = new Date(),
): { readonly since: string; readonly until: string } {
  const until = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return {
    since: new Date(until - days * DAY_MS).toISOString(),
    until: new Date(until).toISOString(),
  };
}

/** The scope and period picked, defaulted, with setters that keep the URL. */
function useUsageFilters() {
  const search = useSearch({ from: "/authed/operations/" });
  const navigate = useNavigate({ from: "/operations/" });
  const operator = useHasPermission("usage.installation_read");
  const scope: UsageSummaryScope = operator
    ? (search.scope ?? "installation")
    : "me";
  const days = search.days ?? 30;
  return {
    operator,
    scope,
    days,
    setScope: (next: UsageSummaryScope) =>
      void navigate({ search: (prev) => ({ ...prev, scope: next }) }),
    setDays: (next: UsagePeriod) =>
      void navigate({ search: (prev) => ({ ...prev, days: next }) }),
  };
}

/** GET /v1/limits, the installation operator's alone; others get 403. */
export function useInstallationLimits(enabled: boolean) {
  const { client } = useAgentPlatform();
  return useQuery({
    // The home's key, so the two screens share one read.
    queryKey: ["limits"],
    queryFn: () =>
      unwrap(client.GET("/v1/limits")) as Promise<InstallationLimitsResponse>,
    enabled,
    retry: false,
  });
}

const TAB_PATHS: Readonly<Record<OperationsTab, string>> = {
  overview: "/operations",
  usage: "/operations/usage",
  tools: "/operations/tools",
  limits: "/operations/limits",
};

/** The menu's head and tabs over the tab shown. */
export function OperationsLayout() {
  const operator = useHasPermission("usage.installation_read");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs: OperationsTab[] = ["overview"];
  if (operator) tabs.push("limits");
  const current =
    tabs.find((tab) => tab !== "overview" && pathname === TAB_PATHS[tab]) ??
    "overview";
  return (
    <>
      <OperationsHead
        tabs={tabs}
        current={current}
        tabLink={(tab, label) => (
          <Link to={TAB_PATHS[tab]} activeOptions={{ exact: true }}>
            {label}
          </Link>
        )}
      />
      <Outlet />
    </>
  );
}

export function OperationsOverviewScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const filters = useUsageFilters();
  const { since, until } = usagePeriod(filters.days);
  const counts = useQuery({
    queryKey: ["session-counts"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/counts"),
      ) as Promise<CountSessionsResponse>,
    refetchInterval: 30_000,
    retry: false,
  });
  const limits = useInstallationLimits(filters.operator);
  // The KPIs add up the series rather than ask the summary, which is slow over
  // a long period. The old period's figures stay while the new one is read,
  // and going back to a period read a moment ago asks nothing.
  const series = useQuery({
    ...usageSeriesQuery(client, filters.scope, since, until),
    placeholderData: keepPreviousData,
    staleTime: USAGE_STALE_MS,
  });
  return (
    <div
      aria-busy={series.isPending || undefined}
      className="flex min-w-0 flex-col gap-8"
    >
      <SessionCounts
        counts={counts.data?.counts}
        // The slot line is the installation's; it waits for the counts too.
        slots={
          !filters.operator || limits.isError
            ? undefined
            : limits.data
              ? {
                  used: limits.data.usage.execution_slots_used,
                  limit: limits.data.limits.execution_slot_limit,
                }
              : null
        }
        statusLink={(status, link) => {
          // The list has no queued tab; that count opens every session.
          const filter = SESSION_FILTERS.find((name) => name === status);
          return (
            <Link
              to="/sessions"
              search={filter ? { status: filter } : {}}
              className={link.className}
            >
              {link.children}
            </Link>
          );
        }}
        error={
          counts.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={counts.error}
                onRetry={() => void counts.refetch()}
              />
            </Card>
          ) : undefined
        }
      />
      <div>
        <UsageFilters
          {...(filters.operator
            ? { scope: filters.scope, onScopeChange: filters.setScope }
            : {})}
          days={filters.days}
          onDaysChange={filters.setDays}
        />
        <Section title={t("operations.recent", { days: filters.days })}>
          {series.isError ? (
            <Card className="py-0">
              <LoadFailure
                error={series.error}
                onRetry={() => void series.refetch()}
              />
            </Card>
          ) : (
            <UsageKpis buckets={series.data?.buckets} />
          )}
        </Section>
      </div>
    </div>
  );
}

export function OperationsLimitsScreen() {
  const operator = useHasPermission("usage.installation_read");
  const limits = useInstallationLimits(operator);
  if (!operator) return <StatusScreen kind="forbidden" />;
  return (
    <InstallationLimits
      limits={limits.data}
      error={
        limits.isError ? (
          <Card className="py-0">
            <LoadFailure
              error={limits.error}
              onRetry={() => void limits.refetch()}
            />
          </Card>
        ) : undefined
      }
    />
  );
}

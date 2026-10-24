import {
  hashKey,
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { isApiError, unwrap } from "@werft-ai/client";
import type { ListSessionsResponse, SessionStatus } from "@werft-ai/contracts";
import { queryKeys } from "@werft-ai/core";
import { useAgentPlatform, useSessions } from "@werft-ai/react";
import {
  ApprovalInbox,
  type SessionActionProps,
  SessionDetail,
} from "@werft-ai/react/blocks";
import {
  Button,
  buttonVariants,
  EmptyState,
  SearchInput,
  SegmentedControl,
  SegmentedControlItem,
} from "@werft-ai/ui";
import { ArrowLeft, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ReasonButton, useCan } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { SessionOutputs, SessionOutputsCount } from "./session-outputs.tsx";
import { matchesSessionQuery, SessionsOverview } from "./session-overview.tsx";

export function loadError(error: unknown, onRetry: () => void) {
  if (isApiError(error, "FORBIDDEN")) {
    return <StatusScreen kind="forbidden" />;
  }
  return <LoadFailure error={error} onRetry={onRetry} />;
}

const PAGE = "flex flex-col gap-[var(--ap-space-section)]";

/** The status tabs, in the order the design shows them. */
export const SESSION_FILTERS = [
  "needs_input",
  "running",
  "idle",
  "stopped",
  "failed",
] as const satisfies readonly SessionStatus[];
export type SessionFilter = (typeof SESSION_FILTERS)[number];

export interface SessionsSearch {
  /** Absent for every session, so a plain sessions link opens them all. */
  readonly status?: SessionFilter;
}

export function sessionsSearch(
  search: Record<string, unknown>,
): SessionsSearch {
  const status = SESSION_FILTERS.find((name) => name === search.status);
  return status ? { status } : {};
}

/** The console cannot start a session yet; the button says why. */
export function NewSessionButton() {
  const { t } = useI18n();
  return (
    // Narrow screens wrap the reason under the button, so the title keeps
    // the width of the row. The button keeps its own width (console v4
    // .btn) rather than stretching to the reason's.
    <div className="max-sm:w-min [&_.web-guarded]:items-end [&_.web-guarded__reason]:text-right">
      <ReasonButton
        className={buttonVariants()}
        reason={t("sessionList.newUnavailable")}
      >
        <Plus aria-hidden="true" />
        {t("sessionList.new")}
      </ReasonButton>
    </div>
  );
}

export function SessionsScreen() {
  const { t } = useI18n();
  const unavailable = useUnavailable();
  // Validated again: the root route passes the raw query through, so an
  // unknown `status` still reaches this route's search.
  const tab =
    sessionsSearch(useSearch({ from: "/authed/sessions" })).status ?? "all";
  const navigate = useNavigate({ from: "/sessions" });
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const pick = (next: string) =>
    void navigate({
      search: next === "all" ? {} : { status: next as SessionFilter },
      // Replace, not push: flipping through the filters would otherwise fill
      // the back button with filter entries.
      replace: true,
    });
  // The clear button leaves with the empty state, so focus would fall to
  // the page; it goes back to the search box instead.
  const clear = () => {
    setQuery("");
    pick("all");
    search.current?.focus();
  };
  return (
    <Page
      title={t("sessions.title")}
      description={t("sessions.intro")}
      actions={<NewSessionButton />}
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <ApprovalInbox
          layout="row"
          loading={<StatusScreen kind="loading" />}
          renderError={loadError}
          unavailable={unavailable}
          refusal={(error) => t(errorKey(error.code))}
        />
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* The per-status counts wait on an API (94S-811). */}
            <SegmentedControl
              aria-label={t("sessionList.filter.label")}
              value={tab}
              onValueChange={pick}
            >
              <SegmentedControlItem value="all">
                {t("sessionList.filter.all")}
              </SegmentedControlItem>
              {SESSION_FILTERS.map((name) => (
                <SegmentedControlItem key={name} value={name}>
                  {t(`sessions.status.${name}`)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <SearchInput
              ref={search}
              type="search"
              aria-label={t("sessionList.search")}
              placeholder={t("sessionList.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {tab === "all" ? (
            <AllSessions query={query} onClear={clear} />
          ) : (
            <SessionsInStatus
              key={tab}
              status={tab}
              query={query}
              onClear={clear}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

const STATUS_LISTS = [...queryKeys.sessions, "status"] as const;

/**
 * The session hooks and the approval inbox refresh the full list and the
 * waiting page by their exact keys, which miss the status lists; follow
 * those refreshes so an answered or stopped session leaves its tab.
 */
function useFollowListRefresh() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const followed = new Set([
      hashKey(queryKeys.sessions),
      hashKey(queryKeys.waitingSessions),
    ]);
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "invalidate" &&
        followed.has(event.query.queryHash)
      ) {
        void queryClient.invalidateQueries({ queryKey: STATUS_LISTS });
        // An invalidated query reports no further invalidation, and the full
        // list sits unmounted behind a status tab. It has no staleTime, so it
        // reads again on mount with or without the flag; clearing it keeps
        // the next refresh visible here.
        if (!event.query.isActive()) {
          event.query.setState({ isInvalidated: false });
        }
      }
    });
  }, [queryClient]);
}

function useStatusSessions(status: SessionFilter) {
  const { client } = useAgentPlatform();
  useFollowListRefresh();
  return useInfiniteQuery({
    // Under the sessions key, so what refreshes the list refreshes this too.
    queryKey: [...STATUS_LISTS, status],
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: {
            query: {
              status,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListSessionsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    retry: false,
  });
}

interface SessionsViewProps {
  readonly query: string;
  readonly onClear: () => void;
}

function AllSessions(props: SessionsViewProps) {
  return <SessionsView {...props} sessions={useSessions()} />;
}

function SessionsInStatus({
  status,
  ...props
}: SessionsViewProps & { readonly status: SessionFilter }) {
  return (
    <SessionsView
      {...props}
      status={status}
      sessions={useStatusSessions(status)}
    />
  );
}

/**
 * The caller's sessions, every status or one, a page at a time. The search
 * box has no API behind it, so it narrows only the pages read so far.
 */
function SessionsView({
  sessions,
  status,
  query,
  onClear,
}: SessionsViewProps & {
  readonly sessions: UseInfiniteQueryResult<InfiniteData<ListSessionsResponse>>;
  readonly status?: SessionFilter;
}) {
  const { t } = useI18n();
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const shown = items.filter((session) => matchesSessionQuery(session, query));

  if (sessions.isPending) return <StatusScreen kind="loading" />;
  if (sessions.error && items.length === 0) {
    return loadError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title={
          status === undefined
            ? t("sessions.empty")
            : t("sessionList.filter.empty")
        }
      />
    );
  }
  return (
    <div className="flex flex-col items-start gap-4">
      {shown.length === 0 ? (
        <EmptyState
          className="w-full"
          title={t("sessionList.noMatch")}
          description={t("sessionList.noMatchHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={onClear}>
              {t("sessionList.clearFilters")}
            </Button>
          }
        />
      ) : (
        <SessionsOverview sessions={shown} />
      )}
      {sessions.error
        ? loadError(
            sessions.error,
            () =>
              void (sessions.isFetchNextPageError
                ? sessions.fetchNextPage()
                : sessions.refetch()),
          )
        : null}
      {sessions.hasNextPage && !sessions.isFetchNextPageError ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sessions.isFetchingNextPage}
          onClick={() => sessions.fetchNextPage()}
        >
          {sessions.isFetchingNextPage
            ? t("sessions.loadingMore")
            : t("sessions.more")}
        </Button>
      ) : null}
      <p className="m-0 text-caption text-subtle-foreground">
        {t("sessionList.shown", { count: shown.length })} ·{" "}
        {t("sessionList.searchScope")}
      </p>
    </div>
  );
}

/** Why the signed-in credential may not take each session action. */
export function useUnavailable(): SessionActionProps["unavailable"] {
  const { t } = useI18n();
  const missing = (scope: string) => t("guard.missingScope", { scope });
  const canAnswer = useCan("sessions:approve");
  const canControl = useCan("sessions:control");
  const canSend = useCan("sessions:write");
  return {
    ...(canAnswer ? {} : { answer: missing("sessions:approve") }),
    ...(canControl ? {} : { control: missing("sessions:control") }),
    ...(canSend ? {} : { send: missing("sessions:write") }),
  };
}

export function SessionDetailScreen() {
  const { t } = useI18n();
  const { id } = useParams({ from: "/authed/sessions/$id" });
  const unavailable = useUnavailable();
  return (
    <div className={PAGE}>
      <SessionDetail
        back={
          <Link
            to="/sessions"
            className={buttonVariants({ variant: "outline" })}
          >
            <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
            {t("session.back")}
          </Link>
        }
        id={id}
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        tabs={(session) => [
          {
            value: "outputs",
            label: t("session.outputs.title"),
            count: <SessionOutputsCount session={session} />,
            content: <SessionOutputs session={session} />,
          },
        ]}
        unavailable={unavailable}
        refusal={(error) => t(errorKey(error.code))}
      />
    </div>
  );
}

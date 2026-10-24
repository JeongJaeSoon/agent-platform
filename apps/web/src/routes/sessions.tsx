import {
  hashKey,
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { isApiError, unwrap } from "@werft-ai/client";
import type {
  CountSessionsResponse,
  ListSessionsResponse,
  SessionRelation,
  SessionStatus,
} from "@werft-ai/contracts";
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
  NativeSelect,
  NativeSelectOption,
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
import { SessionsOverview } from "./session-overview.tsx";

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

/** The relation filter's choices past "all", in the design's order. */
export const SESSION_RELATIONS = [
  "started",
  "shared",
  "administered",
] as const satisfies readonly SessionRelation[];
export type SessionRelationFilter = (typeof SESSION_RELATIONS)[number];

export interface SessionsSearch {
  /** Absent for every session, so a plain sessions link opens them all. */
  readonly status?: SessionFilter;
  /** Absent for every relation, the API's own default. */
  readonly relation?: SessionRelationFilter;
}

export function sessionsSearch(
  search: Record<string, unknown>,
): SessionsSearch {
  const status = SESSION_FILTERS.find((name) => name === search.status);
  const relation = SESSION_RELATIONS.find((name) => name === search.relation);
  return { ...(status ? { status } : {}), ...(relation ? { relation } : {}) };
}

/** The API's own bound on `q`; the box takes no more. */
const SEARCH_MAX = 200;
const SEARCH_SETTLE_MS = 300;

/**
 * What the search box sends: trimmed, once typing pauses, and nothing for
 * an empty box, which the API would refuse. Emptied, it applies at once.
 */
function useSearchTerm(query: string): string | undefined {
  const typed = query.trim();
  const [settled, setSettled] = useState(typed);
  useEffect(() => {
    // Emptied, the old term goes at once, so the next one waits its turn.
    if (typed === "") {
      setSettled("");
      return;
    }
    const id = setTimeout(() => setSettled(typed), SEARCH_SETTLE_MS);
    return () => clearTimeout(id);
  }, [typed]);
  return typed === "" || settled === "" ? undefined : settled;
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
  const address = sessionsSearch(useSearch({ from: "/authed/sessions" }));
  const tab = address.status ?? "all";
  const relation = address.relation;
  const navigate = useNavigate({ from: "/sessions" });
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const search = useRef<HTMLInputElement>(null);
  const counts = useSessionCounts(relation, q);
  const go = (next: SessionsSearch) =>
    void navigate({
      search: next,
      // Replace, not push: flipping through the filters would otherwise fill
      // the back button with filter entries.
      replace: true,
    });
  const pick = (next: string) =>
    go({
      ...(next === "all" ? {} : { status: next as SessionFilter }),
      ...(relation ? { relation } : {}),
    });
  const pickRelation = (next: string) =>
    go({
      ...(address.status ? { status: address.status } : {}),
      ...(next === "all" ? {} : { relation: next as SessionRelationFilter }),
    });
  // The clear button leaves with the empty state, so focus would fall to
  // the page; it goes back to the search box instead.
  const clear = () => {
    setQuery("");
    go({});
    search.current?.focus();
  };
  return (
    <Page title={t("sessions.title")} description={t("sessions.intro")}>
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <ApprovalInbox
          layout="row"
          loading={<StatusScreen kind="loading" />}
          renderError={loadError}
          unavailable={unavailable}
          refusal={(error) => t(errorKey(error.code))}
        />
        <div className="flex min-w-0 flex-col gap-4">
          {/* The groupings and their counts on the left, search on the right. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                aria-label={t("sessionList.filter.label")}
                value={tab}
                onValueChange={pick}
              >
                <SegmentedControlItem value="all" count={counts.data?.total}>
                  {t("sessionList.filter.all")}
                </SegmentedControlItem>
                {SESSION_FILTERS.map((name) => (
                  <SegmentedControlItem
                    key={name}
                    value={name}
                    count={counts.data?.counts[name]}
                  >
                    {t(`sessions.status.${name}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <NativeSelect
                aria-label={t("sessionList.relation.label")}
                value={relation ?? "all"}
                onChange={(event) => pickRelation(event.target.value)}
              >
                <NativeSelectOption value="all">
                  {t("sessionList.relation.all")}
                </NativeSelectOption>
                {SESSION_RELATIONS.map((name) => (
                  <NativeSelectOption key={name} value={name}>
                    {t(`sessionList.relation.${name}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <SearchInput
              ref={search}
              type="search"
              aria-label={t("sessionList.search")}
              placeholder={t("sessionList.search")}
              maxLength={SEARCH_MAX}
              // At the row's end, 240–280px; alone on its line, full width.
              wrapperClassName="max-w-none flex-[1_1_100%] sm:ml-auto sm:w-[260px] sm:flex-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {tab === "all" && relation === undefined && q === undefined ? (
            <AllSessions onClear={clear} />
          ) : (
            <FilteredSessions
              key={tab}
              filter={{
                ...(tab === "all" ? {} : { status: tab }),
                ...(relation ? { relation } : {}),
                ...(q ? { q } : {}),
              }}
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

interface SessionsFilter {
  readonly status?: SessionFilter;
  readonly relation?: SessionRelationFilter;
  readonly q?: string;
}

function useFilteredSessions(filter: SessionsFilter) {
  const { client } = useAgentPlatform();
  return useInfiniteQuery({
    // Under the sessions key, so what refreshes the list refreshes this too.
    queryKey: [...STATUS_LISTS, filter],
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: {
            query: { ...filter, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ) as Promise<ListSessionsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    retry: false,
  });
}

/** The tabs' numbers, for the relation and search the list is read with. */
function useSessionCounts(
  relation: SessionRelationFilter | undefined,
  q: string | undefined,
) {
  const { client } = useAgentPlatform();
  // Here, read whatever the tab: the counts follow every list refresh, and
  // so does the filtered list under the same key.
  useFollowListRefresh();
  const filter = { ...(relation ? { relation } : {}), ...(q ? { q } : {}) };
  return useQuery({
    queryKey: [...STATUS_LISTS, "counts", filter],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/counts", { params: { query: filter } }),
      ) as Promise<CountSessionsResponse>,
    retry: false,
  });
}

interface SessionsViewProps {
  readonly onClear: () => void;
}

function AllSessions(props: SessionsViewProps) {
  return <SessionsView {...props} sessions={useSessions()} />;
}

function FilteredSessions({
  filter,
  ...props
}: SessionsViewProps & { readonly filter: SessionsFilter }) {
  return (
    <SessionsView
      {...props}
      filter={filter}
      sessions={useFilteredSessions(filter)}
    />
  );
}

/** The caller's sessions for the filters picked, a page at a time. */
function SessionsView({
  sessions,
  filter = {},
  onClear,
}: SessionsViewProps & {
  readonly sessions: UseInfiniteQueryResult<InfiniteData<ListSessionsResponse>>;
  readonly filter?: SessionsFilter;
}) {
  const { t } = useI18n();
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];

  if (sessions.isPending) return <StatusScreen kind="loading" />;
  if (sessions.error && items.length === 0) {
    return loadError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
    if (filter.relation || filter.q) {
      return (
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
      );
    }
    return (
      <EmptyState
        title={
          filter.status === undefined
            ? t("sessions.empty")
            : t("sessionList.filter.empty")
        }
      />
    );
  }
  return (
    <div className="flex flex-col items-start gap-4">
      <SessionsOverview sessions={items} />
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
        {t("sessionList.shown", { count: items.length })}
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

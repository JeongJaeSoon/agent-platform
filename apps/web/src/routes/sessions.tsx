import {
  hashKey,
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
import { useAgentPlatform } from "@werft-ai/react";
import {
  ApprovalInbox,
  type SessionActionProps,
  SessionDetail,
  SessionList,
} from "@werft-ai/react/blocks";
import {
  SessionRow,
  type SessionRowMessages,
  SessionTable,
} from "@werft-ai/react/components";
import {
  Button,
  buttonVariants,
  EmptyState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { ArrowLeft, Plus } from "lucide-react";
import { useEffect } from "react";
import { ReasonButton, useCan } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { SessionOutputs, SessionOutputsCount } from "./session-outputs.tsx";

function loadError(error: unknown, onRetry: () => void) {
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

export function SessionsScreen() {
  const { t } = useI18n();
  const unavailable = useUnavailable();
  // Validated again: the root route passes the raw query through, so an
  // unknown `status` still reaches this route's search.
  const tab =
    sessionsSearch(useSearch({ from: "/authed/sessions" })).status ?? "all";
  const navigate = useNavigate({ from: "/sessions" });
  return (
    <Page
      title={t("sessions.title")}
      description={t("sessions.intro")}
      actions={
        // Narrow screens wrap the reason under the button, so the title keeps
        // the width of the row.
        <div className="max-sm:w-min">
          <ReasonButton
            className={buttonVariants()}
            reason={t("sessionList.newUnavailable")}
          >
            <Plus aria-hidden="true" />
            {t("sessionList.new")}
          </ReasonButton>
        </div>
      }
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <ApprovalInbox
          loading={<StatusScreen kind="loading" />}
          renderError={loadError}
          unavailable={unavailable}
          refusal={(error) => t(errorKey(error.code))}
        />
        <Tabs
          value={tab}
          // Replace, not push, as on the agent tabs: arrowing across the tabs
          // would otherwise fill the back button with tab entries.
          onValueChange={(next) =>
            void navigate({
              search: next === "all" ? {} : { status: next as SessionFilter },
              replace: true,
            })
          }
          className="min-w-0 gap-[var(--ap-space-block)]"
        >
          <div className="border-b">
            <TabsList
              variant="line"
              aria-label={t("sessionList.filter.label")}
              // English names overflow 390px; the tabs wrap rather than scroll,
              // since a scroll box clips the active tab's underline.
              className="flex-wrap justify-start gap-y-0 p-0 group-data-[orientation=horizontal]/tabs:h-auto"
            >
              <TabsTrigger
                value="all"
                className="h-9 text-control after:bottom-0"
              >
                {t("sessionList.filter.all")}
              </TabsTrigger>
              {SESSION_FILTERS.map((name) => (
                <TabsTrigger
                  key={name}
                  value={name}
                  className="h-9 text-control after:bottom-0"
                >
                  {t(`sessions.status.${name}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="all">
            <SessionList
              loading={<StatusScreen kind="loading" />}
              renderError={loadError}
            />
          </TabsContent>
          {SESSION_FILTERS.map((name) => (
            <TabsContent key={name} value={name}>
              <SessionsInStatus status={name} />
            </TabsContent>
          ))}
        </Tabs>
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

/**
 * One status of the caller's sessions, a page at a time. The session list
 * block reads every status only; this follows its rows and paging.
 */
function SessionsInStatus({ status }: { readonly status: SessionFilter }) {
  const { t, locale } = useI18n();
  const { client, renderLink } = useAgentPlatform();
  useFollowListRefresh();
  const sessions = useInfiniteQuery({
    // Under the sessions key, so what refreshes the list refreshes this too.
    queryKey: [...STATUS_LISTS, status],
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: {
            query: pageParam ? { status, cursor: pageParam } : { status },
          },
        }),
      ) as Promise<ListSessionsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    retry: false,
  });
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];

  if (sessions.isPending) return <StatusScreen kind="loading" />;
  if (sessions.error && items.length === 0) {
    return loadError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
    return <EmptyState title={t("sessionList.filter.empty")} />;
  }
  const messages: SessionRowMessages = {
    status: (value) => t(`sessions.status.${value}`),
    admission: (state) => t(`sessions.admission.${state}`),
    statusAxis: t("sessions.column.status"),
    admissionAxis: t("sessions.column.admission"),
    runtime: t("sessions.column.runtime"),
    lastEvent: t("sessions.column.lastEvent"),
    created: t("sessions.column.created"),
    queuedTurns: (count) => `${t("session.queuedTurns")} ${count}`,
    none: t("sessions.none"),
  };
  return (
    <div className="flex flex-col items-start gap-4">
      <SessionTable
        label={t("sessions.tableLabel")}
        messages={{
          id: t("sessions.column.id"),
          status: t("sessions.column.status"),
          admission: t("sessions.column.admission"),
          runtime: t("sessions.column.runtime"),
          lastEvent: t("sessions.column.lastEvent"),
          created: t("sessions.column.created"),
        }}
      >
        {items.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            messages={messages}
            locale={locale}
            renderLink={(link) =>
              renderLink({ to: "session", id: session.id, ...link })
            }
          />
        ))}
      </SessionTable>
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
    </div>
  );
}

/** Why the signed-in credential may not take each session action. */
function useUnavailable(): SessionActionProps["unavailable"] {
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

import type {
  DataTag,
  DefaultError,
  InfiniteData,
  InfiniteQueryObserverOptions,
  QueryFunction,
  QueryKey,
  QueryObserverOptions,
} from "@tanstack/query-core";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  AgentAdminsView,
  AgentDetail,
  AuthMeResponse,
  ListAdministeredAgentsResponse,
  ListAgentsResponse,
  ListApiKeysResponse,
  ListInvitesResponse,
  ListLinkedAccountsResponse,
  ListMembersResponse,
  ListMyTeamsResponse,
  ListPendingRequestsResponse,
  ListProfilesResponse,
  ListSessionsResponse,
  ListTeamsResponse,
  LoginMethodsResponse,
  SessionDetail,
  SessionUsageResponse,
  TeamDetail,
  UsageBreakdownBy,
  UsageBreakdownResponse,
  UsageSeriesResponse,
  UsageSummaryScope,
} from "@werft-ai/contracts";

type Options<T, K extends QueryKey> = QueryObserverOptions<
  T,
  DefaultError,
  T,
  T,
  K
> & { queryKey: K; queryFn: QueryFunction<T, K> };

/**
 * What react-query's `queryOptions` does, on query-core types: the key is
 * tagged with the data type, so `getQueryData(key)` and `setQueryData(key)`
 * know what the cache holds there.
 */
function queryOptions<T, K extends QueryKey>(
  options: Options<T, K>,
): Options<T, K> & { queryKey: DataTag<K, T, DefaultError> } {
  return options as Options<T, K> & { queryKey: DataTag<K, T, DefaultError> };
}

type InfiniteOptions<T, K extends QueryKey, P> = InfiniteQueryObserverOptions<
  T,
  DefaultError,
  InfiniteData<T, P>,
  K,
  P
> & { queryKey: K; queryFn: QueryFunction<T, K, P>; initialPageParam: P };

/** `queryOptions` for a paged list, as react-query's `infiniteQueryOptions`. */
function infiniteQueryOptions<T, K extends QueryKey, P>(
  options: InfiniteOptions<T, K, P>,
): InfiniteOptions<T, K, P> & {
  queryKey: DataTag<K, InfiniteData<T, P>, DefaultError>;
} {
  return options as InfiniteOptions<T, K, P> & {
    queryKey: DataTag<K, InfiniteData<T, P>, DefaultError>;
  };
}

// Detail, cost and pending requests change while a turn runs; the event
// stream is live, the rest is read again on this beat.
const LIVE_REFETCH_MS = 5_000;

/**
 * Query keys are the cache's public names. A screen that shows server state
 * reads it through one of these; anything that changes who is signed in
 * clears the whole cache instead of invalidating keys one by one.
 */
export const queryKeys = {
  me: ["me"] as const,
  viewer: ["me", "optional"] as const,
  loginMethods: ["login-methods"] as const,
  members: ["members"] as const,
  // Under "members", so every member change refreshes the loaded pages too.
  memberPages: (q: string | undefined) =>
    ["members", "pages", { q: q ?? null }] as const,
  firstMembers: ["members", "first"] as const,
  invites: ["invites"] as const,
  agents: ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  agentAdmins: (id: string) => ["agents", id, "admins"] as const,
  administeredAgents: ["administered-agents"] as const,
  teams: ["teams"] as const,
  // Under "teams", so every team change refreshes it too.
  myTeams: ["teams", "mine"] as const,
  linkedAccounts: ["linked-accounts"] as const,
  apiKeys: ["api-keys"] as const,
  profiles: ["profiles"] as const,
  team: (id: string) => ["teams", id] as const,
  sessions: ["sessions"] as const,
  // An object segment, so it never reads as a session id.
  waitingSessions: ["sessions", { status: "needs_input" }] as const,
  session: (id: string) => ["sessions", id] as const,
  sessionUsage: (id: string) => ["sessions", id, "usage"] as const,
  pendingRequests: (id: string) =>
    ["sessions", id, "pending-requests"] as const,
  usageSeries: (
    scope: UsageSummaryScope,
    since: string,
    until: string | null,
  ) => ["usage-series", scope, since, until] as const,
  usageBreakdown: (
    scope: UsageSummaryScope,
    since: string,
    until: string | null,
    by: UsageBreakdownBy,
  ) => ["usage-breakdown", scope, since, until, by] as const,
};

export function meQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: () => unwrap(client.GET("/v1/auth/me")) as Promise<AuthMeResponse>,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * Who is signed in on a page that works either way (the invite link): no
 * session is an answer here, not a reason to send the reader to /login.
 */
export function viewerQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.viewer,
    queryFn: async (): Promise<AuthMeResponse | null> => {
      try {
        return (await unwrap(client.GET("/v1/auth/me"))) as AuthMeResponse;
      } catch (error) {
        if (isApiError(error, "UNAUTHORIZED")) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function loginMethodsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.loginMethods,
    queryFn: () =>
      unwrap(
        client.GET("/v1/auth/login-methods"),
      ) as Promise<LoginMethodsResponse>,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** The catalog is read once at API startup, so it rarely changes under a page. */
export function profilesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.profiles,
    queryFn: () =>
      unwrap(client.GET("/v1/profiles")) as Promise<ListProfilesResponse>,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

// PAGE_LIMIT_MAX, for the lists read to the end; this entry point imports no
// contracts values.
const READ_ALL_PAGE_LIMIT = 100;

/** Every member of the workspace, every page read, oldest first. */
export function membersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.members,
    queryFn: async (): Promise<ListMembersResponse> => {
      const items: ListMembersResponse["items"] = [];
      let cursor: string | null = null;
      do {
        const page = (await unwrap(
          client.GET("/v1/members", {
            params: {
              query: cursor
                ? { cursor, limit: READ_ALL_PAGE_LIMIT }
                : { limit: READ_ALL_PAGE_LIMIT },
            },
          }),
        )) as ListMembersResponse;
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      return { items, next_cursor: null };
    },
    retry: false,
  });
}

/**
 * The workspace's two oldest members, one small read: enough to tell whether
 * anyone joined after the first, and to learn whether the caller may list
 * members at all.
 */
export function firstMembersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.firstMembers,
    queryFn: () =>
      unwrap(
        client.GET("/v1/members", { params: { query: { limit: 2 } } }),
      ) as Promise<ListMembersResponse>,
    retry: false,
  });
}

/**
 * The workspace's members a page at a time, oldest first: those whose name
 * or email contains `q` when one is given.
 */
export function memberPagesQuery(client: ApiClient, q?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.memberPages(q),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/members", {
          params: {
            query: {
              ...(q ? { q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListMembersResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    // A list left behind (another search, another tab) is dropped, so coming
    // back reads its first page instead of every page it had.
    gcTime: 0,
    retry: false,
  });
}

export function invitesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.invites,
    queryFn: () =>
      unwrap(client.GET("/v1/invites")) as Promise<ListInvitesResponse>,
    retry: false,
  });
}

/** Every agent of the workspace, every page read, oldest first. */
export function agentsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.agents,
    queryFn: async (): Promise<ListAgentsResponse> => {
      const items: ListAgentsResponse["items"] = [];
      let cursor: string | null = null;
      do {
        const page = (await unwrap(
          client.GET("/v1/agents", {
            params: {
              query: cursor
                ? { cursor, limit: READ_ALL_PAGE_LIMIT }
                : { limit: READ_ALL_PAGE_LIMIT },
            },
          }),
        )) as ListAgentsResponse;
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      return { items, next_cursor: null };
    },
    retry: false,
  });
}

export function agentQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeys.agent(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}", { params: { path: { id } } }),
      ) as Promise<AgentDetail>,
    retry: false,
  });
}

export function teamsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.teams,
    queryFn: () =>
      unwrap(client.GET("/v1/teams")) as Promise<ListTeamsResponse>,
    retry: false,
  });
}

export function teamQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeys.team(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/teams/{team_id}", {
          params: { path: { team_id: id } },
        }),
      ) as Promise<TeamDetail>,
    retry: false,
  });
}

export function agentAdminsQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeys.agentAdmins(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/admins", { params: { path: { id } } }),
      ) as Promise<AgentAdminsView>,
    retry: false,
  });
}

/** The agents the caller administers now, directly or through a team. */
export function administeredAgentsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.administeredAgents,
    queryFn: () =>
      unwrap(
        client.GET("/v1/administered-agents"),
      ) as Promise<ListAdministeredAgentsResponse>,
    retry: false,
  });
}

/** The teams the caller is in now, names only. */
export function myTeamsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.myTeams,
    queryFn: () =>
      unwrap(client.GET("/v1/my-teams")) as Promise<ListMyTeamsResponse>,
    retry: false,
  });
}

export function linkedAccountsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.linkedAccounts,
    queryFn: () =>
      unwrap(
        client.GET("/v1/linked-accounts"),
      ) as Promise<ListLinkedAccountsResponse>,
    retry: false,
  });
}

/** The caller's personal keys and the agent keys they may revoke. */
export function apiKeysQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.apiKeys,
    queryFn: () =>
      unwrap(client.GET("/v1/api-keys")) as Promise<ListApiKeysResponse>,
    retry: false,
    // The key tabs share this list; issuing and revoking invalidate it.
    staleTime: 30_000,
  });
}

export function sessionsQuery(client: ApiClient) {
  return infiniteQueryOptions({
    queryKey: queryKeys.sessions,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      ) as Promise<ListSessionsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    retry: false,
  });
}

/** The first page of sessions waiting on an answer, for the sidebar's badge. */
export function waitingSessionsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.waitingSessions,
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions", {
          params: { query: { status: "needs_input" } },
        }),
      ) as Promise<ListSessionsResponse>,
    retry: false,
    refetchInterval: 30_000,
  });
}

export function sessionQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeys.session(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}", { params: { path: { id } } }),
      ) as Promise<SessionDetail>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function sessionUsageQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeys.sessionUsage(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/usage", { params: { path: { id } } }),
      ) as Promise<SessionUsageResponse>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/**
 * Day buckets of a period. A fixed `until` lets a screen read 90 days once
 * and cut the 7- and 30-day views from the same answer.
 */
export function usageSeriesQuery(
  client: ApiClient,
  scope: UsageSummaryScope,
  since: string,
  until: string | null = null,
) {
  return queryOptions({
    queryKey: queryKeys.usageSeries(scope, since, until),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/series", {
          params: {
            query: { scope, since, ...(until === null ? {} : { until }) },
          },
        }),
      ) as Promise<UsageSeriesResponse>,
    retry: false,
  });
}

export function usageBreakdownQuery(
  client: ApiClient,
  scope: UsageSummaryScope,
  since: string,
  by: UsageBreakdownBy,
  until: string | null = null,
) {
  return queryOptions({
    queryKey: queryKeys.usageBreakdown(scope, since, until, by),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/breakdown", {
          params: {
            query: { scope, since, by, ...(until === null ? {} : { until }) },
          },
        }),
      ) as Promise<UsageBreakdownResponse>,
    retry: false,
  });
}

export function pendingRequestsQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeys.pendingRequests(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/pending-requests", {
          params: { path: { id } },
        }),
      ) as Promise<ListPendingRequestsResponse>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

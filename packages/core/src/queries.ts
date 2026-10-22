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

export function membersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.members,
    queryFn: () =>
      unwrap(client.GET("/v1/members")) as Promise<ListMembersResponse>,
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

export function agentsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.agents,
    queryFn: () =>
      unwrap(client.GET("/v1/agents")) as Promise<ListAgentsResponse>,
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

/** The caller's personal keys and the service keys they may revoke. */
export function apiKeysQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.apiKeys,
    queryFn: () =>
      unwrap(client.GET("/v1/api-keys")) as Promise<ListApiKeysResponse>,
    retry: false,
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

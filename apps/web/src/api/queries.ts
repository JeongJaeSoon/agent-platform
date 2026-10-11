import type {
  AuthMeResponse,
  ListInvitesResponse,
  ListMembersResponse,
} from "@agent-platform/contracts";
import { queryOptions } from "@tanstack/react-query";
import { type ApiClient, isApiError, unwrap } from "./client.ts";

/**
 * Query keys are the cache's public names. A screen that shows server state
 * reads it through one of these; anything that changes who is signed in
 * clears the whole cache instead of invalidating keys one by one.
 */
export const queryKeys = {
  me: ["me"] as const,
  viewer: ["me", "optional"] as const,
  members: ["members"] as const,
  invites: ["invites"] as const,
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

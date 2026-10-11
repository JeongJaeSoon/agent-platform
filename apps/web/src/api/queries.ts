import type { AuthMeResponse } from "@agent-platform/contracts";
import { queryOptions } from "@tanstack/react-query";
import { type ApiClient, unwrap } from "./client.ts";

/**
 * Query keys are the cache's public names. A screen that shows server state
 * reads it through one of these; anything that changes who is signed in
 * clears the whole cache instead of invalidating keys one by one.
 */
export const queryKeys = {
  me: ["me"] as const,
};

export function meQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: () => unwrap(client.GET("/v1/auth/me")) as Promise<AuthMeResponse>,
    // A 401 or 403 is an answer, not a blip; retrying only delays the screen.
    retry: false,
    staleTime: 30_000,
  });
}

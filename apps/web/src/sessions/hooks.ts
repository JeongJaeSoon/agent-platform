import {
  type SessionEventFrame,
  type StreamState,
  subscribeSessionEvents,
} from "@agent-platform/client";
import type {
  ChangeSessionProfileRequest,
  ListPendingRequestsResponse,
  ListSessionsResponse,
  SessionDetail,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import { useServices } from "../services.tsx";

/*
 * The session screens' data: what to fetch and when, and nothing about how it
 * looks. views.tsx draws what these return.
 */

export const sessionKeys = {
  list: ["sessions"] as const,
  detail: (id: string) => ["sessions", id] as const,
  usage: (id: string) => ["sessions", id, "usage"] as const,
  pending: (id: string) => ["sessions", id, "pending-requests"] as const,
};

// Detail, cost and pending requests change while a turn runs; the event
// stream is live, the rest is read again on this beat.
const LIVE_REFETCH_MS = 5_000;
// Events kept on screen; older ones drop off so a long session does not
// grow the page without bound.
export const EVENT_WINDOW = 200;

export function useSessions() {
  const { client } = useServices();
  return useInfiniteQuery({
    queryKey: sessionKeys.list,
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

export function useSession(id: string) {
  const { client } = useServices();
  return useQuery({
    queryKey: sessionKeys.detail(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}", { params: { path: { id } } }),
      ) as Promise<SessionDetail>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function useSessionUsage(id: string, enabled: boolean) {
  const { client } = useServices();
  return useQuery({
    queryKey: sessionKeys.usage(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/usage", { params: { path: { id } } }),
      ) as Promise<SessionUsageResponse>,
    enabled,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function usePendingRequests(id: string, enabled: boolean) {
  const { client } = useServices();
  return useQuery({
    queryKey: sessionKeys.pending(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/pending-requests", {
          params: { path: { id } },
        }),
      ) as Promise<ListPendingRequestsResponse>,
    enabled,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** Moves the session onto another profile from its next turn on. */
export function useChangeSessionProfile(id: string) {
  const { client, queryClient } = useServices();
  return useMutation<unknown, ApiError, ChangeSessionProfileRequest>({
    mutationFn: (body) =>
      unwrap(
        client.POST("/v1/sessions/{id}/profile", {
          params: {
            path: { id },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body,
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) }),
  });
}

export type { SessionEventFrame };
export type EventStreamState = StreamState;

/**
 * The session's event stream, replayed from the start. The client resumes
 * with Last-Event-ID after a dropped connection and delivers each event once;
 * a refusal (the share taken back, the login gone) closes it for good and the
 * screen says so.
 */
export function useSessionEvents(id: string, enabled: boolean) {
  const services = useServices();
  const [events, setEvents] = useState<readonly SessionEventFrame[]>([]);
  const [state, setState] = useState<EventStreamState>("connecting");

  useEffect(() => {
    if (!enabled) return;
    setEvents([]);
    setState("connecting");
    const stop = new AbortController();
    void subscribeSessionEvents(services.client, id, {
      signal: stop.signal,
      onEvent: (event) =>
        setEvents((current) => [...current, event].slice(-EVENT_WINDOW)),
      // The old subscription closes after the next one started.
      onState: (next) => {
        if (!stop.signal.aborted) setState(next);
      },
      onError: (error) => {
        if (isApiError(error, "UNAUTHORIZED")) services.onUnauthorized();
      },
      ...(services.eventRetry ? { retry: services.eventRetry } : {}),
    });
    return () => stop.abort();
  }, [services, id, enabled]);

  return { events, state };
}

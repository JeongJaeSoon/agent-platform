import {
  type SessionEventFrame as ClientEventFrame,
  type StreamState,
  subscribeSessionEvents,
} from "@agent-platform/client";
import type {
  ChangeSessionProfileRequest,
  ListPendingRequestsResponse,
  ListSessionsResponse,
  SessionDetail,
  SessionEventPayload,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { useAgentPlatform } from "@agent-platform/react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import { useAppServices } from "../services.tsx";

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
  const { client } = useAgentPlatform();
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
  const { client } = useAgentPlatform();
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
  const { client } = useAgentPlatform();
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
  const { client } = useAgentPlatform();
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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
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

export type EventStreamState = StreamState;

/** One event as the client delivers it, a tool result's call named. */
export interface SessionEventFrame extends ClientEventFrame {
  /** A tool result's call, named when the result arrived. */
  readonly toolName?: string;
}

// Tool results wait for their call's name; calls whose result never comes
// are dropped oldest first past this many.
const PENDING_CALLS_MAX = EVENT_WINDOW;

function toolCalls(payload: SessionEventPayload) {
  if (payload.event !== "tool_use" && payload.event !== "assistant") return [];
  const content = (payload.data.message as { content?: unknown } | null)
    ?.content;
  return Array.isArray(content)
    ? content.flatMap(
        (block: { type?: unknown; id?: unknown; name?: unknown }) =>
          block?.type === "tool_use" && typeof block.id === "string"
            ? [[block.id, String(block.name ?? "")] as const]
            : [],
      )
    : [];
}

/**
 * The session's event stream, replayed from the start. The client resumes
 * with Last-Event-ID after a dropped connection and delivers each event once;
 * a refusal (the share taken back, the login gone) closes it for good and the
 * screen says so.
 */
export function useSessionEvents(id: string, enabled: boolean) {
  const { client } = useAgentPlatform();
  const services = useAppServices();
  const [events, setEvents] = useState<readonly SessionEventFrame[]>([]);
  const [state, setState] = useState<EventStreamState>("connecting");

  useEffect(() => {
    if (!enabled) return;
    setEvents([]);
    setState("connecting");
    const stop = new AbortController();
    const callNames = new Map<string, string>();
    void subscribeSessionEvents(client, id, {
      signal: stop.signal,
      onEvent: (frame) => {
        const { payload } = frame;
        for (const [callId, name] of toolCalls(payload)) {
          callNames.set(callId, name);
          if (callNames.size > PENDING_CALLS_MAX) {
            callNames.delete(callNames.keys().next().value as string);
          }
        }
        const callId =
          payload.event === "tool_result"
            ? (payload.data as { tool_use_id?: unknown } | null)?.tool_use_id
            : undefined;
        const toolName =
          typeof callId === "string" ? callNames.get(callId) : undefined;
        if (typeof callId === "string") callNames.delete(callId);
        const event: SessionEventFrame =
          toolName === undefined ? frame : { ...frame, toolName };
        setEvents((current) => [...current, event].slice(-EVENT_WINDOW));
      },
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
  }, [client, services, id, enabled]);

  return { events, state };
}

import type {
  ListPendingRequestsResponse,
  ListSessionsResponse,
  SessionDetail,
  SessionEventName,
  SessionEventPayload,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { unwrap } from "../api/client.ts";
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

// A record, so a kind added to the contract fails the typecheck until it is
// listened for here (the web app imports contracts as types only).
const EVENT_NAMES = Object.keys({
  system: true,
  assistant: true,
  tool_use: true,
  tool_result: true,
  question: true,
  result: true,
  status: true,
  error: true,
} satisfies Record<SessionEventName, true>);

export type EventStreamState = "connecting" | "open" | "closed";

/** One SSE frame, its envelope unpacked next to the kind's payload. */
export interface SessionEventFrame {
  readonly id: string;
  readonly occurredAt: string;
  readonly turnId: string | null;
  readonly payload: SessionEventPayload;
}

interface Envelope {
  readonly occurred_at: string;
  readonly turn_id: string | null;
  readonly data: unknown;
}

/**
 * The session's event stream, replayed from the start. EventSource sends the
 * login cookie on a same-origin URL and resumes with Last-Event-ID on its own
 * after a dropped connection; once it gives up (an error status), the stream
 * is closed for good and the screen says so.
 */
export function useSessionEvents(id: string, enabled: boolean) {
  const [events, setEvents] = useState<readonly SessionEventFrame[]>([]);
  const [state, setState] = useState<EventStreamState>("connecting");

  useEffect(() => {
    if (!enabled) return;
    setEvents([]);
    setState("connecting");
    const source = new EventSource(
      `/v1/sessions/${encodeURIComponent(id)}/events`,
    );
    const seen = new Set<string>();
    const receive = (message: MessageEvent<string>) => {
      if (seen.has(message.lastEventId)) return;
      seen.add(message.lastEventId);
      let envelope: Envelope;
      try {
        envelope = JSON.parse(message.data);
      } catch {
        return;
      }
      const event: SessionEventFrame = {
        id: message.lastEventId,
        occurredAt: envelope.occurred_at,
        turnId: envelope.turn_id,
        payload: {
          event: message.type,
          data: envelope.data,
        } as SessionEventPayload,
      };
      setEvents((current) => [...current, event].slice(-EVENT_WINDOW));
    };
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, receive);
    }
    source.onopen = () => setState("open");
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setState("closed");
      else setState("connecting");
    };
    return () => source.close();
  }, [id, enabled]);

  return { events, state };
}

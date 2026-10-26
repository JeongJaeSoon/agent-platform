import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type { ListSessionsResponse } from "@werft-ai/contracts";
import { queryKeys, waitingSessionsQuery } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  AgentMapPage,
  type Lane,
  laneOf,
  type MapSession,
  runNodesOf,
  useAgentMapBoard,
  useSessionRunTree,
} from "@werft-ai/react/agent-map";
import { useMemo, useState } from "react";
import { StatusScreen } from "../components/status-screen.tsx";
import { loadError } from "./sessions.tsx";

/** How often the board reads the list again; only the open session streams. */
export const BOARD_POLL_MS = 5_000;

/**
 * The newest sessions (the API's default page of 50), read again every
 * BOARD_POLL_MS while the tab shows. A read in flight keeps the last one on
 * screen. Under the sessions key, so what refreshes the list refreshes this.
 */
function useBoardList() {
  const { client } = useAgentPlatform();
  return useQuery({
    queryKey: [...queryKeys.sessions, { view: "agent-map" }],
    queryFn: () =>
      unwrap(client.GET("/v1/sessions")) as Promise<ListSessionsResponse>,
    refetchInterval: BOARD_POLL_MS,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

const LANE_ORDER: readonly Lane[] = ["attention", "running", "queued", "idle"];

// Until the reader picks one, the card a person would act on first.
function firstCard(sessions: readonly MapSession[]) {
  for (const lane of LANE_ORDER) {
    const card = sessions.find((session) => laneOf(session) === lane);
    if (card) return card;
  }
  return undefined;
}

/**
 * The newest page plus the waiting sessions older than it, so the strip
 * counts what the sidebar badge counts. The waiting list is the badge's own
 * query: no read of its own, and the newest page wins where both list one.
 */
function useBoardSessions() {
  const { client } = useAgentPlatform();
  const list = useBoardList();
  const waiting = useQuery(waitingSessionsQuery(client));
  // Placed together on the first read, or the older cards would come in
  // as new and push the lanes down; a failed waiting read leaves them out.
  const data = useMemo(() => {
    if (waiting.isPending) return undefined;
    if (!list.data || !waiting.data) return list.data;
    const seen = new Set(list.data.items.map((session) => session.id));
    const older = waiting.data.items.filter((session) => !seen.has(session.id));
    return older.length === 0
      ? list.data
      : { ...list.data, items: [...list.data.items, ...older] };
  }, [list.data, waiting.data, waiting.isPending]);
  return {
    list,
    data,
    readAt: Math.max(list.dataUpdatedAt, waiting.dataUpdatedAt),
  };
}

/**
 * /sessions/map: the list read on a timer, the open session streamed. Loaded
 * on its own, so the graph does not weigh on the other screens.
 */
export function AgentMapScreen() {
  const navigate = useNavigate();
  const { list, data, readAt } = useBoardSessions();
  const { board, pendingMoves, tidy, announcement } = useAgentMapBoard(
    data,
    readAt,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<"board" | "detail">("board");
  const sessions = board?.sessions ?? [];
  const selected =
    sessions.find((session) => session.id === chosen) ?? firstCard(sessions);
  const { tree } = useSessionRunTree(selected?.id ?? null);
  const nodes = useMemo(() => (tree ? runNodesOf(tree) : []), [tree]);

  if (list.error && !list.data)
    return loadError(list.error, () => void list.refetch());
  // The board's stand-in would need the strip's size, which only the list
  // tells (open requests older than its page are not on it); until the list
  // comes, the route's own loading screen goes on.
  if (!board) return <StatusScreen kind="loading" />;
  return (
    <AgentMapPage
      updatedAt={list.dataUpdatedAt || null}
      pendingMoves={pendingMoves}
      onTidy={tidy}
      announcement={announcement}
      sessions={sessions}
      doneCount={board.doneCount}
      selected={selected ? { session: selected, nodes } : null}
      onSelect={(id) => {
        setChosen(id);
        setView("detail");
      }}
      view={view}
      onBack={() => setView("board")}
      onExpandDone={() =>
        void navigate({ to: "/sessions", search: { status: "stopped" } })
      }
    />
  );
}

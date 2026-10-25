import {
  isApiError,
  type StreamState,
  subscribeSessionEvents,
} from "@werft-ai/client";
import type { ListSessionsResponse } from "@werft-ai/contracts";
import { useEffect, useRef, useState } from "react";

import { useAgentPlatform } from "../../provider.tsx";
import { createRunTreeBuilder, type RunTree } from "../../run-tree.ts";
import {
  arrangeBoard,
  type BoardMemory,
  mapSessionOf,
  type StatusChange,
} from "./board-data.ts";
import { laneOf } from "./lane-board.tsx";
import type { AgentMapMessages } from "./messages.ts";
import type { MapSession } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

/**
 * The board as the list reads now: oldest session first, so a new one lands
 * at its lane's end, and a card whose status moved held in place until
 * `tidy()`. `changes` says what the last read moved, for a live region.
 */
export function useAgentMapBoard(
  list: ListSessionsResponse | undefined,
  override?: Partial<AgentMapMessages>,
) {
  const messages = useAgentMapMessages(override);
  const [tidied, setTidied] = useState(0);
  // Placing a read advances the memory, so each (read, tidy) is placed once;
  // a second render of the same pair, as StrictMode does, reuses it.
  const placed = useRef<{
    readonly list: ListSessionsResponse;
    readonly tidied: number;
    readonly board: Board;
  } | null>(null);
  let board: Board | null = null;
  if (list) {
    const cached = placed.current;
    if (cached?.list === list && cached.tidied === tidied) board = cached.board;
    else {
      board = placeBoard(
        list,
        cached?.board.memory ?? null,
        cached !== null && cached.tidied !== tidied,
        messages,
        Date.now(),
      );
      placed.current = { list, tidied, board };
    }
  }
  // The last summary stays until the next one, so the region is not read
  // out blank between two reads.
  const [announcement, setAnnouncement] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new board speaks, not the wording object each render makes
  useEffect(() => {
    if (board && (board.changes.length > 0 || board.added > 0))
      setAnnouncement(messages.changes(board.changes, board.added));
  }, [board]);
  return {
    board,
    pendingMoves:
      board?.sessions.filter((session) => session.pinnedLane).length ?? 0,
    tidy: () => setTidied((count) => count + 1),
    announcement,
  };
}

interface Board {
  readonly sessions: MapSession[];
  /** Ended sessions of the read that stand in no lane. */
  readonly doneCount: number;
  readonly memory: BoardMemory;
  readonly changes: readonly StatusChange[];
  readonly added: number;
}

function placeBoard(
  list: ListSessionsResponse,
  before: BoardMemory | null,
  tidy: boolean,
  messages: AgentMapMessages,
  now: number,
): Board {
  const cards = [...list.items]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((summary) => mapSessionOf(summary, now, messages));
  const next = arrangeBoard(cards, before, tidy);
  // An ended session leaves its lane only once the board is tidied.
  const sessions = next.sessions.filter((card) => laneOf(card) !== "done");
  return {
    ...next,
    sessions,
    doneCount: next.sessions.length - sessions.length,
  };
}

/**
 * One session's run tree from its whole event stream, not a window of it:
 * a subagent whose spawning call scrolled out of a window would be drawn
 * apart from its parent. The builder keeps a few records per call, and a
 * burst of frames (the replay on connect) rebuilds the tree once.
 */
export function useSessionRunTree(id: string | null) {
  const { client, onUnauthorized, eventRetry } = useAgentPlatform();
  const [tree, setTree] = useState<RunTree | null>(null);
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    if (id === null) return;
    setTree(null);
    setState("connecting");
    const stop = new AbortController();
    const builder = createRunTreeBuilder();
    let flush: ReturnType<typeof setTimeout> | undefined;
    void subscribeSessionEvents(client, id, {
      signal: stop.signal,
      onEvent: (frame) => {
        if (!builder.push(frame) || flush !== undefined) return;
        flush = setTimeout(() => {
          flush = undefined;
          setTree(builder.tree());
        }, 0);
      },
      onState: (next) => {
        if (stop.signal.aborted) return;
        setState(next);
        // A session with no events yet still has its own run.
        if (next === "open") setTree((current) => current ?? builder.tree());
      },
      onError: (error) => {
        if (isApiError(error, "UNAUTHORIZED")) onUnauthorized?.();
      },
      ...(eventRetry ? { retry: eventRetry } : {}),
    });
    return () => {
      stop.abort();
      clearTimeout(flush);
    };
  }, [client, onUnauthorized, eventRetry, id]);

  return { tree, state };
}

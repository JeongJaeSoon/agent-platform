import { Button, Card, Skeleton } from "@werft-ai/ui";
import type { JSX } from "react";

import { LaneBoard } from "./lane-board.tsx";
import type { AgentMapMessages } from "./messages.ts";
import { RelationPanel } from "./relation-panel.tsx";
import type { MapNode, MapSession } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

export interface AgentMapProps {
  readonly sessions: readonly MapSession[];
  readonly doneCount: number;
  /** The open session and its rows; null before one is chosen. */
  readonly selected: {
    readonly session: MapSession;
    readonly nodes: readonly MapNode[];
  } | null;
  readonly onSelect: (id: string) => void;
  /**
   * Below md the board and the panel take turns: "detail" shows the panel
   * with a way back. From md up both always show.
   */
  readonly view?: "board" | "detail" | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly onExpandDone?: (() => void) | undefined;
  /** The list has not arrived: the board and panel keep their places. */
  readonly loading?: boolean | undefined;
  readonly now?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

const COLUMNS =
  "grid items-start gap-6 md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]";

/** The board of status lanes beside the selected session's relations. */
export function AgentMap({
  sessions,
  doneCount,
  selected,
  onSelect,
  view = "board",
  onBack,
  onExpandDone,
  loading = false,
  now,
  messages: override,
}: AgentMapProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  const detail = view === "detail";
  if (loading) return <AgentMapLoading detail={detail} messages={messages} />;
  return (
    <div className={COLUMNS}>
      <div className={detail ? "hidden md:block" : undefined}>
        <LaneBoard
          sessions={sessions}
          doneCount={doneCount}
          selectedId={selected?.session.id ?? null}
          onSelect={onSelect}
          onExpandDone={onExpandDone}
          now={now}
          messages={messages}
        />
      </div>
      <div
        className={`flex flex-col gap-3 md:sticky md:top-4 ${detail ? "" : "hidden md:flex"}`}
      >
        {detail ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start md:hidden"
            onClick={onBack}
          >
            {messages.back}
          </Button>
        ) : null}
        {selected ? (
          <RelationPanel
            session={selected.session}
            nodes={selected.nodes}
            now={now}
            messages={messages}
          />
        ) : null}
      </div>
    </div>
  );
}

const CARD = "rounded-(--radius-card) border bg-card p-3";

// MapSessionCard's line heights (status, title, agent, note, counts), so a
// lane's first card lands where its stand-in stood.
const CARD_ROWS = [
  ["19.5px", "40%"],
  ["21px", "70%"],
  ["18px", "50%"],
  ["18px", "90%"],
  ["20px", "30%"],
] as const;

function AgentMapLoading({
  detail,
  messages,
}: {
  readonly detail: boolean;
  readonly messages: AgentMapMessages;
}): JSX.Element {
  return (
    <div className={COLUMNS}>
      <output className="sr-only">{messages.loading}</output>
      <div
        aria-hidden="true"
        data-stand-in="board"
        className={`min-w-0 flex-col gap-4 ${detail ? "hidden md:flex" : "flex"}`}
      >
        {(["attention", "running", "queued", "idle"] as const).map((lane) => (
          <section key={lane} className="flex flex-col gap-2">
            <h2 className="m-0 text-control font-semibold">
              {messages.lane(lane)}
            </h2>
            <div className={`${CARD} flex flex-col gap-2`}>
              {CARD_ROWS.map(([height, width]) => (
                <Skeleton
                  key={height + width}
                  shape="block"
                  height={height}
                  width={width}
                  label=""
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <Card
        aria-hidden="true"
        data-stand-in="panel"
        className={`min-w-0 gap-4 p-4 ${detail ? "flex" : "hidden md:flex"}`}
      >
        <Skeleton width="45%" label="" />
        <Skeleton width="60%" label="" />
        <div className="grid grid-cols-[176px_minmax(0,1fr)] gap-x-12 gap-y-3">
          <Skeleton shape="block" height="120px" label="" />
          <div className="flex flex-col gap-3">
            <Skeleton shape="block" height="120px" label="" />
            <Skeleton shape="block" height="120px" label="" />
          </div>
        </div>
      </Card>
    </div>
  );
}

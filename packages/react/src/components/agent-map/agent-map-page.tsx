import { Button, PageHeader } from "@werft-ai/ui";
import { type JSX, useEffect, useRef, useState } from "react";

import { AgentMap, type AgentMapProps } from "./agent-map.tsx";
import type { AgentMapMessages } from "./messages.ts";
import { useAgentMapMessages } from "./use-messages.ts";

export interface AgentMapPageProps extends AgentMapProps {
  /** When the list was last read (ms); null before the first read. */
  readonly updatedAt: number | null;
  /** Cards held out of their lane until the reader tidies up. */
  readonly pendingMoves?: number | undefined;
  readonly onTidy?: (() => void) | undefined;
  /** What the last read of the list changed, read aloud. */
  readonly announcement?: string | undefined;
}

/** The agent map screen: its head, how fresh the board is, and the map. */
export function AgentMapPage({
  updatedAt,
  pendingMoves = 0,
  onTidy,
  announcement = "",
  ...map
}: AgentMapPageProps): JSX.Element {
  const messages = useAgentMapMessages(map.messages);
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={messages.title}
        description={messages.description}
        titleRef={title}
      />
      <p className="-mt-3 m-0 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        <span>
          <ListAge updatedAt={updatedAt} now={map.now} messages={messages} />
          {` · ${messages.liveScope}`}
        </span>
        {pendingMoves > 0 ? (
          // A link-sized button keeps the line's height as it appears.
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto p-0 text-caption"
            onClick={onTidy}
          >
            {messages.tidy(pendingMoves)}
          </Button>
        ) : null}
      </p>
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
      <AgentMap listTitle={title} {...map} />
    </div>
  );
}

// Ticks on its own so the board does not render every second.
function ListAge({
  updatedAt,
  now,
  messages,
}: {
  readonly updatedAt: number | null;
  readonly now: number | undefined;
  readonly messages: AgentMapMessages;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [now]);
  return messages.listUpdated(
    updatedAt === null
      ? null
      : Math.max(0, Math.round(((now ?? clock) - updatedAt) / 1_000)),
  );
}

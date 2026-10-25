import { Badge, Button, Card, RelativeTime } from "@werft-ai/ui";
import type { JSX } from "react";

import { useAgentPlatform } from "../../provider.tsx";
import { SessionStatusLabel } from "../session/session-status-label.tsx";
import type { AgentMapMessages } from "./messages.ts";
import { RelationGraph } from "./relation-graph.tsx";
import { RelationTree } from "./relation-tree.tsx";
import type { MapNode, MapSession } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

export interface RelationPanelProps {
  readonly session: MapSession;
  readonly nodes: readonly MapNode[];
  readonly now?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/**
 * The selected session: its header, its runs as a graph from md up and as a
 * tree below, and a link to its full timeline.
 */
export function RelationPanel({
  session,
  nodes,
  now,
  messages: override,
}: RelationPanelProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  const { locale, renderLink } = useAgentPlatform();
  return (
    <Card className="min-w-0 gap-4 p-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 min-w-0 truncate text-description font-semibold">
            {session.title}
          </h2>
          <SessionStatusLabel
            status={session.status}
            label={messages.status(session.status)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
          <Badge variant="gray">{session.agent}</Badge>
          <Badge variant="mono">{session.model}</Badge>
          {session.branch ? (
            <Badge variant="mono">{session.branch}</Badge>
          ) : null}
          <span>
            {messages.live}{" "}
            <RelativeTime
              value={session.lastEventAt}
              locale={locale}
              {...(now === undefined ? {} : { now })}
            />
          </span>
        </div>
      </div>
      <div className="hidden md:block">
        <RelationGraph
          session={session}
          nodes={nodes}
          now={now}
          messages={messages}
        />
      </div>
      <div className="md:hidden">
        <RelationTree
          session={session}
          nodes={nodes}
          now={now}
          messages={messages}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-caption text-muted-foreground">
        <span>{messages.relationNote}</span>
        <Button asChild variant="link" size="sm" className="ml-auto px-0">
          {renderLink({
            to: "session",
            id: session.id,
            children: messages.timeline,
          })}
        </Button>
      </div>
    </Card>
  );
}

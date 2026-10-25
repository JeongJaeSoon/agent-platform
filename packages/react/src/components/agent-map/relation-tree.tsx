import { Bot } from "lucide-react";
import type { JSX } from "react";

import type { AgentMapMessages } from "./messages.ts";
import { RunNode } from "./run-node.tsx";
import type { MapNode, MapSession } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

export interface RelationTreeProps {
  readonly session: MapSession;
  readonly nodes: readonly MapNode[];
  readonly now?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/** Below md: the same rows as RelationGraph as an indented list, no edges. */
export function RelationTree({
  session,
  nodes,
  now,
  messages: override,
}: RelationTreeProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 flex items-center gap-2 font-semibold">
        <Bot aria-hidden="true" className="size-4" />
        {session.agent}
        <span className="font-normal text-caption text-muted-foreground">
          {messages.sessionRun}
        </span>
      </p>
      <ul
        aria-label={messages.relations}
        className="m-0 flex list-none flex-col gap-2 border-l-2 border-border py-0 pl-3"
      >
        {nodes.map((node) => (
          <RunNode
            key={node.id}
            node={node}
            layout="tree"
            now={now}
            messages={messages}
          />
        ))}
      </ul>
    </div>
  );
}

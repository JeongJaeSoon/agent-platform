import type { SessionStatus } from "@werft-ai/contracts";
import {
  Badge,
  RelativeTime,
  StatusDot,
  type StatusDotStatus,
} from "@werft-ai/ui";
import {
  ArrowLeft,
  ArrowRight,
  Hourglass,
  type LucideIcon,
  ShieldQuestion,
} from "lucide-react";
import { type CSSProperties, type JSX, type RefObject, useRef } from "react";

import { useAgentPlatform } from "../../provider.tsx";
import { FRESH_CLASS, useArrival } from "./fresh.ts";
import type { AgentMapMessages } from "./messages.ts";
import { ToolChips } from "./tool-chip.tsx";
import type { MapEdgeKind, MapNode } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

const SESSION_DOT: Record<SessionStatus, StatusDotStatus> = {
  queued: "idle",
  running: "run",
  needs_input: "wait",
  idle: "idle",
  failed: "failed",
  stopped: "done",
};

// Delegation carries the design's own mark (the Task badge on a subagent);
// every other edge names itself, so no edge is told apart by colour alone.
const EDGE_BADGE: Record<
  Exclude<MapEdgeKind, "delegation">,
  { readonly icon: LucideIcon; readonly variant: "gray" | "amber" }
> = {
  approval: { icon: ShieldQuestion, variant: "amber" },
  request: { icon: ArrowRight, variant: "gray" },
  response: { icon: ArrowLeft, variant: "gray" },
  waiting: { icon: Hourglass, variant: "gray" },
};

export function nodeDot(node: MapNode): StatusDotStatus {
  return node.kind === "run" ? node.status : SESSION_DOT[node.status];
}

export interface RunNodeProps {
  readonly node: MapNode;
  /**
   * "graph" draws the badges on the right; "tree" (below md) leaves the
   * delegation badge out, as the design does, and keeps the others.
   */
  readonly layout?: "graph" | "tree" | undefined;
  /** The `now` relative times are read against; the clock by default. */
  readonly now?: number | undefined;
  /** The graph's grid placement. */
  readonly style?: CSSProperties | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/**
 * One row of the relation panel: a run of the selected session with its
 * latest tool calls, or another session it exchanged messages with.
 */
export function RunNode({
  node,
  layout = "graph",
  now,
  style,
  messages: override,
}: RunNodeProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  const { locale } = useAgentPlatform();
  const edge = node.edge === "delegation" ? null : EDGE_BADGE[node.edge];
  const EdgeIcon = edge?.icon;
  const showTask = layout === "graph" && node.kind === "run" && node.label;
  const ref = useRef<HTMLElement>(null);
  useArrival(ref, node.fresh);
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-control">
        <StatusDot status={nodeDot(node)} />
        <span className="font-medium">
          {node.kind === "run"
            ? (node.label ?? messages.ownRun)
            : `${node.agent} · ${node.title}`}
        </span>
        <span className="whitespace-nowrap text-caption text-muted-foreground">
          {node.kind === "run"
            ? messages.run(node.status)
            : messages.status(node.status)}
        </span>
        {edge && EdgeIcon ? (
          <Badge variant={edge.variant} className="ml-auto">
            <EdgeIcon aria-hidden="true" />
            {messages.edge(node.edge)}
          </Badge>
        ) : null}
        {showTask ? (
          <Badge variant="mono" className={edge ? undefined : "ml-auto"}>
            {messages.delegationBadge}
          </Badge>
        ) : null}
      </span>
      {node.kind === "run" ? (
        <ToolChips
          tools={node.tools}
          hidden={node.hiddenTools}
          messages={messages}
        />
      ) : (
        <p className="m-0 flex min-w-0 items-center gap-1 text-caption text-muted-foreground">
          <span className="min-w-0 truncate">{node.message}</span>
          <span className="flex-none">
            ·{" "}
            <RelativeTime
              value={node.at}
              locale={locale}
              {...(now === undefined ? {} : { now })}
            />
          </span>
        </p>
      )}
    </>
  );
  const fresh = node.fresh ? "" : undefined;
  if (layout === "tree") {
    return (
      <li
        ref={ref as RefObject<HTMLLIElement>}
        data-fresh={fresh}
        className={`flex flex-col gap-2 ${FRESH_CLASS}`}
      >
        {body}
      </li>
    );
  }
  return (
    <div
      ref={ref as RefObject<HTMLDivElement>}
      data-row={node.id}
      data-edge={node.edge}
      data-state={nodeDot(node)}
      data-fresh={fresh}
      style={style}
      className={`flex min-w-0 flex-col gap-2 rounded-(--radius-card) border bg-surface p-3 ${FRESH_CLASS}`}
    >
      {body}
    </div>
  );
}

import { useReducedMotion } from "@werft-ai/ui";
import { Bot } from "lucide-react";
import {
  type JSX,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { AgentMapMessages } from "./messages.ts";
import { RunNode } from "./run-node.tsx";
import type { MapEdgeKind, MapNode, MapSession } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

interface Edge {
  readonly key: string;
  readonly d: string;
  readonly kind: MapEdgeKind;
  readonly state: string;
}

// One stroke utility per edge: two would be ordered by the stylesheet, not
// by the class list.
const PLAIN = "stroke-(color:--color-border-strong) stroke-[1.5]";

// A run edge takes the run's state, as in the design; a message edge keeps
// one colour and shows its kind by dash and arrow instead.
const STATE_CLASS: Record<string, string> = {
  run: "stroke-(color:--ap-tone-progress-fg) stroke-[1.5] [stroke-dasharray:6_5]",
  wait: "stroke-(color:--ap-tone-attention-fg) stroke-2",
  failed: "stroke-(color:--ap-tone-danger-fg) stroke-[1.5]",
};
const MESSAGE_CLASS: Partial<Record<MapEdgeKind, string>> = {
  waiting: `${PLAIN} [stroke-dasharray:1_4] [stroke-linecap:round]`,
};

export interface RelationGraphProps {
  readonly session: MapSession;
  /** The session's own run first, then each row in arrival order. */
  readonly nodes: readonly MapNode[];
  readonly now?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/**
 * Fixed columns, no layout engine: the session's run on the left, one row
 * per run or messaged session on the right, an edge from the run to each
 * row. A new row only appends, so nothing above it moves.
 */
export function RelationGraph({
  session,
  nodes,
  now,
  messages: override,
}: RelationGraphProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  const reduced = useReducedMotion();
  const arrow = useId();
  const box = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<readonly Edge[]>([]);
  const measure = useCallback(() => {
    const root = box.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const from = root
      .querySelector<HTMLElement>("[data-node='root']")
      ?.getBoundingClientRect();
    if (!from) return;
    const next: Edge[] = [];
    for (const row of root.querySelectorAll<HTMLElement>("[data-row]")) {
      const to = row.getBoundingClientRect();
      const x1 = from.right - origin.left;
      const y1 = from.top - origin.top + 22;
      const x2 = to.left - origin.left;
      const y2 = to.top - origin.top + 22;
      const cx = Math.round((x1 + x2) / 2);
      next.push({
        key: row.dataset.row ?? "",
        d: `M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`,
        kind: (row.dataset.edge as MapEdgeKind | undefined) ?? "delegation",
        state: row.dataset.state ?? "idle",
      });
    }
    setEdges(next);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session or row moves the nodes without resizing the box
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [measure, session, nodes]);

  const subagents = nodes.filter(
    (node) => node.kind === "run" && node.label !== null,
  ).length;
  return (
    <div
      ref={box}
      className="relative grid grid-cols-[176px_minmax(0,1fr)] gap-x-12 gap-y-3"
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path
              d="M0 0L8 4L0 8z"
              className="fill-(color:--color-border-strong)"
            />
          </marker>
        </defs>
        {edges.map((edge) => {
          const message =
            edge.kind === "request" ||
            edge.kind === "response" ||
            edge.kind === "waiting";
          const flowing = !message && edge.state === "run";
          return (
            <path
              key={edge.key}
              d={edge.d}
              data-edge={edge.kind}
              markerEnd={
                edge.kind === "request" || edge.kind === "waiting"
                  ? `url(#${arrow})`
                  : undefined
              }
              markerStart={
                edge.kind === "response" ? `url(#${arrow})` : undefined
              }
              className={`fill-none ${
                (message
                  ? MESSAGE_CLASS[edge.kind]
                  : STATE_CLASS[edge.state]) ?? PLAIN
              }`}
            >
              {flowing && !reduced ? (
                <animate
                  attributeName="stroke-dashoffset"
                  from="0"
                  to="-11"
                  dur="1s"
                  repeatCount="indefinite"
                />
              ) : null}
            </path>
          );
        })}
      </svg>
      <div
        data-node="root"
        style={{ gridRow: `1 / span ${Math.max(nodes.length, 1)}` }}
        className="self-start rounded-(--radius-card) border bg-card p-3"
      >
        <span className="flex items-center gap-2 text-caption text-muted-foreground">
          <Bot aria-hidden="true" className="size-3" />
          {messages.sessionRun}
        </span>
        <p className="m-0 mt-1 font-semibold">{session.agent}</p>
        <p className="m-0 mt-0.5 font-mono text-caption text-muted-foreground">
          {session.model}
        </p>
        <p className="m-0 mt-2 text-caption text-muted-foreground tabular-nums">
          {messages.runTotals(session.toolCount, subagents)}
        </p>
      </div>
      {nodes.map((node, index) => (
        <RunNode
          key={node.id}
          node={node}
          now={now}
          style={{ gridColumn: 2, gridRow: index + 1 }}
          messages={messages}
        />
      ))}
    </div>
  );
}

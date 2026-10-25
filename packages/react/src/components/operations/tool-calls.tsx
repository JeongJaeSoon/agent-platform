import { Badge, EmptyState, Skeleton } from "@werft-ai/ui";
import type { JSX } from "react";

import { useAgentPlatform } from "../../provider.tsx";
import type { ToolCallsMessages } from "./messages.ts";
import type { UsageToolCall } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

const OUTCOME_BADGE = { ok: "green", failed: "red", unknown: "gray" } as const;

export interface ToolCallsProps {
  /** GET /v1/usage/tools/{name}/calls `calls`; undefined while read. */
  readonly calls: readonly UsageToolCall[] | undefined;
  /** The zone the call times are read in; the viewer's by default. */
  readonly timeZone?: string | undefined;
  /** Placeholder rows while `calls` is read; the host says it is loading. */
  readonly loadingRows?: number | undefined;
  readonly messages?: Partial<ToolCallsMessages> | undefined;
}

const ROW =
  "grid min-h-10 grid-cols-[1fr_auto_72px] items-center gap-3 border-b last:border-b-0";

/**
 * One tool's latest calls: the session (a link only when the viewer may read
 * it), agent and time, how long it took and how it ended. An unknown outcome
 * is never drawn as success.
 */
export function ToolCalls({
  calls,
  timeZone,
  loadingRows = 3,
  messages: override,
}: ToolCallsProps): JSX.Element {
  const { messages, format } = useOperationsMessages("toolCalls", override);
  const { locale, renderLink } = useAgentPlatform();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  return (
    <div data-slot="tool-calls">
      <p className="m-0 -mt-1 mb-2 text-caption text-subtle-foreground leading-4">
        {messages.note}
      </p>
      {calls === undefined ? (
        // A call row's two lines at their heights, so the list does not grow
        // when the calls come; no empty items for assistive tech.
        <ul aria-hidden="true" className="m-0 list-none p-0">
          {Array.from({ length: loadingRows }, (_, row) => row).map((row) => (
            <li key={row} className={ROW}>
              <span className="flex min-w-0 flex-col">
                <Skeleton
                  decorative
                  width="50%"
                  height="1lh"
                  className="justify-center"
                />
                <Skeleton
                  decorative
                  width="35%"
                  height="1rem"
                  className="justify-center"
                />
              </span>
            </li>
          ))}
        </ul>
      ) : calls.length === 0 ? (
        <EmptyState title={messages.empty} />
      ) : (
        <ul className="m-0 list-none p-0">
          {calls.map((call) => (
            <li
              key={`${call.occurred_at}-${call.session_id ?? call.agent}`}
              className={ROW}
            >
              <span className="flex min-w-0 flex-col [&>*]:truncate">
                {call.session_id !== null ? (
                  renderLink({
                    to: "session",
                    id: call.session_id,
                    className: "text-link no-underline hover:underline",
                    children: call.title ?? call.session_id,
                  })
                ) : (
                  <span className="text-subtle-foreground">
                    {messages.hidden}
                  </span>
                )}
                <span className="text-caption text-subtle-foreground leading-4">
                  {call.agent === null ? "" : `${call.agent} · `}
                  {time.format(new Date(call.occurred_at))}
                </span>
              </span>
              <span className="text-subtle-foreground tabular-nums">
                {call.duration_ms === null
                  ? messages.none
                  : format.elapsed(call.duration_ms)}
              </span>
              <span className="flex justify-end">
                <Badge variant={OUTCOME_BADGE[call.outcome]}>
                  {messages.outcome[call.outcome]}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

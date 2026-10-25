import type { UsageSummaryScope } from "@werft-ai/contracts";
import { Text } from "@werft-ai/ui";
import type { JSX } from "react";

import type { UsageBasisMessages } from "./messages.ts";
import { Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

const DAY_MS = 86_400_000;

export interface UsageBasisProps {
  readonly scope: UsageSummaryScope;
  /** The half-open period asked for, on UTC midnights. */
  readonly period: { readonly since: string; readonly until: string };
  /** GET /v1/usage/series `refreshed_at`; undefined while it is read. */
  readonly refreshedAt: string | undefined;
  /** The zone `refreshedAt` is shown in; the viewer's by default. */
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
  readonly messages?: Partial<UsageBasisMessages> | undefined;
}

/** Whose usage, which UTC days, which day a session's figures count on, when read. */
export function UsageBasis({
  scope,
  period,
  refreshedAt,
  timeZone,
  className,
  messages: override,
}: UsageBasisProps): JSX.Element {
  const { messages, format } = useOperationsMessages("usageBasis", override);
  const first = period.since.slice(0, 10);
  const last = new Date(Date.parse(period.until) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  const basis = `${messages.scope[scope]} · ${first} – ${last} (UTC) · ${messages.rule} · `;
  return (
    <Text variant="meta" className={className}>
      {refreshedAt ? (
        `${basis}${messages.readAt(format.clock(refreshedAt, timeZone))}`
      ) : (
        <>
          {basis}
          <Value loading width="5.5rem">
            {null}
          </Value>
        </>
      )}
    </Text>
  );
}

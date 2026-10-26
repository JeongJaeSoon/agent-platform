import type { UsageSummaryScope } from "@werft-ai/contracts";
import { SegmentedControl, SegmentedControlItem } from "@werft-ai/ui";
import type { JSX } from "react";

import type { UsageFiltersMessages } from "./messages.ts";
import { useOperationsMessages } from "./use-messages.ts";

export const USAGE_PERIODS = [7, 30, 90] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export interface UsageFiltersProps {
  /**
   * The scope picked, for a viewer who may read the whole installation's
   * usage; without it there is no scope choice.
   */
  readonly scope?: UsageSummaryScope | undefined;
  readonly onScopeChange?: ((scope: UsageSummaryScope) => void) | undefined;
  readonly days: UsagePeriod;
  readonly onDaysChange: (days: UsagePeriod) => void;
  readonly messages?: Partial<UsageFiltersMessages> | undefined;
}

/** Whose usage and how many UTC days back. */
export function UsageFilters({
  scope,
  onScopeChange,
  days,
  onDaysChange,
  messages: override,
}: UsageFiltersProps): JSX.Element {
  const { messages } = useOperationsMessages("usageFilters", override);
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      {scope === undefined ? null : (
        <SegmentedControl
          aria-label={messages.scope}
          value={scope}
          onValueChange={(value) => onScopeChange?.(value as UsageSummaryScope)}
        >
          <SegmentedControlItem value="me">{messages.me}</SegmentedControlItem>
          <SegmentedControlItem value="installation">
            {messages.installation}
          </SegmentedControlItem>
        </SegmentedControl>
      )}
      <SegmentedControl
        aria-label={messages.period}
        value={String(days)}
        onValueChange={(value) => onDaysChange(Number(value) as UsagePeriod)}
        className="ml-auto"
      >
        {USAGE_PERIODS.map((period) => (
          <SegmentedControlItem key={period} value={String(period)}>
            {messages.days(period)}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

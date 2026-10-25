import type { UsageSummaryScope } from "@werft-ai/contracts";
import { USAGE_PERIODS, type UsagePeriod } from "@werft-ai/react/components";

/*
 * The operations menu's URL state, apart from its screens so the router
 * validates a search without loading them.
 */

export interface OperationsSearch {
  readonly scope?: UsageSummaryScope;
  readonly days?: UsagePeriod;
}

export function operationsSearch(
  search: Record<string, unknown>,
): OperationsSearch {
  const days = USAGE_PERIODS.find((n) => n === Number(search.days));
  return {
    ...(search.scope === "me" || search.scope === "installation"
      ? { scope: search.scope }
      : {}),
    ...(days ? { days } : {}),
  };
}

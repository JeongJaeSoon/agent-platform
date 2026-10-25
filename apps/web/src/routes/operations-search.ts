import type { UsageSummaryScope } from "@werft-ai/contracts";
import { USAGE_PERIODS, type UsagePeriod } from "@werft-ai/react/components";

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

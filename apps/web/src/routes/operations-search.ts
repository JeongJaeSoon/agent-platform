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

export interface OperationsToolsSearch extends OperationsSearch {
  /** Narrows the tools tab to one agent's sessions. */
  readonly agent_id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function operationsToolsSearch(
  search: Record<string, unknown>,
): OperationsToolsSearch {
  return {
    ...operationsSearch(search),
    ...(typeof search.agent_id === "string" && UUID.test(search.agent_id)
      ? { agent_id: search.agent_id }
      : {}),
  };
}

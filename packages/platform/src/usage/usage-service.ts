import {
  type InstallationLimitsResponse,
  type SessionUsageResponse,
  USAGE_TOOLS_LIMIT,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
  type UsageToolCallsQuery,
  type UsageToolCallsResponse,
  type UsageToolsQuery,
  type UsageToolsResponse,
} from "@werft-ai/contracts";
import {
  budgetExceeded,
  type InstallationLimits,
  STORAGE_ACCOUNTED_CONTENT,
  sessionBudgetOf,
} from "../limits/installation-limits.ts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { UsageReader, UsageSummaryFilter } from "../ports/usage-reader.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";

/**
 * A limit as a decimal string without rounding it: the parser accepts more
 * precision than `sessions.cost_usd` keeps, and a limit shown rounded would
 * disagree with the comparison the gates make.
 */
export function decimalUsd(value: number): string {
  const text = String(value);
  const exponent = /^(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);
  if (!exponent) return text;
  const [, lead, fraction = "", power] = exponent;
  return `0.${"0".repeat(Number(power) - 1)}${lead}${fraction}`;
}

type UsageToolRow = UsageToolsResponse["tools"][number];

function top(
  tools: readonly UsageToolRow[],
  rank: (tool: UsageToolRow) => number,
): UsageToolRow | undefined {
  let best: UsageToolRow | undefined;
  for (const tool of tools) {
    const score = rank(tool);
    if (score <= 0) continue;
    if (
      best === undefined ||
      score > rank(best) ||
      (score === rank(best) && tool.name < best.name)
    ) {
      best = tool;
    }
  }
  return best;
}

/**
 * The tool taking the most time in all, the one failing at the highest rate
 * and the one slowest per call (median), ties to the first name. A kind no
 * tool qualifies for (no time, no failure) is left out.
 */
export function toolFindings(
  tools: readonly UsageToolRow[],
): UsageToolsResponse["findings"] {
  const picks = [
    ["most_time", top(tools, (t) => t.total_ms)],
    ["fails_often", top(tools, (t) => t.failed / t.calls)],
    ["slowest", top(tools, (t) => t.median_ms)],
  ] as const;
  return picks.flatMap(([kind, tool]) =>
    tool ? [{ kind, name: tool.name }] : [],
  );
}

export function createUsageService(deps: {
  authorization: AuthorizationPolicy;
  reader: UsageReader;
  limits: InstallationLimits;
}) {
  const { authorization, reader, limits } = deps;

  function requireInstallationReader(actor: Caller) {
    return requirePermitted(authorization, actor, "usage.installation_read", {
      kind: "workspace",
      id: actor.ownerId,
    });
  }

  // A personal key adds up its creator's sessions, the ones made in the
  // console included; a key nobody created adds up its own.
  async function filterFor(
    actor: Caller,
    scope: UsageSummaryQuery["scope"],
  ): Promise<UsageSummaryFilter> {
    if (scope === "installation") {
      await requireInstallationReader(actor);
      return { kind: "installation" };
    }
    await requirePermitted(authorization, actor, "session.read", {
      kind: "session",
      id: null,
    });
    const userId = actor.actor?.userId ?? null;
    if (userId !== null) {
      return { kind: "user", ownerId: actor.ownerId, userId };
    }
    const apiKeyId = actor.actor?.apiKeyId ?? null;
    if (apiKeyId !== null) {
      return { kind: "api_key", ownerId: actor.ownerId, apiKeyId };
    }
    throw new SessionServiceError(
      "FORBIDDEN",
      "This caller started no sessions of its own to sum",
    );
  }

  return {
    // Summed over every owner, so the installation owner's alone (94S-762).
    async getInstallationLimits(
      actor: Caller,
    ): Promise<InstallationLimitsResponse> {
      await requireInstallationReader(actor);
      const usage = await reader.installationUsage();
      return {
        scope: "installation",
        refreshed_at: usage.readAt.toISOString(),
        limits: {
          execution_slot_limit: limits.executionSlotLimit,
          queued_input_limit_per_session: limits.queuedInputLimitPerSession,
          storage_limit_bytes: limits.storageLimitBytes,
          max_turn_seconds: limits.maxTurnSeconds,
          session_cost_limit_usd: decimalUsd(limits.sessionCostLimitUsd),
          session_token_limit: limits.sessionTokenLimit,
          provider_max_retries: limits.providerMaxRetries,
        },
        usage: {
          execution_slots_used: usage.executionSlotsUsed,
          queued_input_count: usage.queuedInputCount,
          storage: {
            used_bytes: usage.storageUsedBytes,
            accounted_content: [...STORAGE_ACCOUNTED_CONTENT],
            updated_at: usage.storageUpdatedAt?.toISOString() ?? null,
          },
        },
      };
    },

    async getUsageSummary(
      actor: Caller,
      query: UsageSummaryQuery,
    ): Promise<UsageSummaryResponse> {
      const filter = await filterFor(actor, query.scope);
      const summary = await reader.usageSummary(filter, {
        since: query.since,
        ...(query.until === undefined ? {} : { until: query.until }),
      });
      return {
        scope: query.scope,
        period: {
          since: query.since.toISOString(),
          until: summary.until.toISOString(),
        },
        refreshed_at: summary.readAt.toISOString(),
        session_count: summary.sessionCount,
        cost_usd: summary.costUsd,
        cost_complete: summary.incompleteTurnCount === 0,
        token_count: summary.providerTokens,
        run_seconds: summary.runSeconds,
        basis: {
          sessions: "created_in_period",
          cost: "provider_usage_estimate",
          run_time: "turn_wall_clock",
        },
      };
    },

    async getUsageTools(
      actor: Caller,
      query: UsageToolsQuery,
    ): Promise<UsageToolsResponse> {
      const filter = await filterFor(actor, query.scope);
      const rows = await reader.usageTools(
        filter,
        {
          period: {
            since: query.since,
            ...(query.until === undefined ? {} : { until: query.until }),
          },
          ...(query.agent_id === undefined ? {} : { agentId: query.agent_id }),
        },
        USAGE_TOOLS_LIMIT,
      );
      const tools = rows.map((row) => ({
        name: row.name,
        calls: row.calls,
        failed: row.failed,
        total_ms: row.totalMs,
        median_ms: row.medianMs,
        max_ms: row.maxMs,
      }));
      return { tools, findings: toolFindings(tools) };
    },

    async getUsageToolCalls(
      actor: Caller,
      name: string,
      query: UsageToolCallsQuery,
    ): Promise<UsageToolCallsResponse> {
      const filter = await filterFor(actor, query.scope);
      const tools = {
        period: {
          since: query.since,
          ...(query.until === undefined ? {} : { until: query.until }),
        },
        ...(query.agent_id === undefined ? {} : { agentId: query.agent_id }),
      };
      const page = await reader.usageToolCalls(filter, {
        ...tools,
        name,
        sort: query.sort,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ownerId: actor.ownerId,
        viewer: {
          userId: actor.actor?.userId ?? null,
          apiKeyId: actor.actor?.apiKeyId ?? null,
        },
      });
      return {
        calls: page.calls.map((call) => ({
          session_id: call.sessionId,
          title: call.title,
          agent: call.agent,
          occurred_at: call.occurredAt.toISOString(),
          duration_ms: call.durationMs,
          outcome: call.outcome,
        })),
        next_cursor: page.nextCursor,
        per_day: await reader.usageToolDays(filter, { ...tools, name }),
      };
    },

    async getSessionUsage(
      actor: Caller,
      sessionId: string,
    ): Promise<SessionUsageResponse> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const usage = await reader.sessionUsage(actor.ownerId, sessionId);
      // Another owner's session does not exist as far as this principal can
      // tell, the same answer every session read gives.
      if (!usage) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return {
        session_id: usage.sessionId,
        period: "session_lifetime",
        refreshed_at: usage.readAt.toISOString(),
        cost: {
          amount_usd: usage.costUsd,
          kind: usage.unmetered ? "unmetered" : "estimated",
          source: "provider_usage",
          completeness_scope: "turn_reports",
          complete:
            usage.unreportedTurnCount === 0 && usage.openTurnCount === 0,
          reported_turn_count: usage.reportedTurnCount,
          unreported_turn_count: usage.unreportedTurnCount,
          open_turn_count: usage.openTurnCount,
        },
        cost_limit_usd: usage.unmetered
          ? null
          : decimalUsd(limits.sessionCostLimitUsd),
        token_count: usage.providerTokens,
        token_limit: limits.sessionTokenLimit,
        // The predicate dispatch stops at, so this and the gate agree.
        budget_exceeded: budgetExceeded(
          {
            costUsd: Number(usage.costUsd),
            providerTokens: usage.providerTokens,
          },
          sessionBudgetOf(limits),
        ),
        queued_input_count: usage.queuedInputCount,
        queued_input_limit: limits.queuedInputLimitPerSession,
      };
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;

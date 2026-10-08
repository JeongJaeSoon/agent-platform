import type {
  InstallationLimitsResponse,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import type {
  AuthorizationPolicy,
  Principal,
} from "../authorization/policy.ts";
import {
  budgetExceeded,
  type InstallationLimits,
  STORAGE_ACCOUNTED_CONTENT,
  sessionBudgetOf,
} from "../limits/installation-limits.ts";
import type { UsageReader } from "../ports/usage-reader.ts";
import { type SessionCatalog, unmeteredSession } from "../sessions/catalog.ts";
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

export function createUsageService(deps: {
  authorization: AuthorizationPolicy;
  reader: UsageReader;
  limits: InstallationLimits;
  catalog: SessionCatalog;
}) {
  const { authorization, reader, limits, catalog } = deps;

  return {
    // Any principal holding sessions:read may read it, whoever's sessions
    // they own (decision): alpha users are internal staff and the
    // scope model has no installation operator to reserve it for. Revisit
    // before external exposure.
    async getInstallationLimits(): Promise<InstallationLimitsResponse> {
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

    async getSessionUsage(
      actor: Principal,
      sessionId: string,
    ): Promise<SessionUsageResponse> {
      requirePermitted(authorization, actor, "sessions:read");
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
          // The same predicate pricing uses, so a session reads unmetered
          // exactly when its calls were recorded at no cost.
          kind: unmeteredSession(catalog, usage) ? "unmetered" : "estimated",
          source: "provider_usage",
          completeness_scope: "turn_reports",
          complete:
            usage.unreportedTurnCount === 0 && usage.openTurnCount === 0,
          reported_turn_count: usage.reportedTurnCount,
          unreported_turn_count: usage.unreportedTurnCount,
          open_turn_count: usage.openTurnCount,
        },
        cost_limit_usd: decimalUsd(limits.sessionCostLimitUsd),
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

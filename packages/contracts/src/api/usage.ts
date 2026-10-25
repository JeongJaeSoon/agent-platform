import { z } from "zod";

import { costUsdSchema } from "../domain/digest.ts";
import {
  agentIdSchema,
  opaqueCursorSchema,
  sessionIdSchema,
  timestampSchema,
} from "../shared/index.ts";

const countSchema = z.number().int().nonnegative();

/**
 * What the storage limit counts today. A reader must not assume
 * events, checkpoints or worker disks are inside `used_bytes`.
 */
export const STORAGE_ACCOUNTED_CONTENT_VALUES = ["input_messages"] as const;

/**
 * GET /v1/limits: the limits the installation runs under and how
 * much of the installation-wide ones is in use. Every figure under `usage`
 * is summed across all owners, so none of them compares against a
 * per-session limit.
 */
export const installationLimitsResponseSchema = z
  .object({
    scope: z.literal("installation"),
    refreshed_at: timestampSchema,
    limits: z
      .object({
        execution_slot_limit: countSchema,
        queued_input_limit_per_session: countSchema,
        storage_limit_bytes: countSchema,
        max_turn_seconds: countSchema,
        session_cost_limit_usd: costUsdSchema,
        // null when the installation sets no token limit.
        session_token_limit: countSchema.nullable(),
        provider_max_retries: countSchema,
      })
      .strict(),
    usage: z
      .object({
        // Launches holding a slot, reservations and workers still being
        // removed included: the count the scheduler compares to the limit.
        execution_slots_used: countSchema,
        queued_input_count: countSchema,
        storage: z
          .object({
            used_bytes: countSchema,
            accounted_content: z.array(
              z.enum(STORAGE_ACCOUNTED_CONTENT_VALUES),
            ),
            // When the counter last moved; `refreshed_at` is when it was read.
            updated_at: timestampSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/**
 * GET /v1/sessions/{id}/usage. The cost is an estimate, never a
 * bill: every Messages call the egress proxy saw, the engine's and a tool's
 * alike, priced by the platform's table. A session from before
 * that also carries the engine's own turn totals up to then. `complete` is
 * about turn reports only: false while a turn is running or when a turn
 * ended without reporting a cost, in which case the true total is unknown.
 */
export const sessionUsageResponseSchema = z
  .object({
    session_id: sessionIdSchema,
    period: z.literal("session_lifetime"),
    refreshed_at: timestampSchema,
    cost: z
      .object({
        amount_usd: costUsdSchema,
        // `unmetered`: the session's profile declared it is not billed per
        // token, so its calls cost nothing and the cost limit never stops it.
        kind: z.enum(["estimated", "unmetered"]),
        source: z.literal("provider_usage"),
        completeness_scope: z.literal("turn_reports"),
        complete: z.boolean(),
        reported_turn_count: countSchema,
        unreported_turn_count: countSchema,
        open_turn_count: countSchema,
      })
      .strict(),
    // null for an unmetered session: the cost limit does not apply to it.
    cost_limit_usd: costUsdSchema.nullable(),
    // Every token of the same calls the cost counts, whatever they cost.
    token_count: countSchema,
    token_limit: countSchema.nullable(),
    // Either limit reached.
    budget_exceeded: z.boolean(),
    queued_input_count: countSchema,
    queued_input_limit: countSchema,
  })
  .strict();

export const USAGE_SUMMARY_SCOPE_VALUES = ["installation", "me"] as const;

// A calendar date is that day's 00:00 UTC; a timestamp with an offset is
// moved to UTC. Either way the period is cut on UTC.
const periodBoundSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform(
    (value) => new Date(value.length === 10 ? `${value}T00:00:00Z` : value),
  )
  // An impossible day such as 2026-02-30 is no date; PostgreSQL has no year 0.
  .pipe(z.date().min(new Date("0001-01-01T00:00:00Z")));

/**
 * GET /v1/usage/summary. `installation` sums every owner's sessions and is
 * the installation owner's alone; `me` sums the sessions the caller started.
 */
const usagePeriodQuerySchema = z.object({
  scope: z.enum(USAGE_SUMMARY_SCOPE_VALUES),
  since: periodBoundSchema,
  // Omitted: the moment the database reads the figures.
  until: periodBoundSchema.optional(),
});

function refinePeriod(
  query: { since: Date; until?: Date | undefined },
  ctx: z.RefinementCtx,
) {
  if (query.since < (query.until ?? new Date())) return;
  ctx.addIssue(
    query.until === undefined
      ? {
          code: "custom",
          message: "since must be in the past",
          path: ["since"],
        }
      : {
          code: "custom",
          message: "until must be after since",
          path: ["until"],
        },
  );
}

export const usageSummaryQuerySchema =
  usagePeriodQuerySchema.superRefine(refinePeriod);

/**
 * GET /v1/usage/tools: the same scopes and period as the summary, the period
 * cutting on when each tool call's tool_use event was stored.
 */
export const usageToolsQuerySchema = usagePeriodQuerySchema
  .extend({ agent_id: agentIdSchema.optional() })
  .superRefine(refinePeriod);

/** The most tool names one GET /v1/usage/tools response lists. */
export const USAGE_TOOLS_LIMIT = 200;

export const USAGE_TOOL_FINDING_KIND_VALUES = [
  "most_time",
  "fails_often",
  "slowest",
] as const;

/**
 * Calls per tool name, the most-called first. A call is timed from its
 * tool_use to its paired tool_result; one without a result yet, or with
 * either time missing, counts in `calls` but in no `_ms` figure. `failed`
 * counts results with `is_error: true` only. Each finding names a row of
 * `tools`, whose figures it reads.
 */
export const usageToolsResponseSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            calls: countSchema,
            failed: countSchema,
            total_ms: countSchema,
            median_ms: countSchema,
            max_ms: countSchema,
          })
          .strict(),
      )
      .max(USAGE_TOOLS_LIMIT),
    findings: z.array(
      z
        .object({
          kind: z.enum(USAGE_TOOL_FINDING_KIND_VALUES),
          name: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const USAGE_TOOL_CALLS_SORT_VALUES = ["recent", "slowest"] as const;
export const USAGE_TOOL_CALLS_LIMIT_DEFAULT = 20;
export const USAGE_TOOL_CALLS_LIMIT_MAX = 100;
export const USAGE_TOOL_CALLS_MAX_DAYS = 366;
export const USAGE_TOOL_CALL_OUTCOME_VALUES = [
  "ok",
  "failed",
  "unknown",
] as const;

export const usageToolCallsParamsSchema = z.object({
  name: z.string().min(1).max(512),
});

/**
 * GET /v1/usage/tools/{name}/calls: the scopes, period and agent filter of
 * GET /v1/usage/tools, one page of that tool's calls.
 */
export const usageToolCallsQuerySchema = usagePeriodQuerySchema
  .extend({
    agent_id: agentIdSchema.optional(),
    sort: z.enum(USAGE_TOOL_CALLS_SORT_VALUES).default("recent"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(USAGE_TOOL_CALLS_LIMIT_MAX)
      .default(USAGE_TOOL_CALLS_LIMIT_DEFAULT),
    cursor: opaqueCursorSchema.optional(),
  })
  .superRefine(refinePeriod)
  // per_day lists every date, so the period is bounded.
  .superRefine((query, ctx) => {
    const until = query.until ?? new Date();
    if (
      until.getTime() - query.since.getTime() >
      USAGE_TOOL_CALLS_MAX_DAYS * 86_400_000
    ) {
      ctx.addIssue({
        code: "custom",
        message: `the period may span at most ${USAGE_TOOL_CALLS_MAX_DAYS} days`,
        path: ["since"],
      });
    }
  });

/**
 * `session_id` and `title` are null for a session the caller may not read;
 * the call's time, duration, outcome and agent still show. `agent` is null
 * for a session made without one. `per_day` has every UTC date the period
 * touches, zeros included.
 */
export const usageToolCallsResponseSchema = z
  .object({
    calls: z
      .array(
        z
          .object({
            session_id: sessionIdSchema.nullable(),
            title: z.string().nullable(),
            agent: z.string().nullable(),
            occurred_at: timestampSchema,
            duration_ms: countSchema.nullable(),
            outcome: z.enum(USAGE_TOOL_CALL_OUTCOME_VALUES),
          })
          .strict(),
      )
      .max(USAGE_TOOL_CALLS_LIMIT_MAX),
    next_cursor: opaqueCursorSchema.nullable(),
    per_day: z.array(
      z.object({ date: z.iso.date(), calls: countSchema }).strict(),
    ),
  })
  .strict();

/**
 * A session counts in the period it was created in, so `cost_usd` is the sum
 * of `GET /v1/sessions/{id}/usage` `cost.amount_usd` over the same sessions
 * and `cost_complete` is false when any of them is.
 */
export const usageSummaryResponseSchema = z
  .object({
    scope: z.enum(USAGE_SUMMARY_SCOPE_VALUES),
    // Half-open: since <= created_at < until.
    period: z
      .object({ since: timestampSchema, until: timestampSchema })
      .strict(),
    refreshed_at: timestampSchema,
    session_count: countSchema,
    cost_usd: costUsdSchema,
    cost_complete: z.boolean(),
    token_count: countSchema,
    // Wall-clock time turns ran: an open turn counts up to `refreshed_at`.
    run_seconds: countSchema,
    basis: z
      .object({
        sessions: z.literal("created_in_period"),
        cost: z.literal("provider_usage_estimate"),
        run_time: z.literal("turn_wall_clock"),
      })
      .strict(),
  })
  .strict();

export type UsageSummaryScope = (typeof USAGE_SUMMARY_SCOPE_VALUES)[number];
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;
export type UsageToolsQuery = z.infer<typeof usageToolsQuerySchema>;
export type UsageToolsResponse = z.infer<typeof usageToolsResponseSchema>;
export type UsageToolCallsParams = z.infer<typeof usageToolCallsParamsSchema>;
export type UsageToolCallsQuery = z.infer<typeof usageToolCallsQuerySchema>;
export type UsageToolCallsResponse = z.infer<
  typeof usageToolCallsResponseSchema
>;
export type InstallationLimitsResponse = z.infer<
  typeof installationLimitsResponseSchema
>;
export type SessionUsageResponse = z.infer<typeof sessionUsageResponseSchema>;

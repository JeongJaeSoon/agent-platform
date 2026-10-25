import { z } from "zod";

import { costUsdSchema } from "../domain/digest.ts";
import {
  agentIdSchema,
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

const usagePeriodQuerySchema = z.object({
  scope: z.enum(USAGE_SUMMARY_SCOPE_VALUES),
  since: periodBoundSchema,
  // Omitted: the moment the database reads the figures.
  until: periodBoundSchema.optional(),
});

function checkPeriod(
  query: z.infer<typeof usagePeriodQuerySchema>,
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

/**
 * GET /v1/usage/summary. `installation` sums every owner's sessions and is
 * the installation owner's alone; `me` sums the sessions the caller started.
 */
export const usageSummaryQuerySchema =
  usagePeriodQuerySchema.superRefine(checkPeriod);

const DAY_MS = 86_400_000;
/**
 * The longest period a series or breakdown answers, a leap year of day
 * buckets: each reads every session of the period.
 */
export const USAGE_PERIOD_MAX_DAYS = 366;

function checkBoundedPeriod(
  query: z.infer<typeof usagePeriodQuerySchema>,
  ctx: z.RefinementCtx,
) {
  checkPeriod(query, ctx);
  const until = query.until ?? new Date();
  if (until.getTime() - query.since.getTime() <= USAGE_PERIOD_MAX_DAYS * DAY_MS)
    return;
  ctx.addIssue({
    code: "custom",
    message: `a period spans at most ${USAGE_PERIOD_MAX_DAYS} days`,
    path: ["since"],
  });
}

/** GET /v1/usage/series: the summary's sessions, one bucket per UTC day. */
export const usageSeriesQuerySchema = usagePeriodQuerySchema
  .extend({ bucket: z.enum(["day"]).default("day") })
  .superRefine(checkBoundedPeriod);

export const USAGE_BREAKDOWN_BY_VALUES = ["model", "agent"] as const;

/** GET /v1/usage/breakdown: the summary's sessions grouped by model or agent. */
export const usageBreakdownQuerySchema = usagePeriodQuerySchema
  .extend({ by: z.enum(USAGE_BREAKDOWN_BY_VALUES) })
  .superRefine(checkBoundedPeriod);

/**
 * GET /v1/usage/tools: the same scopes and period as the summary, the period
 * cutting on when each tool call's tool_use event was stored.
 */
export const usageToolsQuerySchema = usagePeriodQuerySchema
  .extend({ agent_id: agentIdSchema.optional() })
  .superRefine(checkPeriod);

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

/**
 * Every UTC day the period touches, oldest first, empty days included. Each
 * bucket adds up the sessions created that day exactly as the summary does,
 * so the buckets of one response sum to the summary of the same period.
 * `run_seconds` is the floor of the running total minus the one before, so
 * whole seconds are never lost to rounding each day.
 */
export const usageSeriesResponseSchema = z
  .object({
    // Half-open: since <= created_at < until.
    period: z
      .object({ since: timestampSchema, until: timestampSchema })
      .strict(),
    refreshed_at: timestampSchema,
    buckets: z.array(
      z
        .object({
          date: z.iso.date(),
          session_count: countSchema,
          cost_usd: costUsdSchema,
          // true for a day without sessions.
          cost_complete: z.boolean(),
          token_count: countSchema,
          run_seconds: countSchema,
        })
        .strict(),
    ),
  })
  .strict();

const usageBreakdownFiguresSchema = z
  .object({
    session_count: countSchema,
    input_tokens: countSchema,
    output_tokens: countSchema,
    cache_read_input_tokens: countSchema,
    // The 1-hour cache writes are part of it, not a fifth column.
    cache_creation_input_tokens: countSchema,
    // The four columns' sum, the summary's `token_count` for the totals.
    token_count: countSchema,
    cost_usd: costUsdSchema,
  })
  .strict();

/**
 * The summary's sessions grouped, largest cost first. `by=agent`: each
 * session counts once, under its agent, so the rows add up to the totals in
 * every column. `by=model`: a session counts under every model it called, so
 * the rows' `session_count` may add up to more than the totals'; a session's
 * cost no metered call explains (sessions from before proxy metering) is the
 * row whose `key` is null. `key` and `label` are null on the row for sessions
 * without an agent or with that unexplained cost. `totals` is the summary of
 * the same period: `session_count`, `token_count` and `cost_usd` equal it.
 */
export const usageBreakdownResponseSchema = z
  .object({
    rows: z.array(
      usageBreakdownFiguresSchema
        .extend({
          // The agent id, or the model as the proxy recorded it.
          key: z.string().nullable(),
          // The agent's name; for a model, the model again.
          label: z.string().nullable(),
        })
        .strict(),
    ),
    totals: usageBreakdownFiguresSchema,
  })
  .strict();

export type UsageSummaryScope = (typeof USAGE_SUMMARY_SCOPE_VALUES)[number];
export type UsageBreakdownBy = (typeof USAGE_BREAKDOWN_BY_VALUES)[number];
export type UsageBreakdownQuery = z.infer<typeof usageBreakdownQuerySchema>;
export type UsageBreakdownResponse = z.infer<
  typeof usageBreakdownResponseSchema
>;
export type UsageSeriesQuery = z.infer<typeof usageSeriesQuerySchema>;
export type UsageSeriesResponse = z.infer<typeof usageSeriesResponseSchema>;
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;
export type UsageToolsQuery = z.infer<typeof usageToolsQuerySchema>;
export type UsageToolsResponse = z.infer<typeof usageToolsResponseSchema>;
export type InstallationLimitsResponse = z.infer<
  typeof installationLimitsResponseSchema
>;
export type SessionUsageResponse = z.infer<typeof sessionUsageResponseSchema>;

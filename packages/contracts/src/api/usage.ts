import { z } from "zod";

import { costUsdSchema } from "../domain/digest.ts";
import { sessionIdSchema, timestampSchema } from "../shared/index.ts";

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
    cost_limit_usd: costUsdSchema,
    // Every token of the same calls the cost counts, whatever they cost.
    token_count: countSchema,
    token_limit: countSchema.nullable(),
    // Either limit reached.
    budget_exceeded: z.boolean(),
    queued_input_count: countSchema,
    queued_input_limit: countSchema,
  })
  .strict();

export type InstallationLimitsResponse = z.infer<
  typeof installationLimitsResponseSchema
>;
export type SessionUsageResponse = z.infer<typeof sessionUsageResponseSchema>;

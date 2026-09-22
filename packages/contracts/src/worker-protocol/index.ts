import { z } from "zod";

import { postSessionAnswerRequestSchema } from "../api/answer.ts";
import { sessionEventVariants } from "../api/event.ts";
import {
  attemptStateSchema,
  sessionRuntimeSchema,
  terminalTurnStatusSchema,
} from "../api/session.ts";
import {
  attemptIdSchema,
  epochSchema,
  executionIdSchema,
  opaqueCursorSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";

// Every post-claim call carries the fenced identity the gateway verifies in
// the same transaction as the write.
export const workerScopeSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: turnIdSchema.nullable(),
  attempt_id: attemptIdSchema,
  lease_epoch: epochSchema,
  execution_generation: epochSchema,
  auth_revision: epochSchema,
});

export const checkpointRefSchema = z.object({
  revision: revisionSchema,
  manifest_ref: z.string().min(1),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const bootstrapClaimRequestSchema = z
  .object({
    execution_id: executionIdSchema,
    execution_generation: epochSchema,
    credential: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("launch_nonce"), nonce: z.string().min(1) }),
      z.object({
        kind: z.literal("workload_identity"),
        job_uid: z.string().min(1),
      }),
    ]),
  })
  .strict();
// Retrying bootstrapClaim issues a new credential and revokes the previous
// one, so two retries in flight at once can leave a worker holding the token
// that lost. Before its first accepted call a worker that is answered 401
// claims again: while the attempt has not used a token, the same binding
// comes back with a working credential.
export const bootstrapClaimResponseSchema = workerScopeSchema.extend({
  session_credential: z.string().min(1),
  lease_expires_at: timestampSchema,
  runtime: sessionRuntimeSchema,
  restore: checkpointRefSchema.nullable(),
});

export const nextInputRequestSchema = workerScopeSchema
  .extend({ wait_ms: z.number().int().nonnegative().optional() })
  .strict();
export const nextInputResponseSchema = z.object({
  input: z
    .object({
      turn_id: turnIdSchema,
      input_id: z.string().min(1),
      message: z.string().min(1),
      delivery_started_at: timestampSchema,
    })
    .nullable(),
  lease_expires_at: timestampSchema,
});

export const heartbeatRequestSchema = workerScopeSchema
  .extend({ attempt_state: attemptStateSchema })
  .strict();
export const heartbeatResponseSchema = z.object({
  lease_expires_at: timestampSchema,
  auth_revision: epochSchema,
  control_pending: z.boolean(),
});

const v = sessionEventVariants;
// Per attempt, source_sequence starts at 1 and increases by one. Subscribers
// read the stream back in the order it was stored, so an event whose
// predecessor is missing is refused rather than written out of order: the
// worker resends from the acknowledged prefix.
function sourced<V extends (typeof v)[keyof typeof v]>(variant: V) {
  return variant.extend({
    source_sequence: z.number().int().positive(),
    occurred_at: timestampSchema,
  });
}
export const workerEventSchema = z.discriminatedUnion("event", [
  sourced(v.system),
  sourced(v.assistant),
  sourced(v.tool_use),
  sourced(v.tool_result),
  sourced(v.question),
  sourced(v.result),
  sourced(v.status),
  sourced(v.error),
]);
export const appendEventsRequestSchema = workerScopeSchema
  .extend({
    batch_key: z.string().min(1),
    events: z.array(workerEventSchema).min(1),
  })
  .strict();
export const appendEventsResponseSchema = z.object({
  // The attempt's durable prefix: 0 until sequence 1 is stored.
  accepted_through: z.number().int().nonnegative(),
  cursor: opaqueCursorSchema,
});

// Answers are redelivered until the worker advances answers_after, so a crash
// between applying an answer and the next poll replays the same sequence.
export const pendingControlRequestSchema = workerScopeSchema
  .extend({ answers_after: z.number().int().nonnegative() })
  .strict();
export const controlIntentSchema = z.object({
  control_id: z.string().min(1),
  kind: z.enum(["interrupt", "pause", "terminate"]),
  target_turn_id: turnIdSchema.nullable(),
  issued_at: timestampSchema,
});
export const pendingControlResponseSchema = z.object({
  control: controlIntentSchema.nullable(),
  answers: z.array(
    z.object({
      sequence: z.number().int().positive(),
      answer: postSessionAnswerRequestSchema,
    }),
  ),
});

export const finalizeRequestSchema = workerScopeSchema
  .extend({
    turn_id: turnIdSchema,
    finalize_key: z.string().min(1),
    terminal: z.object({
      status: terminalTurnStatusSchema.exclude(["cancelled"]),
      reason: z.string().min(1).nullable(),
      result: z.unknown().nullable(),
      usage: z.unknown().nullable(),
    }),
    checkpoint: checkpointRefSchema.nullable(),
  })
  .strict();
export const finalizeResponseSchema = z.object({
  turn_id: turnIdSchema,
  status: terminalTurnStatusSchema,
  checkpoint_revision: revisionSchema.nullable(),
});

export const releaseRequestSchema = workerScopeSchema
  .extend({ reason: z.string().min(1) })
  .strict();
export const releaseResponseSchema = z.object({ released: z.boolean() });

export type WorkerScope = z.infer<typeof workerScopeSchema>;
export type CheckpointRef = z.infer<typeof checkpointRefSchema>;
export type BootstrapClaimRequest = z.infer<typeof bootstrapClaimRequestSchema>;
export type BootstrapClaimResponse = z.infer<
  typeof bootstrapClaimResponseSchema
>;
export type NextInputRequest = z.infer<typeof nextInputRequestSchema>;
export type NextInputResponse = z.infer<typeof nextInputResponseSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type AppendEventsRequest = z.infer<typeof appendEventsRequestSchema>;
export type AppendEventsResponse = z.infer<typeof appendEventsResponseSchema>;
export type PendingControlRequest = z.infer<typeof pendingControlRequestSchema>;
export type ControlIntent = z.infer<typeof controlIntentSchema>;
export type PendingControlResponse = z.infer<
  typeof pendingControlResponseSchema
>;
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type ReleaseResponse = z.infer<typeof releaseResponseSchema>;

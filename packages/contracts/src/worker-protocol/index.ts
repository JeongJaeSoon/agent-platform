import { z } from "zod";

import { postSessionAnswerRequestSchema } from "../api/answer.ts";
import { sessionEventVariants } from "../api/event.ts";
import { pendingQuestionSchema } from "../api/pending.ts";
import {
  attemptStateSchema,
  permissionModeSchema,
  sessionRuntimeSchema,
  terminalTurnStatusSchema,
} from "../api/session.ts";
import {
  attemptIdSchema,
  epochSchema,
  executionIdSchema,
  INT4_MAX,
  opaqueCursorSchema,
  requestIdSchema,
  requiredUnknownSchema,
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
// What the session was created against. It is copied from the session row,
// not looked up in the catalog at claim time, so a repository that has since
// left the catalog still describes the workspace this session lives in.
export const workspaceRepositorySchema = z
  .object({
    // Catalog key at creation; null for rows that predate the catalog (94S-147).
    id: z.string().min(1).nullable(),
    // Verbatim, userinfo included: stripping it would break the private
    // clones that have no other credential path yet. The worker treats the
    // whole URL as a secret. Credential delivery proper is a separate ticket.
    url: z.string().min(1),
    branch: z.string().min(1),
  })
  .strict();
export const workspaceDescriptorSchema = z
  .object({ repository: workspaceRepositorySchema })
  .strict();

const apiKeyAuthSchema = z
  .object({ kind: z.literal("api_key"), value: z.string().min(1) })
  .strict();
const bearerAuthSchema = z
  .object({ kind: z.literal("bearer"), value: z.string().min(1) })
  .strict();
export const runtimeProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: z.url(),
      auth: apiKeyAuthSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: z.url(),
      auth: z.discriminatedUnion("kind", [apiKeyAuthSchema, bearerAuthSchema]),
    })
    .strict(),
]);
// Everything the engine needs beyond the identity in `runtime`: resolved by
// the server from the profile the session was created with. The provider
// credential rides here. The claim that carries it can be replayed only
// until the attempt's first accepted call, and it is the platform's write
// fence that is scoped to the binding, not the credential's own validity:
// a shared provider key handed out this way is still a shared key. Nothing
// here may reach an event, a manifest or a log — see `loggableBootstrapClaim`.
export const runtimeConfigSchema = z
  .object({
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    permission_mode: permissionModeSchema,
    provider: runtimeProviderSchema,
  })
  .strict();

export const bootstrapClaimResponseSchema = workerScopeSchema.extend({
  session_credential: z.string().min(1),
  lease_expires_at: timestampSchema,
  runtime: sessionRuntimeSchema,
  runtime_config: runtimeConfigSchema,
  workspace: workspaceDescriptorSchema,
  restore: checkpointRefSchema.nullable(),
});

// The claim as a log line may carry it: an allowlist of identifiers, never
// the whole response minus the secrets. The session token, the provider
// credential and the repository URL (which may embed one) are what a leak
// would consist of.
export function loggableBootstrapClaim(response: BootstrapClaimResponse) {
  return {
    session_id: response.session_id,
    attempt_id: response.attempt_id,
    lease_epoch: response.lease_epoch,
    execution_generation: response.execution_generation,
    auth_revision: response.auth_revision,
    lease_expires_at: response.lease_expires_at,
    runtime: response.runtime,
    model: response.runtime_config.model,
    permission_mode: response.runtime_config.permission_mode,
    provider_kind: response.runtime_config.provider.kind,
    repository_id: response.workspace.repository.id,
    branch: response.workspace.repository.branch,
    restore_revision: response.restore?.revision ?? null,
  };
}

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
    source_sequence: z.number().int().positive().max(INT4_MAX),
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

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

// A permission or question the attempt is holding a live callback for. The
// worker registers it before anyone is told about it, so every request a
// client can see is one an answer can reach. `input_hash` is taken over the
// callback's own arguments, before redaction: the display copy below is
// redacted, and two different arguments must never share an approval.
export const registerPendingRequestSchema = workerScopeSchema
  .extend({
    turn_id: turnIdSchema,
    request_id: requestIdSchema,
    input_hash: sha256HexSchema,
    request: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("permission"),
          tool: z.string().min(1),
          input: requiredUnknownSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("question"),
          questions: z.array(pendingQuestionSchema).min(1),
        })
        .strict(),
    ]),
  })
  .strict();
// `expires_in_ms` is what is left, measured on the server's clock: a replay
// never restarts the lifetime, and the worker needs no clock agreement to
// know how long answers are still accepted.
export const registerPendingResponseSchema = z.object({
  request_id: requestIdSchema,
  expires_at: timestampSchema,
  expires_in_ms: z.number().int().nonnegative(),
});

// How a registered request ended on the worker: `answered` once the callback
// got the delivered answer (a deny included), `expired` when nothing reached
// it in time, `cancelled` when the callback went away first.
export const pendingSettlementSchema = z
  .object({
    request_id: requestIdSchema,
    outcome: z.enum(["answered", "expired", "cancelled"]),
  })
  .strict();

// Answers are redelivered until the worker advances answers_after, so a crash
// between applying an answer and the next poll replays the same sequence.
// Settlements ride along and are resent until a call carrying them succeeds;
// they are independent of the cursor, which only says what was seen.
export const pendingControlRequestSchema = workerScopeSchema
  .extend({
    answers_after: z.number().int().nonnegative(),
    settled: z.array(pendingSettlementSchema).max(256).optional(),
  })
  .strict();
export const controlIntentSchema = z.object({
  control_id: z.string().min(1),
  kind: z.enum(["interrupt", "pause", "terminate"]),
  target_turn_id: turnIdSchema.nullable(),
  issued_at: timestampSchema,
});
// In ascending sequence order.
export const pendingControlResponseSchema = z.object({
  control: controlIntentSchema.nullable(),
  answers: z.array(
    z.object({
      sequence: z.number().int().positive(),
      answer: postSessionAnswerRequestSchema,
      // The registered hash, so the worker applies the answer only to the
      // callback it was given for.
      input_hash: sha256HexSchema,
    }),
  ),
});

export const finalizeRequestSchema = workerScopeSchema
  .extend({
    turn_id: turnIdSchema,
    finalize_key: z.string().min(1),
    // The last source_sequence this attempt produced before the terminal.
    // The turn only closes once the stream is durable through it, so a
    // finalize can never overtake its own event tail (94S-218). Zero means
    // the attempt has written no events yet.
    final_source_sequence: z.number().int().nonnegative().max(INT4_MAX),
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
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;
export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type NextInputRequest = z.infer<typeof nextInputRequestSchema>;
export type NextInputResponse = z.infer<typeof nextInputResponseSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type AppendEventsRequest = z.infer<typeof appendEventsRequestSchema>;
export type AppendEventsResponse = z.infer<typeof appendEventsResponseSchema>;
export type RegisterPendingRequest = z.infer<
  typeof registerPendingRequestSchema
>;
export type RegisterPendingResponse = z.infer<
  typeof registerPendingResponseSchema
>;
export type PendingSettlement = z.infer<typeof pendingSettlementSchema>;
export type PendingControlRequest = z.infer<typeof pendingControlRequestSchema>;
export type ControlIntent = z.infer<typeof controlIntentSchema>;
export type PendingControlResponse = z.infer<
  typeof pendingControlResponseSchema
>;
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type ReleaseResponse = z.infer<typeof releaseResponseSchema>;

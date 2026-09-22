import { z } from "zod";

import { postSessionAnswerRequestSchema } from "../api/answer.ts";
import { sessionEventVariants } from "../api/event.ts";
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

// Why a run refuses to be checkpointed right now (runtime-core
// CheckpointBlockReason, mirrored here so the wire schema is closed).
export const checkpointBlockReasonSchema = z.enum([
  "mirror_error",
  "no_engine_session",
  "turn_in_flight",
]);

// The worker's view of its transcript mirror, reported with each heartbeat.
// `persisted_at` is the last mirror write that succeeded; `mirror_error` is
// set while a batch has been dropped and the mirror no longer describes the
// engine session. The server records the error as the session's pending
// reason, which holds new turns and completed terminals back until a
// checkpoint that reads the whole transcript commits.
export const transcriptReportSchema = z
  .object({
    persisted_at: timestampSchema.nullable(),
    mirror_error: z.string().min(1).nullable(),
  })
  .strict();

export const heartbeatRequestSchema = workerScopeSchema
  .extend({
    attempt_state: attemptStateSchema,
    // Optional so a worker that does not mirror yet heartbeats unchanged.
    transcript: transcriptReportSchema.optional(),
  })
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

// Asks the server where the next checkpoint goes. The runtime's own verdict
// travels with it: the server decides which refusals outlive the turn and
// records those as the session's pending reason. The answer is authoritative —
// the revision and manifest key come from the committed pointer, never from
// the worker's memory of its restore point.
export const checkpointRequestSchema = workerScopeSchema
  .extend({
    preparation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready") }).strict(),
      z
        .object({
          status: z.literal("rejected"),
          reason: checkpointBlockReasonSchema,
          detail: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();
export const checkpointRequestResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    revision: revisionSchema,
    manifest_ref: z.string().min(1),
  }),
  z.object({
    status: z.literal("blocked"),
    reason: checkpointBlockReasonSchema,
    detail: z.string().min(1),
  }),
]);

// What the worker runs, so the server can say whether the committed
// checkpoint can be resumed by it (runtime-core RuntimeFingerprint).
export const runtimeFingerprintSchema = z
  .object({
    engine: z.string().min(1),
    sdk_version: z.string().min(1),
    cli_version: z.string().min(1),
    profile_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const restorePlanRequestSchema = workerScopeSchema
  .extend({ runtime: runtimeFingerprintSchema })
  .strict();

const restoreObjectSchema = z.object({
  key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const restoreArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum([
      "transcript_root",
      "transcript_subagent",
      "workspace_bundle",
    ]),
    label: z.string(),
    objects: z.array(restoreObjectSchema),
  }),
  z.object({
    kind: z.literal("workspace_untracked"),
    label: z.string(),
    objects: z.array(restoreObjectSchema.extend({ path: z.string().min(1) })),
  }),
]);
export const restorePlanSchema = z.object({
  revision: revisionSchema,
  manifest_ref: z.string().min(1),
  engine: z.string().min(1),
  resume: z.string().min(1),
  cwd: z.string().min(1),
  git_commit: z.string().regex(/^[0-9a-f]{40}$/),
  artifacts: z.array(restoreArtifactSchema),
  object_keys: z.array(z.string().min(1)),
});
// `none` is a new session. `unavailable` and `incompatible` are refusals the
// worker must fail its claim on: starting a fresh engine session on top of a
// session that has a checkpoint is exactly what the pointer exists to stop.
export const restorePlanResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("ready"), plan: restorePlanSchema }),
  z.object({
    status: z.literal("unavailable"),
    code: z.literal("CHECKPOINT_UNAVAILABLE"),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("incompatible"),
    code: z.literal("INCOMPATIBLE_CHECKPOINT"),
    mismatches: z.array(
      z.object({
        field: z.enum(["cliVersion", "engine", "profileSha256", "sdkVersion"]),
        expected: z.string(),
        found: z.string(),
      }),
    ),
  }),
]);

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
export type CheckpointBlockReason = z.infer<typeof checkpointBlockReasonSchema>;
export type TranscriptReport = z.infer<typeof transcriptReportSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type CheckpointRequest = z.infer<typeof checkpointRequestSchema>;
export type CheckpointRequestResponse = z.infer<
  typeof checkpointRequestResponseSchema
>;
export type RuntimeFingerprintWire = z.infer<typeof runtimeFingerprintSchema>;
export type RestorePlanRequest = z.infer<typeof restorePlanRequestSchema>;
export type RestorePlanWire = z.infer<typeof restorePlanSchema>;
export type RestorePlanResponse = z.infer<typeof restorePlanResponseSchema>;
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

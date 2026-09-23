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

// An object store version id (S3 VersionId): opaque UTF-8, at most 1024
// bytes. "null" is S3's name for the replaceable unversioned slot, so it
// never counts as a pinned version. Same rules as the manifest codec's.
export const objectVersionSchema = z
  .string()
  .min(1)
  .refine((version) => version !== "null", {
    message: 'version "null" is not an immutable version',
  })
  .refine((version) => new TextEncoder().encode(version).byteLength <= 1024, {
    message: "a version id is at most 1024 bytes of UTF-8",
  });

export const checkpointRefSchema = z.object({
  revision: revisionSchema,
  manifest_ref: z.string().min(1),
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // The version `putImmutable` answered for the manifest. The server verifies
  // that version, records it on the pointer and restores from it; a server
  // that requires versions refuses a checkpoint without one (94S-229).
  manifest_version: objectVersionSchema.optional(),
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

// Who the session acts for: its owner partition (`AuthorizationContext.
// owner_scope`), copied from the session row. The worker hashes it into the
// checkpoint fingerprint (94S-209), which is what keeps two partitions on one
// shared provider endpoint from resuming each other's checkpoints. It is an
// identifier, never a credential, and it names a partition rather than the
// caller of the moment so another member of the same partition can resume.
export const claimPrincipalSchema = z
  .object({ owner_scope: z.string().min(1) })
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
// Which of the checked-out repository's own Claude project settings the run
// takes in. Only its root CLAUDE.md can be let in, as text the worker reads
// itself; the repository's settings.json never loads, because it can carry
// hooks that run commands no permission callback sees, `env` that points the
// engine (and the provider credential) at another endpoint, and permission
// rules that pre-approve tools — and that surface grows with every CLI
// release. There is deliberately no `hooks` switch: the strict object refuses
// one. It becomes a field when an operator-reviewed repository has to run its
// hooks, which also needs a sandbox for what they execute.
//
// Absent on the wire means off, and the gateway leaves it out when it is off:
// a worker built before the field refuses unknown keys, and off is what that
// worker already does. When it is on, such a worker refuses the claim — the
// right answer from a worker that could not honour it.
export const projectSettingsSchema = z
  .object({ claude_md: z.boolean() })
  .strict();

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
    project_settings: projectSettingsSchema.optional(),
  })
  .strict();

// The catalog's name for the settings in `runtime_config` (94S-132): a hash
// of the profile without its credential. The settings still ride in full —
// the engine needs them — and this is what a log line or a later
// comparison (94S-253) can hold instead.
export const profileFingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>");

export const bootstrapClaimResponseSchema = workerScopeSchema.extend({
  session_credential: z.string().min(1),
  lease_expires_at: timestampSchema,
  runtime: sessionRuntimeSchema,
  profile_fingerprint: profileFingerprintSchema,
  runtime_config: runtimeConfigSchema,
  workspace: workspaceDescriptorSchema,
  principal: claimPrincipalSchema,
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
    profile_fingerprint: response.profile_fingerprint,
    model: response.runtime_config.model,
    permission_mode: response.runtime_config.permission_mode,
    provider_kind: response.runtime_config.provider.kind,
    claude_md: response.runtime_config.project_settings?.claude_md === true,
    repository_id: response.workspace.repository.id,
    branch: response.workspace.repository.branch,
    owner_scope: response.principal.owner_scope,
    restore_revision: response.restore?.revision ?? null,
  };
}

export const nextInputRequestSchema = workerScopeSchema
  .extend({ wait_ms: z.number().int().nonnegative().optional() })
  .strict();
/**
 * The most one finalize may report a turn cost. Far above any real turn, so a
 * runaway report cannot overflow the session's stored sum; the worker clamps
 * to it rather than send a terminal the gateway would refuse.
 */
export const MAX_TURN_COST_USD = 1_000_000;

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
  // Nothing more is coming to this attempt: release and exit rather than
  // hold the execution slot. `reason` says why when it is not the attempt's
  // own drain. Optional so a worker older than 94S-131 still parses it.
  draining: z.boolean().optional(),
  reason: z.enum(["BUDGET_EXCEEDED"]).optional(),
});

// Why a run refuses to be checkpointed right now (runtime-core
// CheckpointBlockReason, mirrored here so the wire schema is closed).
export const checkpointBlockReasonSchema = z.enum([
  "background_writer",
  "checkpoint_lease_held",
  "mirror_error",
  "no_engine_session",
  "tool_in_flight",
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

export const PENDING_SETTLEMENTS_MAX = 256;

// Answers are redelivered until the worker advances answers_after, so a crash
// between applying an answer and the next poll replays the same sequence.
// Settlements ride along and are resent until a call carrying them succeeds;
// they are independent of the cursor, which only says what was seen.
export const pendingControlRequestSchema = workerScopeSchema
  .extend({
    answers_after: z.number().int().nonnegative(),
    settled: z
      .array(pendingSettlementSchema)
      .max(PENDING_SETTLEMENTS_MAX)
      .optional(),
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

// `version`, when present, is the only thing the worker may download: the
// key's current object can be a later write than the one the checkpoint
// verified (94S-229).
const restoreObjectSchema = z.object({
  key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  version: objectVersionSchema.optional(),
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
    objects: z.array(
      restoreObjectSchema.extend({
        path: z.string().min(1),
        // Absent for a file restored without execute bits.
        executable: z.literal(true).exactOptional(),
      }),
    ),
  }),
]);
export const restorePlanSchema = z.object({
  revision: revisionSchema,
  manifest_ref: z.string().min(1),
  manifest_version: objectVersionSchema.optional(),
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
      // What the engine says this turn cost, in USD; an estimate, not a bill.
      // Absent or null when it said nothing, which counts as zero spent.
      cost_usd: z
        .number()
        .nonnegative()
        .max(MAX_TURN_COST_USD)
        .nullable()
        .optional(),
    }),
    checkpoint: checkpointRefSchema.nullable(),
  })
  .strict();
export const finalizeResponseSchema = z.object({
  turn_id: turnIdSchema,
  status: terminalTurnStatusSchema,
  checkpoint_revision: revisionSchema.nullable(),
});

// `pause_control_id` makes the release the drained attempt's answer to that
// pause: the coordinator commits the pause with it or refuses it (409
// CHECKPOINT_UNAVAILABLE while no safe checkpoint covers the session, 409
// REQUEST_STALE once the pause is not the open one), and a refused attempt
// keeps its lease. Without it the release is unconditional.
export const releaseRequestSchema = workerScopeSchema
  .extend({
    reason: z.string().min(1),
    pause_control_id: z.string().min(1).optional(),
  })
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
export type ClaimPrincipal = z.infer<typeof claimPrincipalSchema>;
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
